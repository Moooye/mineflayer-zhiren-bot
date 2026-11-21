// ============================================================
// 状态查询指令：!状态 / !status
// 回复：在线状态、坐标、血量、饥饿、维度、在线时长、背包占用
// 仅私聊（whisperOnly）：公屏发来静默忽略——公屏是广播的，多个机器人会各自回一条，
//   变成三份重复回执；私聊发给某一个机器人，只看它自己的状态。
// ============================================================
'use strict'

function fmtUptime (ms) {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${h}时${m}分${sec}秒`
}

// 秒数格式化为 “x分y秒” / “y秒”
function fmtSec (s) {
  const v = Math.max(0, Number(s) || 0)
  const m = Math.floor(v / 60)
  const r = v % 60
  return m > 0 ? `${m}分${r}秒` : `${r}秒`
}

const statusCommand = {
  name: 'status',
  aliases: ['状态', 'zt'],
  usage: '!状态',
  permission: 'status',
  whisperOnly: true,
  cooldownMs: 3000,
  async execute ({ ctx, reply }) {
    const bot = ctx.bot
    const p = bot.entity.position
    const used = bot.inventory.items().length
    const since = ctx.onlineSince ? Date.now() - ctx.onlineSince : 0
    await reply(
      `【${ctx.account.username}】坐标 ${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)} ` +
      `血量 ${(bot.health || 0).toFixed(0)}/20 饥饿 ${bot.food}/20 ` +
      `维度 ${(bot.game && bot.game.dimension) || '?'} 背包 ${used}/36` +
      (since ? ` 在线 ${fmtUptime(since)}` : '')
    )

    // 功能开关总览（统一展示，关闭也标注）
    const br = ctx.services.bottleRunner
    const snap = br ? br.getSnapshot() : null
    const afkOn = ctx.getStatus().antiAfk
    const eatOn = ctx.services.autoEat ? ctx.services.autoEat.enabled : false
    const atkSnap = ctx.services.attackRunner.getSnapshot()
    await reply(`功能：防AFK${afkOn ? '开' : '关'} 进食${eatOn ? '开' : '关'} 瓶子${snap && snap.enabled ? '开' : '关'} 攻击${atkSnap.enabled ? '开' : '关'}`)
    if (atkSnap.enabled) await reply(`攻击任务：开启，每 ${atkSnap.intervalTicks} tick（约 ${(atkSnap.intervalTicks / 20).toFixed(2).replace(/\.?0+$/, '')} 秒）一次`)

    // 瓶子任务详情 / omen buff / 袭击：各发一条（不使用换行，避免非法字符）
    if (snap) {
      if (snap.enabled) await reply(`瓶子任务：开启，下一瓶 ${fmtSec(snap.nextInSeconds)}后`)
      if (snap.buff) await reply(`${snap.buff.label}：剩余 ${fmtSec(snap.buff.seconds)}`)
      if (snap.raid) await reply(`袭击：进行中（进度 ${snap.raid.progress}%）`)
    }
  },
}

module.exports = [statusCommand]
