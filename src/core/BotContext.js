// ============================================================
// BotContext：单个机器人的容器（集成版）
// 装配：pathfinder、antiAfk、ChatQueue、WarpQueue、
//      Whitelist、AutoEat、Greetings、TpaAcceptor、EntityFilter、聊天指令系统
// 生命周期：offline | connecting | online | reconnecting | waitServer(等服务器上线) | ended | giveUp
// 资源分两级清理：
//   botCleanups   每次断线/重连清理（per-bot）
//   permCleanups  进程退出清理（持久服务）
// ============================================================
'use strict'
const path = require('path')
const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')

const antiAfk = require('../behaviors/antiAfk')
const { AutoEat } = require('../behaviors/autoEat')
const { Greetings } = require('../behaviors/greetings')
const { TpaAcceptor } = require('../behaviors/tpaAcceptor')
const { EntityFilter } = require('../behaviors/entityFilter')
const { PlayerWatch } = require('../behaviors/playerWatch')
const { AutoAuth } = require('../behaviors/autoAuth')
const { ChatQueue } = require('../services/ChatQueue')
const { WarpQueue } = require('../services/WarpQueue')
const { ServerProbe } = require('../services/ServerProbe')
const { BottleRunner } = require('../services/BottleRunner')
const { AttackRunner } = require('../services/AttackRunner')
const { ChestManager } = require('../services/ChestManager')
const { ServerMetrics } = require('../services/ServerMetrics')
const { Whitelist } = require('../services/Whitelist')
const { TaskRunner } = require('./TaskRunner')
const { ReconnectPolicy } = require('./ReconnectPolicy')
const { CommandRegistry, loadAllCommands } = require('../commands')
const { createLogger } = require('../utils/logger')
const { sleep, findOnlinePlayer, parseIncomingWhisper, chunkString } = require('../utils/helpers')
const ITEM_ZH = require('../utils/itemNamesZh')

const PROJECT_ROOT = path.join(__dirname, '..', '..')

// 登录看门狗超时（毫秒）：TCP 已连上、却迟迟没进入游戏时，到点主动断开重试
const LOGIN_TIMEOUT_MS = 90000

// 回执通道（回复玩家）：默认用 /msg 私聊；
// 服务器说“没这条指令/没权限”（插件锁指令、禁了 msg 等）时，按 REPLY_WHISPER_FORMS 顺序换下一种写法，
// 全都被拒才改成公屏回复，过一阵再从头试回私聊。
const REPLY_REJECT_WINDOW_MS = 5000 // 发完私聊后多长时间内出现的“拒绝”算这条私聊的
const REPLY_RETRY_MS = 10 * 60 * 1000 // 掉到公屏后多久重试一次私聊
// 私聊写法候选（{to}=玩家名，{msg}=内容）：配置 reply.whisperCommands 可覆盖，自己配的写法会排在最前面
const REPLY_WHISPER_FORMS = ['msg {to} {msg}', 'tell {to} {msg}', 'w {to} {msg}']
const REPLY_REJECT_RE = /(unknown command|unknown or incomplete command|command not found|do not have permission|no permission|not allowed to use|permission denied|未知的?命令|未知指令|找不到该?命令|没有权限|无权限|权限不足|不能使用该命令|无法使用该命令|你不是管理员|必须由管理员)/i

// 安全解析踢出/断开原因
function parseReason (reason) {
  if (reason == null) return ''
  if (typeof reason === 'object') {
    try {
      const parts = []
      const walk = v => {
        if (!v) return
        if (typeof v === 'string') parts.push(v)
        else if (Array.isArray(v)) v.forEach(walk)
        else if (typeof v === 'object') {
          if (typeof v.text === 'string') parts.push(v.text)
          // translate 结构（如 {"translate":"multiplayer.disconnect.xxx"}）：key 本身就是原因线索
          if (typeof v.translate === 'string') parts.push(v.translate)
        }
        if (Array.isArray(v.extra)) v.extra.forEach(walk)
      }
      walk(reason)
      return parts.join('').replace(/§./g, '').trim()
    } catch (_) { return String(reason) }
  }
  return String(reason).replace(/§./g, '').trim()
}

// 公屏指令的跨机器人去重：同一条公屏指令 3 个机器人都会收到，同一进程里只记一条
const recentPublicCmds = new Map()

class BotContext {
  /**
   * @param {object} account    账号配置（已合并默认项）
   * @param {object} globalCfg  全局配置
   * @param {object} chatLogger ChatLogger
   * @param {object} notifier   Notifier
   */
  constructor (account, globalCfg, chatLogger, notifier, chatMonitor) {
    this.account = account
    this.globalCfg = globalCfg
    this.chatLogger = chatLogger
    this.notifier = notifier
    this.chatMonitor = chatMonitor
    this.logger = createLogger(account.username)

    this.status = 'offline'
    this.bot = null
    this.botCleanups = []
    this.permCleanups = []
    this.reconnectPolicy = new ReconnectPolicy(globalCfg.reconnect)
    this._reconnectTimer = null
    this._waitServerCancel = null // “等服务器上线”的注销函数（非 null 表示正在等）
    this._chunkTrimTimer = null // 远处区块定期清理的定时器
    this._probe = null // 最近一次用到的服务器探测器（只用于状态展示）
    this._manualStop = false
    this.onlineSince = 0
    this.followTarget = null
    this._cmdDedup = new Map()
    this._afkPaused = true // 进服默认防AFK关闭，!afk 开 后才启动
    // 回执通道状态：pending = 刚发出、还在等服务器反应的那条私聊；formIndex = 当前在用第几种私聊写法
    this._reply = { pending: null, whisperFailedAt: 0, warnedAt: 0, formIndex: 0 }

    this.services = {}
    this.commands = null
    this._buildServices()
  }

  // 持久服务（构造一次，重连不重建，通过 ctx.bot 动态访问）
  _buildServices () {
    const s = this.services
    s.whitelist = new Whitelist(this.globalCfg.whitelist)
    s.taskRunner = new TaskRunner(this, this.globalCfg.taskRunner)
    s.chatQueue = new ChatQueue(this, this.globalCfg.chatQueue)
    s.warpQueue = new WarpQueue(this, this.globalCfg.warp)
    // 进服强制自动进食关闭（忽略配置里的 enabled），仅 !进食 开 后启用；其余参数保留
    s.autoEat = new AutoEat(this, Object.assign({}, this.globalCfg.autoEat, this.account.autoEat, { enabled: false }))
    s.greetings = new Greetings(this, this.globalCfg.greetings)
    s.tpaAcceptor = new TpaAcceptor(this, this.globalCfg.autoAcceptTpa)
    s.playerWatch = new PlayerWatch(this, this.globalCfg.playerWatch)
    s.entityFilter = new EntityFilter(this, this.globalCfg.perf)
    s.bottleRunner = new BottleRunner(this)
    s.attackRunner = new AttackRunner(this)
    // 自动登录/注册（有登录插件的服务器用；没配密码则整个功能不启用）
    s.autoAuth = new AutoAuth(this, this.globalCfg.autoAuth)
    // 箱子/木桶自动存取（配了 chest.station 坐标或 stationAlias 才可用）
    s.chestManager = new ChestManager(this, this.globalCfg.chest)
    // 面板卡片上的 TPS / Ping（每连接一次重新绑定）
    s.metrics = new ServerMetrics(this.globalCfg.metrics)

    // 指令系统（指令清单集中在 src/commands/index.js 的 loadAllCommands）
    this.commands = new CommandRegistry(this, this.globalCfg.commands)
    this.commands.registerAll(loadAllCommands())

    // 进程级清理
    this.permCleanups.push(() => s.taskRunner.stop())
    this.permCleanups.push(() => s.chatQueue.stop())
    this.permCleanups.push(() => s.warpQueue.stop())
    this.permCleanups.push(() => s.bottleRunner.stopForShutdown())
    this.permCleanups.push(() => s.attackRunner.stopForShutdown())
    this.permCleanups.push(() => s.chestManager.stopForShutdown())
    this.permCleanups.push(() => this._clearWaitServer())
  }

  // 供 TaskRunner 任务访问的统一 API
  getApi () {
    return { bot: this.bot, services: this.services, account: this.account }
  }

  // per-bot 清理登记
  regBotCleanup (fn) { this.botCleanups.push(fn) }

  // 首次连接
  connect () {
    if (this.status === 'connecting' || this.status === 'online') return
    this._manualStop = false
    this._createBot()
  }

  // 解析当前生效的服务器：账号级 server（每个机器人可连不同服）优先，否则用全局默认
  // 端口“填了才用”：账号没填端口就是“不指定”，用默认 25565，不再继承全局端口——
  // 否则给一个域名配上别的服务器的自定义端口，就永远连不上了
  _resolveServer () {
    const g = this.globalCfg.server
    const a = this.account.server
    if (a && a.host) {
      return {
        host: a.host,
        port: Number(a.port) || undefined,
        version: a.version === undefined ? g.version : a.version,
      }
    }
    return g
  }

  _createBot () {
    // 真要连了：先注销“等服务器上线”的等待，别让探测回调再触发一次重连
    this._clearWaitServer()
    this.status = 'connecting'
    const s = this._resolveServer()
    this.bot = mineflayer.createBot({
      host: s.host,
      // 端口没填就用 25565：minecraft-protocol 只在端口正好是 25565、且主机不是 IP 时
      // 才会去查 _minecraft._tcp SRV 记录（见 minecraft-protocol/src/client/tcp_dns.js）
      port: s.port || 25565,
      version: s.version,
      username: this.account.username,
      auth: this.account.auth,
      profilesFolder: path.join(PROJECT_ROOT, 'auth-cache'),
      // 视距（chunk）：建连参数下发，mineflayer 登录时会随客户端信息一起发给服务器
      // 调小后服务端不再推送远处实体与区块，挂机时省 CPU（配置 perf.viewDistance）
      viewDistance: this.services.entityFilter.viewDistance,
      onMsaCode: data => {
        this.logger.info(`【正版授权】请打开 https://www.microsoft.com/link 输入代码：${data.user_code}`)
      },
    })
    this.bot._logger = this.logger // 供行为插件写运行日志（落 runtime 日志文件）
    // 服务器要求资源包时必须按协议回执，否则会永远卡在“配置阶段”进不了世界：
    // 表现是 TCP 连上、正版登录也过了，但一直“连接中”，不报错也不掉线（只收 keep_alive）。
    // 机器人不渲染材质，这里直接回“已接受 + 已下载 + 已加载”跳过下载；
    // 若回“拒绝”，服务端开了强制资源包会直接踢人（multiplayer.requiredTexturePrompt.disconnect）。
    const packDone = new Set()
    try {
      this.bot._client.on('add_resource_pack', data => {
        const key = String((data && data.uuid) || '')
        if (packDone.has(key)) return
        packDone.add(key)
        try {
          this.bot._client.write('resource_pack_receive', { uuid: data && data.uuid, result: 3 }) // accepted
          this.bot._client.write('resource_pack_receive', { uuid: data && data.uuid, result: 4 }) // downloaded
          this.bot._client.write('resource_pack_receive', { uuid: data && data.uuid, result: 0 }) // successfully loaded
          this.logger.info('服务器要求资源包：已按“跳过下载”回执，继续进入服务器')
        } catch (e) {
          this.logger.warn('回应资源包请求失败：' + e.message)
        }
      })
    } catch (_) { /* 忽略 */ }
    // 登录看门狗：TCP 连上了却收不到登录应答（地址通但服务器不回应 / 账号被拒 / 连接被挂住）时，
    // 到点主动断开重试并写下原因——mineflayer 这一步自身没有任何超时，
    // 否则会永远停在“连接中”且毫无提示，还会把串行启动的其他账号一起卡住
    this._clearLoginWatch()
    this._sawLoginChallenge = false
    try {
      // 记录“服务器是否已经发来加密请求”：有的话说明卡在服务器侧的正版校验，没有则是地址/入口不对
      this.bot._client.on('packet', (data, meta) => {
        if (meta && meta.state === 'login' && meta.name === 'encryption_begin') this._sawLoginChallenge = true
      })
      this.bot._client.once('connect', () => {
        this._loginWatch = setTimeout(() => {
          if (this.status === 'online') return
          const why = this._sawLoginChallenge
            ? '（服务器已要求正版验证，之后却没有任何回应——多半是服务器侧挂起了这个账号的登录）'
            : '（服务器连登录应答都没发——一般是地址/端口/入口域名不对）'
          this.logger.warn(`登录超时：已连上 ${s.host}${s.port ? ':' + s.port : ''}，但 ${LOGIN_TIMEOUT_MS / 1000} 秒内没能进入游戏${why}，断开重试`)
          try { this.bot.quit('登录超时') } catch (_) { this._recreateNow() }
        }, LOGIN_TIMEOUT_MS)
      })
    } catch (_) { /* 忽略 */ }
    // 26.x（26.1 快照起）服务器要求客户端每个 tick（50ms）发一个 tick_end 包，
    // 否则服务器的移动校验会把 bot 判成“非法移动”（invalid_player_movement）几秒内踢出。
    // minecraft-protocol 1.68 尚未自动发送，这里按版本手动补发（协议数据里 tick_end 是空包，无字段）。
    // 昨天能在线是因为服务器当时没启用该校验；发此包对所有版本无害（旧版本没有这个包名，写入失败会自动停发）
    try {
      let tickTimer = null
      const stopTick = () => { if (tickTimer) { clearInterval(tickTimer); tickTimer = null } }
      const startTick = () => {
        if (tickTimer) return
        const ver = String(this.bot._client.version || '')
        if (!/26\./.test(ver)) return // 仅 26.x 协议需要
        tickTimer = setInterval(() => {
          try { this.bot && this.bot._client && this.bot._client.write('tick_end', {}) } catch (_) { stopTick() }
        }, 50)
      }
      // 必须等真正进入世界（play 状态）再发：登录刚成功（success）时还在 configuration 状态，
      // 过早发送服务器会报“An internal error occurred in your connection”
      this.bot.once('spawn', startTick)
      this.bot._client.on('end', stopTick)
    } catch (_) { /* 忽略 */ }
    this.bot.loadPlugin(pathfinder)
    this.bot.loadPlugin(antiAfk)
    this._bindBotEvents()
  }

  _bindBotEvents () {
    const bot = this.bot
    const name = this.account.username

    // 视距 + 实体过滤（挂机省 CPU）：必须在登录前绑定，mineflayer 登录时会把视距带给服务器
    this.services.entityFilter.bindBot(bot)

    bot.on('login', () => this.logger.info('登录成功，正在进入服务器...'))

    // 首次进入世界（once：死亡重生不重复初始化）
    bot.once('spawn', () => {
      this.status = 'online'
      this._clearLoginWatch()
      this.onlineSince = Date.now()
      this.reconnectPolicy.onSuccess()
      this.logger.info(`已上线，位置（${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)}）`)
      // 上线后先冻结物理 5 秒：mineflayer 进服立即开始物理模拟并发移动包，
      // 部分服务器反作弊（如 invalid_player_movement）会在进服头几秒判定“非法移动”直接踢人；
      // 冻结期间 bot 原地不动、不发送 position，等反作弊完成初始校验后再恢复
      try {
        bot.physicsEnabled = false
        const unfreeze = setTimeout(() => {
          try { if (this.bot) this.bot.physicsEnabled = true } catch (_) { /* 已断线 */ }
        }, 5000)
        unfreeze.unref?.()
      } catch (_) { /* 忽略：个别版本没有 physicsEnabled */ }
      // 远处区块定期清理（防“挂机几十分钟内存涨到堆上限崩掉”）
      this._startChunkTrim(bot)
      this.regBotCleanup(() => this._stopChunkTrim())

      // 防AFK：进服默认关闭，仅 !afk 开 后启动（此处只配置、不自动 start）
      if (this.account.antiAfk) bot.afk.configure(this.account.antiAfk)
      // 拾取循环始终运行；断线时统一彻底停止两个循环
      this.regBotCleanup(() => bot.afk.shutdownAll())
      // 绑定 Boss 血条以跟踪“袭击”状态（断线清理）
      this.regBotCleanup(this.services.bottleRunner.bindBot(bot))
      // 绑定正前方攻击物理帧（断线清理，攻击回到关闭）
      this.regBotCleanup(this.services.attackRunner.bindBot(bot))
      // 绑定 TPS / Ping 采样（断线清理）
      this.regBotCleanup(this.services.metrics.bindBot(bot))
      // 自动进食：进服默认关闭，仅 !进食 开 后启动（断线仍登记停止）
      this.regBotCleanup(() => this.services.autoEat.stop())
      // 自动登录：每次进服重新判断登录状态（重连后可能要重新登录）
      this.services.autoAuth.reset()
      if (this.services.autoAuth.enabled) {
        this.logger.info('自动登录已启用：等待服务器的登录/注册提示（密码已配置，日志中不显示）')
      }
      // 定时存箱（配了 chest.autoScheduleMs 才启动；断线时停表）
      this.services.chestManager.start()
      this.regBotCleanup(() => this.services.chestManager.stop())
      this.services.greetings.onSpawn()
    })

    // 公聊
    bot.on('chat', (username, message) => {
      if (username === bot.username) return
      this.services.autoAuth.feed(message) // 自动登录：识别登录/注册提示
      this.chatLogger.logChat(name, username, message)
      if (this.chatMonitor) this.chatMonitor.feed('chat', username, message)
      this._noteIncomingCommand(username, message, false) // 管理员/白名单玩家的公屏指令：进控制台日志
      this.services.warpQueue.feedMessage(message)
      this.services.tpaAcceptor.feed(message)
      this.services.playerWatch.feed(message) // 盯人：X 离开了游戏 类文案兑底
      this._dispatchCommand(username, message, false)
    })

    // 私聊（原版 "X whispers to you: ..." 格式；插件改写过的格式由 messagestr 兜底）
    bot.on('whisper', (username, message) => {
      if (username === bot.username) return
      this._onIncomingWhisper(username, message)
    })

    // 玩家加入（用于可选欢迎语）
    bot.on('playerJoined', player => {
      if (player.username === bot.username) return
      this.services.greetings.onPlayerJoin(player.username)
    })

    // 玩家离开（盯人：!检测 <玩家> 后，他下线就自动 /tpa）
    bot.on('playerLeft', player => {
      if (!player || player.username === bot.username) return
      this.services.playerWatch.onPlayerLeft(player.username)
    })

    // 系统/动作栏消息
    bot.on('messagestr', (message, messagePosition) => {
      this.noteServerMessage(message) // 回执通道：看服务器有没有拒绝我们的私聊回复
      this.services.autoAuth.feed(message) // 自动登录：登录提示多数走系统消息
      this.services.warpQueue.feedMessage(message)
      this.services.tpaAcceptor.feed(message)
      this.services.playerWatch.feed(message) // 盯人：部分服务器只发系统提示，不听 playerLeft 也能抓
      // 兜底：服务器插件（如 TSL）把私聊改写成 [A ➥ 机器人] 内容 的系统消息，
      //       此时 mineflayer 不会触发 whisper 事件，这里按同样口径当私聊指令处理
      const w = parseIncomingWhisper(message, bot.username)
      if (w && w.from.toLowerCase() !== String(bot.username).toLowerCase()) {
        this._onIncomingWhisper(w.from, w.content)
      }
      // 系统广播（加入/退出/服务器公告）进公屏；动作栏(game_info)短暂易刷屏，不进
      if (messagePosition === 'system' && message && this.chatMonitor) {
        this.chatMonitor.feed('system', '', message)
      }
      if (messagePosition !== 'system' && messagePosition !== 'game_info') return
      if (message) this.chatLogger.logChat(name, '[服务器]', message)
    })

    bot.on('death', () => {
      this.logger.warn('机器人死亡，等待重生...')
      this.notifier.notify('death', `${name} 已死亡`)
      // 主动请求重生（payloadId 0 = perform respawn）
      try { bot._client.write('client_command', { payloadId: 0 }) } catch (_) { /* 忽略 */ }
      // 重生后自动回家
      bot.once('respawn', async () => {
        await sleep(2000)
        try { await this.services.warpQueue.home() } catch (_) { /* 无家则忽略 */ }
      })
    })

    bot.on('respawn', () => this.logger.info('已重生'))

    bot.on('kicked', reason => {
      // 踢出原因除了给用户看的文本，再原样打印原始 JSON：
      // 服务器踢人没给文本（或用了新版格式）时，原始结构里往往还有 translate key / 错误码可查
      let raw = ''
      try {
        raw = typeof reason === 'string' ? reason : JSON.stringify(reason)
      } catch (_) { /* 忽略序列化失败 */ }
      if (raw && raw !== '{}' && raw !== '""') raw = `（原始: ${raw.slice(0, 500)}）`
      else raw = ''
      this.logger.warn(`被服务器踢出：${parseReason(reason) || '原因未提供'}${raw}`)
    })

    bot.on('error', err => {
      this.logger.error(`连接错误：${err.message}`)
      // mineflayer 在部分失败场景（正版 profile 获取失败、登录阶段超时等）只发 error 不发 end，
      // 不补发重连的话重连循环会原地停摆（20261121 实测：Failed to obtain profile data 后再无任何尝试）。
      // 连接尚未建立（connecting）时，等 3 秒还没有 end 事件，就按一次普通断线走 _onEnd 流程
      if (this.status === 'connecting' && !this._manualStop) {
        if (this._errOnlyTimer) clearTimeout(this._errOnlyTimer)
        this._errOnlyTimer = setTimeout(() => {
          this._errOnlyTimer = null
          if (this.status === 'connecting' && !this._manualStop) {
            this.logger.warn('连接错误后未见 end 事件，按断线处理并安排重连')
            this._onEnd(err.message)
          }
        }, 3000)
        this._errOnlyTimer.unref?.()
      }
    })

    bot.on('end', reason => this._onEnd(reason))
  }

  // 收到一条发给本机器人的私聊：去重 → 记日志/送面板 → 喂传送与自动接受 → 当指令分发
  // 两条通道共用：whisper 事件（原版格式）与 messagestr 兜底（插件改写格式）
  _onIncomingWhisper (username, message) {
    const key = `whisper|${username}|${message}`
    const now = Date.now()
    const ts = this._cmdDedup.get(key)
    if (ts && now - ts < 2000) return // 同一条私聊两个通道都收到时只处理一次
    this._cmdDedup.set(key, now)
    if (this._cmdDedup.size > 100) this._cmdDedup.clear()

    this._noteIncomingCommand(username, message, true) // 管理员/白名单玩家的私聊指令：进控制台日志

    this.chatLogger.logWhisper(this.account.username, username, message, true)
    // 玩家私聊（下的指令）送控制台日志显示，to=接收的机器人
    if (this.chatMonitor) {
      this.chatMonitor.feed('cmd-in', username, message, { to: (this.bot && this.bot.username) || this.account.username })
    }
    this.services.warpQueue.feedMessage(message)
    this.services.tpaAcceptor.feed(message)
    this._dispatchCommand(username, message, true)
  }

  // 管理员（owners）/ 传送白名单管理员（tpAdmins）/ 白名单玩家（friends）发来的指令写进控制台日志（公屏、私聊都写）：
  //   · 公屏：必须是带前缀（!/！）的真指令才记，免得把白名单玩家的普通闲聊当指令刷屏；
  //           同一条公屏指令 3 个机器人都会收到，同一进程里只记第一条；
  //   · 私聊：主管/白名单私聊可省前缀，所以私聊一律记；
  //   同时送面板“控制台日志”窗口（公屏指令按内容去重，只保留一条）。
  _noteIncomingCommand (username, message, isWhisper) {
    const whitelist = this.services.whitelist
    const role = whitelist.getRole(username)
    if (role !== 'owner' && role !== 'friend' && role !== 'tpadmin') return false
    const text = String(message || '').trim()
    if (!text) return false
    if (!isWhisper && !/^[!！]/.test(text)) return false
    if (!isWhisper) {
      const key = `${username}|${text}`.toLowerCase()
      const now = Date.now()
      const last = recentPublicCmds.get(key)
      if (last && now - last < 2000) return false
      recentPublicCmds.set(key, now)
      if (recentPublicCmds.size > 200) recentPublicCmds.clear()
    }
    const who = role === 'owner' ? '管理员' : (role === 'tpadmin' ? '白名单管理员' : '白名单')
    this.logger.info(`收到${isWhisper ? '私聊' : '公屏'}指令 ← ${username}（${who}）：${text}`)
    // 私聊指令送面板“控制台日志”已在 _onIncomingWhisper 里做（含陌生人的私聊），这里只管公屏
    if (this.chatMonitor && !isWhisper) this.chatMonitor.feed('cmd-in', username, text, { pub: true })
    return true
  }

  // 命令分发（带去重，防御同消息双事件）
  _dispatchCommand (username, message, isWhisper) {
    const key = `${username}|${message}`
    const now = Date.now()
    const ts = this._cmdDedup.get(key)
    if (ts && now - ts < 2000) return
    this._cmdDedup.set(key, now)
    if (this._cmdDedup.size > 100) this._cmdDedup.clear()
    this.commands.handle({ username, message, isWhisper })
  }

  // 连接结束：清理 per-bot 资源，按策略重连
  _onEnd (reason) {
    if (this._errOnlyTimer) { clearTimeout(this._errOnlyTimer); this._errOnlyTimer = null }
    const text = parseReason(reason)
    this.logger.warn(`连接结束：${text || '未知原因'}`)
    this._cleanupBot()

    if (this._manualStop) { this.status = 'ended'; return }

    // 被面板“停用”的账号：断开后不再重连（startAll 也只会启动 enabled 的账号）
    if (this.account && this.account.enabled === false) {
      this.status = 'stopped'
      this.logger.info('该账号已在面板停用：不再自动重连（要恢复就在面板点「启用」）')
      return
    }

    const d = this.reconnectPolicy.registerFailure(text)
    if (d.action === 'giveUp') {
      this.status = 'giveUp'
      this.notifier.notify('giveUp', `${this.account.username} 放弃重连：${text}`)
      return
    }
    this.status = 'reconnecting'
    this.logger.info(`${(d.delayMs / 1000).toFixed(1)}s 后进行第 ${d.attempt} 次重连`)
    this._scheduleConnect(d.delayMs)
  }

  // 排一次重连：到点先探服务器在不在线，再决定是直连还是“保持离线只探测”
  _scheduleConnect (delayMs) {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer)
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      this._tryConnect()
    }, delayMs)
  }

  // 重连前先看服务器在不在线（serverWatch.enabled=false 时直接连，等同于老行为）
  async _tryConnect () {
    if (this._manualStop) return
    const sw = this.globalCfg.serverWatch || {}
    if (sw.enabled === false) return this._recreateNow()
    const probe = ServerProbe.for(this._resolveServer(), sw)
    this._probe = probe
    const online = await probe.check()
    if (this._manualStop) return
    if (online) {
      this.logger.info(`服务器 ${probe.label} 在线${probe.describe()}，开始第 ${this.reconnectPolicy.attempts} 次重连`)
      this._clearWaitServer()
      this._recreateNow()
      return
    }
    this._enterWaitServer(probe)
  }

  // 服务器不在线：保持离线，只探测不直连；一探测到在线立刻重连
  _enterWaitServer (probe) {
    this.status = 'waitServer'
    // 断开的旧 bot 对象清掉：面板状态不要停留在旧坐标上
    if (this.bot) { try { this.bot.removeAllListeners() } catch (_) { /* 忽略 */ } this.bot = null }
    if (this._waitServerCancel) return // 已经在等了，别重复登记
    const sw = this.globalCfg.serverWatch || {}
    const every = Math.max(1, Math.round((Number(sw.intervalMs) || 10000) / 1000))
    this.logger.warn(`服务器 ${probe.label} 不在线（${probe.lastError || '无响应'}）：已停止直连尝试，保持离线，每 ${every} 秒探测一次，服务器一恢复就自动重连`)
    this._waitServerCancel = probe.watch(() => {
      this._waitServerCancel = null
      if (this._manualStop) return
      this.status = 'reconnecting'
      this.logger.info(`服务器 ${probe.label} 已恢复在线${probe.describe()}，立即重连`)
      this._recreateNow()
    })
  }

  _clearWaitServer () {
    if (this._waitServerCancel) {
      try { this._waitServerCancel() } catch (_) { /* 忽略 */ }
      this._waitServerCancel = null
    }
  }

  // ---- 远处区块定期清理 ----
  // 服务器/插件在部分版本下不发 unload_chunk（或机器人长期不动、区块只增不减），
  // 区块就一直堆在 bot.world 里，挂机几十分钟内存一路涨到堆上限直接崩。
  // 这里定时把「离机器人超过 perf.keepChunks 个区块」的旧区块卸掉（服务器视角里它们本来也该卸载了，
  // 走回去时服务器会重新下发，不影响寻路）；身边 keepChunks 内的区块一律不动。
  _startChunkTrim (bot) {
    this._stopChunkTrim()
    const perf = this.globalCfg.perf || {}
    if (perf.trimChunks === false) return
    const every = Math.max(60000, Number(perf.chunkTrimMs) || 300000)
    this._chunkTrimTimer = setInterval(() => this._trimFarChunks(bot), every)
  }

  _stopChunkTrim () {
    if (this._chunkTrimTimer) { clearInterval(this._chunkTrimTimer); this._chunkTrimTimer = null }
  }

  // 卸载晚当前位置很远的旧区块，返回卸载个数（keepOverride 用于内存告急时收紧保留范围）
  _trimFarChunks (bot, keepOverride) {
    try {
      const world = bot && bot.world
      const me = bot && bot.entity && bot.entity.position
      if (!world || typeof world.getColumns !== 'function' || typeof world.unloadColumn !== 'function' || !me) return 0
      const perf = this.globalCfg.perf || {}
      const keep = Math.max(1, Number(keepOverride) || Math.max(4, Number(perf.keepChunks) || 16))
      const cx = Math.floor(me.x / 16)
      const cz = Math.floor(me.z / 16)
      let removed = 0
      for (const col of world.getColumns()) {
        const x = Number(col && col.chunkX)
        const z = Number(col && col.chunkZ)
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue
        if (Math.max(Math.abs(x - cx), Math.abs(z - cz)) <= keep) continue
        try { world.unloadColumn(x, z); removed++ } catch (_) { /* 单个失败不影响其他 */ }
      }
      if (removed) {
        const mb = Math.round(process.memoryUsage().heapUsed / 1048576)
        this.logger.info(`内存清理：卸载了 ${removed} 个远处区块（保留身边 ${keep} 区块内），堆用量 ${mb}MB`)
      }
      return removed
    } catch (e) {
      if (this.logger) this.logger.warn('清理远处区块失败：' + e.message)
      return 0
    }
  }

  // 紧急省内存：把“非玩家 / 非掉落物”的实体从内存里丢掉（等价于临时开一次实体过滤）
  // 只在自己快把堆吃满时才用，平时不动；玩家和掉落物保留（跟随/去/防AFK拾取要用）
  _dropNonEssentialEntities (bot) {
    if (!bot || !bot.entities) return 0
    let n = 0
    for (const key of Object.keys(bot.entities)) {
      const e = bot.entities[key]
      if (!e || typeof e !== 'object') continue
      if (bot.entity && e.id === bot.entity.id) continue
      const type = String(e.type || '').toLowerCase()
      const name = String(e.name || '').toLowerCase()
      if (type === 'player' || name === 'player' || type === 'item' || name === 'item') continue
      try { delete bot.entities[key]; n++ } catch (_) { /* 单个失败不影响其他 */ }
    }
    return n
  }

  /**
   * 内存告急时的就地清理（由 main.js 的内存看门狗调用）——目标是“清得出内存、机器人不掉线”
   * @param {'soft'|'hard'} level soft=卸远处区块+清扫；hard=只留身边 2 区块+丢掉怪实体
   * @returns {{level:string, unloaded:number, entities:number, gc:boolean, heapBefore:number, heapAfter:number}}
   */
  memoryClean (level = 'soft') {
    const gc = require('../utils/memoryGuard').getGc()
    const before = Math.round(process.memoryUsage().heapUsed / 1048576)
    const perf = this.globalCfg.perf || {}
    const keep = level === 'hard' ? 2 : Math.max(4, Math.floor((Number(perf.keepChunks) || 16) / 2))
    let unloaded = 0
    let entities = 0
    const bot = this.bot
    if (bot && bot.entity) {
      unloaded = this._trimFarChunks(bot, keep)
      if (level === 'hard') entities = this._dropNonEssentialEntities(bot)
    }
    // 实体过滤开着时顺手跑一次清扫（它平时是定时扫，这里加一次立刻生效）
    try {
      const ef = this.services.entityFilter
      if (ef && ef.enabled && typeof ef._sweep === 'function') ef._sweep(bot)
    } catch (_) { /* 忽略 */ }
    let didGc = false
    if (typeof gc === 'function') { try { gc(); didGc = true } catch (_) { /* 忽略 */ } }
    const after = Math.round(process.memoryUsage().heapUsed / 1048576)
    return { level, unloaded, entities, gc: didGc, heapBefore: before, heapAfter: after }
  }

  // 清掉登录看门狗（进入游戏 / 连接结束 / 主动重连时都要清，避免误杀新连接）
  _clearLoginWatch () {
    if (this._loginWatch) { clearTimeout(this._loginWatch); this._loginWatch = null }
  }

  _cleanupBot () {
    this._clearLoginWatch()
    this._stopChunkTrim()
    const fns = this.botCleanups.splice(0)
    for (let i = fns.length - 1; i >= 0; i--) { try { fns[i]() } catch (_) { /* 忽略 */ } }
    try { this.services.taskRunner.cancelCurrent('bot-end') } catch (_) { /* 忽略 */ }
    try { this.services.taskRunner.clearPending() } catch (_) { /* 忽略 */ }
    try { this.bot.pathfinder.setGoal(null) } catch (_) { /* 忽略 */ }
    this.followTarget = null
  }

  // ================= Web / 高层动作 =================
  // 停止当前任务与跟随（等同 !停止）
  actionStop () {
    try { this.services.taskRunner.cancelCurrent('web-stop') } catch (_) { /* 忽略 */ }
    // 统一停掉寻路 / 挖掘 / 左右键 / 控制状态等所有动作源
    try { this.services.taskRunner.abortActions() } catch (_) { /* 忽略 */ }
    this.followTarget = null
    return { ok: true, message: '已停止当前动作' }
  }

  /**
   * 原地左右转（只转视角、不移动；配合 !攻击 用来调整准星方向）
   * @param {'left'|'right'} dir 方向
   * @param {number|string} [degrees] 角度，默认 90（1-360）
   */
  async actionTurn (dir, degrees) {
    const bot = this.bot
    if (!bot || !bot.entity) return { ok: false, message: '机器人当前不在线' }
    const raw = degrees === undefined || degrees === null || String(degrees).trim() === '' ? 90 : Number(degrees)
    if (!Number.isFinite(raw) || raw <= 0 || raw > 360) return { ok: false, message: '角度需为 1-360 的数字（不填默认 90）' }
    const left = dir === 'left'
    // mineflayer 的 yaw：π=南、π/2=西、0=北、-π/2=东，
    // 所以左转是 yaw 增大、右转是 yaw 减小
    const target = bot.entity.yaw + (left ? 1 : -1) * raw * Math.PI / 180
    // 归一化到 [-π, π]，避免连着转时角度无限增长
    const yaw = Math.atan2(Math.sin(target), Math.cos(target))
    try {
      // force=true：立即生效（与 antiAfk 里的 look 用法一致）
      await bot.look(yaw, bot.entity.pitch, true)
    } catch (e) {
      return { ok: false, message: '转向失败：' + ((e && e.message) || e) }
    }
    return { ok: true, message: `已${left ? '左' : '右'}转 ${raw}°` }
  }

  /**
   * 俯视：把视线调到「水平向下 x 度」（只改俯仰、不移动；配合 !攻击 用来对准）
   *   x > 0 → 向下看 x 度；x < 0 → 向上看 |x| 度；x = 0 → 平视
   * 注意 mineflayer 的 pitch 符号：负数才是向下（见 physics.js 的 lookAt：pitch = atan2(Δy, 水平距离)）
   * @param {number|string} [degrees] 角度 -90～90，不填默认 30（向下 30°）
   */
  async actionLookDown (degrees) {
    const bot = this.bot
    if (!bot || !bot.entity) return { ok: false, message: '机器人当前不在线' }
    const raw = degrees === undefined || degrees === null || String(degrees).trim() === '' ? 30 : Number(degrees)
    if (!Number.isFinite(raw) || raw < -90 || raw > 90) return { ok: false, message: '角度需为 -90～90 的数字（正数=向下看，负数=向上看，0=平视；不填默认 30）' }
    const pitch = -raw * Math.PI / 180 // 负号：mineflayer 里 pitch 越小越向下
    try {
      // force=true：立即生效（与 !左转/!右转 一致）
      await bot.look(bot.entity.yaw, pitch, true)
    } catch (e) {
      return { ok: false, message: '转向失败：' + ((e && e.message) || e) }
    }
    const dir = raw > 0 ? '向下' : (raw < 0 ? '向上' : '平视')
    return { ok: true, message: `已俯视 ${raw}°（${dir}）` }
  }

  async actionHome (name) {
    const r = await this.services.warpQueue.home(name)
    return { ok: true, message: '回家指令：' + r.status }
  }

  async actionSethome (name) {
    const r = await this.services.warpQueue.sethome(name)
    return { ok: true, message: '设家指令：' + r.status }
  }

  async actionDelhome (name) {
    const r = await this.services.warpQueue.delhome(name)
    return { ok: true, message: '删除家指令：' + r.status }
  }

  async actionFollow (playerName) {
    const bot = this.bot
    if (!bot) return { ok: false, message: '未连接' }
    const player = findOnlinePlayer(bot, playerName)
    const entity = player && player.entity
    if (!entity) return { ok: false, message: '找不到在线玩家：' + playerName }
    const { goals } = require('mineflayer-pathfinder')
    bot.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true)
    this.followTarget = player.username
    return { ok: true, message: '开始跟随 ' + player.username }
  }

  async actionGoto (playerName) {
    const bot = this.bot
    if (!bot) return { ok: false, message: '未连接' }
    const player = findOnlinePlayer(bot, playerName)
    const entity = player && player.entity
    if (!entity) return { ok: false, message: '找不到在线玩家：' + playerName }
    const { goals } = require('mineflayer-pathfinder')
    await this.services.taskRunner.enqueue({
      name: 'web-goto', kind: 'goto', timeoutMs: 60000,
      run: async () => {
        const ep = entity.position
        await bot.pathfinder.goto(new goals.GoalNear(ep.x, ep.y, ep.z, 2))
      },
    })
    return { ok: true, message: '已到达 ' + player.username + ' 附近' }
  }

  // 指令控制台：发送任意命令（/开头）或聊天
  async actionConsole (text) {
    const t = String(text || '').trim()
    if (!t) return { ok: false, message: '内容为空' }
    if (t.startsWith('/')) await this.services.chatQueue.sendCommand(t, { priority: 5, dedupe: false })
    else await this.services.chatQueue.send(t, { priority: 9, dedupe: false })
    return { ok: true, message: '已发送：' + t }
  }

  // 防 AFK 开关
  setAntiAfk (on) {
    this._afkPaused = !on
    const bot = this.bot
    if (bot && bot.afk) {
      if (on) bot.afk.start(this.account.antiAfk)
      else bot.afk.stop()
    }
    return { ok: true, message: on ? '防AFK已恢复' : '防AFK已暂停' }
  }

  // 自动进食开关（面板用；聊天 !进食 指令直接操作 services.autoEat）
  setAutoEat (on) {
    const autoEat = this.services.autoEat
    autoEat.enabled = !!on
    if (on) autoEat.start(); else autoEat.stop()
    return { ok: true, message: on ? '自动进食已开启' : '自动进食已关闭' }
  }

  // 灾厄之瓶开关（面板用）：on 时立即喝一瓶并按分钟定时
  async actionBottle (on, minutes) {
    if (on) return await this.services.bottleRunner.start(minutes)
    return this.services.bottleRunner.stop()
  }

  // ---- 箱子 / 木桶（!存箱 / !取 / !开箱，面板同款按钮）----
  // 存箱：按配置规则把该存的存进仓库箱子；all=true 时除 keep 外全部存
  async actionDeposit (all) {
    return await this.services.chestManager.depositAll({ all: !!all, manual: true })
  }

  // 取物：从仓库箱子取出指定物品
  async actionWithdraw (name, count) {
    return await this.services.chestManager.withdraw(name, count)
  }

  // 开箱查看：只走过去打开看看，不存不取
  async actionPeekChest () {
    return await this.services.chestManager.peek()
  }

  // 清空：一次性丢出【全部】物品——盔甲(5-8) + 主背包(9-35) + 快捷栏(36-44) + 副手(45)
  // 整叠丢；组间只留很短间隔，避免同一时刻刷太多包被判异常
  async actionClear () {
    const bot = this.bot
    if (!bot) return { ok: false, message: '未连接' }
    try { if (bot.afk) bot.afk.setPickupSuppressed(true) } catch (_) { /* 忽略 */ }
    let groups = 0
    const failed = []
    try {
      // window.items() 只覆盖 inventoryStart~End（9-44，主背包+快捷栏），
      // 盔甲与副手要自己指定范围：5-8 盔甲、45 副手。
      const items = bot.inventory.itemsRange(5, 46)
      const window = bot.currentWindow || bot.inventory
      for (const it of items) {
        try {
          // sourceStart/End 精确指向这一格：这样盔甲/副手也能被丢出去
          await bot.transfer({
            window,
            itemType: it.type,
            metadata: it.metadata,
            count: it.count, // 整叠
            sourceStart: it.slot,
            sourceEnd: it.slot + 1,
            destStart: -999, // -999 = 丢出窗口（丢弃）
          })
          groups++
        } catch (_) { failed.push(`${it.name}×${it.count}`) }
        await sleep(40)
      }
    } finally {
      await sleep(800) // 等丢出的物品飞离吸附范围，再恢复拾取
      try { if (bot.afk) bot.afk.setPickupSuppressed(false) } catch (_) { /* 忽略 */ }
    }
    if (!groups && !failed.length) return { ok: true, message: '背包（含盔甲/副手）本就是空的' }
    return {
      ok: true,
      message: `已清空，一次性丢出 ${groups} 组物品（含盔甲/副手）` +
        (failed.length ? `；${failed.length} 组失败：${failed.slice(0, 3).join('、')}` : ''),
    }
  }

  /**
   * 移动到指定坐标（pathfinder），距目标 range 格停止，带 60s 超时保护
   * @param {number} range 停止距离，默认 0.3
   */
  async actionMoveTo (x, y, z, range) {
    const bot = this.bot
    if (!bot) return { ok: false, message: '未连接' }
    const r = Number(range)
    const useRange = Number.isFinite(r) && r > 0 ? r : 0.3
    const { GoalNear } = require('mineflayer-pathfinder').goals
    try {
      await this.services.taskRunner.enqueue({
        name: 'move-to', kind: 'goto', timeoutMs: 60000,
        run: async () => { await bot.pathfinder.goto(new GoalNear(Number(x), Number(y), Number(z), useRange)) },
      })
      return { ok: true, message: `已移动到 ${x},${y},${z}（${useRange} 格内）` }
    } catch (e) {
      return { ok: false, message: '移动失败或超时：' + ((e && e.message) || e) }
    }
  }

  /**
   * 正前方攻击开关（面板/命令共用）
   * @param {string[]} args 第一个为 tick 数；'关/off' 关闭
   */
  actionAttack (args) {
    const a0 = String((args && args[0]) || '').toLowerCase()
    if (['关', '关闭', '停', 'off', '0'].includes(a0)) return this.services.attackRunner.stop()
    return this.services.attackRunner.start(args && args[0])
  }

  // ---- 管理指令调用 ----
  requestReconnect () {
    this._manualStop = false
    this._clearWaitServer() // 手动重连：不等了，直接连（服务器还没上线就再按策略重试）
    this.reconnectPolicy.reset()
    if (this.bot) { try { this.bot.quit('主动重连') } catch (_) { this._recreateNow() } }
    else this._recreateNow()
  }

  _recreateNow () {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer)
    this._cleanupBot()
    // 旧 bot 的监听要拆干净：否则它再发一次 end 会触发第二轮重连
    if (this.bot) { try { this.bot.removeAllListeners() } catch (_) { /* 忽略 */ } this.bot = null }
    this._createBot()
  }

  shutdownBot () {
    this._manualStop = true
    this._clearWaitServer()
    if (this.bot) { try { this.bot.quit('主动关闭') } catch (_) { /* 忽略 */ } }
    this.status = 'ended'
  }

  // 进程退出
  async stop () {
    this._manualStop = true
    this._clearWaitServer()
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer)
    if (this.bot && this.status !== 'ended') {
      await new Promise(r => {
        this.bot.once('end', r)
        try { this.bot.quit('退出') } catch (_) { r() }
        setTimeout(r, 1500)
      })
    }
    this._cleanupBot()
    const fns = this.permCleanups.splice(0)
    for (let i = fns.length - 1; i >= 0; i--) { try { fns[i]() } catch (_) { /* 忽略 */ } }
    this.status = 'ended'
  }

  // 私聊写法候选：自己配的排最前，后面跟上内置的 msg/tell/w（去重）
  _whisperForms () {
    const cfg = this.globalCfg.reply || {}
    const own = Array.isArray(cfg.whisperCommands)
      ? cfg.whisperCommands
      : (cfg.whisperCommand ? [cfg.whisperCommand] : [])
    const list = own.concat(REPLY_WHISPER_FORMS).map(s => String(s == null ? '' : s).trim()).filter(Boolean)
    return list.filter((s, i) => list.indexOf(s) === i)
  }

  _botName () { return (this.bot && this.bot.username) || 'Bot' }

  /**
   * 回复玩家：面板日志 + 游戏内 /msg 私聊（到人）
   *   1) 按 reply.whisperCommands（默认 msg / tell / w）第一种私聊写法发；
   *   2) 服务器若回“未知命令/无权限”（插件锁指令、禁了该写法）→ 5 秒内认定被拒，
   *      自动换下一种写法；全都被拒才改公屏（前缀 reply.chatPrefix），过 10 分钟再从第一种试起；
   *   3) 两种走法都会写进面板控制台日志，并标注（私聊：msg / 公屏）。
   * 配置：reply.whisperCommands（数组，可只留一种）/ reply.whisperCommand（旧的单项写法，仍兼容）
   *      / reply.chatPrefix / reply.fallbackChat(false 则永不用公屏)
   */
  async sendReply (to, text) {
    const cfg = this.globalCfg.reply || {}
    const monitor = this.chatMonitor
    const botName = this._botName()
    const forms = this._whisperForms()
    const idx = Math.min(Math.max(0, this._reply.formIndex || 0), forms.length - 1)
    const tmpl = forms[idx]
    const tryWhisper = Date.now() - (this._reply.whisperFailedAt || 0) > REPLY_RETRY_MS
    const useWhisper = tryWhisper || cfg.fallbackChat === false
    const prefix = String(cfg.chatPrefix || '[给 {to}] ').replace('{to}', String(to))
    for (const seg of chunkString(String(text), 200)) {
      if (monitor) monitor.feed('cmd-out', botName, seg, { to, via: useWhisper ? 'whisper' : 'chat', form: useWhisper ? tmpl : '' })
      if (useWhisper) {
        this._reply.pending = { at: Date.now(), to, seg, form: tmpl }
        await this.services.chatQueue.sendCommand(tmpl.replace('{to}', String(to)).replace('{msg}', seg), { priority: 1, dedupe: false })
      } else {
        await this.services.chatQueue.send(prefix + seg, { priority: 2, dedupe: false })
      }
    }
  }

  // 服务器每句话都过一下：刚发出的私聊被回“未知命令/没权限”时，换下一种私聊写法；全被拒才改公屏
  noteServerMessage (text) {
    const p = this._reply.pending
    if (!p) return
    if (Date.now() - p.at > REPLY_REJECT_WINDOW_MS) { this._reply.pending = null; return }
    if (!REPLY_REJECT_RE.test(String(text || ''))) return
    this._reply.pending = null
    const cfg = this.globalCfg.reply || {}
    const forms = this._whisperForms()
    const used = p.form || forms[0]
    const short = String(text || '').slice(0, 60)
    const next = (this._reply.formIndex || 0) + 1

    // 还有别的私聊写法 → 换成下一种（仍然到人；fallbackChat=false 只禁公屏，不影响换写法）
    if (next < forms.length) {
      this._reply.formIndex = next
      this.logger.warn(`私聊写法「${used}」被服务器拒绝（${short}），改用「${forms[next]}」`)
      if (this.chatMonitor) {
        this.chatMonitor.feed('cmd-out', this._botName(),
          `（私聊写法 ${used} 被拒，换成 ${forms[next]} 重试）`, { to: p.to, via: 'whisper', form: forms[next] })
      }
      return
    }

    this._reply.whisperFailedAt = Date.now()
    this._reply.formIndex = 0 // 过 REPLY_RETRY_MS 之后从第一种写法重新试
    if (cfg.fallbackChat === false) {
      if (this._reply.warnedAt === 0 || Date.now() - this._reply.warnedAt > 60000) {
        this._reply.warnedAt = Date.now()
        this.logger.warn('私聊写法都被服务器拒绝，且 reply.fallbackChat=false（不用公屏），回执只能看面板')
        if (this.chatMonitor) this.chatMonitor.feed('cmd-out', this._botName(), '（私聊都被拒，fallbackChat=false，只能看面板）', { to: p.to, via: 'whisper' })
      }
      return
    }
    this.logger.warn(`私聊写法都被服务器拒绝（${short}），改在公屏回复 ${p.to}` +
      '（想修好的话把配置 reply.whisperCommands 改成服务器支持的写法，例如 "msg {to} {msg}"）')
    if (this.chatMonitor && (this._reply.warnedAt === 0 || Date.now() - this._reply.warnedAt > 60000)) {
      this._reply.warnedAt = Date.now()
      this.chatMonitor.feed('cmd-out', this._botName(),
        '（私聊都被拒，之后改用公屏；可改配置 reply.whisperCommands 换写法）', { to: p.to, via: 'chat' })
    }
  }

  // Web 状态
  getStatus () {
    const bot = this.bot
    const e = bot && bot.entity
    let uptime = null
    if (this.status === 'online' && this.onlineSince) {
      const s = Math.floor((Date.now() - this.onlineSince) / 1000)
      uptime = `${Math.floor(s / 3600)}时${Math.floor((s % 3600) / 60)}分`
    }
    const srv = this._resolveServer()
    return {
      username: this.account.username,
      // 面板卡片的唯一标识：账号名@服务器:端口（同名账号挂不同服时区分两张卡片）
      key: this.account.username.toLowerCase() + '@' + String(srv.host || '').toLowerCase() + ':' + (Number(srv.port) || 25565),
      auth: this.account.auth,
      enabled: this.account.enabled !== false,
      status: this.status,
      serverHost: srv.host,
      serverPort: srv.port,
      position: e ? [Number(e.position.x.toFixed(1)), Number(e.position.y.toFixed(1)), Number(e.position.z.toFixed(1))] : null,
      health: bot ? bot.health : null,
      food: bot ? bot.food : null,
      dimension: bot && bot.game ? bot.game.dimension : null,
      reconnectAttempts: this.reconnectPolicy.attempts,
      waitingServer: !!this._waitServerCancel, // 正在等服务器上线（没在直连）
      serverState: this._probe ? this._probe.state : 'unknown', // unknown | online | offline
      antiAfk: !this._afkPaused,
      autoEat: this.services.autoEat.enabled,
      bottle: this.services.bottleRunner.enabled,
      attack: this.services.attackRunner.enabled,
      attackTicks: this.services.attackRunner.intervalTicks,
      authed: this.services.autoAuth.enabled ? this.services.autoAuth.isAuthed : null, // null = 未启用自动登录
      chestConfigured: this.services.chestManager.isConfigured(),
      chestBusy: this.services.chestManager._busy,
      tps: this.services.metrics.tps, // 服务器 TPS（估算，拿不到为 null）
      ping: this.services.metrics.ping, // 本连接延迟（服务器广播；拿不到为 null）
      mspt: this.services.metrics.mspt, // 每 tick 毫秒数（估算，拿不到为 null）
      inv: this._invSnapshot(), // 背包/装备/副手快照（离线为 null）
      uptime,
    }
  }

  // 背包快照（面板显示用）：快捷栏 0-8 + 背包 9-35、装备 36-39（靴/腿/胸/头）、副手 45。
  // 物品名优先用中文映射（itemNamesZh，官方 zh_cn 生成），没有的回退 mineflayer 英文显示名；
  // 只留物品显示名和数量，不挖 NBT；离线或窗口未就绪返回 null
  _invSnapshot () {
    const bot = this.bot
    if (!bot || !bot.inventory || !Array.isArray(bot.inventory.slots)) return null
    const cell = it => it ? { n: ITEM_ZH[it.name] || it.displayName || it.name, c: it.count } : null
    const s = bot.inventory.slots
    const main = []
    for (let i = 0; i < 36; i++) main.push(cell(s[i]))
    const armor = [s[39], s[38], s[37], s[36]].map(cell) // 头盔/胸甲/护腿/靴子
    return { main, armor, off: cell(s[45]) }
  }

  /**
   * 给外部（MC 客户端 mod / 本地软件）用的 bot 数据快照。
   * 与 getStatus 的区别：字段名尽量贴合游戏里常见的叫法（dim/world、pos、hp），
   * 且附带实体数 / 玩家数等只有这里才方便统计的量。
   * 取不到的字段一律给 null，由展示端决定显示成 "-"，不编造数值。
   */
  getBotSnapshot () {
    const bot = this.bot
    const e = bot && bot.entity
    // 账号没配服务器时 _resolveServer 可能给不出对象；整个接口不能因此崩掉
    let srv = {}
    try { srv = this._resolveServer() || {} } catch (_) { /* 取不到就留空 */ }

    // 实体数：只统计本机器人视野内已加载的实体
    let entities = null
    try {
      if (bot && bot.entities) entities = Object.keys(bot.entities).length
    } catch (_) { /* 取不到就留 null */ }

    // 玩家数：优先用服务器 TAB 列表（在线玩家）
    let players = null
    try {
      if (bot && bot.players) players = Object.keys(bot.players).length
    } catch (_) { /* 取不到就留 null */ }

    // 区块数：本 bot 已加载的区块数量
    let chunkCount = null
    try {
      if (bot && bot.world && typeof bot.world.getLoadedChunkCount === 'function') {
        chunkCount = bot.world.getLoadedChunkCount()
      } else if (bot && bot.world && Array.isArray(bot.world.chunks)) {
        chunkCount = bot.world.chunks.length
      }
    } catch (_) { /* 取不到就留 null */ }

    // 服务器指标：取不到一律 null（HUD 显示 "-"）
    const m = (this.services && this.services.metrics) || {}
    const out = {
      username: this.account && this.account.username ? this.account.username : null,
      serverHost: srv.host || null,
      serverPort: Number(srv.port) || 25565,
      status: this.status,
      dimension: bot && bot.game ? bot.game.dimension : null,
      position: e ? [
        Math.round(e.position.x * 10) / 10,
        Math.round(e.position.y * 10) / 10,
        Math.round(e.position.z * 10) / 10
      ] : null,
      health: (bot && typeof bot.health === 'number') ? Math.round(bot.health * 10) / 10 : null,
      food: (bot && typeof bot.food === 'number') ? Math.round(bot.food * 10) / 10 : null,
      tps: (typeof m.tps === 'number') ? m.tps : null,
      mspt: (typeof m.mspt === 'number') ? m.mspt : null,
      ping: (typeof m.ping === 'number') ? m.ping : null,
      entities: entities,
      players: players,
      chunkCount: chunkCount,
      // 领地 / 拥有者：等接入领地插件（GriefPrevention / Residence）再填，目前固定 null
      claim: null,
      owner: null,
      updatedAt: Date.now(),
    }
    return out
  }
}

module.exports = { BotContext }
