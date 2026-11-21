// ============================================================
// 聊天日志
//  - 全量聊天：logs/chat/<账号>/YYYY-MM-DD.log
//  - 私聊汇总：logs/whisper/YYYY-MM-DD.log（跨账号，标明方向）
// ============================================================
'use strict'
const path = require('path')
const { DailyFileWriter } = require('../utils/dailyFile')

const CHAT_DIR = path.join(__dirname, '..', '..', 'logs', 'chat')
const WHISPER_DIR = path.join(__dirname, '..', '..', 'logs', 'whisper')

// 私聊全项目共享一个文件
const whisperWriter = new DailyFileWriter(WHISPER_DIR)
// 每个账号一个全量聊天写入器
const chatWriters = new Map()

// 当前时间 HH:mm:ss（固定北京时间，不受机器时区影响）
function nowText () {
  return new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}

class ChatLogger {
  // 记录一条普通聊天（含服务器消息）
  logChat (account, username, message) {
    let w = chatWriters.get(account)
    if (!w) {
      w = new DailyFileWriter(path.join(CHAT_DIR, account))
      chatWriters.set(account, w)
    }
    w.writeLine(`${nowText()} <${username}> ${message}`)
  }

  /**
   * 记录一条私聊
   * @param {boolean} incoming true=别人发给bot（<<）；false=bot发出（>>）
   */
  logWhisper (account, username, message, incoming = true) {
    const arrow = incoming ? '<<' : '>>'
    whisperWriter.writeLine(`${nowText()} [${account}] ${arrow} ${username}: ${message}`)
  }

  close () {
    whisperWriter.close()
    for (const w of chatWriters.values()) w.close()
    chatWriters.clear()
  }
}

module.exports = { ChatLogger }
