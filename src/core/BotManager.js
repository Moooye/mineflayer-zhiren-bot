// ============================================================
// BotManager：多账号编排层（集成版）
// 职责：错峰串行启动、等待各账号上线、状态汇总打印、统一停止；
//      重连由各 BotContext 内部按 ReconnectPolicy 自行完成；
//      单账号故障/放弃不影响其他账号
// ============================================================
'use strict'
const { BotContext } = require('./BotContext')
const { loadAllCommands } = require('../commands')
const { createLogger } = require('../utils/logger')
const { sleep, statusCn } = require('../utils/helpers')

// 每个账号最多让后面的账号等多久（毫秒）：卡住的号不必拖满 joinTimeoutMs
const MAX_WAIT_PER_ACCOUNT_MS = 180000

// “在线/离线”状态汇总行的打印间隔：5 分钟一次（启动时先打一行，之后每 5 分钟一行）
const STATUS_REPORT_MS = 5 * 60 * 1000

class BotManager {
  /**
   * @param {object} cfg        全局配置
   * @param {object} chatLogger ChatLogger
   * @param {object} notifier   Notifier
   */
  constructor (cfg, chatLogger, notifier, chatMonitor, configStore) {
    this.cfg = cfg
    this.logger = createLogger('manager')
    this.notifier = notifier
    this.chatMonitor = chatMonitor
    this.configStore = configStore
    this.chatLogger = chatLogger
    this.contexts = cfg.accounts
      .filter(a => a.enabled)
      .map(a => new BotContext(a, cfg, chatLogger, notifier, chatMonitor))
    // 回链 manager，供 !白名/!清白 等全局命令调用
    this.contexts.forEach(c => { c.manager = this })
    this._statusTimer = null
  }

  async startAll () {
    const { joinDelayMs, joinTimeoutMs } = this.cfg.timing
    this.logger.info(`准备启动 ${this.contexts.length} 个账号，目标服务器 ${this.cfg.server.host}`)

    for (let i = 0; i < this.contexts.length; i++) {
      const ctx = this.contexts[i]
      this.logger.info(`[${i + 1}/${this.contexts.length}] 启动账号 ${ctx.account.username} ...`)
      try {
        ctx.connect()
      } catch (e) {
        this.logger.error(`账号 ${ctx.account.username} 创建失败：${e.message}`)
        continue
      }

      const result = await this._waitJoin(ctx, Math.min(joinTimeoutMs, MAX_WAIT_PER_ACCOUNT_MS))
      if (result === 'timeout') this.logger.warn(`账号 ${ctx.account.username} 上线超时，继续下一个`)

      if (i < this.contexts.length - 1) await sleep(joinDelayMs)
    }

    this._startStatusReport()
    this.logger.info('启动流程结束，机器人进入挂机状态')
  }

  // 等待账号到达稳定状态：online/ended/giveUp 算“有结论”；
  // reconnecting / waitServer 也算——说明第一次尝试已经失败（正在重试或服务器不在线），
  // 不必把后面的账号一起等满
  async _waitJoin (ctx, timeoutMs) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (['online', 'ended', 'giveUp', 'reconnecting', 'waitServer'].includes(ctx.status)) return ctx.status
      await sleep(500)
    }
    return 'timeout'
  }

  _startStatusReport () {
    const print = () => {
      const line = this.contexts.map(c => `${c.account.username}:${statusCn(c.status)}`).join('  |  ')
      // 附一行内存：挂了很久时一眼就能看出内存是不是在涨（涨到堆上限会被看门狗重启）
      const m = process.memoryUsage()
      const cap = Math.round(require('v8').getHeapStatistics().heap_size_limit / 1048576)
      this.logger.info(`状态  ${line}   内存 ${Math.round(m.heapUsed / 1048576)}/${cap}MB`)
    }
    print()
    this._statusTimer = setInterval(print, STATUS_REPORT_MS)
  }

  // 内存告急时就地清理所有账号（由 main.js 的看门狗调用）：不做任何下线/重连动作
  // @param {'soft'|'hard'} level
  memoryClean (level = 'soft') {
    const sum = { level, bots: 0, unloaded: 0, entities: 0, gc: false }
    for (const ctx of this.contexts) {
      try {
        const r = ctx.memoryClean(level)
        sum.bots++
        sum.unloaded += r.unloaded || 0
        sum.entities += r.entities || 0
        sum.gc = sum.gc || !!r.gc
      } catch (e) {
        this.logger.warn(`${ctx.account.username} 内存清理失败：${e.message}`)
      }
    }
    return sum
  }

  // Web 面板 / 外部查询用：聚合状态
  getStatus () {
    return this.contexts.map(c => c.getStatus())
  }

  /**
   * 外部（MC 客户端 mod / 本地软件）用的 bot 数据聚合。
   * 只列出真正连着服务器的 bot（status === 'online'），
   * 停用、离线、正在重连的都不给——mod 那边显示一个空列表比显示陈年数据好。
   */
  getBotSnapshots () {
    return this.contexts
      .filter(c => c.status === 'online' && c.bot)
      .map(c => {
        try { return c.getBotSnapshot() } catch (e) { return null }
      })
      .filter(Boolean)
  }

  // 服务器公屏增量消息（供面板轮询）
  getPublicChat (sinceId) {
    return this.chatMonitor ? this.chatMonitor.getSince(sinceId) : []
  }

  // 当前服务器连接信息（供面板显示）
  getServer () {
    const s = this.cfg.server
    return { host: s.host, port: s.port, version: s.version }
  }

  /**
   * 添加机器人：写入配置 → 立即创建并连接 → 持久化
   * 同名账号规则：**同一台服务器**上只能有一个（提示“账号已存在”）；
   *               **不同服务器**允许加同一个账号（方便中转 / 换服挂机），
   *               但正版账号同一时间只能在一个服务器在线，所以会返回一句提醒。
   * @param {string} username 账号名
   * @param {string} auth 'offline' | 'microsoft'
   * @param {string} [host] 该账号要去的服务器（面板“新账号默认IP”；留空 = 用全局默认）
   * @param {string|number} [port] 端口（填了才用）
   */
  async addBot (username, auth, host, port) {
    const name = String(username || '').trim()
    const useAuth = auth === 'microsoft' ? 'microsoft' : 'offline'
    if (!name) return { ok: false, message: '账号名不能为空' }
    const h = String(host || '').trim()
    const p = this._parsePort(port)
    if (p === null) return { ok: false, message: `端口「${String(port).trim()}」不合法：请填 1-65535 的整数，或留空使用默认端口` }
    const target = h ? { host: h, port: p } : this._serverOfAccount(null)

    const key = name.toLowerCase()
    const sameName = [...this.cfg.accounts, ...this.contexts.map(c => c.account)]
      .filter(a => a && String(a.username || '').toLowerCase() === key)
    const dupSameServer = sameName.find(a => this._sameServer(this._serverOfAccount(a), target))
    if (dupSameServer) {
      const s = this._serverOfAccount(dupSameServer)
      return { ok: false, message: `账号已存在：${name}（在 ${s.host}${s.port && s.port !== 25565 ? ':' + s.port : ''} 已经有一个了；同一台服务器只能挂一个，想换服请先把那个删掉或停用）` }
    }

    const accountCfg = { username: name, enabled: true, auth: useAuth }
    if (h) { accountCfg.server = { host: h }; if (p) accountCfg.server.port = p }
    // 账号级 antiAfk 与全局合并（与 configLoader 逻辑一致）
    accountCfg.antiAfk = Object.assign({}, this.cfg.antiAfk, accountCfg.antiAfk || {})
    this.cfg.accounts.push(accountCfg)
    const ctx = new BotContext(accountCfg, this.cfg, this.chatLogger, this.notifier, this.chatMonitor)
    ctx.manager = this
    this.contexts.push(ctx)
    if (this.configStore) this.configStore.save()
    try { ctx.connect() } catch (e) { return { ok: false, message: '创建失败：' + e.message } }

    const where = accountCfg.server ? accountCfg.server.host + (accountCfg.server.port ? ':' + accountCfg.server.port : '') : (target.host || '默认服务器')
    const other = sameName.find(a => !this._sameServer(this._serverOfAccount(a), target))
    const warn = other
      ? `（提醒：同名账号在 ${this._serverOfAccount(other).host} 也有一个。正版账号同一时间只能在一个服务器在线，两边都开着会互相顶下线；建议用卡片的「停用」只留一个在线）`
      : ''
    return { ok: true, message: `已添加 ${name}（${useAuth === 'microsoft' ? '正版' : '离线'}）→ ${where}，正在加入服务器${warn}` }
  }

  // 删除机器人：停止 → 从运行列表与配置移除 → 持久化
  // target 可是唯一标识（账号@服:端口）或账号名（同名多个时只删第一个）
  async removeBot (target) {
    const name = String(target || '').trim()
    const ctx = this._findCtx(name)
    if (!ctx) return { ok: false, message: '找不到账号：' + name }
    const ci = this.contexts.indexOf(ctx)
    // 按对象引用找到该账号在配置里的那一项（同名账号不会被删错）
    let ai = this.cfg.accounts.indexOf(ctx.account)
    if (ai === -1) ai = this.cfg.accounts.findIndex(a => a.username === ctx.account.username && this._sameServer(this._serverOfAccount(a), this._serverOfAccount(ctx.account)))
    try { await ctx.stop() } catch (_) { /* 忽略停止阶段错误 */ }
    this.contexts.splice(ci, 1)
    if (ai !== -1) this.cfg.accounts.splice(ai, 1)
    if (this.configStore) this.configStore.save()
    const s = this._serverOfAccount(ctx.account)
    return { ok: true, message: `已删除机器人：${ctx.account.username}${s.host ? '（' + s.host + '）' : ''}` }
  }

  /**
   * 修改账号登录方式：改配置 → 持久化 → 立即重连使其生效
   */
  setAuth (target, auth) {
    const useAuth = auth === 'microsoft' ? 'microsoft' : 'offline'
    const acc = this._findAccount(target)
    const ctx = this._findCtx(target)
    if (!acc && !ctx) return { ok: false, message: '找不到账号：' + target }
    if (acc) acc.auth = useAuth
    if (ctx) ctx.account.auth = useAuth
    if (this.configStore) this.configStore.save()
    if (ctx) ctx.requestReconnect()
    return { ok: true, message: `已切换为${useAuth === 'microsoft' ? '正版' : '离线'}登录，正在重连` }
  }

  /**
   * 解析面板传来的端口：“填了才用”
   * @returns {number|undefined|null} 留空/未填 → undefined（不指定，连接时用默认 25565）；
   *   非法（非整数或超出 1-65535）→ null，由调用方报错，避免静默当成默认端口
   */
  _parsePort (port) {
    const raw = port === undefined || port === null ? '' : String(port).trim()
    if (!raw) return undefined
    const p = Number(raw)
    return (Number.isInteger(p) && p >= 1 && p <= 65535) ? p : null
  }

  /**
   * 某个账号“实际会连到哪台服”（与 BotContext._resolveServer 同一套规则）：
   * 账号级 server.host 优先，否则用全局默认；端口留空 = 不指定（连接时用 25565 / 查 SRV）
   * @param {object|null} accountCfg 传 null = 拿当前全局默认服务器
   */
  _serverOfAccount (accountCfg) {
    const g = this.cfg.server || {}
    const a = (accountCfg && accountCfg.server) || {}
    if (a.host) return { host: String(a.host).trim(), port: Number(a.port) || undefined }
    return { host: String(g.host || '').trim(), port: Number(g.port) || undefined }
  }

  // 同一个服务器（主机大小写不敏感；端口留空按 25565 算）
  _sameServer (x, y) {
    return String(x.host || '').toLowerCase() === String(y.host || '').toLowerCase() &&
      ((x.port || 25565) === (y.port || 25565))
  }

  /**
   * 账号在面板里的唯一标识：账号名@服务器:端口（小写）。
   * 同名账号挂到不同服务器时，用它区分“同一账号的两张卡片”。
   */
  _keyOf (accountCfg) {
    const s = this._serverOfAccount(accountCfg)
    return String((accountCfg && accountCfg.username) || '').toLowerCase() + '@' +
      String(s.host || '').toLowerCase() + ':' + (s.port || 25565)
  }

  // 面板传来的 target：既支持唯一标识（账号@服:端口），也支持老的纯账号名（只取第一个匹配）
  _findCtx (target) {
    const t = String(target || '').trim().toLowerCase()
    if (!t) return null
    return this.contexts.find(c => this._keyOf(c.account) === t) ||
      this.contexts.find(c => c.account.username.toLowerCase() === t) || null
  }

  _findAccount (target) {
    const t = String(target || '').trim().toLowerCase()
    if (!t) return null
    const ctx = this._findCtx(t)
    if (ctx) return this.cfg.accounts.find(a => a === ctx.account) || ctx.account
    return this.cfg.accounts.find(a => this._keyOf(a) === t) ||
      this.cfg.accounts.find(a => a.username.toLowerCase() === t) || null
  }

  /**
   * 修改服务器地址（端口可留空）：改配置 → 持久化 → 全部重连以接入新服
   * 端口规则：填了才用；留空则不指定端口，连接时用默认 25565（域名还会先查 SRV 记录）
   */
  setServer (host, port) {
    const h = String(host || '').trim()
    if (!h) return { ok: false, message: '服务器地址不能为空' }
    const p = this._parsePort(port)
    if (p === null) return { ok: false, message: `端口「${String(port).trim()}」不合法：请填 1-65535 的整数，或留空使用默认端口` }
    this.cfg.server.host = h
    this.cfg.server.port = p
    if (this.configStore) this.configStore.save()
    for (const ctx of this.contexts) { try { ctx.requestReconnect() } catch (_) { /* 忽略 */ } }
    return { ok: true, message: `服务器已改为 ${h}${p ? ':' + p : ''}${p ? '' : '（未填端口，按域名/IP 正常进服）'}，正在全部重连` }
  }

  /**
   * 设置“单个账号”的服务器（每个机器人可连不同服务器）：
   * 改账号级 server → 持久化 → 只重连该账号
   * @param {string} username 账号名
   * @param {string} host 服务器IP
   * @param {string|number} port 端口（留空则使用默认端口 25565）
   */
  setAccountServer (target, host, port) {
    const key = String(target || '').trim()
    const acc = this._findAccount(key)
    const ctx = this._findCtx(key)
    if (!acc && !ctx) return { ok: false, message: '找不到账号：' + target }
    const h = String(host || '').trim()
    if (!h) return { ok: false, message: '服务器IP不能为空' }
    const p = this._parsePort(port)
    if (p === null) return { ok: false, message: `端口「${String(port).trim()}」不合法：请填 1-65535 的整数，或留空使用默认端口` }
    const server = { host: h }
    if (p) server.port = p // 端口留空时不写入：连接时用默认端口，不再继承全局端口
    if (acc) acc.server = server
    if (ctx) ctx.account.server = server
    if (this.configStore) this.configStore.save()
    if (ctx) ctx.requestReconnect()
    return { ok: true, message: `${acc ? acc.username : target} 的服务器已改为 ${h}${p ? ':' + p : ''}${p ? '' : '（未填端口，按域名/IP 正常进服）'}，正在重连` }
  }

  /**
   * 启用 / 停用一个账号（同名账号加在两台服务器时，用这个切换留哪个在线）
   * 停用 = 断开且不再自动重连（配置里 enabled=false，下次启动也不会拉起来）
   */
  setEnabled (target, on) {
    const acc = this._findAccount(target)
    const ctx = this._findCtx(target)
    if (!acc && !ctx) return { ok: false, message: '找不到账号：' + target }
    const want = !!on
    const who = (acc && acc.username) || (ctx && ctx.account.username) || target
    if (acc) acc.enabled = want
    if (ctx) {
      ctx.account.enabled = want
      if (want) {
        if (ctx.status === 'stopped' || ctx.status === 'offline' || ctx.status === 'ended' || ctx.status === 'giveUp') {
          try { ctx.requestReconnect() } catch (_) { /* 忽略 */ }
        }
      } else {
        Promise.resolve(ctx.stop()).catch(() => {}) // 停用：断开，且 _onEnd 里不会再重连
      }
    }
    if (this.configStore) this.configStore.save()
    return { ok: true, message: want ? `${who} 已启用，正在连接` : `${who} 已停用（已断开，不再自动重连）` }
  }


  // 白名单信息（供面板显示）：好友名单 + 白名单组可用指令 + 每人个人权限 + 传送白名单（管理员/成员） + 指令目录 + 最高权限者
  getWhitelist () {
    const w = this.cfg.whitelist
    let cmds = Array.isArray(w.friendCommands) ? w.friendCommands.slice() : []
    // 以运行中任一 context 的实际清单为准
    let perms = (w.friendPerms && typeof w.friendPerms === 'object') ? { ...w.friendPerms } : {}
    if (this.contexts[0]) {
      const svc = this.contexts[0].services.whitelist
      cmds = [...svc.friendCommands]
      perms = {}
      for (const [n, set] of svc.friendPerms) perms[n] = [...set]
    }
    const pubSvc = this.contexts[0] && this.contexts[0].services.whitelist
    return {
      friends: Array.isArray(w.friends) ? w.friends : [],
      // 传送白名单取配置里的原件：保留你输入的大小写，面板显示好看（运行时的集合内部一律小写）
      tpAdmins: Array.isArray(w.tpAdmins) ? w.tpAdmins.slice() : [],
      tpPlayers: Array.isArray(w.tpPlayers) ? w.tpPlayers.slice() : [],
      publicCmds: pubSvc ? [...pubSvc.pubChatters] : (Array.isArray(w.publicCmds) ? w.publicCmds.slice() : []),
      friendCommands: cmds,
      friendPerms: perms,
      catalog: this.getCommandCatalog(),
      owners: w.owners || [],
    }
  }

  // 指令目录（供面板渲染勾选框）：静态加载，不依赖有没有机器人在线
  getCommandCatalog () {
    return loadAllCommands().map(d => ({
      name: d.name,
      usage: d.usage || d.name,
      permission: d.permission || 'control',
      // 仅私聊：公屏发来不执行（面板可用它标出「需私聊」提示）
      whisperOnly: !!d.whisperOnly,
    }))
  }

  // 添加白名单玩家（对所有 bot 生效）
  addFriend (name) {
    const disp = String(name || '').trim()
    if (!disp) return { ok: false, message: '玩家名不能为空' }
    const w = this.cfg.whitelist
    const lower = disp.toLowerCase()
    if ((w.friends || []).some(x => String(x).toLowerCase() === lower)) return { ok: false, message: '已在白名单：' + disp }
    w.friends = w.friends || []
    w.friends.push(disp)
    for (const ctx of this.contexts) ctx.services.whitelist.friends.add(lower)
    if (this.configStore) this.configStore.save()
    return { ok: true, message: '已添加白名单：' + disp }
  }

  // 移除白名单玩家（同时清掉他的个人权限，避免残留）
  removeFriend (name) {
    const lower = String(name || '').toLowerCase()
    const w = this.cfg.whitelist
    const i = (w.friends || []).findIndex(x => String(x).toLowerCase() === lower)
    if (i === -1) return { ok: false, message: '不在白名单：' + name }
    w.friends.splice(i, 1)
    if (w.friendPerms) delete w.friendPerms[lower]
    if (Array.isArray(w.publicCmds)) {
      const j = w.publicCmds.findIndex(x => String(x).toLowerCase() === lower)
      if (j !== -1) w.publicCmds.splice(j, 1)
    }
    for (const ctx of this.contexts) {
      ctx.services.whitelist.friends.delete(lower)
      ctx.services.whitelist.deleteFriendPerms(lower)
      ctx.services.whitelist.pubChatters.delete(lower)
    }
    if (this.configStore) this.configStore.save()
    return { ok: true, message: '已移除白名单：' + name }
  }

  /**
   * 设置某个白名单玩家的个人权限清单（面板按人勾选）
   * 规则：设了个人清单就只按个人清单放行（'*' = 全部非管理指令）；
   *       传空清单 = 清除个人设置，回退到白名单组公共勾选
   * @param {string} name 玩家名（须已在白名单）
   * @param {string[]} list 指令名数组
   */
  setFriendPerms (name, list) {
    const disp = String(name || '').trim()
    if (!disp) return { ok: false, message: '玩家名不能为空' }
    const lower = disp.toLowerCase()
    const w = this.cfg.whitelist
    if (!(w.friends || []).some(x => String(x).toLowerCase() === lower)) {
      return { ok: false, message: disp + ' 不在白名单里，请先「添加白名单」' }
    }
    const catalog = this.getCommandCatalog()
    const allowed = new Set(catalog.filter(c => c.permission !== 'admin').map(c => c.name))
    const cleaned = []
    for (const raw of (Array.isArray(list) ? list : [])) {
      const n = String(raw || '').toLowerCase()
      if ((allowed.has(n) || n === '*') && !cleaned.includes(n)) cleaned.push(n)
    }
    const usage = new Map(catalog.map(c => [c.name, c.usage || c.name]))
    // 空清单 = 清除个人权限，回退公共勾选
    if (!cleaned.length) {
      if (w.friendPerms) delete w.friendPerms[lower]
      for (const ctx of this.contexts) ctx.services.whitelist.deleteFriendPerms(lower)
      if (this.configStore) this.configStore.save()
      return { ok: true, message: disp + ' 的个人权限已清除，回退到白名单组公共指令' }
    }
    w.friendPerms = w.friendPerms || {}
    w.friendPerms[lower] = cleaned
    for (const ctx of this.contexts) ctx.services.whitelist.setFriendPerms(lower, cleaned)
    if (this.configStore) this.configStore.save()
    const isAll = cleaned.includes('*')
    const shown = isAll ? '全部指令' : cleaned.map(n => usage.get(n) || n).join('、')
    return { ok: true, message: disp + ' 的个人权限已更新：' + shown }
  }

  /**
   * 添加「传送白名单管理员」（组3）：只能管传送白名单（给名单加人/移除），其他权限一律没有
   */
  addTpAdmin (name) {
    const disp = String(name || '').trim()
    if (!disp) return { ok: false, message: '玩家名不能为空' }
    const lower = disp.toLowerCase()
    const w = this.cfg.whitelist
    w.tpAdmins = w.tpAdmins || []
    if ((w.owners || []).some(x => String(x).toLowerCase() === lower)) {
      return { ok: false, message: disp + ' 已是最高权限者，不需要再设白名单管理员' }
    }
    if (w.tpAdmins.some(x => String(x).toLowerCase() === lower)) {
      return { ok: false, message: '已是传送白名单管理员：' + disp }
    }
    w.tpAdmins.push(disp)
    for (const ctx of this.contexts) ctx.services.whitelist.tpAdmins.add(lower)
    if (this.configStore) this.configStore.save()
    return { ok: true, message: disp + ' 已成为传送白名单管理员（只能管传送白名单）' }
  }

  // 取消「传送白名单管理员」
  removeTpAdmin (name) {
    const lower = String(name || '').toLowerCase()
    const w = this.cfg.whitelist
    const i = (w.tpAdmins || []).findIndex(x => String(x).toLowerCase() === lower)
    if (i === -1) return { ok: false, message: '不是传送白名单管理员：' + name }
    w.tpAdmins.splice(i, 1)
    for (const ctx of this.contexts) ctx.services.whitelist.tpAdmins.delete(lower)
    if (this.configStore) this.configStore.save()
    return { ok: true, message: '已取消传送白名单管理员：' + name }
  }

  /**
   * 加入「传送白名单」（组3 管理员能给的唯一权限）：
   * 他在名单里 = 他对机器人 tpa/tpahere 时自动 /tpaccept；除此之外不给任何指令权限
   */
  addTpPlayer (name) {
    const disp = String(name || '').trim()
    if (!disp) return { ok: false, message: '玩家名不能为空' }
    const lower = disp.toLowerCase()
    const w = this.cfg.whitelist
    w.tpPlayers = w.tpPlayers || []
    if (w.tpPlayers.some(x => String(x).toLowerCase() === lower)) {
      return { ok: false, message: '已在传送白名单：' + disp }
    }
    w.tpPlayers.push(disp)
    for (const ctx of this.contexts) ctx.services.whitelist.tpPlayers.add(lower)
    if (this.configStore) this.configStore.save()
    return { ok: true, message: disp + ' 已加入传送白名单（他 tpa/tpahere 时机器人自动接受，其他权限不给）' }
  }

  // 移出传送白名单
  removeTpPlayer (name) {
    const lower = String(name || '').toLowerCase()
    const w = this.cfg.whitelist
    const i = (w.tpPlayers || []).findIndex(x => String(x).toLowerCase() === lower)
    if (i === -1) return { ok: false, message: '不在传送白名单：' + name }
    w.tpPlayers.splice(i, 1)
    for (const ctx of this.contexts) ctx.services.whitelist.tpPlayers.delete(lower)
    if (this.configStore) this.configStore.save()
    return { ok: true, message: '已移出传送白名单：' + name }
  }

  /**
   * 设置白名单（好友）组可用的指令清单（按指令名）
   * 管理类(admin)指令一律剔除：永远只归 owners（最高权限组）
   * @param {string[]} list 指令名数组
   */
  setFriendCommands (list) {
    const catalog = this.getCommandCatalog()
    const allowed = new Set(catalog.filter(c => c.permission !== 'admin').map(c => c.name))
    const cleaned = []
    for (const raw of (Array.isArray(list) ? list : [])) {
      const n = String(raw || '').toLowerCase()
      if (allowed.has(n) && !cleaned.includes(n)) cleaned.push(n)
    }
    this.cfg.whitelist.friendCommands = cleaned
    for (const ctx of this.contexts) ctx.services.whitelist.friendCommands = new Set(cleaned)
    if (this.configStore) this.configStore.save()
    const usage = new Map(catalog.map(c => [c.name, c.usage || c.name]))
    return {
      ok: true,
      message: `白名单组可用指令已更新（${cleaned.length} 条）：` + (cleaned.map(n => usage.get(n) || n).join('、') || '无（不响应任何指令）'),
    }
  }

  /**
   * 设置某个白名单玩家是否属于「公屏组」：
   * 公屏组成员可以在公屏（带 ! 前缀）触发「需私聊」类指令（瓶子/箱子/检测等）；
   * 同一条公屏广播所有 bot 都会收到，进程内只让第一只收到消息的 bot 执行
   * @param {string} name 玩家名（须已在白名单）
   * @param {boolean} on true=加入公屏组，false=移出
   */
  setPublicCmd (name, on) {
    const disp = String(name || '').trim()
    if (!disp) return { ok: false, message: '玩家名不能为空' }
    const lower = disp.toLowerCase()
    const w = this.cfg.whitelist
    if (!(w.friends || []).some(x => String(x).toLowerCase() === lower)) {
      return { ok: false, message: disp + ' 不在白名单里，请先「添加白名单」' }
    }
    const want = on !== false && on !== '0' && on !== 'false'
    w.publicCmds = Array.isArray(w.publicCmds) ? w.publicCmds : []
    const has = w.publicCmds.some(x => String(x).toLowerCase() === lower)
    if (want === has) return { ok: true, message: disp + (want ? ' 已在公屏组' : ' 本来就不在公屏组') }
    if (want) w.publicCmds.push(disp)
    else w.publicCmds = w.publicCmds.filter(x => String(x).toLowerCase() !== lower)
    for (const ctx of this.contexts) {
      if (want) ctx.services.whitelist.pubChatters.add(lower)
      else ctx.services.whitelist.pubChatters.delete(lower)
    }
    if (this.configStore) this.configStore.save()
    return { ok: true, message: disp + (want ? ' 已加入公屏组：可在公屏触发需私聊类指令（每只 bot 都会执行）' : ' 已移出公屏组：需私聊类指令恢复仅私聊触发') }
  }

  // Web 控制入口：target=账号名 或 'all'；action + args
  async control (target, action, args) {
    // 管理类动作：manager 级，只执行一次，不按账号遍历
    if (action === 'add-bot') return { ok: true, result: await this.addBot(args && args[0], args && args[1], args && args[2], args && args[3]) }
    if (action === 'remove-bot') return { ok: true, result: await this.removeBot(args && args[0]) }
    if (action === 'enable-bot') return { ok: true, result: this.setEnabled(args && args[0], true) }
    if (action === 'disable-bot') return { ok: true, result: this.setEnabled(args && args[0], false) }
    if (action === 'set-auth') return { ok: true, result: this.setAuth(args && args[0], args && args[1]) }
    if (action === 'server') return { ok: true, result: this.setServer(args && args[0], args && args[1]) }
    if (action === 'set-account-server') return { ok: true, result: this.setAccountServer(args && args[0], args && args[1], args && args[2]) }
    if (action === 'add-friend') return { ok: true, result: this.addFriend(args && args[0]) }
    if (action === 'remove-friend') return { ok: true, result: this.removeFriend(args && args[0]) }
    if (action === 'add-tp-admin') return { ok: true, result: this.addTpAdmin(args && args[0]) }
    if (action === 'remove-tp-admin') return { ok: true, result: this.removeTpAdmin(args && args[0]) }
    if (action === 'add-tp-player') return { ok: true, result: this.addTpPlayer(args && args[0]) }
    if (action === 'remove-tp-player') return { ok: true, result: this.removeTpPlayer(args && args[0]) }
    if (action === 'friend-cmds') return { ok: true, result: this.setFriendCommands(args || []) }
    if (action === 'set-friend-perms') return { ok: true, result: this.setFriendPerms(args && args[0], (args || []).slice(1)) }
    if (action === 'set-public-cmd') return { ok: true, result: this.setPublicCmd(args && args[0], args && args[1]) }

    const runOne = async ctx => {
      switch (action) {
        case 'reconnect': ctx.requestReconnect(); return { ok: true, message: '正在重连' }
        case 'shutdown': ctx.shutdownBot(); return { ok: true, message: '正在下线' }
        case 'stop': return ctx.actionStop()
        case 'home': return await ctx.actionHome(args && args[0])
        case 'sethome': return await ctx.actionSethome(args && args[0])
        case 'delhome': return await ctx.actionDelhome(args && args[0])
        case 'follow': return await ctx.actionFollow(args && args[0])
        case 'goto': return await ctx.actionGoto(args && args[0])
        case 'console': return await ctx.actionConsole(args && args.join(' '))
        case 'afk': return ctx.setAntiAfk(!!(args && args[0] === 'on'))
        case 'eat': return ctx.setAutoEat(!!(args && args[0] === 'on'))
        case 'bottle': return await ctx.actionBottle(!!(args && args[0] === 'on'), args && args[1])
        case 'deposit': return await ctx.actionDeposit(args && args[0] === 'all')
        case 'withdraw': return await ctx.actionWithdraw(args && args[0], args && args[1])
        case 'peekchest': return await ctx.actionPeekChest()
        case 'clear': return await ctx.actionClear()
        case 'attack': return ctx.actionAttack(args)
        case 'turn-left': return await ctx.actionTurn('left', args && args[0])
        case 'turn-right': return await ctx.actionTurn('right', args && args[0])
        case 'look-down': return await ctx.actionLookDown(args && args[0])
        case 'move': return await ctx.actionMoveTo(args && args[0], args && args[1], args && args[2], args && args[3])
        default: return { ok: false, message: '未知动作：' + action }
      }
    }

    if (target === 'all') {
      const results = []
      for (const ctx of this.contexts) {
        try { results.push({ username: ctx.account.username, key: this._keyOf(ctx.account), result: await runOne(ctx) }) }
        catch (e) { results.push({ username: ctx.account.username, key: this._keyOf(ctx.account), result: { ok: false, message: e.message } }) }
      }
      return { ok: true, results }
    }
    // target 可是唯一标识（账号@服:端口）或账号名
    const ctx = this._findCtx(target)
    if (!ctx) return { ok: false, message: '找不到账号：' + target }
    try { return { ok: true, result: await runOne(ctx) } }
    catch (e) { return { ok: false, message: e.message } }
  }

  async stopAll () {
    if (this._statusTimer) { clearInterval(this._statusTimer); this._statusTimer = null }
    this.logger.info('正在停止全部机器人...')
    for (let i = this.contexts.length - 1; i >= 0; i--) {
      try { await this.contexts[i].stop() } catch (e) {
        this.logger.error(`停止 ${this.contexts[i].account.username} 出错：${e.message}`)
      }
    }
    this.logger.info('全部机器人已停止')
  }
}

module.exports = { BotManager }
