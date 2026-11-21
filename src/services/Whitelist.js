// ============================================================
// Whitelist：聊天指令权限（按“权限组”，共三组）
// 组1 owner（最大权限，配置 owners，如 管理员玩家）      ：全部指令
// 组2 friend（白名单组，由 owner 添加）            ：仅 friendCommands 列出的那些指令（面板勾选）
// 组3 tpadmin（传送白名单管理员，配置 tpAdmins）  ：白名单组的指令全部可用 + 传送白名单的加白/清白/看名单；
//      即「管理员 ⊇ 白名单组」（避免同一个人既在白名单又被设成管理员后，反而一条指令都用不了）；
//      他们能给别人的唯一权限 = 「自己 tpa/tpahere 时机器人自动接受」（即 tpPlayers）
// 传送白名单成员 tpPlayers（由 tpadmin / owner 添加）：不响应任何指令；
//      唯一特权 = 他的 tpa / tpahere 机器人自动 /tpaccept
// 其他玩家                                          ：默认不响应；blacklist 优先拒绝
// 注：管理类指令(permission='admin')一律只归 owner；只有 tpAdminCommands（传送白名单那三条）对 tpadmin 开放
// 另：支持临时授权；每人每权限点冷却
// ============================================================
'use strict'

// 传送白名单管理员唯一能用的三条指令：加人 / 移除 / 看名单
const DEFAULT_TP_ADMIN_COMMANDS = ['tpadd', 'tpremove', 'tplist']

class Whitelist {
  /**
   * @param {object} cfg { owners:[], tpAdmins:[], tpPlayers:[], friends:[], blacklist:[], friendCommands:[] }
   */
  constructor (cfg = {}) {
    this.owners = new Set((cfg.owners || []).map(s => String(s).toLowerCase()))
    // 传送白名单管理员（组3）：只能管“传送白名单”，其他权限一律没有
    this.tpAdmins = new Set((cfg.tpAdmins || []).map(s => String(s).toLowerCase()))
    // 传送白名单成员：被授权的唯一福利 = 自己的 tpa/tpahere 机器人自动接受
    this.tpPlayers = new Set((cfg.tpPlayers || []).map(s => String(s).toLowerCase()))
    this.friends = new Set((cfg.friends || []).map(s => String(s).toLowerCase()))
    this.blacklist = new Set((cfg.blacklist || []).map(s => String(s).toLowerCase()))
    // 白名单（组2）可用的指令清单，按指令名；'*' = 不限
    this.friendCommands = new Set((cfg.friendCommands || []).map(s => String(s).toLowerCase()))
    // 每个白名单玩家的个人权限清单（面板可给每人单独勾选）：
    //   key = 小写玩家名，value = Set<指令名>（'*' = 全部非管理指令）
    //   设了个人清单的玩家只按个人清单放行；没设的走上面的公共 friendCommands
    this.friendPerms = new Map()
    for (const [n, list] of Object.entries(cfg.friendPerms || {})) {
      if (!Array.isArray(list)) continue
      this.friendPerms.set(String(n).toLowerCase(), new Set(list.map(s => String(s).toLowerCase()).filter(Boolean)))
    }
    // 组3 能用的指令：默认只有 tpadd / tpremove / tplist
    this.tpAdminCommands = new Set((cfg.tpAdminCommands || DEFAULT_TP_ADMIN_COMMANDS).map(s => String(s).toLowerCase()))
    // 公屏组：在这个名单里的玩家可以在公屏（带 ! 前缀）触发「需私聊」类指令；
    // 同一条公屏广播所有 bot 都会收到，进程内只让第一只收到消息的 bot 执行
    this.pubChatters = new Set((cfg.publicCmds || []).map(s => String(s).toLowerCase()))
    this.tempGrants = new Map() // lowerName -> { role, expireAt }
    this.cooldowns = new Map()  // name|perm -> ts
  }

  _norm (name) { return String(name || '').toLowerCase() }

  // 获取角色组（含临时授权）
  getRole (name) {
    const key = this._norm(name)
    if (this.blacklist.has(key)) return 'blacklisted'

    const grant = this.tempGrants.get(key)
    if (grant) {
      if (Date.now() < grant.expireAt) return grant.role
      this.tempGrants.delete(key)
    }

    if (this.owners.has(key)) return 'owner'
    if (this.tpAdmins.has(key)) return 'tpadmin'
    if (this.friends.has(key)) return 'friend'
    return 'other'
  }

  // 是否在“传送白名单”里（组3 管理员添加的人；不是角色组，只是“自动接受传送”这一项权限）
  isTpPlayer (name) { return this.tpPlayers.has(this._norm(name)) }

  // 是否在「公屏组」里（可以在公屏触发「需私聊」类指令）；黑名单优先拒绝
  isPublicCmd (name) {
    const key = this._norm(name)
    if (this.blacklist.has(key)) return false
    return this.pubChatters.has(key)
  }

  /**
   * 谁能让机器人自动 /tpaccept（收到他的 tpa / tpahere 就接受）：
   *   owner / 传送白名单管理员 / 白名单组 / 传送白名单成员；黑名单与其他人一律不行
   */
  canAcceptTpa (name) {
    const key = this._norm(name)
    if (this.blacklist.has(key)) return false
    const role = this.getRole(name)
    if (role === 'blacklisted') return false
    if (role === 'owner' || role === 'tpadmin' || role === 'friend') return true
    return this.tpPlayers.has(key)
  }

  /**
   * 判断某玩家能不能用某条指令
   * @param {string} name        玩家名
   * @param {string} permission  该指令的权限点（'status'|'control'|'warp'|'admin'）
   * @param {string} [commandName] 指令名（白名单组按指令名放行）
   */
  can (name, permission, commandName) {
    const role = this.getRole(name)
    if (role === 'blacklisted') return false
    if (role === 'owner') return true // 组1：全部指令
    if (role === 'tpadmin') {
      // 组3：传送白名单的加白/清白/看名单——无论他同时还在不在白名单组，都放行
      const n = String(commandName || '').toLowerCase()
      if (n && this.tpAdminCommands.has(n)) return true
      // 其余按「白名单组」处理：管理员天然享有白名单组的全部指令
      if (permission === 'admin') return false
      if (this.friendCommands.has('*')) return true
      return !!n && this.friendCommands.has(n)
    }
    if (role === 'friend') {
      // 组2：按勾选的指令名放行；管理类指令永远只归 owner
      if (permission === 'admin') return false
      // 先看个人权限：设了个人清单就只按个人清单放行（'*' = 全部）
      const personal = this.friendPerms.get(this._norm(name))
      if (personal) {
        if (personal.has('*')) return true
        return !!commandName && personal.has(String(commandName).toLowerCase())
      }
      // 没设个人清单：走白名单组公共勾选
      if (this.friendCommands.has('*')) return true
      return !!commandName && this.friendCommands.has(String(commandName).toLowerCase())
    }
    return false // 传送白名单成员（tpPlayers）与其他玩家：不响应任何指令
  }

  /**
   * 冷却检查：同一玩家同一指令在 cooldownMs 内只放行一次
   * @returns {boolean} true=本次放行，false=仍在冷却
   */
  checkCooldown (name, permission, cooldownMs) {
    if (!cooldownMs || cooldownMs <= 0) return true
    const key = `${this._norm(name)}|${permission}`
    const now = Date.now()
    const ts = this.cooldowns.get(key)
    if (ts != null && now - ts < cooldownMs) return false
    this.cooldowns.set(key, now)
    return true
  }

  // 临时授权（role: 'friend'|'owner'）
  grantTemp (name, role = 'friend', durationMs = 3600000) {
    this.tempGrants.set(this._norm(name), { role, expireAt: Date.now() + durationMs })
  }

  revokeTemp (name) {
    this.tempGrants.delete(this._norm(name))
  }

  /**
   * 设置某个白名单玩家的个人权限清单（按指令名，'*' = 全部非管理指令）
   * 空清单 = 清除个人设置，回退到白名单组公共 friendCommands
   */
  setFriendPerms (name, list) {
    const key = this._norm(name)
    const arr = (Array.isArray(list) ? list : []).map(s => String(s).toLowerCase()).filter(Boolean)
    if (!key || !arr.length) { this.friendPerms.delete(key); return }
    this.friendPerms.set(key, new Set(arr))
  }

  // 取个人权限清单；没设过返回 null（表示跟随公共勾选）
  getFriendPerms (name) {
    const s = this.friendPerms.get(this._norm(name))
    return s ? [...s] : null
  }

  // 删除个人权限（移除白名单时清理）
  deleteFriendPerms (name) {
    this.friendPerms.delete(this._norm(name))
  }

  getSnapshot () {
    return {
      owners: [...this.owners],
      tpAdmins: [...this.tpAdmins],
      tpPlayers: [...this.tpPlayers],
      publicCmds: [...this.pubChatters],
      friends: [...this.friends],
      blacklist: [...this.blacklist],
      friendCommands: [...this.friendCommands],
      friendPerms: Object.fromEntries([...this.friendPerms].map(([n, s]) => [n, [...s]])),
      tempGrants: [...this.tempGrants.entries()].map(([n, v]) => ({ name: n, role: v.role, expireAt: v.expireAt })),
    }
  }
}

module.exports = { Whitelist }
