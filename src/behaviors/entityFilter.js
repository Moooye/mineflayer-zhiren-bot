// ============================================================
// entityFilter：实体过滤（服务器实体不拖累机器人）
//   在 bot.entities 外面套一层拦截：
//     · 类型不在「保留清单」里的实体：存不进去、读不到、也不出现在遍历里
//     · 已经判定要隐藏的实体 id 会记下来，mineflayer 内部
//       `bot.entities[id] || (bot.entities[id] = new Entity(id))` 重建的空壳也会被丢弃
//   默认保留 player / item（跟随、去、传送、防AFK 拾取要用），其余（怪/动物/水生物…）全部隐藏。
//   ★ 近身保留（keepNearRadius，默认 8 格）：这个距离内的实体一律不过滤。
//     `!攻击` 走 bot.entityAtCursor()（默认 3.5 格），只靠类型过滤的话怪物早就被丢掉了、只会空挥；
//     所以：近身（含刚走过来、刚 spawn 的）实体一律留在内存里，远的一样过滤掉，
//     内存代价被“身边 8 格”限制住。keepNearRadius = 0 可关掉近身保留（回到纯类型过滤）。
//   自身实体（bot.entity）永远保留：mineflayer 的 fetchEntity 会往 bot.entities 里塞自己，
//   拦掉的话每个自身实体包都会重建一个新 Entity（更费 CPU），并且读 bot.entities[自己] 会变成 undefined。
//   关掉开关（enabled=false）时代理一律放行，等价于原版 bot.entities。
// 注意：不靠 keepTypes 也不靠近身保留（keepNearRadius=0）时，!攻击 会因为看不到怪物而空挥；
//       默认 keepNearRadius=8，所以开启实体过滤后 !攻击 照常生效。
// 说明：实体包本身仍由 mineflayer 解析（实现限制），所以本功能省的是实体对象的内存、GC
//       与后续状态更新；视距按需在配置 perf.viewDistance 里设置（null = 保持默认）。
// ============================================================
'use strict'

class EntityFilter {
  /**
   * @param {object} botContext BotContext
   * @param {object} options     { viewDistance, entityFilter:{ enabled, keepTypes, logEveryMs, sweepMs, unknownTtlMs, hiddenTtlMs } }
   */
  constructor (botContext, options = {}) {
    this.ctx = botContext
    const sub = options.entityFilter || {}
    this.enabled = sub.enabled !== false
    this.keepTypes = new Set((sub.keepTypes || ['player', 'item']).map(s => String(s).toLowerCase()))
    // 近身保留半径（格）：这个距离内的实体一律不过滤（!攻击 要靠它命中）。0 = 关闭
    this.keepNearRadius = sub.keepNearRadius === undefined ? 8 : Math.max(0, Number(sub.keepNearRadius) || 0)
    // 近身保留的数量上限（防极端场景：身边一堆怪时也有个上限）
    this.keepNearMax = sub.keepNearMax === undefined ? 40 : Math.max(1, Number(sub.keepNearMax) || 40)
    this.logEveryMs = sub.logEveryMs || 60000
    this.sweepMs = sub.sweepMs || 10000
    this.unknownTtlMs = sub.unknownTtlMs || 15000 // 类型一直没解析出来的空壳，多久后清掉
    this.hiddenTtlMs = sub.hiddenTtlMs || 600000 // 隐藏 id 记忆保留多久（超时后靠上面的 TTL 兜底）
    this.viewDistance = options.viewDistance // null = 不改视距
    this.filtered = 0
    this.kept = 0
    this.admitted = 0 // 被“近身保留”放回内存的次数
    this.nearSkipped = 0 // 超过 keepNearMax 而没放回的次数
    this._lastFiltered = 0
    this._hidden = new Map() // 已判定隐藏的实体 id -> 最近出现时间
    this._unknownSince = new Map()
    this._lastLogAt = 0
    this._sweepTimer = null
    this._proxiedBot = null
  }

  bindBot (bot) {
    if (this.viewDistance != null && this.viewDistance !== 0 && typeof bot.setSettings === 'function') {
      try {
        bot.setSettings({ viewDistance: this.viewDistance })
      } catch (e) {
        if (this.ctx.logger) this.ctx.logger.warn(`设置视距失败（${this.viewDistance}）：${e.message}`)
      }
    }
    this._installProxy(bot)
    const onSpawn = entity => this._onSpawn(bot, entity)
    const onMoved = entity => this._onMoved(bot, entity)
    const onUpdate = entity => this._onMoved(bot, entity) // 元数据更新也跑一遍：近身的顺手放回来
    const onGone = entity => this._onGone(entity)
    bot.on('entitySpawn', onSpawn)
    bot.on('entityMoved', onMoved)
    bot.on('entityUpdate', onUpdate)
    bot.on('entityGone', onGone)
    if (this._sweepTimer) clearInterval(this._sweepTimer)
    this._sweepTimer = setInterval(() => this._sweep(bot), this.sweepMs)
    return () => {
      bot.removeListener('entitySpawn', onSpawn)
      bot.removeListener('entityMoved', onMoved)
      bot.removeListener('entityUpdate', onUpdate)
      bot.removeListener('entityGone', onGone)
      if (this._sweepTimer) { clearInterval(this._sweepTimer); this._sweepTimer = null }
      this._hidden.clear()
      this._unknownSince.clear()
    }
  }

  _isSelf (bot, entity) {
    return !!(bot.entity && entity && entity.id === bot.entity.id)
  }

  // 只按类型判断该不该隐藏（不看远近、不看隐藏记忆）
  _shouldHideByType (entity) {
    const type = String(entity.type || '').toLowerCase()
    const name = String(entity.name || '').toLowerCase()
    if (!type && !name) return false // 类型未知：不在这里判断（避免误伤），由 id 记忆和清扫兜底
    return !(this.keepTypes.has(type) || this.keepTypes.has(name))
  }

  // 是否在“近身保留”范围里（!攻击 要用近身实体，所以这个范围内的不过滤）
  _isNear (bot, entity) {
    if (!this.keepNearRadius) return false
    const me = bot && bot.entity && bot.entity.position
    const p = entity && entity.position
    if (!me || !p) return false
    const dx = p.x - me.x
    const dy = p.y - me.y
    const dz = p.z - me.z
    const r = this.keepNearRadius
    return dx * dx + dy * dy + dz * dz <= r * r
  }

  // 类型已知、且不在保留清单里 → 该隐藏（近身的除外）
  _shouldHide (bot, entity) {
    if (!this.enabled || !entity || typeof entity !== 'object') return false
    if (this._isSelf(bot, entity)) return false
    if (!this._shouldHideByType(entity)) return false
    if (this._isNear(bot, entity)) return false // 近身实体一律保留：!攻击 要靠它
    return true
  }

  // 该丢弃吗：类型可判定为隐藏，或者这个 id 之前已被判定隐藏（空壳重建）
  _shouldDrop (bot, entity) {
    if (!entity || typeof entity !== 'object') return false
    if (this._shouldHide(bot, entity)) return true
    if (this._isNear(bot, entity)) return false // 近身：忽略“隐藏记忆”，放回来
    return this._isHidden(entity.id)
  }

  // 把近身实体放回真实存储（绕开写入过滤），并清掉它的“隐藏记忆”
  _admit (bot, entity) {
    const raw = this._backing
    if (!raw || !entity || entity.id == null) return false
    if (raw[entity.id] === entity) return false // 已经在内存里
    if (this._nearCount() >= this.keepNearMax) { this.nearSkipped++; return false }
    this._hidden.delete(String(entity.id))
    this._unknownSince.delete(String(entity.id))
    raw[entity.id] = entity // 直接写真实存储：代理的 get/set 都会因为“近身”而放行
    this.admitted++
    return true
  }

  // 当前内存里有多少个“近身”实体（只在 admit 时调用，频率很低）
  _nearCount () {
    const raw = this._backing
    if (!raw) return 0
    let n = 0
    for (const k of Object.keys(raw)) {
      if (this._isNear(this.ctx.bot, raw[k])) n++
    }
    return n
  }

  // 实体移动/状态更新：近身的放回内存（可能是之前被过滤掉、现在走过来的怪），走远的再清掉
  _onMoved (bot, entity) {
    if (!this.enabled || !entity || typeof entity !== 'object') return
    if (this._isSelf(bot, entity)) return
    if (this._isNear(bot, entity)) { this._admit(bot, entity); return }
    const raw = this._backing
    if (raw && entity.id != null && raw[entity.id] === entity && this._shouldHideByType(entity)) {
      this._noteHidden(entity.id)
      delete raw[entity.id]
      this.filtered++
      this._maybeLog()
    }
  }

  // 实体被服务器销毁：清掉它的隐藏记忆（下次同 id 重生不会被误拦）
  _onGone (entity) {
    if (!entity || entity.id == null) return
    this._hidden.delete(String(entity.id))
    this._unknownSince.delete(String(entity.id))
  }

  // 隐藏 id 统一按字符串记（Object.keys 出来的就是字符串，避免 number/string 对不上）
  _noteHidden (id) {
    if (id != null) this._hidden.set(String(id), Date.now())
  }

  _isHidden (id) {
    return id != null && this._hidden.has(String(id))
  }

  // 把 bot.entities 换成拦截版（mineflayer 重连会重新赋值，用 setter 兜住）
  _installProxy (bot) {
    if (this._proxiedBot === bot) return
    this._proxiedBot = bot
    let backing = bot.entities || {}
    this._backing = backing // 清扫要直接看真实存储：代理的 ownKeys 会把待隐藏的过滤掉，看不到就清不掉
    const self = this
    // 要拦的值才返回 true：关过滤时全放行；自身实体永不拦；其余按类型/记忆判断
    const wrapped = v => self.enabled && !self._isSelf(bot, v) && self._shouldDrop(bot, v)
    const wrap = () => new Proxy(backing, {
      get (t, k, r) {
        const v = Reflect.get(t, k, r)
        return wrapped(v) ? undefined : v
      },
      set (t, k, v) {
        if (wrapped(v)) {
          if (v && typeof v === 'object' && v.id != null && self._shouldHide(bot, v)) self._noteHidden(v.id)
          self.filtered++
          self._maybeLog()
          return true // 直接丢弃，不存
        }
        return Reflect.set(t, k, v)
      },
      has (t, k) { return wrapped(Reflect.get(t, k)) ? false : Reflect.has(t, k) },
      ownKeys (t) { return Reflect.ownKeys(t).filter(k => !wrapped(Reflect.get(t, k))) },
      getOwnPropertyDescriptor (t, k) {
        return wrapped(Reflect.get(t, k)) ? undefined : Reflect.getOwnPropertyDescriptor(t, k)
      },
    })
    let proxy = wrap()
    Object.defineProperty(bot, 'entities', {
      configurable: true,
      enumerable: true,
      get: () => proxy,
      set: v => { backing = v || {}; this._backing = backing; proxy = wrap() },
    })
  }

  _onSpawn (bot, entity) {
    if (!entity) return
    if (this._isSelf(bot, entity)) { this.kept++; return }
    if (this._shouldHide(bot, entity) || this._isHidden(entity.id)) {
      this._noteHidden(entity.id)
      delete bot.entities[entity.id]
      this.filtered++
    } else {
      this.kept++
    }
    this._maybeLog()
  }

  // 定时清扫（只看真实存储）：清掉已判定隐藏的实体 + 类型一直没解析出来的空壳 + 过期记忆
  _sweep (bot) {
    if (!this.enabled || !bot) return
    const raw = this._backing || bot.entities
    if (!raw) return
    const now = Date.now()
    let removed = 0
    // 近身实体的数量上限（默认 40）：超了就按距离从远到近丢掉多余的（正常场景不会触发）
    if (this.keepNearRadius && this.keepNearMax) {
      const me = bot.entity && bot.entity.position
      if (me) {
        const near = []
        for (const id of Object.keys(raw)) {
          const e = raw[id]
          if (this._isSelf(bot, e)) continue
          if (!this._shouldHideByType(e) || !this._isNear(bot, e)) continue
          const p = e.position
          const dx = p.x - me.x, dy = p.y - me.y, dz = p.z - me.z
          near.push({ id, e, d: dx * dx + dy * dy + dz * dz })
        }
        if (near.length > this.keepNearMax) {
          near.sort((a, b) => b.d - a.d) // 远的先丢
          for (const item of near.slice(0, near.length - this.keepNearMax)) {
            this._noteHidden(item.id)
            delete raw[item.id]
            this.nearSkipped++
            removed++
          }
        }
      }
    }
    for (const id of Object.keys(raw)) {
      const e = raw[id]
      if (this._isSelf(bot, e)) continue
      if (this._shouldDrop(bot, e)) {
        // 记住它：mineflayer 的 fetchEntity 会用同一个 id 重建空壳，不记住的话下一个包又钻回来
        if (this._shouldHide(bot, e)) this._noteHidden(id)
        delete raw[id]
        this._unknownSince.delete(id)
        removed++
        continue
      }
      const unresolved = e && !e.type && !e.name
      if (unresolved) {
        const since = this._unknownSince.get(id)
        if (since == null) this._unknownSince.set(id, now)
        else if (now - since > this.unknownTtlMs) { delete raw[id]; this._unknownSince.delete(id); removed++ }
      } else {
        this._unknownSince.delete(id)
      }
    }
    for (const [id, ts] of this._hidden) if (now - ts > this.hiddenTtlMs) this._hidden.delete(id)
    if (removed) { this.filtered += removed; this._maybeLog() }
  }

  _maybeLog () {
    const now = Date.now()
    if (now - this._lastLogAt < this.logEveryMs) return
    const delta = this.filtered - this._lastFiltered
    this._lastLogAt = now
    this._lastFiltered = this.filtered
    if (!delta) return // 这个窗口没有新的拦截就不刷日志
    const bot = this.ctx.bot
    const alive = bot ? Object.keys(bot.entities || {}).length : 0
    const near = this.keepNearRadius ? `，近身 ${this.keepNearRadius} 格内保留` : ''
    if (this.ctx.logger) this.ctx.logger.info(`实体过滤：本窗口拦截 ${delta} 次写入，已隐藏 ${this._hidden.size} 个实体（累计 ${this.filtered} 次），当前内存里保留 ${alive} 个实体${near}`)
  }

  setEnabled (on) {
    this.enabled = !!on
    if (!on) this._hidden.clear()
    return { ok: true, message: on ? '实体过滤已开启（非保留实体不再进入机器人内存）' : '实体过滤已关闭' }
  }

  getSnapshot () {
    return {
      enabled: this.enabled,
      viewDistance: this.viewDistance == null ? '未改' : this.viewDistance,
      keepTypes: [...this.keepTypes],
      keepNearRadius: this.keepNearRadius,
      admitted: this.admitted,
      nearSkipped: this.nearSkipped,
      filtered: this.filtered,
      kept: this.kept,
    }
  }
}

module.exports = { EntityFilter }
