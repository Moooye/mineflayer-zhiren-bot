// ============================================================
// 防 AFK 行为（丢 / 捡物品版，Mineflayer 插件）
//
// 进服默认全部关闭（不丢也不捡），收到 !afk 开 才启动：
//   1) 拾取循环（随 start() 启动）：
//      只原地捡“贴身/自动吸附范围”内的掉落物，不追远处物品，不区分谁丢的
//   2) 丢捡循环（由 start()/stop() 手动开关）：
//      开启时在原地朝下丢出 1 个“廉价物品”到脚下，靠自动吸附原地捡回
//      （不锁定丢出者），用 丢出+捡回 的动作防 AFK；
//      !afk 关 时停丢、保留贴身拾取；断线/重连后回到“全部关闭”
//
// 接口：
//   bot.afk.start(cfg)  开启丢捡（防AFK ON）
//   bot.afk.stop()      关闭丢捡（防AFK OFF，拾取仍继续）
//   bot.afk.shutdownAll()  断线/卸载时彻底停止两个循环
//   bot.afk.isRunning() 丢捡是否开启
// ============================================================
'use strict'
const { sleep } = require('../utils/helpers')

// 允许“丢了再捡”的廉价常见物品（绝不丢工具/装备/贵重物，避免丢失风险）
const SAFE_TOSS = [
  'dirt', 'coarse_dirt', 'rooted_dirt', 'cobblestone', 'stone', 'cobbled_deepslate',
  'granite', 'diorite', 'andesite', 'tuff', 'calcite', 'netherrack',
  'sand', 'gravel', 'red_sand', 'sandstone', 'moss_block',
  'clay', 'clay_ball', 'flint', 'rotten_flesh', 'stick',
]

// 判断实体是否为掉落物（兼容不同版本命名）
function isDroppedItem (en) {
  if (!en) return false
  if (en.name === 'item' || en.name === 'item_entity') return true
  if (en.displayName === 'Item') return true
  return false
}

function antiAfk (bot) {
  let cfg = {}
  let tossTimer = null
  let tossRunning = false
  let pickupTimer = null
  let pickupRunning = false // 进服默认不拾取，start()（!afk 开）才启动
  let pickupSuppressed = false // 临时抑制拾取（清空背包时用，避免丢出被立即捡回）
  let busyUntil = 0

  // 日志：优先用 BotContext 注入的 logger（落 runtime 日志文件），否则 console
  const log = (...args) => {
    try {
      if (bot._logger && typeof bot._logger.info === 'function') bot._logger.info(args.join(' '))
      else console.log(...args)
    } catch (_) { /* 忽略 */ }
  }

  // ---- 是否有其他移动动作（避免拾取/丢捡抢控制） ----
  function isOtherAction () {
    try { if (bot.pathfinder && bot.pathfinder.isMoving()) return true } catch (_) { /* 忽略 */ }
    return Date.now() < busyUntil
  }

  // ---- 拾取：列出半径内掉落物（由近到远） ----
  function nearbyItems (radius) {
    const out = []
    for (const id in bot.entities) {
      const en = bot.entities[id]
      if (isDroppedItem(en)) {
        const d = bot.entity.position.distanceTo(en.position)
        if (d <= radius) out.push({ en, d })
      }
    }
    out.sort((a, b) => a.d - b.d)
    return out.map(x => x.en)
  }

  // 贴身自动吸附范围：掉落物进入此距离会被游戏自动拉向玩家，无需移动
  const AUTO_PICKUP_RANGE = 1.3

  async function pickupOnce () {
    // 只扫描贴身范围，绝不 walkTo 追物品（未接到移动指令保持原地）
    const items = nearbyItems(AUTO_PICKUP_RANGE)
    if (items.length === 0) return
    const target = items[0]
    if (!target || !target.position) return
    const d = bot.entity.position.distanceTo(target.position)
    log(`[antiAfk:${bot.username}] 贴身掉落物(距离${d.toFixed(1)})，原地等吸附`)
    await sleep(300) // 不移动，等待游戏自动吸附拾取
  }

  function pickupLoop () {
    if (!pickupRunning) return
    pickupTimer = setTimeout(async () => {
      try {
        if (bot.entity && !isOtherAction() && !pickupSuppressed) await pickupOnce()
      } catch (_) { /* 单轮失败不影响后续 */ }
      pickupLoop()
    }, 2500)
  }

  // ---- 丢捡：选一个廉价物品，朝下丢到脚下再捡回 ----
  function pickTossItem () {
    const safe = bot.inventory.items().filter(i => SAFE_TOSS.includes(i.name))
    if (safe.length === 0) return null
    safe.sort((a, b) => b.count - a.count) // 优先数量多的
    return safe[0]
  }

  async function tossOnce () {
    const item = pickTossItem()
    if (!item) {
      log(`[antiAfk:${bot.username}] 无安全可丢物品，挥手兜底`)
      bot.swingArm('right') // 没有可丢物品：挥手兜底（也能轻微防AFK）
      return
    }
    // 原地：朝下看、先静止并清零水平速度，丢 1 个安全物品到脚下
    await bot.look(bot.entity.yaw, Math.PI / 2, true)
    try { bot.clearControlStates(); bot.entity.velocity.x = 0; bot.entity.velocity.z = 0 } catch (_) { /* 忽略 */ }
    await bot.toss(item.type, null, 1)
    log(`[antiAfk:${bot.username}] 原地丢出 ${item.name}，等待捡回`)
    bot.swingArm('right')
    // 不锁定丢出者：等待自动捡回；未捡回则由常驻拾取循环（谁近谁捡）兜底
    await sleep(2000)
  }

  function scheduleToss () {
    if (!tossRunning) return
    const min = Number(cfg.minIntervalMs) || 20000
    const max = Number(cfg.maxIntervalMs) || 60000
    const wait = min + Math.random() * Math.max(1, max - min)
    tossTimer = setTimeout(async () => {
      try {
        const other = isOtherAction()
        let goalDesc = '无'
        try { goalDesc = bot.pathfinder.goal ? bot.pathfinder.goal.constructor.name : '无' } catch (_) { goalDesc = '?' }
        log(`丢捡周期：受阻=${other} goal=${goalDesc}`)
        if (bot.entity && !other) {
          busyUntil = Date.now() + 4000
          await tossOnce()
        }
      } catch (err) { log(`丢捡出错：${(err && err.message) || err}`) }
      scheduleToss()
    }, wait)
  }

  bot.afk = {
    configure (options = {}) {
      if (options && Object.keys(options).length) cfg = options
    },
    start (options = {}) {
      if (options && Object.keys(options).length) cfg = options
      if (!pickupRunning) { pickupRunning = true; pickupLoop() } // 开启时同时启用贴身拾取
      if (!tossRunning) {
        tossRunning = true
        log('丢捡循环已启动')
        scheduleToss()
      }
    },
    stop () {
      // 仅关闭丢捡；拾取循环保留（关闭防AFK仍要捡东西）
      tossRunning = false
      if (tossTimer) { clearTimeout(tossTimer); tossTimer = null }
    },
    isRunning () { return tossRunning },
    // 临时抑制/恢复贴身拾取（清空背包时，避免丢出的物品被立即捡回）
    setPickupSuppressed (v) { pickupSuppressed = !!v },
    shutdownAll () {
      tossRunning = false
      pickupRunning = false
      pickupSuppressed = false
      if (tossTimer) { clearTimeout(tossTimer); tossTimer = null }
      if (pickupTimer) { clearTimeout(pickupTimer); pickupTimer = null }
      try { bot.clearControlStates() } catch (_) { /* 忽略 */ }
    },
  }

  // 拾取循环不再自动启动：进服默认关闭，由 bot.afk.start()（!afk 开）启用
}

module.exports = antiAfk
