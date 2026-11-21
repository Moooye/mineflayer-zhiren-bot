// ============================================================
// Notifier：通用事件通知（可选，默认关闭）
// 通过通用 Webhook 推送关键事件（死亡、放弃重连、长时间故障等）
// 不绑定特定平台：同时发送 text 与 content 字段，
//   通用接收方读 text，Discord 兼容读 content。
// 未配置 webhookUrl 则完全不启用；推送失败静默，不影响挂机。
// ============================================================
'use strict'

class Notifier {
  /**
   * @param {object} options { enabled:false, webhookUrl:'', events:['death','giveUp'] }
   */
  constructor (options = {}) {
    this.enabled = options.enabled === true
    this.webhookUrl = options.webhookUrl || ''
    this.events = new Set(options.events || ['death', 'giveUp'])
    this.sentCount = 0
    this.failedCount = 0
  }

  /**
   * 发送通知
   * @param {string} event 事件名（不在启用列表则忽略）
   * @param {string} text  文本内容
   */
  async notify (event, text) {
    if (!this.enabled || !this.webhookUrl) return
    if (!this.events.has(event)) return
    const ok = await this._post({ event, text, content: text, ts: Date.now() })
    if (ok) this.sentCount++; else this.failedCount++
  }

  _post (payload) {
    return new Promise(resolve => {
      let u
      try { u = new URL(this.webhookUrl) } catch (_) { return resolve(false) }
      const lib = u.protocol === 'https:' ? require('https') : require('http')
      const data = JSON.stringify(payload)
      const req = lib.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      }, res => { res.resume(); resolve(true) })
      req.on('error', () => resolve(false))
      req.setTimeout(5000, () => { req.destroy(); resolve(false) })
      req.write(data)
      req.end()
    })
  }

  getSnapshot () {
    return { enabled: this.enabled, sent: this.sentCount, failed: this.failedCount }
  }
}

module.exports = { Notifier }
