// ============================================================
// MemoryGuard：进程内存看门狗（先清理、后重启，尽量不掉线）
//   按 V8 堆用量占上限的比例分级处理：
//     ≥ warnRatio(0.70)    记一条中文告警（只记一次）
//     ≥ cleanRatio(0.78)   软清理：卸载远处区块 + 实体过滤清扫 + 强制 GC
//     ≥ hardRatio(0.85)    硬清理：只留身边几区块、丢掉怪/动物实体、再强制 GC
//     ≥ restartRatio(0.95) 先硬清理一次；清理后还是这么高（真的降不下来）才优雅重启
//   清理是"就地释放内存"，机器人保持在线；只有实在降不下来才走重启兜底。
// ============================================================
'use strict'
const v8 = require('v8')
const vm = require('vm')

function heapInfo () {
  const m = process.memoryUsage()
  const limit = v8.getHeapStatistics().heap_size_limit
  const rssLimit = require('os').totalmem()
  return {
    used: m.heapUsed,
    rss: m.rss,
    limit,
    rssLimit,
    usedMb: Math.round(m.heapUsed / 1048576),
    rssMb: Math.round(m.rss / 1048576),
    limitMb: Math.round(limit / 1048576),
    ratio: limit > 0 ? m.heapUsed / limit : 0,
  }
}

// 取一个能强制 GC 的函数（Node 默认不给 --expose-gc，这里用 v8 开关临时打开）
let cachedGc
function getGc () {
  if (typeof global.gc === 'function') return global.gc
  if (cachedGc !== undefined) return cachedGc
  try {
    v8.setFlagsFromString('--expose-gc')
    const g = vm.runInNewContext('gc')
    v8.setFlagsFromString('--no-expose-gc')
    cachedGc = typeof g === 'function' ? g : null
  } catch (_) {
    cachedGc = null
  }
  return cachedGc
}

const LEVEL_CN = { soft: '软', hard: '硬' }

class MemoryGuard {
  /**
   * @param {object} options
   *   logger          日志器（info/warn）
   *   warnRatio       0.70 告警线
   *   cleanRatio      0.78 软清理线
   *   hardRatio       0.85 硬清理线
   *   restartRatio    0.95 重启兜底线（清理无效时才用）
   *   minCleanGapMs   两次清理的最小间隔（默认 60000ms，避免频繁清理拖慢机器人）
   *   intervalMs      检查间隔（默认 30000ms）
   *   onClean(level)  就地清理回调（由 main.js 调 manager.memoryClean），返回 {unloaded,entities,gc,...}
   *   onRestart(info) 兜底重启回调（优雅下线 + 退出，由 start.bat 拉起来）
   *   heap()          取内存信息（测试可注入假数据）
   *   now()           取时间（测试可注入）
   */
  constructor (options = {}) {
    this.logger = options.logger || null
    this.warnRatio = num(options.warnRatio, 0.70)
    this.cleanRatio = num(options.cleanRatio, 0.78)
    this.hardRatio = num(options.hardRatio, 0.85)
    this.restartRatio = num(options.restartRatio, 0.95)
    this.minCleanGapMs = num(options.minCleanGapMs, 60000)
    this.intervalMs = num(options.intervalMs, 30000)
    this.onClean = options.onClean || null
    this.onRestart = options.onRestart || null
    this.heap = options.heap || heapInfo
    this.now = options.now || (() => Date.now())
    this.gc = options.gc === false ? null : getGc()

    this._timer = null
    this._warned = false
    this._restarting = false
    this._lastCleanAt = 0
    this._lastCleanLevel = ''
    this.cleanCount = 0
    this.restartCount = 0
    this.lastResult = null
  }

  start () {
    if (this._timer) return
    this._timer = setInterval(() => this.check(), this.intervalMs)
  }

  stop () {
    if (this._timer) { clearInterval(this._timer); this._timer = null }
  }

  /**
   * 走一遍判定
   * @returns {'ok'|'warn'|'clean'|'clean-skipped'|'restart'}
   */
  check () {
    const info = this.heap()
    if (info.ratio < this.warnRatio) {
      this._warned = false
      return 'ok'
    }
    if (info.ratio < this.cleanRatio) {
      if (!this._warned) {
        this._warned = true
        if (this.logger) {
          this.logger.warn(`内存偏高：已用 ${info.usedMb}MB / 上限 ${info.limitMb}MB（${pct(info.ratio)}）；` +
            `到 ${pct(this.cleanRatio)} 会自动清理（卸载远处区块 + 强制 GC），机器人保持在线`)
        }
      }
      return 'warn'
    }
    if (info.ratio >= this.restartRatio) {
      // 先清理；刚清理过还是这么高，才认定"降不下来"，走兜底重启
      if (this._cleanedRecently()) return this._restart(info)
      return this._clean('hard', info, true) ? 'clean' : 'clean-skipped'
    }
    const level = info.ratio >= this.hardRatio ? 'hard' : 'soft'
    if (!this._clean(level, info, false)) return 'clean-skipped'
    return 'clean'
  }

  _cleanedRecently () {
    return this._lastCleanAt > 0 && (this.now() - this._lastCleanAt) < this.minCleanGapMs
  }

  /** @returns {boolean} 是否真的执行了清理 */
  _clean (level, info, force) {
    if (!force && this._cleanedRecently()) return false
    this._lastCleanAt = this.now()
    this._lastCleanLevel = level
    this.cleanCount++
    if (!this.onClean) return false
    let res = null
    try {
      res = this.onClean(level, info)
    } catch (e) {
      if (this.logger) this.logger.warn('内存自动清理出错：' + e.message)
      return false
    }
    const after = this.heap()
    this.lastResult = res
    const parts = []
    if (res && res.unloaded) parts.push(`卸载 ${res.unloaded} 个远处区块`)
    if (res && res.entities) parts.push(`丢掉 ${res.entities} 个怪/动物实体`)
    if (res && res.gc) parts.push('强制 GC')
    if (this.logger) {
      this.logger.warn(`内存自动清理（${LEVEL_CN[level] || level}）：${parts.length ? parts.join('、') : '无需清理'}；` +
        `堆 ${info.usedMb}MB → ${after.usedMb}MB（上限 ${after.limitMb}MB，占 ${pct(after.ratio)}）`)
    }
    return true
  }

  _restart (info) {
    if (this._restarting) return 'restart'
    this._restarting = true
    this.restartCount++
    if (this.logger) {
      this.logger.warn(`内存清理后仍然占满：堆 ${info.usedMb}MB / 上限 ${info.limitMb}MB（${pct(info.ratio)}），` +
        '为避免堆爆硬崩，先优雅下线再自动重启（start.bat 会在 5 秒后重新拉起）')
    }
    if (this.onRestart) { try { this.onRestart(info) } catch (_) { /* 忽略：重启流程自身出错也要退出 */ } }
    return 'restart'
  }

  getSnapshot () {
    return {
      warnRatio: this.warnRatio,
      cleanRatio: this.cleanRatio,
      hardRatio: this.hardRatio,
      restartRatio: this.restartRatio,
      cleanCount: this.cleanCount,
      restartCount: this.restartCount,
      lastCleanLevel: this._lastCleanLevel,
      gcAvailable: !!this.gc,
    }
  }
}

function num (v, d) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : d
}
function pct (r) { return Math.round(r * 100) + '%' }

module.exports = { MemoryGuard, heapInfo, getGc }
