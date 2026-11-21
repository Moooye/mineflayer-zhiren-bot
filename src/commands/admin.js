// ============================================================
// 管理指令（permission: admin）。三组权限：
//   组1 owner（如 管理员玩家）：全部指令
//   组2 白名单组（owner 添加）：按面板勾选的那几条指令
//   组3 传送白名单管理员：只有下面三条「传送白名单」指令（其余管理指令仍旧只归 owner）
//
//   !重连                  主动重连该机器人（默认仅 owner；可在面板勾给白名单组或个人）
//   !关服 / !下线          停止该机器人（仅 owner）
//   !授权 <玩家> [分钟]    临时授予好友权限，默认 60 分钟（仅 owner）
//   !白名 <玩家>           加入白名单（组2）（仅 owner）
//   !清白 <玩家>           移除白名单（组2）；不带玩家=清空全部（仅 owner）
//   !白名单                查看白名单 / 传送白名单 / 管理员名单（仅 owner）
//   !传送管理员 [删] <玩家> 指定/取消「传送白名单管理员」（组3）（仅 owner）
//   !传送白名 <玩家>       把某人加入传送白名单 = 给他「tpa/tpahere 机器人自动接受」这一项权限
//                          （组3 管理员 + owner；其他权限一律给不了）
//   !传送清白 <玩家>       移出传送白名单（组3 管理员 + owner）
//   !传送名单              查看传送白名单（组3 管理员 + owner）
// ============================================================
'use strict'

// !重连 主动重连该机器人。权限点 'reconnect'（非 admin）：默认仍只有 owner，
// 但可在面板「白名单组可用指令（公共）」或某人「个人权限」里勾给白名单玩家
const reconnectCommand = {
  name: 'reconnect',
  aliases: ['重连'],
  usage: '!重连',
  permission: 'reconnect',
  cooldownMs: 5000,
  async execute ({ ctx, reply }) {
    reply('即将主动重连...')
    ctx.requestReconnect()
  },
}

const shutdownCommand = {
  name: 'shutdown',
  aliases: ['关服', '下线', '关机'],
  usage: '!关服',
  permission: 'admin',
  cooldownMs: 3000,
  async execute ({ ctx, reply }) {
    reply('该机器人即将下线')
    ctx.shutdownBot()
  },
}

const authorizeCommand = {
  name: 'authorize',
  aliases: ['授权', '临时授权'],
  usage: '!授权 <玩家> [分钟]',
  permission: 'admin',
  cooldownMs: 2000,
  async execute ({ args, ctx, reply }) {
    if (!args[0]) return reply('用法：!授权 <玩家> [分钟]')
    const minutes = parseInt(args[1], 10) || 60
    ctx.services.whitelist.grantTemp(args[0], 'friend', minutes * 60000)
    reply(`已临时授权 ${args[0]} 为好友，有效期 ${minutes} 分钟`)
  },
}

// !白名 <玩家>  加入白名单（组2，全局，等同面板“添加白名单”）——只有最高权限者能加
const addFriendCommand = {
  name: 'addfriend',
  aliases: ['白名', '加白'],
  usage: '!白名 <玩家>',
  permission: 'admin',
  cooldownMs: 1500,
  async execute ({ args, ctx, reply }) {
    if (!args[0]) return reply('用法：!白名 <玩家>')
    const r = ctx.manager.addFriend(args[0])
    return reply(r.message)
  },
}

// !清白 <玩家>  移除指定白名单（组2）；不带玩家 = 清空全部白名单
const clearFriendCommand = {
  name: 'clearfriend',
  aliases: ['清白', '移除白名'],
  usage: '!清白 <玩家>（不带玩家=清空全部）',
  permission: 'admin',
  cooldownMs: 1500,
  async execute ({ args, ctx, player, reply }) {
    if (!args[0]) {
      // 双保险：清空全部是高危操作，只允许最高权限者
      if (ctx.services.whitelist.getRole(player) !== 'owner') {
        return reply('清空全部白名单只限最高权限者；要移除请用 !清白 <玩家>')
      }
      const all = ctx.manager.getWhitelist().friends.slice()
      for (const f of all) ctx.manager.removeFriend(f)
      return reply(`已清空全部白名单（${all.length} 人）`)
    }
    const r = ctx.manager.removeFriend(args[0])
    return reply(r.message)
  },
}

// !白名单  总览：组2 白名单 / 传送白名单 / 传送白名单管理员（仅最高权限者）
const friendsCommand = {
  name: 'friends',
  aliases: ['白名单', '查白名单'],
  usage: '!白名单',
  permission: 'admin',
  cooldownMs: 2000,
  async execute ({ ctx, reply }) {
    const w = ctx.manager.getWhitelist()
    const friends = w.friends || []
    const tp = w.tpPlayers || []
    const admins = w.tpAdmins || []
    const parts = [`白名单（${friends.length}）：` + (friends.length ? friends.join('、') : '无')]
    parts.push(`传送白名单（${tp.length}）：` + (tp.length ? tp.join('、') : '无'))
    if (admins.length) parts.push('传送白名单管理员：' + admins.join('、'))
    return reply(parts.join(' ｜ '))
  },
}

// !传送管理员 [删] <玩家>  指定/取消「传送白名单管理员」（组3）——仅最高权限者
const tpAdminCommand = {
  name: 'tpadmin',
  aliases: ['传送管理', '传送管理员', '白名单管理员'],
  usage: '!传送管理员 [删] <玩家>',
  permission: 'admin',
  cooldownMs: 1500,
  async execute ({ args, ctx, reply }) {
    const manager = ctx.manager
    if (!args.length) {
      const cur = manager.getWhitelist().tpAdmins || []
      return reply(cur.length
        ? `传送白名单管理员（${cur.length} 人）：` + cur.join('、')
        : '还没有传送白名单管理员；用 !传送管理员 <玩家> 指定')
    }
    const REMOVE_WORDS = ['删', '移除', '取消', 'remove', 'delete', 'del']
    let name = args[0]
    let removing = false
    if (REMOVE_WORDS.includes(String(name).toLowerCase())) {
      removing = true
      name = args[1]
    }
    if (!name) return reply('用法：!传送管理员 [删] <玩家>')
    const r = removing ? manager.removeTpAdmin(name) : manager.addTpAdmin(name)
    return reply(r.message)
  },
}

// !传送白名 <玩家>  组3 管理员能给的唯一权限：让他的 tpa/tpahere 被机器人自动接受
const tpAddCommand = {
  name: 'tpadd',
  aliases: ['传送白名', '传送加白'],
  usage: '!传送白名 <玩家>',
  permission: 'admin',
  cooldownMs: 1500,
  async execute ({ args, ctx, reply }) {
    if (!args[0]) return reply('用法：!传送白名 <玩家>')
    const r = ctx.manager.addTpPlayer(args[0])
    return reply(r.message)
  },
}

// !传送清白 <玩家>  移出传送白名单
const tpRemoveCommand = {
  name: 'tpremove',
  aliases: ['传送清白', '传送移除'],
  usage: '!传送清白 <玩家>',
  permission: 'admin',
  cooldownMs: 1500,
  async execute ({ args, ctx, reply }) {
    if (!args[0]) return reply('用法：!传送清白 <玩家>')
    const r = ctx.manager.removeTpPlayer(args[0])
    return reply(r.message)
  },
}

// !传送名单  查看传送白名单（组3 管理员 + owner）
const tpListCommand = {
  name: 'tplist',
  aliases: ['传送名单', '传送白名单'],
  usage: '!传送名单',
  permission: 'admin',
  cooldownMs: 2000,
  async execute ({ ctx, reply }) {
    const w = ctx.manager.getWhitelist()
    const tp = w.tpPlayers || []
    const admins = w.tpAdmins || []
    const parts = [`传送白名单（${tp.length}）：` + (tp.length ? tp.join('、') : '无')]
    if (admins.length) parts.push('管理员：' + admins.join('、'))
    parts.push('（名单里的人：他 tpa/tpahere 时机器人自动接受，其他权限不给）')
    return reply(parts.join(' ｜ '))
  },
}

module.exports = [
  reconnectCommand,
  shutdownCommand,
  authorizeCommand,
  addFriendCommand,
  clearFriendCommand,
  friendsCommand,
  tpAdminCommand,
  tpAddCommand,
  tpRemoveCommand,
  tpListCommand,
]
