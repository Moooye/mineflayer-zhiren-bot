// ============================================================
// ChatQueue：聊天/指令队列（防刷屏核心）
// 全项目唯一出口：任何模块不得直接 bot.chat()，统一走这里
// 特性：令牌桶限流（默认 1.5s/条）、相同内容冷却去重、超长切分、
//      优先级（主人响应 > 系统命令 > 闲聊）、队列上限溢出丢弃
// ============================================================
'use strict'
const { sleep, chunkString } = require('../utils/helpers')

// 净化聊天/命令文本：Vanilla 仅接受 >= 0x20 的可打印字符，且禁止 §(U+00A7)
// 与 DEL(U+007F)，否则服务器以 “Illegal characters in chat” 踢人。
// 控制字符（换行/回车/制表等）替换为空格，§/DEL 直接移除。
function sanitizeChat (text) {
  return String(text == null ? '' : text)
    .replace(/[§\u007F]/g, '')         // 移除 § 与 DEL
    .replace(/[\u0000-\u001F]/g, ' ') // 控制字符（换行等）→ 空格
    .replace(/\s+/g, ' ')
    .trim()
}

let seq = 0

class ChatQueue {
  /**
   * @param {object} botContext BotContext（用于取 bot 与在线状态）
   * @param {object} options    { minIntervalMs, dedupeMs, maxQueue }
   */
  constructor (botContext, options = {}) {
    this.ctx = botContext
    this.minIntervalMs = options.minIntervalMs || 1500
    this.dedupeMs = options.dedupeMs || 3000
    this.maxQueue = options.maxQueue || 50
    this.queue = []
    this.recent = new Map() // dedupeKey -> ts
    this.running = true
    this.sentCount = 0
    this.droppedCount = 0
    this._loopPromise = this._loop()
  }

  get bot () { return this.ctx.bot }
  get online () { return this.ctx.status === 'online' }

  /**
   * 发送一条聊天（超长自动切分）
   * @param {string} text
   * @param {object} opts { priority=9, dedupe=true }
   * @returns {Promise<boolean>} 是否真正发出（被去重/丢弃则 false）
   */
  send (text, opts = {}) {
    if (!this.running) return Promise.resolve(false)
    const safe = sanitizeChat(text)
    if (!safe) return Promise.resolve(false) // 净化后为空，不发送
    const priority = opts.priority == null ? 9 : opts.priority
    const useDedupe = opts.dedupe !== false
    const parts = chunkString(safe, 240)

    // 切分多段用一个聚合 Promise
    let resolveAll
    const all = new Promise(r => { resolveAll = r })
    let pending = parts.length
    const results = []

    parts.forEach(part => {
      const item = {
        id: ++seq,
        text: part,
        priority,
        dedupeKey: useDedupe ? part : null,
        _resolve: sent => { results.push(sent); if (--pending === 0) resolveAll(results.every(Boolean)) },
      }
      this._enqueueItem(item, priority)
    })
    return all
  }

  // 发送命令（默认高优先级，不去重——命令通常必须执行；相同命令仍可按需去重）
  sendCommand (cmd, opts = {}) {
    const text = cmd.startsWith('/') ? cmd : '/' + cmd
    return this.send(text, Object.assign({ priority: 5, dedupe: false }, opts))
  }

  _enqueueItem (item, priority) {
    // 入队前去重（短时间完全相同内容直接不排队）
    if (item.dedupeKey && this._isDuplicate(item.dedupeKey)) {
      this.droppedCount++
      item._resolve(false)
      return
    }
    if (this.queue.length >= this.maxQueue) {
      // 溢出：若新项优先级高于队尾（数字更小），挤掉队尾；否则丢弃新项
      const tail = this.queue[this.queue.length - 1]
      if (priority < tail.priority) {
        const removed = this.queue.pop()
        removed._resolve(false)
        this.droppedCount++
      } else {
        this.droppedCount++
        item._resolve(false)
        if (this.ctx.logger) this.ctx.logger.warn(`聊天队列已满（${this.maxQueue}），丢弃低优先级消息`)
        return
      }
    }
    this.queue.push(item)
    this.queue.sort((a, b) => a.priority - b.priority || a.id - b.id)
  }

  _isDuplicate (key) {
    const now = Date.now()
    const ts = this.recent.get(key)
    return ts != null && now - ts < this.dedupeMs
  }

  _markSent (item) {
    if (item.dedupeKey) this.recent.set(item.dedupeKey, Date.now())
    this.sentCount++
  }

  async _loop () {
    while (this.running) {
      if (!this.queue.length) { await sleep(120); continue }
      // 未上线：等待重连，不丢消息
      if (!this.online || !this.bot) { await sleep(500); continue }

      const item = this.queue.shift()
      // 出队时再次去重
      if (item.dedupeKey && this._isDuplicate(item.dedupeKey)) { item._resolve(false); continue }

      try {
        this.bot.chat(item.text)
        this._markSent(item)
        item._resolve(true)
      } catch (e) {
        if (this.ctx.logger) this.ctx.logger.error(`发送聊天失败：${e.message}`)
        // 发送失败重新放回队首稍后重试
        this.queue.unshift(item)
        await sleep(1000)
        continue
      }
      // 令牌桶：每条之间至少间隔
      await sleep(this.minIntervalMs)
    }
  }

  // 清空待发（断线彻底放弃时用）
  clear () {
    for (const q of this.queue.splice(0)) q._resolve(false)
  }

  getSnapshot () {
    return {
      pending: this.queue.length,
      sent: this.sentCount,
      dropped: this.droppedCount,
      queued: this.queue.map(q => ({ text: q.text.slice(0, 20), priority: q.priority })),
    }
  }

  stop () {
    this.running = false
    this.clear()
  }
}

module.exports = { ChatQueue }
