// ============================================================
// ServerMetrics：当前连接的「服务器 TPS（估算）」「Ping」与「MSPT（估算）」
//   TPS：服务器每 tick 会把世界时间（bot.time.age）加 1，所以
//        TPS ≈ 世界时间增量 / 真实秒数。update_time 包每秒来一次，
//        用滑动窗口（默认 10 秒）平均，卡顿/掉 tick 看得见；服务器卡死
//        （世界时间不再前进）会如实算成 0。窗口没攒够数据时给 null，
//        面板显示 “-”，绝不编一个数字出来。
//   Ping：bot.player.ping（服务器 player_info 里的 latency，
//        就是游戏里按 TAB 看到的那个延迟）。服务器没广播时给 null。
//   MSPT：每 tick 的毫秒数。做法是把「窗口内真实耗时 / 窗口内 tick 数」，
//         即平均每 tick 多少毫秒。20 TPS 健康服务器 ≈ 50ms；掉 tick 时
//         这个值会如实变大（真实 MSPT 只有服务端插件才拿得到，这里只是估算）。
// 用法：const m = new ServerMetrics(); const off = m.bindBot(bot); … off()
// ============================================================
'use strict'

const MAX_TPS = 20 // 服务器正常上限就是 20，超过只可能是测量噪声

class ServerMetrics {
  /**
   * @param {object} [opts] { intervalMs=1000 采样间隔, windowMs=10000 滑动窗口 }
   */
  constructor (opts) {
    const o = opts || {}
    this.intervalMs = Number(o.intervalMs) > 0 ? Number(o.intervalMs) : 1000
    this.windowMs = Number(o.windowMs) > 0 ? Number(o.windowMs) : 10000
    this.tps = null
    this.ping = null
    this.mspt = null
    this.sampledAt = 0
    this._bot = null
    this._timer = null
    this._samples = [] // [{ t, age }] 滑动窗口，用于算 TPS 与 MSPT
  }

  // 绑定到一个 bot（每次重连都要重新绑定；返回清理函数）
  bindBot (bot) {
    this._bot = bot
    this._samples = []
    this.tps = null
    this.ping = null
    this.mspt = null
    this.sampledAt = 0
    this.sample()
    this._timer = setInterval(() => this.sample(), this.intervalMs)
    if (this._timer.unref) this._timer.unref() // 别拖住进程退出
    return () => {
      if (this._timer) { clearInterval(this._timer); this._timer = null }
      this._bot = null
    }
  }

  // 采一次样（定时器调用；自检里也直接调它）
  sample () {
    const bot = this._bot
    if (!bot) return
    const now = Date.now()

    // Ping：服务器广播的本连接延迟
    const p = bot.player && bot.player.ping
    this.ping = (typeof p === 'number' && p >= 0) ? Math.round(p) : null

    // TPS / MSPT：都靠世界时间（tick）在滑动窗口里的推进速度
    const age = bot.time && bot.time.age
    if (typeof age === 'number' && age > 0 && isFinite(age)) {
      this._samples.push({ t: now, age })
      // 丢掉窗口外的旧样本（至少留 2 个：窗口要首尾两个点才能算平均）
      while (this._samples.length > 2 && now - this._samples[0].t > this.windowMs) this._samples.shift()

      const first = this._samples[0]
      const dMs = now - first.t
      const dTicks = age - first.age
      // 窗口至少攒到一半时间才出数；没有首尾样本时（dMs<=0）不出数
      if (dMs >= Math.max(1000, this.windowMs / 2)) {
        // TPS：世界时间增量 / 真实秒数。服务器卡死（dTicks=0）如实算 0
        this.tps = Math.min(MAX_TPS, Math.max(0, Math.round((dTicks / (dMs / 1000)) * 10) / 10))
        // MSPT：窗口内真实耗时 / tick 数 = 平均每 tick 毫秒数。
        // 20 TPS 时 ≈ 50ms；掉 tick 时如实变大。dTicks<=0 时算不出来，保持原值。
        if (dTicks > 0) {
          this.mspt = Math.round(Math.min(dMs / dTicks, 9999) * 10) / 10
        }
        this.sampledAt = now
      }
    }

    // 太久没出数（比如服务器不再发时间包）就当拿不到，回退成 “-”
    if (this.tps !== null && this.sampledAt && now - this.sampledAt > this.windowMs * 3) this.tps = null
    if (this.mspt !== null && this.sampledAt && now - this.sampledAt > this.windowMs * 3) this.mspt = null
  }

  snapshot () {
    return { tps: this.tps, ping: this.ping, mspt: this.mspt }
  }
}

module.exports = { ServerMetrics, MAX_TPS }

module.exports = { ServerMetrics, MAX_TPS }
