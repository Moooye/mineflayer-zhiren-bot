// ============================================================
// ConfigStore：把面板上的管理改动持久化到 <配置名>.panel.json
//  - 仅保存可变部分：server(host/port/version) 与 accounts(username/enabled/auth)
//  - 不重写带中文注释的原始 .js；configLoader 启动时自动合并该覆盖层
// ============================================================
'use strict'
const fs = require('fs')

class ConfigStore {
  /**
   * @param {object} cfg 已加载（含 __configPath）的全局配置
   */
  constructor (cfg) {
    this.cfg = cfg
    const base = String(cfg.__configPath || '').replace(/\.(c?js|json)$/i, '')
    this.panelPath = (base || 'config/accounts') + '.panel.json'
  }

  // 保存当前 server 与 accounts 到覆盖层，返回写入路径
  save () {
    const s = this.cfg.server || {}
    const wl = this.cfg.whitelist || {}
    // 个人权限：只保留「玩家名 -> 字符串数组」的有效项
    const friendPerms = {}
    if (wl.friendPerms && typeof wl.friendPerms === 'object') {
      for (const [k, v] of Object.entries(wl.friendPerms)) {
        if (Array.isArray(v)) friendPerms[k] = v.map(x => String(x).toLowerCase())
      }
    }
    const data = {
      server: { host: s.host, port: s.port, version: s.version === undefined ? false : s.version },
      accounts: (this.cfg.accounts || []).map(a => {
        const row = {
          username: a.username,
          enabled: a.enabled !== false,
          auth: a.auth === 'offline' ? 'offline' : 'microsoft',
        }
        // 账号级独立服务器（未单独设置则不写入，连接时回退全局默认）
        if (a.server && a.server.host) {
          row.server = {
            host: a.server.host,
            port: Number(a.server.port) || undefined,
            version: a.server.version === undefined ? false : a.server.version,
          }
        }
        return row
      }),
      // 白名单：好友名单 + 好友组可用指令 + 每人个人权限 + 传送白名单管理员 + 传送白名单（owners 不在此管理）
      whitelist: {
        friends: Array.isArray(wl.friends) ? wl.friends.slice() : [],
        friendCommands: Array.isArray(wl.friendCommands) ? wl.friendCommands.slice() : [],
        friendPerms,
        tpAdmins: Array.isArray(wl.tpAdmins) ? wl.tpAdmins.slice() : [],
        tpPlayers: Array.isArray(wl.tpPlayers) ? wl.tpPlayers.slice() : [],
      },
    }
    fs.writeFileSync(this.panelPath, JSON.stringify(data, null, 2), 'utf8')
    return this.panelPath
  }
}

module.exports = { ConfigStore }
