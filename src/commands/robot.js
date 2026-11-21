// ============================================================
// 机器人动作类指令（本文件集中注册）：
//   !清空                 一次性丢出全部物品（含盔甲/副手）
//   !攻击 <tick> / !攻击 关  朝正前方定时攻击
//   !移动 x y z [距离]     移动到坐标，默认距目标 0.3 格停止
//   !移动 东|西|南|北 格数  按世界方向移动指定格数
//   !指令 <服务器指令>      让 Bot 执行“允许转发列表”内的服务器指令
//   !说 <内容>             把内容作为普通聊天发到服务器公屏
//   !左转 [角度] / !右转 [角度]  原地转动视角（不移动，默认 90°）
//   !俯视 [角度]           调整视线俯仰角（正下负上，0=平视）
//   !切 <1-9>             切换快捷栏到第几格
//   !副手                 主手当前物品 ⇄ 副手（主手为空则把副手物品拿回）
//   !丢                   把主手和副手物品整组丢出
//   !种树                 摆好手位 → 扫描前方泥土/草方块 → 对准并自动持续右键；缺料私聊告知
//   !装备                 把背包里的头盔/胸甲/护腿/靴子穿上（已有装备不更换）
//   !卸甲                 脱下并丢出身上全部盔甲
//   !右键                 主手右键一次
//   !下车                 按一次 Shift（下车/下马/下船）
//   !持续右键             副手+主手同时连点；再发一次停止（!停止 也能停）
//   !瞄 <x> <y> <z>       把头转向指定坐标
// 权限：control（owner 或被授予控制权限的白名单玩家）
//
// 仅私聊：本文件所有指令都标了 whisperOnly——公屏发来一律静默忽略。
//   公屏是广播的，同服每个机器人都会收到同一条并各自执行一遍（!清空 会互相捡走对方丢出的物品，
//   攻击/移动/装备 会各做一份），所以这些指令必须私聊发。
// ============================================================
'use strict'
const Vec3 = require('vec3').Vec3 || require('vec3')

// 世界方向 → [x增量, z增量]（MC：东 +X，南 +Z）
const DIR_VEC = { 东: [1, 0], 西: [-1, 0], 南: [0, 1], 北: [0, -1] }

const clearCommand = {
  name: 'clear',
  aliases: ['清空', '丢光'],
  usage: '!清空',
  permission: 'control',
  whisperOnly: true,
  cooldownMs: 2000,
  async execute ({ ctx, reply }) {
    const r = await ctx.actionClear()
    await reply(r.message)
  },
}

const attackCommand = {
  name: 'attack',
  aliases: ['攻击', '挥击'],
  usage: '!攻击 <tick数>；关闭 !攻击 关',
  permission: 'control',
  whisperOnly: true,
  cooldownMs: 1000,
  async execute ({ args, ctx, reply }) {
    if (!args.length) return reply('用法：!攻击 <tick数>（20tick=1秒）；关闭 !攻击 关')
    const r = ctx.actionAttack(args)
    await reply(r.message)
  },
}

const moveCommand = {
  name: 'move',
  aliases: ['移动', '走到'],
  usage: '!移动 x y z [距离] 或 !移动 东/西/南/北 格数',
  permission: 'control',
  whisperOnly: true,
  cooldownMs: 1500,
  async execute ({ args, ctx, reply }) {
    if (args.length < 2) return reply('用法：!移动 x y z [距离] 或 !移动 东/西/南/北 格数')
    const p = ctx.bot.entity.position

    // 形式一：!移动 <方向> <格数>
    if (DIR_VEC[args[0]]) {
      const blocks = Number(args[1])
      if (!Number.isFinite(blocks) || blocks <= 0) return reply('格数需为正数')
      const [dx, dz] = DIR_VEC[args[0]]
      // 以当前所在格为起点，计算目标格，y 保持当前
      const tx = Math.floor(p.x) + dx * blocks
      const tz = Math.floor(p.z) + dz * blocks
      const ty = Math.floor(p.y)
      const r = await ctx.actionMoveTo(tx, ty, tz, 0.3)
      return reply(r.message)
    }

    // 形式二：!移动 <x> <y> <z> [距离]
    const x = Number(args[0]); const y = Number(args[1]); const z = Number(args[2])
    if (![x, y, z].every(Number.isFinite)) return reply('坐标需为数字：!移动 x y z [距离]')
    const r = await ctx.actionMoveTo(x, y, z, args[3])
    return reply(r.message)
  },
}

const runServerCommand = {
  name: 'runcmd',
  aliases: ['指令', '执行指令'],
  usage: '!指令 <服务器指令>（无需输入 /）',
  permission: 'control',
  whisperOnly: true,
  cooldownMs: 1500,
  async execute ({ args, ctx, reply }) {
    if (!args.length) return reply('用法：!指令 <服务器指令>（前面不用加 /）')
    const raw = args.join(' ').replace(/^\/+/, '')
    const cmdName = raw.split(/\s+/)[0].toLowerCase()
    // 允许转发列表（配置 commands.allowedServerCommands）
    const allow = (ctx.globalCfg.commands.allowedServerCommands || []).map(x => String(x).toLowerCase())
    if (!allow.includes(cmdName)) return reply(`服务器指令「${cmdName}」不在允许转发列表`)
    await ctx.services.chatQueue.sendCommand('/' + raw, { priority: 5, dedupe: false })
    return reply(`已让机器人执行：/${raw}`)
  },
}

// 跨机器人去重：多个 bot 同时在线时会各自收到同一条公聊指令，
// 不加这层保护会变成“几个机器人同时刷同一句话”。
// robot.js 在进程内只被 require 一次，所以这个 Map 是各 bot 共享的。
const recentSays = new Map()
function claimSay (player, text) {
  const key = `${String(player || '').toLowerCase()}|${text}`
  const now = Date.now()
  const ts = recentSays.get(key)
  if (ts != null && now - ts < 3000) return false
  recentSays.set(key, now)
  if (recentSays.size > 200) recentSays.clear()
  return true
}

const sayCommand = {
  name: 'say',
  aliases: ['说', '公屏', '发言'],
  usage: '!说 <内容>',
  permission: 'control',
  cooldownMs: 2000,
  async execute ({ args, ctx, player, reply }) {
    const text = args.join(' ').trim()
    if (!text) return reply('用法：!说 <内容>（内容会作为聊天发到服务器公屏）')
    if (ctx.status !== 'online') return reply('机器人当前不在线，无法发言')
    // 别的机器人已代为发言：这里静默，避免几个 bot 刷同一句话
    if (!claimSay(player, text)) return
    const sent = await ctx.services.chatQueue.send(text, { priority: 5, dedupe: false })
    if (!sent) return reply('发言失败：聊天队列繁忙，请稍后再试')
    return reply(`已公屏发言：${text}`)
  },
}

const turnLeftCommand = {
  name: 'turnleft',
  aliases: ['左转'],
  usage: '!左转 [角度]（默认 90°）',
  permission: 'control',
  whisperOnly: true,
  cooldownMs: 600,
  async execute ({ args, ctx, reply }) {
    const r = await ctx.actionTurn('left', args[0])
    await reply(r.message)
  },
}

const turnRightCommand = {
  name: 'turnright',
  aliases: ['右转'],
  usage: '!右转 [角度]（默认 90°）',
  permission: 'control',
  whisperOnly: true,
  cooldownMs: 600,
  async execute ({ args, ctx, reply }) {
    const r = await ctx.actionTurn('right', args[0])
    await reply(r.message)
  },
}

// 俯视：把视线调到「水平向下 x 度」（正数向下、负数向上，0 = 平视），用来对准目标
const lookDownCommand = {
  name: 'lookdown',
  aliases: ['俯视', '下视', '向上看'],
  usage: '!俯视 [角度 -90~90]（正数向下、负数向上；0=平视，不填默认 30°）',
  permission: 'control',
  whisperOnly: true,
  cooldownMs: 600,
  async execute ({ args, ctx, reply }) {
    const r = await ctx.actionLookDown(args[0])
    await reply(r.message)
  },
}

// 切换快捷栏：!切 1-9 → bot.setQuickBarSlot(0-8)
const hotbarCommand = {
  name: 'hotbar',
  aliases: ['切', '快捷栏'],
  usage: '!切 <1-9>（切换快捷栏到第几格）',
  permission: 'control',
  whisperOnly: true,
  cooldownMs: 600,
  async execute ({ args, ctx, reply }) {
    const n = Number(args[0])
    if (!Number.isInteger(n) || n < 1 || n > 9) return reply('用法：!切 <1-9>（切换到快捷栏第几格）')
    if (ctx.status !== 'online') return reply('机器人当前不在线，无法切换快捷栏')
    try {
      ctx.bot.setQuickBarSlot(n - 1)
      await reply(`已切换到快捷栏第 ${n} 格`)
    } catch (e) {
      await reply(`切换快捷栏失败：${e.message}`)
    }
  },
}

// 副手：把主手当前物品转移到副手（副手有东西则交换；主手为空则把副手物品拿回主手）
const offhandCommand = {
  name: 'offhand',
  aliases: ['副手', '换副手'],
  usage: '!副手（主手物品 ⇄ 副手）',
  permission: 'control',
  whisperOnly: true,
  cooldownMs: 800,
  async execute ({ ctx, reply }) {
    if (ctx.status !== 'online') return reply('机器人当前不在线，无法操作副手')
    const mainIdx = 36 + (ctx.bot.quickBarSlot || 0) // 快捷栏当前格（36-44）即主手
    const offIdx = 45 // 副手槽
    const slots = (ctx.bot.inventory && ctx.bot.inventory.slots) || []
    const main = slots[mainIdx]
    const off = slots[offIdx]
    try {
      if (main) {
        await ctx.bot.moveSlotItem(mainIdx, offIdx)
        await reply(`已把主手的「${main.displayName || main.name}」转移到副手`)
      } else if (off) {
        await ctx.bot.moveSlotItem(offIdx, mainIdx)
        await reply(`主手为空，已把副手的「${off.displayName || off.name}」拿回主手`)
      } else {
        await reply('主手和副手都是空的，没东西可转移')
      }
    } catch (e) {
      await reply(`副手操作失败：${e.message}`)
    }
  },
}

// 丢：把主手和副手的物品整组丢出（哪个有丢哪个，都空则提示）
const tossHandCommand = {
  name: 'toss',
  aliases: ['丢', '丢掉'],
  usage: '!丢（丢出主手+副手物品）',
  permission: 'control',
  whisperOnly: true,
  cooldownMs: 800,
  async execute ({ ctx, reply }) {
    if (ctx.status !== 'online') return reply('机器人当前不在线，无法丢物品')
    const mainIdx = 36 + (ctx.bot.quickBarSlot || 0) // 快捷栏当前格（36-44）即主手
    const slots = (ctx.bot.inventory && ctx.bot.inventory.slots) || []
    const main = slots[mainIdx]
    const off = slots[45] // 副手槽
    const thrown = []
    try {
      if (main) {
        await ctx.bot.tossStack(main)
        thrown.push(`主手「${main.displayName || main.name}」`)
      }
      if (off) {
        await ctx.bot.tossStack(off)
        thrown.push(`副手「${off.displayName || off.name}」`)
      }
      if (!thrown.length) return reply('主手和副手都是空的，没东西可丢')
      await reply(`已丢出：${thrown.join('、')}`)
    } catch (e) {
      await reply(`丢物品失败${thrown.length ? `（已丢出 ${thrown.join('、')}，剩下的没丢）` : ''}：${e.message}`)
    }
  },
}

// 持续右键连点核心：副手+主手同时右键（约每 300ms 一轮）；掉线自动停（种树和持续右键共用）
function startContinuousUse (ctx) {
  stopContinuousUse(ctx)
  ctx.continuousUse = setInterval(() => {
    if (ctx.status !== 'online') { // 掉线自动停
      stopContinuousUse(ctx)
      return
    }
    try { ctx.bot.activateItem(true) } catch (_) { /* 副手 */ }
    try { ctx.bot.activateItem(false) } catch (_) { /* 主手 */ }
    setTimeout(() => {
      try { ctx.bot.deactivateItem() } catch (_) { /* 忽略 */ }
    }, 120)
  }, 300)
}

function stopContinuousUse (ctx) {
  if (ctx.continuousUse) {
    clearInterval(ctx.continuousUse)
    ctx.continuousUse = null
    return true
  }
  return false
}

// 种树：摆好「副手树苗、主手骨粉」→ 扫描正前方泥土/草方块 → 对准后自动开始持续右键；
// 缺料时私聊告知发指令的玩家；再发一次「持续右键」或「停止」可停止连点
const plantCommand = {
  name: 'plant',
  aliases: ['种树'],
  usage: '!种树（摆好手位并对准前方泥土/草方块自动持续右键；缺料私聊告知）',
  permission: 'control',
  whisperOnly: true,
  cooldownMs: 3000,
  async execute ({ ctx, reply }) {
    if (ctx.status !== 'online') return reply('机器人当前不在线，无法种树')
    const slots = (ctx.bot.inventory && ctx.bot.inventory.slots) || []
    const isSapling = it => it && /_sapling$/.test(it.name)
    const isMeal = it => it && it.name === 'bone_meal'
    const mainIdx = 36 + (ctx.bot.quickBarSlot || 0)
    const missing = []
    try {
      if (!isSapling(slots[45])) { // 副手不是树苗 → 找一棵换上来（槽位被占用自动交换）
        let idx = -1
        for (let i = 9; i <= 44; i++) { if (slots[i] && isSapling(slots[i])) { idx = i; break } }
        if (idx >= 0) await ctx.bot.moveSlotItem(idx, 45)
        else missing.push('树苗')
      }
      if (!isMeal(slots[mainIdx])) { // 主手不是骨粉 → 找一份换上来
        let idx = -1
        for (let i = 9; i <= 44; i++) { if (slots[i] && isMeal(slots[i])) { idx = i; break } }
        if (idx >= 0) await ctx.bot.moveSlotItem(idx, mainIdx)
        else missing.push('骨粉')
      }
      if (missing.length) return reply(`背包里没有${missing.join('和')}，种不了树`) // sendReply 私聊到发指令的人

      // 扫描正前方 7 格内的可种面：由近及远，每格先查地面层（与脚下同层，最常见），再查与脚同层
      const p = ctx.bot.entity.position
      const yaw = ctx.bot.entity.yaw
      // mineflayer 内部视线方向（见 node_modules/mineflayer/lib/plugins/ray_trace.js getViewDirection）：
      //   水平分量 = (-sin(yaw), -cos(yaw))
      const dx = -Math.sin(yaw); const dz = -Math.cos(yaw)
      const plantable = b => b && /^(grass_block|dirt|podzol|coarse_dirt|rooted_dirt|mycelium)$/.test(b.name)
      let target = null
      try {
        for (let i = 1; i <= 7 && !target; i++) {
          const ground = ctx.bot.blockAt(p.offset(dx * i, -1, dz * i).floored())
          if (plantable(ground)) { target = ground; continue }
          const feet = ctx.bot.blockAt(p.offset(dx * i, 0, dz * i).floored())
          if (plantable(feet)) target = feet
        }
      } catch (_) { /* 区块未加载等异常当作没扫到 */ }

      if (!target) return reply('正前方没有找到泥土/草方块，已摆好手位但未开始种植；请对准种植区后再发一次「种树」')
      await ctx.bot.lookAt(target.position.offset(0.5, 1, 0.5)) // 对准该方块顶面中心
      startContinuousUse(ctx) // 副手种苗 + 主手催熟一起连点
      await reply('已对准前方种植区并开始持续右键（副手树苗、主手骨粉）；再发一次「持续右键」或「停止」可停')
    } catch (e) {
      await reply(`种树失败：${e.message}`)
    }
  },
}

// 盔甲槽位：5 头盔 / 6 胸甲 / 7 护腿 / 8 靴子
const ARMOR_SLOTS = [
  { idx: 5, label: '头盔', test: n => /_helmet$|_head$/.test(n) },
  { idx: 6, label: '胸甲', test: n => /_chestplate$/.test(n) },
  { idx: 7, label: '护腿', test: n => /_leggings$/.test(n) },
  { idx: 8, label: '靴子', test: n => /_boots$/.test(n) },
]

// 装备：把背包里的头盔/胸甲/护腿/靴子穿到对应盔甲槽（槽位已有装备则不更换）
const equipCommand = {
  name: 'equip',
  aliases: ['装备', '穿甲'],
  usage: '!装备（穿上背包里的盔甲）',
  permission: 'control',
  whisperOnly: true,
  cooldownMs: 3000,
  async execute ({ ctx, reply }) {
    if (ctx.status !== 'online') return reply('机器人当前不在线，无法装备')
    const slots = (ctx.bot.inventory && ctx.bot.inventory.slots) || []
    const done = []; const skip = []; const none = []
    try {
      for (const a of ARMOR_SLOTS) {
        const worn = slots[a.idx]
        if (worn) { skip.push(`${a.label}（已穿着 ${worn.displayName || worn.name}）`); continue }
        let from = -1
        for (let i = 9; i <= 44; i++) { // 背包主储物格 + 快捷栏
          const it = slots[i]
          if (it && a.test(it.name)) { from = i; break }
        }
        if (from < 0) { none.push(a.label); continue }
        await ctx.bot.moveSlotItem(from, a.idx)
        done.push(`${a.label}（${slots[a.idx].displayName || slots[a.idx].name}）`)
      }
      const parts = []
      if (done.length) parts.push(`已穿上：${done.join('、')}`)
      if (skip.length) parts.push(`保留：${skip.join('、')}`)
      if (none.length) parts.push(`背包里没有：${none.join('、')}`)
      await reply(parts.length ? parts.join('；') : '背包里没有可装备的盔甲')
    } catch (e) {
      await reply(`装备失败${done.length ? `（已穿上 ${done.join('、')}，剩下的没穿）` : ''}：${e.message}`)
    }
  },
}

// 卸甲：把身上穿的头盔/胸甲/护腿/靴子全部脱下并丢出
const unequipCommand = {
  name: 'unequip',
  aliases: ['卸甲', '脱甲'],
  usage: '!卸甲（脱下并丢出身上全部盔甲）',
  permission: 'control',
  whisperOnly: true,
  cooldownMs: 3000,
  async execute ({ ctx, reply }) {
    if (ctx.status !== 'online') return reply('机器人当前不在线，无法卸甲')
    const slots = (ctx.bot.inventory && ctx.bot.inventory.slots) || []
    const tossed = []
    try {
      for (const a of ARMOR_SLOTS) {
        const worn = slots[a.idx]
        if (!worn) continue
        await ctx.bot.tossStack(worn)
        tossed.push(`${a.label}（${worn.displayName || worn.name}）`)
      }
      if (!tossed.length) return reply('身上没有穿任何盔甲')
      await reply(`已卸下并丢出：${tossed.join('、')}`)
    } catch (e) {
      await reply(`卸甲失败${tossed.length ? `（已丢出 ${tossed.join('、')}，剩下的没丢）` : ''}：${e.message}`)
    }
  },
}

// 右键：主手右键一次
const useCommand = {
  name: 'use',
  aliases: ['右键'],
  usage: '!右键（右键一次，主手）',
  permission: 'control',
  whisperOnly: true,
  cooldownMs: 600,
  async execute ({ ctx, reply }) {
    if (ctx.status !== 'online') return reply('机器人当前不在线，无法右键')
    try {
      ctx.bot.activateItem(false) // false = 主手
      await new Promise(r => setTimeout(r, 150))
      try { ctx.bot.deactivateItem() } catch (_) { /* 忽略 */ }
      await reply('已右键一次')
    } catch (e) {
      await reply(`右键失败：${e.message}`)
    }
  },
}

// 下车：按一次 Shift（潜行一下），用于下车/下马/下船
const dismountCommand = {
  name: 'dismount',
  aliases: ['下车', '下马'],
  usage: '!下车（按一次 Shift）',
  permission: 'control',
  whisperOnly: true,
  cooldownMs: 1000,
  async execute ({ ctx, reply }) {
    if (ctx.status !== 'online') return reply('机器人当前不在线，无法下车')
    try {
      ctx.bot.setControlState('sneak', true)
      await new Promise(r => setTimeout(r, 250))
      ctx.bot.setControlState('sneak', false)
      await reply('已按一次 Shift（下车）')
    } catch (e) {
      try { ctx.bot.setControlState('sneak', false) } catch (_) { /* 忽略 */ }
      await reply(`下车失败：${e.message}`)
    }
  },
}

// 持续右键：副手+主手同时连点（约每 300ms 一轮）；再发一次「持续右键」停止
const continuousUseCommand = {
  name: 'continuoususe',
  aliases: ['持续右键', '持续键'],
  usage: '!持续右键（副手+主手连点；再发一次停止）',
  permission: 'control',
  whisperOnly: true,
  cooldownMs: 1500,
  async execute ({ ctx, reply }) {
    if (stopContinuousUse(ctx)) return reply('已停止持续右键') // 已在连点 → 停止
    if (ctx.status !== 'online') return reply('机器人当前不在线，无法持续右键')
    startContinuousUse(ctx)
    await reply('已开始持续右键（副手+主手同时连点）；再发一次「持续右键」可停止')
  },
}

// 瞄：把头转向指定坐标（只摆头，不移动）
const aimCommand = {
  name: 'aim',
  aliases: ['瞄', '瞄准'],
  usage: '!瞄 <x> <y> <z>',
  permission: 'control',
  whisperOnly: true,
  cooldownMs: 800,
  async execute ({ args, ctx, reply }) {
    if (ctx.status !== 'online') return reply('机器人当前不在线，无法瞄准')
    if (args.length < 3) return reply('用法：瞄 <x> <y> <z>，例如 瞄 100 64 -200')
    const nums = args.slice(0, 3).map(Number)
    if (nums.some(n => !Number.isFinite(n))) return reply('坐标必须是数字，例如：瞄 100 64 -200')
    const [x, y, z] = nums
    try {
      await ctx.bot.lookAt(new Vec3(x, y, z)) // mineflayer 会从眼睛位置自动算 yaw/pitch
      await reply(`已瞄准 (${x}, ${y}, ${z})`)
    } catch (e) {
      await reply(`瞄准失败：${e.message}`)
    }
  },
}

module.exports = [
  clearCommand, attackCommand, moveCommand, runServerCommand, sayCommand,
  turnLeftCommand, turnRightCommand, lookDownCommand, hotbarCommand, offhandCommand,
  tossHandCommand, plantCommand, equipCommand, unequipCommand,
  useCommand, dismountCommand, continuousUseCommand, aimCommand,
]
