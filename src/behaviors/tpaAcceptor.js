// ============================================================
// tpaAcceptor：可自动接受名单（owners / 传送白名单管理员 tpAdmins / 白名单组 friends / 传送白名单成员 tpPlayers）
//   对机器人发起 tpa / tpahere 时自动接受
// 识别依据（录自 mc.example.com 的实际插件文本）：
//   [TSL] 管理员玩家 请求传送到你的位置。(60 秒内有效) [接受] [拒绝]
// 规则：黑名单与其他玩家一律忽略（写日志）；
//   识别不了的请求文案也写一条日志，便于按服务器实际文案继续适配。
// 接受命令经 ChatQueue 发出（受限流约束），不直接 bot.chat。
// ============================================================
'use strict'

// “有人在传送我”的文本特征。
// 注意：不能与机器人自己发出的「已向 X 发送传送请求，等待对方回应。 [取消]」混淆，
// 该文案不匹配下面任何一条。
const REQUEST_PATTERNS = [
  /请求传送到你的位置/, // 对方 tpa 我（[TSL] 插件实际文案）
  /请求你传送到/, // 对方 tpahere 我
  /请求将你传送到/,
  /想要传送到你/,
]

// 去掉颜色码与 [称号]/[插件名] 一类方括号标签，只留下可匹配的纯文本
function stripDecor (text) {
  return text
    .replace(/\u00a7[0-9a-fk-or]/gi, '')
    .replace(/\[[^\]]{0,24}\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

class TpaAcceptor {
  /**
   * @param {object} botContext BotContext
   * @param {object} options   { enabled:true, command:'tpaccept', cooldownMs:5000 }
   */
  constructor (botContext, options = {}) {
    this.ctx = botContext
    this.enabled = options.enabled !== false
    this.command = options.command || 'tpaccept'
    this.cooldownMs = options.cooldownMs || 5000
    this._acceptedAt = new Map() // 玩家名(小写) -> 上次自动接受时间
    this._lastPlain = ''
    this._lastPlainAt = 0
  }

  // 每条聊天 / 系统文本都会喂进来（BotContext 的 chat / whisper / messagestr）
  feed (text) {
    if (!this.enabled) return
    const raw = String(text || '').trim()
    if (!raw) return

    const now = Date.now()
    const plain = stripDecor(raw)
    // 同一条消息会同时触发 chat 与 messagestr 两个事件（两事件的原始文本装饰不同），
    // 按“去掉装饰后的文本”去重，避免重复接受与重复日志
    if (plain === this._lastPlain && now - this._lastPlainAt < 3000) return
    this._lastPlain = plain
    this._lastPlainAt = now

    if (!REQUEST_PATTERNS.some(re => re.test(plain))) {
      // 带“接受”按钮、却不是已知文案：留一条日志，便于按服务器实际文案适配
      // 注意用原文判断（[接受] 的方括号会被 stripDecor 去掉）
      if (/\[接受\]/.test(raw)) this.ctx.logger.warn(`疑似传送请求但文案未识别，未自动接受：${plain}`)
      return
    }

    const name = this._parseName(plain)
    if (!name) {
      this.ctx.logger.warn(`收到传送请求但没认出请求者，未自动接受：${plain}`)
      return
    }

    // 谁能自动接受：owners / 传送白名单管理员 / 白名单组 / 传送白名单成员；黑名单与其他人一律忽略
    const wl = this.ctx.services.whitelist
    if (!wl.canAcceptTpa(name)) {
      this.ctx.logger.warn(`忽略 ${name} 的传送请求（不在可自动接受名单里：${wl.getRole(name)}${wl.isTpPlayer(name) ? '/传送白名单' : ''}）`)
      return
    }

    const key = name.toLowerCase()
    const ts = this._acceptedAt.get(key)
    if (ts != null && now - ts < this.cooldownMs) return // 冷却内不重复接受
    this._acceptedAt.set(key, now)

    this.ctx.services.chatQueue.sendCommand(this.command, { priority: 3 })
    this.ctx.logger.info(`已自动接受 ${name} 的传送请求（/${this.command}）`)
    if (this.ctx.chatMonitor) {
      this.ctx.chatMonitor.feed('system', '', `已自动接受 ${name} 的传送请求（/${this.command}）`)
    }
  }

  // 取「请求/想要」前面的那个词作为请求者名字。
  // 名字可能带称号装饰，整词不在白名单时退化到其中的英文名片段。
  _parseName (plain) {
    const m = plain.match(/(\S{1,20}?)\s*(?:请求|想要)/)
    if (!m) return null
    const token = m[1]
    const candidates = [token]
    const ascii = token.match(/[A-Za-z0-9_]{1,16}/)
    if (ascii && ascii[0] !== token) candidates.push(ascii[0])
    for (const c of candidates) {
      const wl = this.ctx.services.whitelist
      if (wl.canAcceptTpa(c)) return c
    }
    return candidates[candidates.length - 1] // 都不在白名单：返回最可能的那个，交给调用方记日志
  }
}

module.exports = { TpaAcceptor }
