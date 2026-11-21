// ============================================================
// ServerProbe：服务器在线探测（Server List Ping）
// 用途：机器人连不上时不要盲目直连——
//     · 先探一次服务器列表 ping（和游戏客户端“刷新服务器”同一条协议，能过 SRV/域名解析）
//     · 不在线 → 保持离线：只按 intervalMs 探测，不再发登录包；
//     · 探测到在线 → 立刻回调（机器人马上重连），并拿到 延迟/在线人数 写日志。
// 共享：同一个 host:port 的所有机器人共用一份探测（模块级注册表），
//       最后一个等待者注销后自动停表；没人等的时候一个探测包都不发。
// ============================================================
'use strict'
const { EventEmitter } = require('events')

const registry = new Map()

class ServerProbe extends EventEmitter {
  /**
   * @param {object} target  { host, port, version } —— 与连接用的服务器配置一致
   * @param {object} options { enabled, intervalMs, timeoutMs }
   */
  constructor (target = {}, options = {}) {
    super()
    this.host = target.host || 'localhost'
    this.port = Number(target.port) || 25565
    this.version = target.version || undefined
    this.explicitPort = !!target.port
    this.label = `${this.host}${this.explicitPort ? ':' + this.port : ''}`
    this.enabled = options.enabled !== false
    this.intervalMs = Math.max(2000, Number(options.intervalMs) || 10000)
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs) || 5000)
    this.minGapMs = Math.min(5000, this.intervalMs) // 多个机器人同时要探测时不用连着发
    this.staleMs = this.intervalMs * 2 + this.timeoutMs // 超过这个时间的结果算过期，要重新探

    this.state = 'unknown' // unknown | online | offline
    this.lastError = ''
    this.lastAt = 0
    this.info = null // ping 到的信息：{ players:{online,max}, version:{name}, latency }
    this.stats = { checks: 0, online: 0, offline: 0 }

    this._waiters = new Set()
    this._loop = null
    this._inFlight = null
    this._lastAt = 0
  }

  // 同一个 host:port 共用一个探测实例
  static for (target, options) {
    const key = `${(target && target.host) || 'localhost'}:${Number(target && target.port) || 25565}`
    let p = registry.get(key)
    if (!p) {
      p = new ServerProbe(target, options)
      registry.set(key, p)
    }
    return p
  }

  get online () { return this.state === 'online' }
  get waiting () { return this._waiters.size }

  // 探测结果描述（写日志用）：延迟/在线人数/版本
  describe () {
    if (!this.info) return ''
    const parts = []
    if (this.info.latency != null) parts.push(`延迟 ${this.info.latency}ms`)
    const pl = this.info.players
    if (pl && pl.online != null) parts.push(`在线 ${pl.online}/${pl.max == null ? '?' : pl.max}`)
    if (this.info.version && this.info.version.name) parts.push(`版本 ${this.info.version.name}`)
    return parts.length ? `（${parts.join('，')}）` : ''
  }

  /**
   * 立刻探一次：返回是否在线。同一时刻的并发调用共用同一次探测；
   * 刚探过（minGapMs 内）且没有 force 时直接返回缓存状态。
   */
  async check ({ force = false } = {}) {
    if (!this.enabled) return true
    if (this._inFlight) return this._inFlight
    if (!force && this._lastAt && Date.now() - this._lastAt < this.minGapMs) return this.online
    this._inFlight = this._ping()
    try { return await this._inFlight } finally { this._inFlight = null }
  }

  async _ping () {
    this._lastAt = Date.now()
    this.stats.checks++
    try {
      const data = await pingOnce({ host: this.host, port: this.port, version: this.version, timeoutMs: this.timeoutMs })
      this.info = data
      this.lastError = ''
      this.stats.online++
      this._setState('online')
      return true
    } catch (e) {
      this.info = null
      this.lastError = (e && e.message) || String(e)
      this.lastError = this.lastError.replace(/\s+/g, ' ').slice(0, 160)
      this.stats.offline++
      this._setState('offline')
      return false
    }
  }

  _setState (state) {
    const changed = state !== this.state
    this.state = state
    this.lastAt = Date.now()
    if (changed) this.emit('state', state, this)
    if (state === 'online') this._flushWaiters()
  }

  _flushWaiters () {
    if (!this._waiters.size) return
    const list = [...this._waiters]
    this._waiters.clear()
    this._stopLoop()
    for (const fn of list) { try { fn() } catch (_) { /* 等待者自己的异常不影响别的等待者 */ } }
  }

  /**
   * 登记“服务器一上线就叫我”。已经在线的（结果没过期）立刻回调。
   * @returns {function} 注销函数；机器人连上以后务必调用
   */
  watch (onOnline) {
    if (this.online && Date.now() - this.lastAt < this.staleMs) {
      onOnline()
      return () => {}
    }
    this._waiters.add(onOnline)
    this._startLoop()
    return () => {
      this._waiters.delete(onOnline)
      if (!this._waiters.size) this._stopLoop()
    }
  }

  _startLoop () {
    if (this._loop || !this.enabled) return
    this.check({ force: true })
    this._loop = setInterval(() => this.check({ force: true }), this.intervalMs)
  }

  _stopLoop () {
    if (this._loop) { clearInterval(this._loop); this._loop = null }
  }

  // 进程清理用：停表并清空等待者
  stop () {
    this._stopLoop()
    this._waiters.clear()
  }

  getSnapshot () {
    return {
      label: this.label,
      enabled: this.enabled,
      state: this.state,
      intervalMs: this.intervalMs,
      lastError: this.lastError,
      lastAt: this.lastAt,
      waiting: this._waiters.size,
      stats: Object.assign({}, this.stats),
      info: this.info,
    }
  }
}

// 一次真实的服务器列表 ping（走 minecraft-protocol：SRV/域名解析与正常进服完全一致）
async function pingOnce ({ host, port, version, timeoutMs }) {
  const mc = require('minecraft-protocol')
  const base = {
    host,
    port,
    closeTimeout: timeoutMs, // 服务器不回状态就按这个超时收工（默认 120s 太久）
    noPongTimeout: Math.min(5000, timeoutMs),
  }
  if (!version) return await mc.ping(base)
  try {
    return await mc.ping(Object.assign({ version }, base))
  } catch (e) {
    // 版本号 minecraft-data 不认（本地错误，不是网络错误）→ 退回默认协议版本再试一次：
    // 服务器列表 ping 不校验协议版本，任何版本号都能拿到状态
    if (isNetworkError(e)) throw e
    return await mc.ping(base)
  }
}

function isNetworkError (err) {
  const msg = String((err && err.message) || err)
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|EAI_AGAIN|EPIPE|EPERM|closed before the server sent/i.test(msg)
}

module.exports = { ServerProbe }
