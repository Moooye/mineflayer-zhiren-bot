// ============================================================
// 功能开关指令：
//   !进食 开/关       自动进食开关（饥饿低于阈值自动取食）
//   !实体过滤 开/关   实体过滤开关（非保留实体从内存隐藏，挂机省 CPU）
// 权限：control（owner）
// 说明：进食进服默认关闭，需收到指令后才开启；实体过滤默认开启（见配置 perf）
// ============================================================
'use strict'

const eatCommand = {
  name: 'eat',
  aliases: ['进食', '自动进食'],
  usage: '!进食 开/关',
  permission: 'control',
  cooldownMs: 2000,
  async execute ({ args, ctx, reply }) {
    const sub = String(args[0] || '').toLowerCase()
    const autoEat = ctx.services.autoEat
    if (['开', '开启', '打开', 'on'].includes(sub)) {
      autoEat.enabled = true
      autoEat.start()
      return reply('自动进食已开启')
    }
    if (['关', '关闭', '关掉', 'off'].includes(sub)) {
      autoEat.enabled = false
      autoEat.stop()
      return reply('自动进食已关闭')
    }
    return reply('用法：!进食 开 / !进食 关')
  },
}

const entityFilterCommand = {
  name: 'entityfilter',
  aliases: ['实体过滤', '隐藏实体', '过滤实体'],
  usage: '!实体过滤 开/关',
  permission: 'control',
  cooldownMs: 2000,
  async execute ({ args, ctx, reply }) {
    const sub = String(args[0] || '').toLowerCase()
    const ef = ctx.services.entityFilter
    if (['开', '开启', '打开', 'on'].includes(sub)) return reply(ef.setEnabled(true).message)
    if (['关', '关闭', '关掉', 'off'].includes(sub)) return reply(ef.setEnabled(false).message)
    const s = ef.getSnapshot()
    return reply(`实体过滤：${s.enabled ? '开' : '关'}；已隐藏 ${s.filtered} 个；保留类型 ${s.keepTypes.join('/')}；视距 ${s.viewDistance == null ? '未改' : s.viewDistance}`)
  },
}

module.exports = [eatCommand, entityFilterCommand]
