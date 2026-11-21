// ============================================================
// 移动类指令：
//   !停止/!stop      取消任务、停止跟随、复位控制
//   !回家/!home      经 WarpQueue 执行 home
//   !跟随 <玩家>     持续跟随（GoalFollow）
//   !去 <玩家>       作为任务走到玩家附近
//   !afk 开/关       防 AFK 开关（等同 Web 面板开关）
//
// 仅私聊：!回家 / !跟随 / !去 标了 whisperOnly——公屏发来一律静默忽略。
//   （公屏是广播的，同服每个机器人都会收到并各自执行一遍，会三份动作 + 三份回执，
//     传送类还会互相撞位置；!停止 与 !afk 保留公屏可用，方便一次控制全部账号。）
// ============================================================
'use strict'
const { goals } = require('mineflayer-pathfinder')
const { findOnlinePlayer, warpStatusCn } = require('../utils/helpers')

const stopCommand = {
  name: 'stop',
  aliases: ['停止', '停下'],
  usage: '!停止',
  permission: 'control',
  cooldownMs: 1000,
  async execute ({ ctx, reply }) {
    // 正在扫箱的话先停扫箱（否则它会继续走到下一个箱子）
    if (ctx.services.chestManager && ctx.services.chestManager.scanStatus().扫描中) {
      ctx.services.chestManager.stopScan()
    }
    // 取消当前任务 → TaskRunner 内部会统一停掉寻路/挖掘/左右键/控制状态等所有动作源
    ctx.services.taskRunner.cancelCurrent('主人停止')
    ctx.services.taskRunner.abortActions()
    if (ctx.continuousUse) { // 停掉持续右键连点
      clearInterval(ctx.continuousUse)
      ctx.continuousUse = null
    }
    ctx.followTarget = null
    await reply('已停止当前动作并取消跟随')
  },
}

const homeCommand = {
  name: 'home',
  aliases: ['回家', 'hui'],
  usage: '!回家 [家名]',
  permission: 'warp',
  whisperOnly: true,
  cooldownMs: 3000,
  async execute ({ args, ctx, reply }) {
    const r = await ctx.services.warpQueue.home(args[0])
    await reply(`回家指令已处理：${warpStatusCn(r.status)}`)
  },
}

const followCommand = {
  name: 'follow',
  aliases: ['跟随', 'gen'],
  usage: '!跟随 <玩家>',
  permission: 'control',
  whisperOnly: true,
  cooldownMs: 2000,
  async execute ({ args, ctx, reply }) {
    if (!args[0]) return reply('用法：!跟随 <玩家>')
    const player = findOnlinePlayer(ctx.bot, args[0])
    const entity = player && player.entity
    if (!entity) return reply(`找不到在线玩家：${args[0]}`)
    ctx.bot.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true)
    ctx.followTarget = player.username
    await reply(`开始跟随 ${player.username}，发 !停止 可结束`)
  },
}

const gotoCommand = {
  name: 'goto',
  aliases: ['去', 'go'],
  usage: '!去 <玩家>',
  permission: 'control',
  whisperOnly: true,
  cooldownMs: 2000,
  async execute ({ args, ctx, reply }) {
    if (!args[0]) return reply('用法：!去 <玩家>')
    const player = findOnlinePlayer(ctx.bot, args[0])
    const entity = player && player.entity
    if (!entity) return reply(`找不到在线玩家：${args[0]}`)
    reply(`正在前往 ${player.username} ...`)
    await ctx.services.taskRunner.enqueue({
      name: 'goto-player',
      kind: 'goto',
      timeoutMs: 60000,
      run: async (api, control) => {
        const ep = entity.position
        await ctx.bot.pathfinder.goto(new goals.GoalNear(ep.x, ep.y, ep.z, 2))
      },
    })
    await reply(`已到达 ${player.username} 附近`)
  },
}

// 防 AFK 开关：!afk 开 / !afk 关（等同 Web 面板开关）
const afkCommand = {
  name: 'afk',
  aliases: ['防afk'],
  usage: '!afk <开/关>',
  permission: 'control',
  cooldownMs: 1000,
  async execute ({ args, ctx, reply }) {
    const a = String(args[0] || '').toLowerCase()
    let on
    if (['开', '开启', '打开', 'on', 'true', '1'].includes(a)) on = true
    else if (['关', '关闭', '关掉', 'off', 'false', '0'].includes(a)) on = false
    else return reply('用法：!afk 开 或 !afk 关')
    const r = ctx.setAntiAfk(on)
    await reply(r.message)
  },
}

module.exports = [stopCommand, homeCommand, followCommand, gotoCommand, afkCommand]
