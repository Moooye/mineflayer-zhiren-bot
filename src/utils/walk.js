// ============================================================
// Walk：确定性简单行走（不使用 mineflayer-pathfinder 的 A* 寻路）
// 适用：平坦地形 / 短距离——挂机点附近、捡掉落物、靠近固定箱子
// 背景：mineflayer-pathfinder 在 26.1.2 上寻路决策会长时间挂起，
//      而仓库坐标固定、挂机点就在附近，直线行走已足够且更可靠
// ============================================================
'use strict'
const { sleep } = require('./helpers')

/**
 * 直线水平走到 (tx, tz) 水平距离 ≤ range；停滞（撞方块/台阶）时自动跳
 * @returns {Promise<boolean>} true=已到达；false=超时
 */
async function walkTo (bot, tx, tz, range = 1.0, timeoutMs = 12000) {
  const start = Date.now()
  let lastPos = bot.entity.position.clone()
  let lastCheck = Date.now()
  bot.setControlState('forward', true)
  try {
    while (Date.now() - start < timeoutMs) {
      const p = bot.entity.position
      const dx = tx - p.x
      const dz = tz - p.z
      if (Math.hypot(dx, dz) <= range) return true
      // 水平转向目标（pitch=0 平视）
      await bot.look(Math.atan2(-dx, dz), 0, true)
      if (Date.now() - lastCheck > 500) {
        const moved = Math.hypot(p.x - lastPos.x, p.z - lastPos.z)
        bot.setControlState('jump', moved < 0.15) // 停滞则跳起（越台阶/脱困）
        lastPos = p.clone()
        lastCheck = Date.now()
      }
      await sleep(90)
    }
    return false
  } finally {
    bot.setControlState('forward', false)
    bot.setControlState('jump', false)
  }
}

/**
 * 走到（静止）实体所在位置
 */
async function walkToEntity (bot, entity, range = 0.8, timeoutMs = 10000) {
  if (!entity || !entity.position) return false
  // 实体若已失效（被捡走/消失）直接视为到达
  if (entity.isValid === false) return true
  return walkTo(bot, entity.position.x, entity.position.z, range, timeoutMs)
}

module.exports = { walkTo, walkToEntity }
