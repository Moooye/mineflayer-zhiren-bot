// ============================================================
// 结构化日志：控制台彩色输出 + 按天滚动写入 logs/runtime/
// 用法：const logger = require(...).createLogger('玩家B')
//      logger.info('xxx') / logger.warn / logger.error / logger.debug
// ============================================================
'use strict'
const path = require('path')
const { DailyFileWriter } = require('./dailyFile')

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const COLORS = {
  debug: '\x1b[90m',   // 灰色
  info: '\x1b[36m',    // 青色
  warn: '\x1b[33m',    // 黄色
  error: '\x1b[31m',   // 红色
}
const RESET = '\x1b[0m'

// 全项目共享一个运行日志文件
const runtimeWriter = new DailyFileWriter(
  path.join(__dirname, '..', '..', 'logs', 'runtime')
)
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL || 'debug']

// 当前时间 HH:mm:ss
function timestamp () {
  // 固定北京时间，不受机器时区影响
  return new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}

function createLogger (scope = '') {
  const tag = scope ? `[${scope}] ` : ''

  function log (level, args) {
    if (LEVELS[level] < MIN_LEVEL) return
    const msg = args
      .map(a => (a instanceof Error ? a.stack : typeof a === 'object' ? JSON.stringify(a) : String(a)))
      .join(' ')
    const line = `${timestamp()} ${level.toUpperCase().padEnd(5)} ${tag}${msg}`
    const colored = `${COLORS[level]}${line}${RESET}`
    if (level === 'error') console.error(colored)
    else if (level === 'warn') console.warn(colored)
    else console.log(colored)
    runtimeWriter.writeLine(line)
  }

  return {
    debug: (...a) => log('debug', a),
    info: (...a) => log('info', a),
    warn: (...a) => log('warn', a),
    error: (...a) => log('error', a),
  }
}

module.exports = { createLogger, runtimeWriter }
