// ============================================================
// WarpQueue：传送队列（传送防刷屏）
// 覆盖指令：tpa、tpahere、home、sethome、delhome（其他 warp/spawn 可通用传入）
// 规则：同一时刻只允许一个在途；两次传送最少间隔 cooldownMs；
//   即时传送(home 等)等待位置变化或确认文本，超时失败可重试一次；
//   请求类(tpa/tpahere)只等待“请求已发送”确认，不等待对方接受；
//   纯命令(delhome)发出即完成。
// 注意：传送命令也必须经 ChatQueue 发送，不直接 bot.chat。
// ============================================================
'use strict'
const { sleep } = require('../utils/helpers')

// 请求已发送的确认关键词
const REQUEST_CONFIRM = ['请求', 'request', '已发送', 'sent', '等待对方', 'pending', 'accept']
// 即时传送确认关键词
const WARP_CONFIRM = ['传送', 'teleport', '已传', 'welcome to', 'arrived at', '已到达']

class WarpQueue {
  /**
   * @param {object} botContext BotContext（含 services.chatQueue）
   * @param {object} options   { cooldownMs, moveThreshold, instantTimeoutMs, requestTimeoutMs }
   */
  constructor (botContext, options = {}) {
    this.ctx = botContext
    this.cooldownMs = options.cooldownMs || 3000
    this.moveThreshold = options.moveThreshold || 3
    this.instantTimeoutMs = options.instantTimeoutMs || 15000
    this.requestTimeoutMs = options.requestTimeoutMs || 5000
    this.queue = []
    this._busy = false
    this.running = true
    this._currentWait = null // { patterns, hit }
    this.count = 0
  }

  // BotContext 把每条服务器/聊天文本喂给这里，用于确认匹配
  feedMessage (text) {
    if (!this._currentWait) return
    const lower = String(text || '').toLowerCase()
    if (this._currentWait.patterns.some(p => lower.includes(p))) this._currentWait.hit = true
  }

  /**
   * 通用执行（排队）
   * @param {object} spec { command, kind:'instant'|'request'|'plain', confirm?:[], timeoutMs?, retryOnce? }
   */
  execute (spec) {
    if (!this.running) return Promise.reject(new Error('WarpQueue 已停止'))
    return new Promise((resolve, reject) => {
      this.queue.push({ spec, resolve, reject })
      this._pump()
    })
  }

  // ---- 便捷封装 ----
  // 家名统一默认 1，且不带参数时也要把 1 带进命令（home 1 / sethome 1 / delhome 1）——
  // 裸 /home、/delhome 在部分服务器上会返回家列表或直接失败
  home (name) {
    return this.execute({ command: `home ${name || '1'}`, kind: 'instant' })
  }
  delhome (name) {
    return this.execute({ command: `delhome ${name || '1'}`, kind: 'plain' })
  }
  sethome (name) {
    return this.execute({ command: `sethome ${name || '1'}`, kind: 'plain' })
  }
  tpa (player) {
    return this.execute({ command: `tpa ${player}`, kind: 'request' })
  }
  tpahere (player) {
    return this.execute({ command: `tpahere ${player}`, kind: 'request' })
  }
  // 其他即时传送（spawn/warp/rtp）
  instant (command) {
    return this.execute({ command, kind: 'instant' })
  }

  async _pump () {
    if (this._busy || !this.running || !this.queue.length) return
    const { spec, resolve, reject } = this.queue.shift()
    this._busy = true
    try {
      const result = await this._handle(spec)
      this.count++
      resolve(result)
    } catch (e) {
      // 失败重试一次
      if (spec.retryOnce !== false) {
        try {
          await sleep(this.cooldownMs)
          const result = await this._handle(spec)
          this.count++
          resolve(result)
        } catch (e2) { reject(e2) }
      } else reject(e)
    } finally {
      await sleep(this.cooldownMs)
      this._busy = false
      this._pump()
    }
  }

  async _handle (spec) {
    const chatQueue = this.ctx.services.chatQueue
    // 1. 经聊天队列发命令
    await chatQueue.sendCommand(spec.command, { priority: 3 })

    // 2. 纯命令：发出即完成
    if (spec.kind === 'plain') return { sent: spec.command, status: 'done' }

    // 3. 请求类：等待“请求已发送”确认（超时不算失败，请求多半已发出）
    if (spec.kind === 'request') {
      const confirmed = await this._waitConfirm(REQUEST_CONFIRM, this.requestTimeoutMs)
      return { sent: spec.command, status: confirmed ? 'request-sent' : 'request-timeout' }
    }

    // 4. 即时传送：等待位移或确认文本
    const timeoutMs = spec.timeoutMs || this.instantTimeoutMs
    const patterns = spec.confirm ? spec.confirm.concat(WARP_CONFIRM) : WARP_CONFIRM
    await Promise.race([
      this._waitMove(timeoutMs),
      this._waitConfirm(patterns, timeoutMs, true),
    ])
    return { sent: spec.command, status: 'teleported' }
  }

  // 等待水平位移达到阈值
  _waitMove (timeoutMs) {
    const bot = this.ctx.bot
    const start = bot.entity.position.clone()
    return new Promise((resolve, reject) => {
      const iv = setInterval(() => {
        const p = this.ctx.bot && this.ctx.bot.entity.position
        if (!p) return
        const dx = p.x - start.x
        const dz = p.z - start.z
        if (Math.sqrt(dx * dx + dz * dz) >= this.moveThreshold) {
          clearInterval(iv); clearTimeout(timer); resolve()
        }
      }, 400)
      const timer = setTimeout(() => { clearInterval(iv); reject(new Error('未检测到传送位移')) }, timeoutMs)
    })
  }

  // 等待确认文本；throwOnTimeout=true 时超时 reject
  _waitConfirm (patterns, timeoutMs, throwOnTimeout = false) {
    return new Promise((resolve, reject) => {
      this._currentWait = { patterns, hit: false }
      const timer = setTimeout(() => {
        this._currentWait = null
        if (throwOnTimeout) reject(new Error('未收到传送确认'))
        else resolve(false)
      }, timeoutMs)
      // 轮询命中（feedMessage 更新 hit）
      const iv = setInterval(() => {
        if (this._currentWait && this._currentWait.hit) {
          clearInterval(iv); clearTimeout(timer); this._currentWait = null; resolve(true)
        }
      }, 200)
    })
  }

  getSnapshot () {
    return { busy: this._busy, pending: this.queue.length, completed: this.count }
  }

  stop () {
    this.running = false
    for (const t of this.queue.splice(0)) t.reject(new Error('WarpQueue 停止'))
  }
}

module.exports = { WarpQueue }
