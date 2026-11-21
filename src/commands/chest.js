// ============================================================
// 箱子 / 木桶存取指令（经 ChestManager，走 TaskRunner 串行 + 超时保护）：
//   !存箱            按配置规则把该存的存进仓库箱子（chest.deposit 名单里的）
//   !存箱 全部       除 chest.keep 保留名单外，全部存进去
//   !取 <物品> [数量] 从仓库箱子取出（数量不填 = 尽量取）
//   !开箱            只走过去打开箱子看看有什么，不存不取
//
// ★ 物品名支持中文：!取 铁锭 64 / !取 钻石 / !取 圆石
//   也可写英文 ID（iron_ingot）或片段（铁 → 唯一命中时自动解析，多个命中会列候选）
//   配置里的 chest.keep / chest.deposit 名单同样中英文都能写
//
// 需要先在配置里填仓库点：chest.station 坐标，或 chest.stationAlias（走服务器 home 指令回家）
// 权限：control（owner 或被授予控制权限的白名单玩家）
// 仅私聊（whisperOnly）：公屏发来静默忽略——公屏是广播的，多个机器人会各自跑去同一个箱子
//   翻找/存取，互相顶窗口（服务器同一时刻只允许一个容器窗口），必然混乱。
// ============================================================
'use strict'

const USAGE_存箱 = '用法：!存箱（按配置规则存）或 !存箱 全部（除保留名单外全存）'
const USAGE_取 = '用法：!取 <物品> [数量]，物品可写中文（如 铁锭、钻石、圆石），数量留空 = 尽量取'

const depositCommand = {
  name: 'deposit',
  aliases: ['存箱', '入库'],
  usage: '!存箱 [全部]',
  permission: 'control',
  whisperOnly: true,
  cooldownMs: 3000,
  async execute ({ args, ctx, reply }) {
    const 全部 = ['全部', '所有', 'all', 'full'].includes(String(args[0] || '').toLowerCase())
    const r = await ctx.actionDeposit(全部)
    return reply(r.message)
  },
}

const withdrawCommand = {
  name: 'withdraw',
  aliases: ['取', '取物', '取出'],
  usage: '!取 <物品，可用中文> [数量]',
  permission: 'control',
  whisperOnly: true,
  cooldownMs: 3000,
  async execute ({ args, ctx, reply }) {
    if (!args[0]) return reply(USAGE_取)
    const r = await ctx.actionWithdraw(args[0], args[1])
    return reply(r.message)
  },
}

const peekChestCommand = {
  name: 'peekchest',
  aliases: ['开箱', '看箱', '箱子'],
  usage: '!开箱（走过去打开箱子看看有什么）',
  permission: 'control',
  whisperOnly: true,
  cooldownMs: 3000,
  async execute ({ ctx, reply }) {
    const r = await ctx.actionPeekChest()
    return reply(r.message)
  },
}

module.exports = [depositCommand, withdrawCommand, peekChestCommand]
