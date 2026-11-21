// ============================================================
// CommandRegistry：聊天指令注册 / 解析 / 权限 / 冷却
// 触发：公聊带前缀（默认 !，全角 ！ 等价）；主管私聊可省略前缀
//       另：服务器插件改写过格式的私聊（如 [A ➥ 机器人] 内容）也会当私聊指令处理
// 仅私聊：指令定义里标了 whisperOnly:true 的，只认私聊——公屏发来直接静默忽略。
//       公屏是广播的，同服多个机器人都会收到同一条并各自执行（多份动作 + 多份回执，
//       还可能出现互相撞位置、互相捡走丢出物），因此这类指令必须走私聊。
// 流程：解析指令名 → [仅私聊则拦公屏] → Whitelist 权限 → 冷却 → execute；
//      陌生人无权限静默（防探测）；owner/白名单组/传送白名单管理员被拒时，私聊回一句原因（每人 30 秒最多一句），
//      避免出现「发指令没反应、以为是坏了」的情况；
//      回复统一走 BotContext.sendReply（面板日志 + 游戏内到人；/tell 被服务器拒了会自动改公屏）
// ============================================================
'use strict'

class CommandRegistry {
  /**
   * @param {object} botContext BotContext
   * @param {object} options    { prefix:'!' }
   */
  constructor (botContext, options = {}) {
    this.ctx = botContext
    this.prefix = options.prefix || '!'
    this.map = new Map()
    this.alias = new Map()
    this._shush = new Map() // 玩家名 -> 上次“没这条指令/没权限”提示时间（节流，防刷屏）
  }

  // 注册一条指令
  register (def) {
    this.map.set(def.name, def)
    ;(def.aliases || []).forEach(a => this.alias.set(a, def.name))
  }

  registerAll (defs) { defs.forEach(d => this.register(d)) }

  resolve (name) {
    if (this.map.has(name)) return this.map.get(name)
    if (this.alias.has(name)) return this.map.get(this.alias.get(name))
    return null
  }

  /**
   * 处理一条入站消息
   * @param {object} p { username, message, isWhisper }
   */
  async handle ({ username, message, isWhisper }) {
    let text = String(message || '').trim()
    // 全角 ！ 与半角 ! 等价（中文输入法下很容易打成全角）
    if (text.startsWith('！')) text = this.prefix + text.slice(1)
    if (text.startsWith(this.prefix)) {
      text = text.slice(this.prefix.length)
    } else if (!isWhisper) {
      return // 公聊必须带前缀
    }

    const parts = text.split(/\s+/)
    const name = (parts.shift() || '').toLowerCase()
    if (!name) return
    const def = this.resolve(name)
    if (!def) { this._notifyUnknown(username, name, isWhisper); return }

    // 仅私聊指令（whisperOnly）：公屏发来默认静默忽略。
    // 例外：「公屏组」玩家（面板可勾选）可以在公屏触发这类指令——
    //       不做防重复，同一条公屏广播每只 bot 都各自执行（用户要求不防重复）。
    if (def.whisperOnly && !isWhisper) {
      if (!this.ctx.services.whitelist.isPublicCmd(username)) return
    }

    const wl = this.ctx.services.whitelist
    if (!wl.can(username, def.permission, def.name)) {
      this._notifyDenied(username, def.name) // 已知角色才回一句；陌生人仍然完全静默
      return
    }
    if (!wl.checkCooldown(username, def.permission, def.cooldownMs)) return

    const reply = t => this.reply(username, t)
    try {
      await def.execute({ args: parts, ctx: this.ctx, player: username, reply, isWhisper })
    } catch (e) {
      if (this.ctx.logger) this.ctx.logger.error(`指令 ${name} 出错：${e.message}`)
      reply(`指令「${name}」执行出错：${e.message}`)
    }
  }

  // 被拒时给一句解释（只对已知角色，陌生人继续静默；每人 30 秒最多一句，防刷屏）
  _notifyDenied (username, commandName) {
    const role = this._knownRole(username)
    if (!role) return
    if (!this._shushOk(username)) return
    const allow = [...(this.ctx.services.whitelist.friendCommands || [])].filter(n => n !== '*')
    const list = allow.length ? `白名单组指令（${allow.slice(0, 14).join('/')}${allow.length > 14 ? '…' : ''}）` : '白名单组指令（未勾选任何指令）'
    const tip = role === 'tpadmin'
      ? `这条「${commandName}」现在没开放给你。你是传送白名单管理员：可用 传送白名/传送清白/传送名单，以及 ${list}`
      : `这条「${commandName}」没开放给白名单组。当前可用：${list}`
    this._safeReply(username, tip)
  }

  // 指令名对不上时也回一句（仅私聊，且只对已知角色；公屏不刷屏）
  _notifyUnknown (username, name, isWhisper) {
    if (!isWhisper) return
    if (!this._knownRole(username)) return
    if (!this._shushOk(username)) return
    this._safeReply(username, `没这条指令：「${name || '(空)'}」。公屏要带前缀 !（全角 ！也行），私聊可直接写指令名，例如「回家」或「!回家」`)
  }

  // owner / friend / tpadmin 才回话；陌生人和黑名单不理（防探测）
  _knownRole (username) {
    const role = this.ctx.services.whitelist.getRole(username)
    return (role === 'owner' || role === 'friend' || role === 'tpadmin') ? role : null
  }

  _shushOk (username) {
    const key = String(username || '').toLowerCase()
    const now = Date.now()
    if (now - (this._shush.get(key) || 0) < 30000) return false
    this._shush.set(key, now)
    if (this._shush.size > 200) this._shush.clear()
    return true
  }

  _safeReply (to, text) {
    try { Promise.resolve(this.reply(to, text)).catch(() => {}) } catch (_) { /* 回复失败不影响主流程 */ }
  }

  // 回复玩家：交给 BotContext.sendReply 统一处理
  //  - 面板控制台日志（带（私聊）/（公屏）标注）
  //  - 游戏内到人：默认 /tell 私聊；服务器拒绝时自动改公屏（配置 reply.*）
  async reply (to, text) {
    return await this.ctx.sendReply(to, text)
  }
}

// 指令目录：不依赖运行中的 bot（面板的权限勾选框、权限校验都用它）
// 注意：新增指令文件时要在这里登记
function loadAllCommands () {
  return [].concat(
    require('./status'),
    require('./movement'),
    require('./warp'),
    require('./detect'),
    require('./bottle'),
    require('./features'),
    require('./chest'),
    require('./scanchest'),
    require('./robot'),
    require('./admin'),
  )
}

module.exports = { CommandRegistry, loadAllCommands }
