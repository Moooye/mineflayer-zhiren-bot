// ============================================================
// BotStatusHud 推送器（可选）
// 作用：把本软件已有的 bot 数据，定时 POST 给打开着 MC 的机器上的
//       BotStatusHud mod（它默认在 127.0.0.1:18765 监听 /bot/{name}）。
//       bot 软件在另一台电脑（云电脑）时，把目标地址填成那台机器的 IP。
//
// 什么时候需要它：
//   - 你选的是「mod 主动推送」：由软件侧发起，POST 到 mod。
//   - 如果你更想让 mod 来拉，就用 mod 的 pull 模式，不用跑这个脚本。
//
// 用法：
//   node tools/bot-status-push.js                       // 用默认目标 127.0.0.1:18765
//   TARGET=http://192.168.1.50:18765 node tools/bot-status-push.js
//   DATASRC=http://127.0.0.1:8848/api/bots node tools/bot-status-push.js
//
// 依赖：仅用 Node 原生 http，无需 npm install。
// ============================================================
'use strict'

const http = require('http')

const PUSH_TARGET = process.env.TARGET || 'http://127.0.0.1:9999'
const DATA_SRC = process.env.DATASRC || 'http://127.0.0.1:9999/api/bots'
const INTERVAL_MS = Number(process.env.INTERVAL_MS) || 2000

function log (...a) {
  console.log(new Date().toISOString(), ...a)
}

/** 从 bot 软件的 /api/bots 拉一次数据 */
function fetchBots () {
  return new Promise((resolve, reject) => {
    const req = http.get(DATA_SRC, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.setTimeout(3000, () => req.destroy(new Error('timeout')))
  })
}

/** 把单个 bot 的数据 POST 到 mod */
function pushBot (bot) {
  return new Promise((resolve, reject) => {
    const name = encodeURIComponent(bot.username || bot.name || 'unknown')
    const path = '/bot/' + name
    const payload = JSON.stringify(bot)
    const u = new URL(PUSH_TARGET + path)
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      res.resume()
      if (res.statusCode >= 200 && res.statusCode < 300) resolve()
      else reject(new Error('HTTP ' + res.statusCode))
    })
    req.on('error', reject)
    req.setTimeout(3000, () => req.destroy(new Error('timeout')))
    req.write(payload)
    req.end()
  })
}

let pushed = 0
let failed = 0

async function tick () {
  let data
  try {
    data = await fetchBots()
  } catch (e) {
    log('拉取数据失败：' + e.message + '（源 ' + DATA_SRC + '）')
    return
  }
  const bots = (data && data.bots) || []
  for (const bot of bots) {
    try {
      await pushBot(bot)
      pushed++
    } catch (e) {
      failed++
      log('推送失败 ' + (bot.username || '?') + '：' + e.message + '（目标 ' + PUSH_TARGET + '）')
    }
  }
  if (bots.length) {
    log('已推送 ' + bots.length + ' 个 bot（累计 ' + pushed + ' 次，失败 ' + failed + ' 次）')
  } else {
    log('当前没有在线 bot 可推送')
  }
}

log('推送器启动：数据源 ' + DATA_SRC + ' → 目标 ' + PUSH_TARGET + '，每 ' + INTERVAL_MS + 'ms 一次')
tick()
setInterval(tick, INTERVAL_MS)
