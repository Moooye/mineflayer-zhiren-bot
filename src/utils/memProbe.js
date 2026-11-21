// ============================================================
// memProbe：内存明细探针（默认关闭，排查「堆一直涨」时才开）
//   打开方式：启动前设环境变量 MEM_PROBE=1（见 诊断内存.bat）
//   每隔 probeMs（默认 60 秒）把关键计数写进运行日志：
//     堆/常驻/外部内存、句柄数、各类活跃资源、
//     每个账号：状态、实体数、区块数、监听器数、记分板条目、bossbar、队伍、队列长度
//   用法：对比同一账号「前后两次」的这些数字，就能看出是谁在涨。
// ============================================================
'use strict'

function mb (v) { return Math.round(v / 1048576 * 10) / 10 }

class MemProbe {
  /**
   * @param {object} manager BotManager
   * @param {object} options { intervalMs, logger }
   */
  constructor (manager, options = {}) {
    this.manager = manager
    this.intervalMs = Math.max(10000, Number(options.intervalMs) || 60000)
    this.logger = options.logger || null
    this.timer = null
  }

  start () {
    if (this.timer) return
    this.sample('启动')
    this.timer = setInterval(() => this.sample('定时'), this.intervalMs)
  }

  stop () {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  sample (tag) {
    const mu = process.memoryUsage()
    const res = {}
    try { for (const r of process.getActiveResourcesInfo()) res[r] = (res[r] || 0) + 1 } catch (_) {}
    let handles = -1
    try { handles = process._getActiveHandles().length } catch (_) {}

    const bots = []
    for (const ctx of (this.manager.contexts || [])) {
      const bot = ctx.bot
      const one = { 账号: ctx.account.username, 状态: ctx.status }
      if (bot) {
        try { one.实体 = Object.keys(bot.entities || {}).length } catch (_) {}
        try { one.区块 = bot.world && bot.world.getColumns ? bot.world.getColumns().length : -1 } catch (_) {}
        try { one.监听 = bot.eventNames().reduce((a, e) => a + bot.listeners(e).length, 0) } catch (_) {}
        try { one.协议监听 = bot._client.eventNames().reduce((a, e) => a + bot._client.listeners(e).length, 0) } catch (_) {}
        try {
          const sbs = bot.scoreboards ? Object.values(bot.scoreboards) : []
          one.记分板 = sbs.length + '(' + sbs.reduce((a, s) => a + (s && s.items ? Object.keys(s.items).length : 0), 0) + '条)'
        } catch (_) {}
        try { one.boss条 = bot.bossBars ? bot.bossBars.length : 0 } catch (_) {}
        try { one.队伍 = bot.teams ? Object.keys(bot.teams).length : 0 } catch (_) {}
        const s = ctx.services || {}
        try { one.发送队列 = s.chatQueue.queue.length + '|去重' + s.chatQueue.recent.size } catch (_) {}
        try { one.任务队列 = s.taskRunner.queue.length + '|历史' + s.taskRunner.history.length } catch (_) {}
        try { one.过滤隐藏 = s.entityFilter._hidden.size } catch (_) {}
      }
      bots.push(one)
    }

    const line = `内存明细（${tag}）：堆 ${mb(mu.heapUsed)}/${mb(mu.heapTotal)}MB · 常驻 ${mb(mu.rss)}MB · 外部 ${mb(mu.external + (mu.arrayBuffers || 0))}MB · 句柄 ${handles}` +
      ` · 资源 ${Object.keys(res).map(k => k.replace('Wrap', '') + ':' + res[k]).join(',')} · ${JSON.stringify(bots)}`
    if (this.logger) this.logger.info(line)
    return line
  }
}

module.exports = { MemProbe }
