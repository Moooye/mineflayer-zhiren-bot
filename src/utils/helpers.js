// ============================================================
// 通用工具函数
// ============================================================
'use strict'

// 等待
function sleep (ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

// 随机整数 [min, max]
function randomInt (min, max) {
  return Math.floor(min + Math.random() * (max - min + 1))
}

// 随机取一个数组元素
function randomChoice (arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

// 数值夹取
function clamp (v, min, max) {
  return Math.max(min, Math.min(max, v))
}

// 给 Promise 加超时；超时后用 onTimeout 处理（通常是中断动作），并抛出
async function withTimeout (promise, ms, label, onTimeout) {
  let timer
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      try { if (typeof onTimeout === 'function') onTimeout() } catch (_) { /* 忽略 */ }
      reject(new Error(`${label || '操作'}超时（${ms}ms）`))
    }, ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

// 可重试地执行异步函数：失败按次数重试，间隔递增
async function retry (fn, times, baseDelayMs = 1000) {
  let lastErr
  for (let i = 0; i <= times; i++) {
    try {
      return await fn(i)
    } catch (e) {
      lastErr = e
      if (i < times) await sleep(baseDelayMs * (i + 1))
    }
  }
  throw lastErr
}

// 长文本按最大长度切分（尽量在空格/标点处断，避免半句）
function chunkString (str, size = 240) {
  const text = String(str)
  if (text.length <= size) return [text]
  const chunks = []
  let rest = text
  while (rest.length > size) {
    let cut = size
    const window = rest.slice(0, size)
    const breakAt = Math.max(window.lastIndexOf(' '), window.lastIndexOf('，'), window.lastIndexOf('。'), window.lastIndexOf('、'))
    if (breakAt > size * 0.5) cut = breakAt + 1
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut)
  }
  if (rest.trim()) chunks.push(rest.trim())
  return chunks.filter(Boolean)
}

// 把 [x,y,z] 数组/对象转成可读字符串
function fmtPos (p) {
  if (!p) return '未知'
  if (Array.isArray(p)) return p.map(n => Number(n).toFixed(1)).join(', ')
  if (typeof p === 'object' && p.x !== undefined) return `${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`
  return String(p)
}

// 去掉 MC 颜色码
function stripColor (text) {
  return String(text == null ? '' : text).replace(/§./g, '')
}

// 机器人状态的中文名（控制台 / 面板显示用；内部状态值一律保持英文，别拿这个去比较）
const STATUS_CN = {
  offline: '离线',
  connecting: '连接中',
  online: '在线',
  reconnecting: '重连',
  waitServer: '等服务器上线',
  ended: '已停止',
  giveUp: '已放弃',
  stopped: '已停用',
}

// 状态值 → 中文（认不出的状态原样返回）
function statusCn (status) {
  return STATUS_CN[status] || status || '-'
}

// 传送队列（WarpQueue）结果的中文名：!回家 / !设家 / !tpa 等回执里显示
const WARP_STATUS_CN = {
  done: '已执行',
  'request-sent': '请求已发送',
  'request-timeout': '请求已发出（未收到确认）',
  teleported: '已传送',
}

function warpStatusCn (status) {
  return WARP_STATUS_CN[status] || status || '-'
}

// 安全 JSON stringify（防循环引用）
function safeJson (obj) {
  const seen = new WeakSet()
  return JSON.stringify(obj, (k, v) => {
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return '[Circular]'
      seen.add(v)
    }
    if (typeof v === 'bigint') return v.toString()
    return v
  })
}

// 大小写宽松查找在线玩家（先精确后模糊），返回 bot.players 项或 null
function findOnlinePlayer (bot, name) {
  const lower = String(name || '').toLowerCase()
  const keys = Object.keys(bot.players)
  const exact = keys.find(k => k.toLowerCase() === lower)
  if (exact) return bot.players[exact]
  const fuzzy = keys.find(k => k.toLowerCase().includes(lower))
  return fuzzy ? bot.players[fuzzy] : null
}

// 从服务器文本里识别“别人私聊本机器人”，返回 { from, content }；认不出返回 null
// 兼容两种实际出现的格式：
//   1) 服务器插件转发： [管理员玩家 ➥ 玩家B] 说 1
//   2) 原版英文格式：   管理员玩家 whispers to you: 说 1
function parseIncomingWhisper (text, selfName) {
  const plain = stripColor(text).trim()
  if (!plain) return null
  const self = String(selfName || '').toLowerCase()
  let m = plain.match(/^\[([^\]➥]{1,32}?)\s*➥\s*([^\]]{1,32}?)\]\s*(.+)$/)
  if (m) {
    if (self && m[2].trim().toLowerCase() !== self) return null // 不是发给自己的
    return { from: m[1].trim(), content: m[3].trim() }
  }
  m = plain.match(/^(\S{1,32}?)\s+whispers to you[:：]\s*(.+)$/i)
  if (m) return { from: m[1].trim(), content: m[2].trim() }
  return null
}

// 生成随机访问令牌
function randomToken (bytes = 24) {
  try {
    return require('crypto').randomBytes(bytes).toString('hex')
  } catch (_) {
    return Math.random().toString(36).slice(2) + Date.now().toString(36)
  }
}

module.exports = {
  sleep,
  randomInt,
  randomChoice,
  clamp,
  withTimeout,
  retry,
  chunkString,
  fmtPos,
  stripColor,
  STATUS_CN,
  statusCn,
  WARP_STATUS_CN,
  warpStatusCn,
  parseIncomingWhisper,
  safeJson,
  findOnlinePlayer,
  randomToken,
}
