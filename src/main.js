// ============================================================
// 入口：加载校验配置 → 启动全部机器人 →（可选）Web 面板 → 等待退出
// 运行：
//   node src/main.js                                   用默认配置
//   node src/main.js config/local-offline.config.js    用指定配置
// ============================================================
'use strict'
const { loadConfig } = require('./utils/configLoader')
const { runtimeWriter, createLogger } = require('./utils/logger')
const { MemoryGuard, heapInfo } = require('./utils/memoryGuard')
const { ChatLogger } = require('./services/ChatLogger')
const { Notifier } = require('./services/Notifier')
const { ChatMonitor } = require('./services/ChatMonitor')
const { ConfigStore } = require('./services/ConfigStore')
const { WebDashboard } = require('./services/WebDashboard')
const { BotManager } = require('./core/BotManager')

// 解析命令行配置路径
function resolveCliConfig () {
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--config=')) return args[i].slice('--config='.length)
    if (args[i] === '--config' && args[i + 1]) return args[i + 1]
    if (!args[i].startsWith('-')) return args[i]
  }
  return null
}

async function main () {
  let cfg
  try {
    cfg = loadConfig(resolveCliConfig())
  } catch (e) {
    console.error(`\x1b[31m${e.message}\x1b[0m`)
    process.exit(1)
  }

  const chatLogger = new ChatLogger()
  const notifier = new Notifier(cfg.notifier)
  const chatMonitor = new ChatMonitor()
  const configStore = new ConfigStore(cfg)
  const manager = new BotManager(cfg, chatLogger, notifier, chatMonitor, configStore)

  // 启动信息：一眼看到堆上限与机器内存，方便判断要不要调 --max-old-space-size
  const systemLogger = createLogger('system')
  {
    const hi = heapInfo()
    systemLogger.info(`启动：Node ${process.version} · 堆上限 ${hi.limitMb}MB · 系统内存 ${Math.round(require('os').totalmem() / 1048576)}MB`)
  }

  // 内存明细探针（可选，排查「堆一直涨」时才开）：启动前设环境变量 MEM_PROBE=1
  //   见项目根目录 诊断内存.bat；平时不开，开了会每分钟多写一行日志
  if (process.env.MEM_PROBE) {
    const { MemProbe } = require('./utils/memProbe')
    const probe = new MemProbe(manager, {
      intervalMs: Number(process.env.MEM_PROBE_MS) || 60000,
      logger: systemLogger,
    })
    probe.start()
    systemLogger.warn(`内存探针已开启：每 ${Math.round(probe.intervalMs / 1000)} 秒记录一行「内存明细」，把 logs\\runtime 当天日志发出来即可定位增长点`)
  }

  // 可选 Web 面板
  let web = null
  if (cfg.web && cfg.web.enabled) {
    web = new WebDashboard(manager, cfg.web)
    // 只有监听真正成功（端口没被占用）才提示并打开浏览器，
    // 否则会出现「提示面板已启动、浏览器却打不开」的假象
    web.start(() => {
      console.log(`状态面板已启动：http://${web.host}:${web.port}`)
      // 开箱体验：Windows 下启动后自动用默认浏览器打开面板（配置 web.autoOpen:false 可关闭）
      if (cfg.web.autoOpen !== false && process.platform === 'win32') {
        try {
          const openHost = (web.host === '0.0.0.0' || !web.host) ? '127.0.0.1' : web.host
          // start "" 是 Windows 用默认程序打开 URL 的标准写法
          require('child_process').exec(`cmd /c start "" "http://${openHost}:${web.port}"`)
        } catch (_) { /* 自动打开失败不影响机器人运行，可手动在浏览器输入地址 */ }
      }
    })
  }

  // 内存看门狗：**先就地清理、尽量不掉线**，实在清不下来才重启兜底
  //   ≥ cleanRatio   软清理：卸载远处区块 + 强制 GC（机器人保持在线）
  //   ≥ hardRatio    硬清理：只留身边 2 区块 + 丢掉怪/动物实体 + 再 GC
  //   ≥ restartRatio 先硬清理一次；一分钟内已清理过还是这么高，才优雅重启（start.bat 5 秒后拉起）
  const memCfg = (cfg.perf && cfg.perf.memory) || {}
  const guard = new MemoryGuard({
    logger: systemLogger,
    warnRatio: memCfg.warnRatio,
    cleanRatio: memCfg.cleanRatio,
    hardRatio: memCfg.hardRatio,
    restartRatio: memCfg.restartRatio,
    minCleanGapMs: memCfg.minCleanGapMs,
    onClean: level => manager.memoryClean(level),
    onRestart: async () => {
      try { await manager.stopAll() } catch (_) { /* 忽略 */ }
      try { if (web) web.stop() } catch (_) { /* 忽略 */ }
      try { chatLogger.close() } catch (_) { /* 忽略 */ }
      try { runtimeWriter.close() } catch (_) { /* 忽略 */ }
      process.exit(42)
    },
  })
  guard.start()
  {
    const s = guard.getSnapshot()
    systemLogger.info(`内存看门狗：${Math.round(s.warnRatio * 100)}% 告警 / ${Math.round(s.cleanRatio * 100)}% 自动软清理 / ` +
      `${Math.round(s.hardRatio * 100)}% 硬清理 / ${Math.round(s.restartRatio * 100)}% 兜底重启` +
      `${s.gcAvailable ? '（可强制 GC）' : '（无强制 GC，只清区块/实体）'}`)
  }

  // 优雅退出
  let stopping = false
  async function shutdown (signal) {
    if (stopping) return
    stopping = true
    try { guard.stop() } catch (_) { /* 忽略 */ }
    console.log(`\n收到退出信号（${signal}），开始安全关闭...`)
    try {
      await manager.stopAll()
      if (web) web.stop()
      chatLogger.close()
      runtimeWriter.close()
    } catch (_) { /* 忽略退出阶段错误 */ }
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGHUP', () => shutdown('SIGHUP'))

  // 启动机器人：
  //  - 面板启用时：面板已优先就绪，机器人在“后台”连接，不被服务器离线 / 上线超时拖慢面板
  //    （面板 HTTP 服务本身保持进程存活；服务器没开也能先打开面板完成配置）
  //  - 面板关闭时：保持等待全部启动（纯挂机原行为）
  if (cfg.web && cfg.web.enabled) {
    manager.startAll().catch(e => console.error(`启动机器人出错：${e.message}`))
  } else {
    await manager.startAll()
  }
}

process.on('uncaughtException', err => {
  console.error(`\x1b[31m未捕获异常：${err.stack || err.message}\x1b[0m`)
})
process.on('unhandledRejection', reason => {
  console.error(`\x1b[31m未处理的 Promise 异常：${reason}\x1b[0m`)
})

main()
