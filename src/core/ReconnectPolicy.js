// ============================================================
// ReconnectPolicy：断线重连策略
// 职责：指数退避（2s→4s→8s…封顶 5 分钟）+ ±20% 抖动；
//      连续失败 10 次进入 30 分钟长冷却；识别踢出原因区别对待：
//        封禁/白名单 → 放弃重连并告警；维护/重启 → 长冷却；网络错误 → 正常退避
// ============================================================
'use strict'

// 原因分类关键词（小写匹配）
const GIVEUP_KEYWORDS = [
  'banned', 'ban ', 'is banned', '封禁', '封号', '已封',
  'not whitelisted', 'whitelist', '白名单', 'blacklist', '黑名单',
  'kicked by moderator',
]
const MAINTENANCE_KEYWORDS = [
  'maintenance', 'restarting', 'restart', '维护', '重启', '停机', 'down for',
]

class ReconnectPolicy {
  constructor (options = {}) {
    this.baseDelayMs = options.baseDelayMs || 2000
    this.maxDelayMs = options.maxDelayMs || 300000
    this.jitter = options.jitter == null ? 0.2 : options.jitter
    this.maxAttempts = options.maxAttempts || 10
    this.longCooldownMs = options.longCooldownMs || 1800000
    this.maintenanceDelayMs = options.maintenanceDelayMs || 300000

    this.attempts = 0
    this.giveUp = false
    this.lastReason = ''
    this.lastDelayMs = 0
  }

  // 分类原因：giveup | maintenance | normal
  classify (reason) {
    const text = String(reason || '').toLowerCase()
    if (!text) return 'normal'
    if (GIVEUP_KEYWORDS.some(k => text.includes(k))) return 'giveup'
    if (MAINTENANCE_KEYWORDS.some(k => text.includes(k))) return 'maintenance'
    return 'normal'
  }

  /**
   * 登记一次失败，返回下一步动作
   * @returns {{action:'reconnect'|'giveUp', delayMs:number, attempt:number, kind:string}}
   */
  registerFailure (reason) {
    this.lastReason = String(reason || '')
    const kind = this.classify(reason)

    if (kind === 'giveup') {
      this.giveUp = true
      this.lastDelayMs = 0
      return { action: 'giveUp', delayMs: 0, attempt: this.attempts, kind }
    }

    this.attempts += 1

    // 维护中：固定长冷却（不增加退避层级太多）
    if (kind === 'maintenance') {
      this.lastDelayMs = this._withJitter(this.maintenanceDelayMs)
      return { action: 'reconnect', delayMs: this.lastDelayMs, attempt: this.attempts, kind }
    }

    // 连续失败超限：30 分钟长冷却，之后继续（不放弃）
    if (this.attempts > this.maxAttempts) {
      this.lastDelayMs = this.longCooldownMs
      // 长冷却后把计数压回，避免一直停在超限
      this.attempts = Math.floor(this.maxAttempts / 2)
      return { action: 'reconnect', delayMs: this.lastDelayMs, attempt: this.attempts, kind: 'longCooldown' }
    }

    // 指数退避
    const expo = this.baseDelayMs * Math.pow(2, this.attempts - 1)
    this.lastDelayMs = this._withJitter(Math.min(expo, this.maxDelayMs))
    return { action: 'reconnect', delayMs: this.lastDelayMs, attempt: this.attempts, kind }
  }

  _withJitter (ms) {
    const j = ms * this.jitter
    return Math.round(ms + (Math.random() * 2 - 1) * j)
  }

  // 重连/上线成功：计数清零
  onSuccess () {
    this.attempts = 0
    this.giveUp = false
  }

  // 手动重置（用户主动重连时）
  reset () {
    this.attempts = 0
    this.giveUp = false
    this.lastReason = ''
    this.lastDelayMs = 0
  }

  getSnapshot () {
    return {
      attempts: this.attempts,
      giveUp: this.giveUp,
      lastReason: this.lastReason,
      lastDelayMs: this.lastDelayMs,
    }
  }
}

module.exports = { ReconnectPolicy }
