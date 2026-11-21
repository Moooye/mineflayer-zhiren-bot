// ============================================================
// 传送请求指令（经 WarpQueue，防刷屏）：
//   !tpa <玩家>       请求传送到对方
//   !tpahere <玩家>   请求对方传送到我这
//   !设家 [家名]      sethome 1（家名默认 1）
//   !删除家 [家名]    delhome 1（家名默认 1）
//
// 仅私聊：本文件四条全部标了 whisperOnly——公屏发来一律静默忽略。
//   传送类一旦被多个机器人同时执行，会三份请求 + 三份回执，还会互相撞位置，
//   所以必须私聊单独发给某一个机器人。
// ============================================================
'use strict'

const { warpStatusCn } = require('../utils/helpers')

const tpaCommand = {
  name: 'tpa',
  aliases: ['传送'],
  usage: '!tpa <玩家>',
  permission: 'warp',
  whisperOnly: true,
  cooldownMs: 3000,
  async execute ({ args, ctx, reply }) {
    if (!args[0]) return reply('用法：!tpa <玩家>')
    const r = await ctx.services.warpQueue.tpa(args[0])
    reply(`tpa 请求已处理：${warpStatusCn(r.status)}`)
  },
}

const tpahereCommand = {
  name: 'tpahere',
  aliases: ['让他来', '叫他来'],
  usage: '!tpahere <玩家>',
  permission: 'warp',
  whisperOnly: true,
  cooldownMs: 3000,
  async execute ({ args, ctx, reply }) {
    if (!args[0]) return reply('用法：!tpahere <玩家>')
    const r = await ctx.services.warpQueue.tpahere(args[0])
    reply(`tpahere 请求已处理：${warpStatusCn(r.status)}`)
  },
}

const delhomeCommand = {
  name: 'delhome',
  aliases: ['删除家', '删家'],
  usage: '!删除家 [家名，默认1]',
  permission: 'warp',
  whisperOnly: true,
  cooldownMs: 2000,
  async execute ({ args, ctx, reply }) {
    const r = await ctx.services.warpQueue.delhome(args[0])
    reply(`删除家指令已处理：${warpStatusCn(r.status)}`)
  },
}

const sethomeCommand = {
  name: 'sethome',
  aliases: ['设家', '设置家'],
  usage: '!设家 [家名，默认1]',
  permission: 'warp',
  whisperOnly: true,
  cooldownMs: 2000,
  async execute ({ args, ctx, reply }) {
    const r = await ctx.services.warpQueue.sethome(args[0])
    reply(`设家指令已处理：${warpStatusCn(r.status)}`)
  },
}

module.exports = [tpaCommand, tpahereCommand, sethomeCommand, delhomeCommand]
