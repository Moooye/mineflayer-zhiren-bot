// ============================================================
// 按天滚动的追加文件写入器
// 日志文件命名：<prefix>YYYY-MM-DD.log，跨天自动切换新文件
// ============================================================
'use strict'
const fs = require('fs')
const path = require('path')

class DailyFileWriter {
  /**
   * @param {string} dir    日志目录
   * @param {string} prefix 文件名前缀（可空）
   */
  constructor (dir, prefix = '') {
    this.dir = dir
    this.prefix = prefix
    this.currentDate = ''
    this.stream = null
  }

  // 当前日期键（北京时间），如 2026-10-05
  _dateKey () {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
  }

  // 确保当天的写入流可用（跨天自动重建）
  _ensureStream () {
    const date = this._dateKey()
    if (this.stream && date === this.currentDate) return this.stream
    if (this.stream) { try { this.stream.end() } catch (_) { /* 忽略 */ } }
    fs.mkdirSync(this.dir, { recursive: true })
    const file = path.join(this.dir, `${this.prefix}${date}.log`)
    this.stream = fs.createWriteStream(file, { flags: 'a' })
    this.currentDate = date
    return this.stream
  }

  // 追加一行
  writeLine (line) {
    try {
      this._ensureStream().write(line + '\n')
    } catch (_) { /* 写日志失败不影响主流程 */ }
  }

  close () {
    if (this.stream) {
      try { this.stream.end() } catch (_) { /* 忽略 */ }
      this.stream = null
      this.currentDate = ''
    }
  }
}

module.exports = { DailyFileWriter }
