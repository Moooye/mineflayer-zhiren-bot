// ============================================================
// BottleRunner：灾厄之瓶（ominous_bottle）定时饮用
//   !瓶子 开 <分钟>  立即喝一瓶，成功后每 <分钟> 再喝一瓶
//   !瓶子 关         停止定时
// 状态：getSnapshot() 提供 任务开关 / 距下一瓶剩余秒 / omen 类 buff 剩余秒
//
// 为什么不用 bot.consume()：
//   ominous_bottle 不在 mineflayer 的 ALWAYS_CONSUMABLES 清单，
//   生存模式且饱食满（food===20）时 bot.consume() 会误报 'Food is full'。
//   故这里直接用 activateItem()/deactivateItem() 自行完成“饮用”，
//   并以服务端 set_cooldown 包或超时判定饮用结束。
// ============================================================
'use strict'

const ITEM_NAME = 'ominous_bottle'
const DRINK_FINISH_MS = 2200 // 饮用约 1.6s，留网络/低 TPS 余量

// omen（之兆）类效果：饮用灾厄之瓶可能给予其中之一，状态里按优先级显示
const OMEN_EFFECTS = [
  { id: 34, name: 'RaidOmen', label: '袭击之兆' },
  { id: 30, name: 'BadOmen', label: '不祥之兆' },
  { id: 33, name: 'TrialOmen', label: '试炼之兆' },
]

class BottleRunner {
  constructor (botContext) {
    this.ctx = botContext
    this.enabled = false
    this.intervalMs = 0
    this.nextRunAt = 0
    this._timer = null
    this._drinking = false
    this.raid = null // 当前袭击状态（由 Boss 血条事件维护）
  }

  // 开启：立即喝一瓶；成功后按周期定时；立即饮用失败则不开启
  async start (intervalMinutes) {
    const minutes = Number(intervalMinutes)
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return { ok: false, message: '用法：!瓶子 开 <分钟>（分钟需大于 0）' }
    }
    const r = await this.drinkOnce()
    if (!r.ok) return { ok: false, message: `未饮用，任务未开启：${r.message}` }

    this.enabled = true
    this.intervalMs = minutes * 60000
    this._armTimer()
    return { ok: true, message: `已饮用灾厄之瓶，之后每 ${minutes} 分钟喝一瓶` }
  }

  stop () {
    this.enabled = false
    this.nextRunAt = 0
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
    return { ok: true, message: '灾厄之瓶定时已关闭' }
  }

  _armTimer () {
    if (this._timer) clearTimeout(this._timer)
    this.nextRunAt = Date.now() + this.intervalMs
    this._timer = setTimeout(() => { this._onTick() }, this.intervalMs)
  }

  async _onTick () {
    this._timer = null
    if (this.ctx.status === 'online' && !this._drinking) {
      const r = await this.drinkOnce()
      if (!r.ok && this.ctx.logger) this.ctx.logger.warn(`定时饮用失败：${r.message}`)
    }
    // 无论本次是否在线/成功，任务保持并继续排下一个周期
    if (this.enabled) this._armTimer()
  }

  // 喝一瓶：equip → activateItem → 等待(set_cooldown/超时) → deactivate
  async drinkOnce () {
    const bot = this.ctx.bot
    if (!bot || this.ctx.status !== 'online') return { ok: false, message: '机器人不在线' }
    if (this._drinking) return { ok: false, message: '上一瓶还在饮用' }

    const item = bot.inventory.items().find(i => i.name === ITEM_NAME)
    if (!item) return { ok: false, message: '背包没有灾厄之瓶' }

    const before = this._countBottles()
    this._drinking = true
    try {
      await bot.equip(item, 'hand')
      await this._holdToFinish(item.type)
      try { bot.deactivateItem() } catch (_) { /* 忽略 */ }
      await new Promise(r => setTimeout(r, 300))

      const after = this._countBottles()
      const buff = this.currentBuff()
      // 成功判定：瓶子数量减少，或已获得 omen 效果
      if (after >= before && !buff) return { ok: false, message: '饮用未生效（物品未消耗）' }

      if (this.ctx.logger) {
        this.ctx.logger.info(`已饮用灾厄之瓶（剩余 ${after} 瓶）${buff ? `，获得${buff.label} ${buff.seconds}秒` : ''}`)
      }
      return { ok: true, consumed: Math.max(1, before - after), buff }
    } catch (e) {
      try { bot.deactivateItem() } catch (_) { /* 忽略 */ }
      return { ok: false, message: e.message }
    } finally {
      this._drinking = false
    }
  }

  // 手持持续饮用，直到服务端 set_cooldown（该物品）或超时
  _holdToFinish (itemId) {
    const bot = this.ctx.bot
    return new Promise(resolve => {
      let settled = false
      const tm = setTimeout(finish, DRINK_FINISH_MS)
      function onCd (pkt) { if (pkt.itemID === itemId) finish() }
      function finish () {
        if (settled) return
        settled = true
        bot._client.removeListener('set_cooldown', onCd)
        clearTimeout(tm)
        resolve()
      }
      bot._client.on('set_cooldown', onCd)
      try { bot.activateItem() } catch (_) { finish() }
    })
  }

  _countBottles () {
    return this.ctx.bot.inventory.items()
      .filter(i => i.name === ITEM_NAME)
      .reduce((sum, i) => sum + i.count, 0)
  }

  // 绑定当前 bot 的 Boss 血条以识别“袭击”，返回清理函数（每次重连重新绑定）
  bindBot (bot) {
    this.raid = null
    const barTitle = bar => {
      try {
        return bar && bar.title && typeof bar.title.toString === 'function'
          ? bar.title.toString()
          : String((bar && bar.title) || '')
      } catch (_) { return '' }
    }
    // 袭击血条：服务端发送翻译键 event.minecraft.raid（客户端本地化为“袭击/Raid”）
    const isRaidBar = bar => /raid/i.test(barTitle(bar))
    const progressOf = bar => Math.max(0, Math.min(1, Number(bar.health) || 0))

    const onCreate = bar => { if (isRaidBar(bar)) this.raid = { uuid: bar.entityUUID, progress: progressOf(bar) } }
    const onUpdate = bar => { if (this.raid && bar.entityUUID === this.raid.uuid) this.raid.progress = progressOf(bar) }
    const onDelete = bar => { if (this.raid && bar && bar.entityUUID === this.raid.uuid) this.raid = null }

    bot.on('bossBarCreated', onCreate)
    bot.on('bossBarUpdated', onUpdate)
    bot.on('bossBarDeleted', onDelete)
    return () => {
      bot.removeListener('bossBarCreated', onCreate)
      bot.removeListener('bossBarUpdated', onUpdate)
      bot.removeListener('bossBarDeleted', onDelete)
      this.raid = null
    }
  }

  // 当前 omen 类 buff（按 OMEN_EFFECTS 优先级取第一个存在的）
  currentBuff () {
    const effects = (this.ctx.bot.entity && this.ctx.bot.entity.effects) || {}
    for (const e of OMEN_EFFECTS) {
      const ef = effects[e.id]
      if (ef) {
        // duration 单位为 tick（20 tick = 1 秒）
        return { id: e.id, name: e.name, label: e.label, amplifier: ef.amplifier, seconds: Math.max(0, Math.round((ef.duration || 0) / 20)) }
      }
    }
    return null
  }

  // 距下一瓶的剩余秒
  nextInSeconds () {
    if (!this.enabled || !this.nextRunAt) return null
    return Math.max(0, Math.round((this.nextRunAt - Date.now()) / 1000))
  }

  getSnapshot () {
    return {
      enabled: this.enabled,
      intervalMinutes: this.intervalMs ? this.intervalMs / 60000 : null,
      nextInSeconds: this.nextInSeconds(),
      buff: this.currentBuff(),
      raid: this.raid ? { active: true, progress: Math.round(this.raid.progress * 100) } : null,
    }
  }

  // 进程退出清理
  stopForShutdown () { this.stop() }
}

module.exports = { BottleRunner }
