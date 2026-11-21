// ============================================================
// 灾厄之瓶指令：
//   !瓶子 开 <分钟>  立即喝一瓶，成功后每 <分钟> 再喝
//   !瓶子 关         停止定时
// 权限：control（owner）
// 仅私聊（whisperOnly）：公屏发来静默忽略——公屏是广播的，多个机器人会各自喝一瓶并各自回执。
// ============================================================
'use strict'

const bottleCommand = {
  name: 'bottle',
  aliases: ['瓶子', '灾厄之瓶'],
  usage: '!瓶子 开 <分钟> / !瓶子 关',
  permission: 'control',
  whisperOnly: true,
  cooldownMs: 1000,
  async execute ({ args, ctx, reply }) {
    const sub = String(args[0] || '').toLowerCase()
    const runner = ctx.services.bottleRunner
    if (['开', '开启', '打开', 'on'].includes(sub)) {
      const r = await runner.start(args[1])
      return reply(r.message)
    }
    if (['关', '关闭', '关掉', 'off'].includes(sub)) {
      const r = runner.stop()
      return reply(r.message)
    }
    return reply('用法：!瓶子 开 <分钟>（立即喝一瓶并定时） 或 !瓶子 关')
  },
}

module.exports = [bottleCommand]
