// ============================================================
// ChatMonitor：服务器公屏消息缓冲（供 Web 面板实时显示）
//  - 汇总各 bot 收到的公聊(chat)与系统广播(system，含加入/退出)
//  - 多个 bot 收到同一条公屏：按内容短时间去重，只保留一条
//  - 环形缓冲，默认保留最近 200 条；支持按 id 增量拉取
// 注：私聊(whisper)不在公屏显示
// ============================================================
'use strict'

let mid = 0

class ChatMonitor {
  constructor (options = {}) {
    this.max = options.max || 200
    this.dedupeMs = options.dedupeMs || 1500
    this.items = []
    this._recent = new Map()
  }

  // 时间 HH:mm:ss（固定北京时间，不受机器时区影响）
  _clock () {
    return new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  }

  /**
   * 喂入一条消息
   * @param {string} type 'chat' 公聊 | 'system' 系统广播 | 'cmd-in' 玩家指令（私聊/公屏） | 'cmd-out' 机器人回复
   * @param {string} username 发言玩家 / 机器人名
   * @param {string} message 文本
   * @param {object} [meta] 可选附加信息：{ to:'对方名' }（私聊/回复的对方）、{ pub:true }（公屏指令，
   *                        不带 to，这样多个机器人收到同一条时能按内容去重）
   * @returns {boolean} 是否被采纳（重复则 false）
   */
  feed (type, username, message, meta) {
    const text = String(message == null ? '' : message)
    if (!text) return false
    const to = meta && meta.to ? String(meta.to) : ''
    // 去重键含对方，避免同内容发给不同人时被误去重
    const key = `${type}|${username || ''}|${to}|${text}`
    const now = Date.now()
    const last = this._recent.get(key)
    if (last && now - last < this.dedupeMs) return false
    this._recent.set(key, now)
    if (this._recent.size > 500) this._recent.clear()

    const item = { id: ++mid, clock: this._clock(), type, username: username || '', message: text }
    if (to) item.to = to
    if (meta && meta.pub) item.pub = true // 公屏指令标记（面板里显示“公屏”而不是“私聊”）
    this.items.push(item)
    if (this.items.length > this.max) this.items.shift()
    return true
  }

  // 增量：返回 id > sinceId 的消息
  getSince (sinceId) {
    const id = Number(sinceId) || 0
    return this.items.filter(x => x.id > id)
  }
}

module.exports = { ChatMonitor }
