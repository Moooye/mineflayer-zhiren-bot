// ============================================================
// 盯人检测指令：
//   !检测 <玩家1> <玩家2>    开始检测「玩家1」：他一离开服务器就自动 /tpa「玩家2」
//   !检测                    查看当前在检测谁
//   !检测 关 [玩家1]         取消（不带玩家=取消全部）
// 两个参数都必填（玩家1=被盯的人，玩家2=tpa 目标）；触发一次后自动解除（避免重复 tpa）；
// 权限点 warp，默认只有最高权限组能用，需要给白名单组的话在面板「白名单组可用指令」里勾上即可。
// 仅私聊（whisperOnly）：公屏发来静默忽略——公屏是广播的，多个机器人会各自登记监听、各自回执。
// ============================================================
'use strict'

const OFF_WORDS = ['关', '取消', '停', '关闭', 'off', 'cancel', 'remove', 'stop']
const USAGE = '用法：!检测 <玩家1> <玩家2>（玩家1 一离开服务器，就自动 /tpa 玩家2）'

function listText (watch) {
  const list = watch.list()
  if (!list.length) return '当前没有在检测任何玩家；' + USAGE
  return `正在检测（${list.length} 人）：` + list.map(w => `${w.name} 离开 → /tpa ${w.target}`).join('、')
}

const detectCommand = {
  name: 'detect',
  aliases: ['检测', '盯人', '监视'],
  usage: '!检测 <玩家1> <玩家2>（玩家1离开服务器则tpa玩家2）',
  permission: 'warp',
  whisperOnly: true,
  cooldownMs: 1500,
  async execute ({ args, ctx, reply }) {
    const watch = ctx.services.playerWatch
    if (!watch) return reply('检测功能不可用（playerWatch 未装配）')
    if (!args.length) return reply(listText(watch))

    if (OFF_WORDS.includes(String(args[0]).toLowerCase())) {
      if (!args[1]) return reply(`已取消全部检测（${watch.clear()} 个）`)
      return reply(watch.unwatch(args[1]).message)
    }

    // 两个参数都必填：玩家1 是被盯的人，玩家2 是 tpa 目标
    const r = watch.watch(args[0], args[1])
    if (!r.ok) return reply(r.message)
    return reply(r.message + '；用 !检测 可随时查看，!检测 关 ' + args[0] + ' 可取消')
  },
}

module.exports = [detectCommand]
