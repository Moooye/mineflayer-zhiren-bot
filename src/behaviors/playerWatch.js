// ============================================================
// playerWatch：盯人 —— 收到 !检测 <玩家1> <玩家2> 后，等「玩家1」离开服务器，
//              自动对「玩家2」执行 /tpa
//   · 注册：watch(name, target)   两个参数都必填（玩家1=被盯的人，玩家2=tpa 目标）
//   · 触发信号①：mineflayer 的 playerLeft 事件（玩家列表里消失，最可靠，与服务器文案无关）
//   · 触发信号②：公屏/系统里的「X 离开了游戏 / X 下线了」文案（兜底，兼容各服务器插件文案）
//   · 触发动作：WarpQueue.tpa(玩家2)（走项目现成的传送队列，受排队/限流约束，不直接 bot.chat）；
//              也可 !检测 关 [玩家1] 手动取消
//   · 一次性：触发成功后自动解除，要再盯得重新发 !检测（不会重复 tpa）
//   · 以最新为准：同一时间只按最新发的那条检测算，重复输入 !检测 会顶掉之前的检测
//   · 跨机器人去重：同一个人下线，只让第一个发现的机器人执行（其余只记日志），
//     避免三个机器人一起 /tpa
// ============================================================
'use strict'

const { warpStatusCn } = require('../utils/helpers')

// 进程级：玩家名(小写) -> { at, bot }。同一玩家在 cooldownMs 内只允许触发一次
const recentTriggers = new Map()

// 「有人离开了」的文案特征（去掉装饰后匹配）
const LEAVE_PATTERNS = [
  /离开了游戏/, /离开了服务器/, /退出了游戏/, /退出了服务器/, /下线了/,
  /left the game/i, /left the server/i, /logged out/i,
]

// 去掉颜色码与 [称号]/[插件名] 一类方括号标签
function stripDecor (text) {
  return text
    .replace(/\u00a7[0-9a-fk-or]/gi, '')
    .replace(/\[[^\]]{0,24}\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

class PlayerWatch {
  /**
   * @param {object} botContext BotContext
   * @param {object} options { enabled:true, cooldownMs:10000 }
   */
  constructor (botContext, options = {}) {
    this.ctx = botContext
    this.enabled = options.enabled !== false
    this.cooldownMs = options.cooldownMs || 10000
    this.watches = new Map() // 玩家1名(小写) -> { name, target, at }
  }

  _norm (name) { return String(name || '').trim().toLowerCase() }
  _botName () { return (this.ctx.bot && this.ctx.bot.username) || this.ctx.account.username }

  // 注册盯人：!检测 <玩家1> <玩家2>
  // 语义（用户确认）：两个参数都必填；同一时间只按**最新**这条检测算；
  //                  重复输入会顶掉之前的检测；触发一次后自动解除
  watch (name, target) {
    const disp = String(name || '').trim()
    const tgt = String(target || '').trim()
    if (!disp) return { ok: false, message: '用法：!检测 <玩家1> <玩家2>（玩家1 离开服务器后，自动 tpa 玩家2）' }
    if (!tgt) {
      return { ok: false, message: `用法：!检测 <玩家1> <玩家2>——还缺「玩家2」（要 tpa 的目标）。例如：!检测 ${disp} 玩家B` }
    }
    if (this._norm(disp) === this._norm(tgt)) {
      return { ok: false, message: '玩家1 和玩家2 不能是同一个名字（玩家1 是等待下线的人，玩家2 是 tpa 的目标）' }
    }
    const key = this._norm(disp)
    const existed = this.watches.has(key)
    // 以最新的检测为准：清掉其它（含同名玩家的旧目标），只留这一条
    const dropped = [...this.watches.values()].filter(w => this._norm(w.name) !== key).map(w => w.name)
    this.watches.clear()
    this.watches.set(key, { name: disp, target: tgt, at: Date.now() })
    this.ctx.logger.info(`${existed ? '盯人检测已更新' : '盯人检测已登记'}：${disp} 离开服务器后自动 /tpa ${tgt}（同一时间只按最新这条算）`)
    if (dropped.length) this.ctx.logger.info('已清除之前的检测：' + dropped.join('、'))
    const tip = dropped.length ? `；已清除之前的检测（${dropped.join('、')}）` : ''
    return {
      ok: true,
      message: `${existed ? '已按最新的检测为准' : '开始检测'}：${disp} 一离开服务器就自动 /tpa ${tgt}（触发一次后自动解除，要再盯请重新发命令）${tip}`,
    }
  }

  // 取消一个
  unwatch (name) {
    const key = this._norm(name)
    const w = this.watches.get(key)
    if (!w) return { ok: false, message: '没有在检测：' + name }
    this.watches.delete(key)
    this.ctx.logger.info(`已取消盯人检测：${w.name}`)
    return { ok: true, message: `已取消检测：${w.name}` }
  }

  // 取消全部，返回取消的个数
  clear () {
    const n = this.watches.size
    if (n) this.ctx.logger.info(`已取消全部盯人检测（${n} 个）`)
    this.watches.clear()
    return n
  }

  // 当前在检测谁
  list () {
    return [...this.watches.values()].map(w => ({ name: w.name, target: w.target, at: w.at }))
  }

  // bot.on('playerLeft') 走这里
  onPlayerLeft (name) {
    return this._trigger(name, '玩家列表')
  }

  // 公屏/系统文案兜底：X 离开了游戏
  feed (text) {
    if (!this.enabled || !this.watches.size) return false
    const raw = String(text || '').trim()
    if (!raw) return false
    const plain = stripDecor(raw)
    if (!LEAVE_PATTERNS.some(re => re.test(plain))) return false
    // 取「离开/退出/下线」前面那个词作为玩家名
    const m = plain.match(/(\S{1,20}?)\s*(?:离开|退出|下线|left|logged)/i)
    if (!m) return false
    const token = m[1]
    const candidates = [token]
    const ascii = token.match(/[A-Za-z0-9_]{1,16}/)
    if (ascii && ascii[0] !== token) candidates.push(ascii[0])
    for (const c of candidates) {
      if (this.watches.has(this._norm(c))) return this._trigger(c, '聊天文案')
    }
    return false
  }

  // 命中判定 + 跨机器人去重 + 触发
  _trigger (name, source) {
    if (!this.enabled) return false
    const key = this._norm(name)
    const w = this.watches.get(key)
    if (!w) return false

    const now = Date.now()
    const last = recentTriggers.get(key)
    if (last && now - last.at < this.cooldownMs) {
      // 同一玩家刚被别的机器人处理过：不重复 /tpa
      this.ctx.logger.info(`检测：${w.name} 的离开已由 ${last.bot} 处理，本机器人跳过`)
      this.watches.delete(key)
      return false
    }
    recentTriggers.set(key, { at: now, bot: this._botName() })
    if (recentTriggers.size > 200) recentTriggers.clear()

    this.watches.delete(key) // 一次性
    this._fire(w, source)
    return true
  }

  async _fire (w, source) {
    const tgt = w.target
    this.ctx.logger.info(`检测到 ${w.name} 离开服务器（${source}），自动执行 /tpa ${tgt}`)
    if (this.ctx.chatMonitor) this.ctx.chatMonitor.feed('system', '', `[检测] ${w.name} 离开服务器 → /tpa ${tgt}`)
    try {
      const r = await this.ctx.services.warpQueue.tpa(tgt)
      this.ctx.logger.info(`/tpa ${tgt} 请求已处理：${warpStatusCn(r && r.status)}`)
      if (this.ctx.chatMonitor) this.ctx.chatMonitor.feed('system', '', `[检测] /tpa ${tgt}：${warpStatusCn(r && r.status)}`)
      return r
    } catch (e) {
      this.ctx.logger.warn(`自动 /tpa ${tgt} 失败：${e && e.message}`)
      return null
    }
  }

  getSnapshot () {
    return { enabled: this.enabled, watches: this.list() }
  }
}

module.exports = { PlayerWatch }
