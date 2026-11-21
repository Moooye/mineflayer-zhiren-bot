// ============================================================
// 配置加载与校验
// 启动时调用 loadConfig(可选配置路径)：字段有误会收集全部问题并抛中文错误；
// 未提供的可选块自动补默认值
// ============================================================
'use strict'
const fs = require('fs')
const path = require('path')

const VALID_AUTH = ['microsoft', 'offline']

function loadConfig (configPathArg) {
  const defaultPath = path.join(__dirname, '..', '..', 'config', 'accounts.config.js')
  const configPath = configPathArg ? path.resolve(process.cwd(), configPathArg) : defaultPath
  let cfg
  try {
    cfg = require(configPath)
  } catch (e) {
    throw new Error(
      `无法加载配置 ${configPath}：${e.message}\n` +
      '请确认文件存在，可从 config/accounts.config.example.js 复制一份再修改。'
    )
  }

  // 面板覆盖层：Web 面板增删 bot / 改登录方式 / 改服务器IP 后写入的同名 .panel.json
  // 存在则用它覆盖 server 与 accounts（不改动带注释的原始 .js）
  const panelPath = configPath.replace(/\.(c?js|json)$/i, '') + '.panel.json'
  try {
    const panel = JSON.parse(fs.readFileSync(panelPath, 'utf8'))
    if (panel && panel.server) cfg.server = Object.assign({}, cfg.server, panel.server)
    if (panel && Array.isArray(panel.accounts)) cfg.accounts = panel.accounts
    // 白名单仅合并好友名单、好友组可用指令、传送白名单管理员与传送白名单，owners（最高权限者）保持原配置
    if (panel && panel.whitelist) {
      cfg.whitelist = cfg.whitelist || {}
      if (Array.isArray(panel.whitelist.friends)) cfg.whitelist.friends = panel.whitelist.friends
      if (Array.isArray(panel.whitelist.friendCommands)) cfg.whitelist.friendCommands = panel.whitelist.friendCommands
      // 下面这两项也是面板/聊天里改的，必须一起合并回来，否则重启就丢
      if (Array.isArray(panel.whitelist.tpAdmins)) cfg.whitelist.tpAdmins = panel.whitelist.tpAdmins
      if (Array.isArray(panel.whitelist.tpPlayers)) cfg.whitelist.tpPlayers = panel.whitelist.tpPlayers
      // 每个白名单玩家的个人权限（对象：小写玩家名 -> 指令名数组），面板里单独勾选的
      if (panel.whitelist.friendPerms && typeof panel.whitelist.friendPerms === 'object') {
        cfg.whitelist.friendPerms = panel.whitelist.friendPerms
      }
    }
  } catch (e) {
    // 文件不存在属于正常情况；但“文件存在却解析失败”必须报警：
    // 覆盖层会被整体丢弃，表现为面板里改了、重启后又变回去，很难排查
    if (fs.existsSync(panelPath)) {
      console.error(`\x1b[31m[配置] 覆盖层 ${panelPath} 格式错误，已忽略（面板上的改动不会生效）：${e.message}\x1b[0m`)
    }
  }

  // 记录实际配置路径，供 ConfigStore 定位覆盖文件
  cfg.__configPath = configPath

  const errors = []

  // ---- server ----
  if (!cfg.server || !cfg.server.host) errors.push('server.host 服务器地址必填，例如 mc.example.com')
  cfg.server = cfg.server || {}
  // 端口“填了才用”：留空就保持未指定，不往配置里塞默认值（不然面板上会一直是 25565，
  // 也分不清到底是“没填”还是“手填了 25565”）。连接时由 BotContext 退到默认 25565。
  const rawPort = cfg.server.port
  cfg.server.port = (rawPort === undefined || rawPort === null || String(rawPort).trim() === '')
    ? undefined
    : (Number(rawPort) || undefined)
  if (cfg.server.version === undefined) cfg.server.version = false

  // ---- timing ----
  cfg.timing = Object.assign({ joinDelayMs: 5000, joinTimeoutMs: 180000 }, cfg.timing)

  // ---- 各功能块默认值 ----
  cfg.reconnect = Object.assign(
    { baseDelayMs: 2000, maxDelayMs: 300000, jitter: 0.2, maxAttempts: 10, longCooldownMs: 1800000, maintenanceDelayMs: 300000 },
    cfg.reconnect
  )
  cfg.taskRunner = Object.assign({ rapidWindowMs: 60000, rapidLimit: 5, cooldownMs: 60000 }, cfg.taskRunner)
  cfg.chatQueue = Object.assign({ minIntervalMs: 1500, dedupeMs: 3000, maxQueue: 50 }, cfg.chatQueue)
  cfg.warp = Object.assign({ cooldownMs: 3000, moveThreshold: 3, instantTimeoutMs: 15000, requestTimeoutMs: 5000 }, cfg.warp)
  cfg.autoEat = Object.assign({ enabled: true, startAt: 14, checkMs: 10000 }, cfg.autoEat)
  cfg.greetings = Object.assign({ greetOnSpawn: false, welcomeOnJoin: false }, cfg.greetings)
  // allowedServerCommands：!指令 允许转发的服务器指令白名单（保守默认，可在配置追加）
  cfg.commands = Object.assign(
    { prefix: '!', allowedServerCommands: ['list', 'spawn', 'help', 'me'] },
    cfg.commands
  )
  cfg.notifier = Object.assign({ enabled: false, webhookUrl: '', events: ['death', 'giveUp'] }, cfg.notifier)
  cfg.web = Object.assign({ enabled: false, host: '127.0.0.1', port: 8848 }, cfg.web)
  // 回执（回复玩家）：私聊写法按顺序试，被服务器拒了就换下一种，全被拒才改公屏
  cfg.reply = Object.assign(
    { whisperCommands: ['msg {to} {msg}', 'tell {to} {msg}', 'w {to} {msg}'], chatPrefix: '[给 {to}] ', fallbackChat: true },
    cfg.reply
  )

  // ---- autoAuth 自动登录/注册（有登录插件的服务器）----
  // password 必填才会启用；没配密码时整个功能不生效（不会乱发空密码）
  // register：'auto' 按服务器提示自动判断该注册还是登录 | true 只注册 | false 只登录
  cfg.autoAuth = Object.assign(
    {
      enabled: true,
      password: '',
      register: 'auto',
      loginCommand: 'login',
      registerCommand: 'register',
      retryMs: 8000,     // 两次尝试的最小间隔（防刷屏）
      maxAttempts: 5,    // 最多试几次，超过就放弃并告警
    },
    cfg.autoAuth
  )

  // ---- chest 箱子/木桶自动存取 ----
  // station：仓库点坐标（{x,y,z} 或 [x,y,z]）；也可只配 stationAlias 走服务器 home 指令回家
  // keep：永远留身上不存；deposit：!存箱 时会被存进去的名单（不配则只响应「!存箱 全部」）
  //   ★ 两个名单里物品名**中文英文都能写**：'钻石镐' 与 'diamond_pickaxe' 等价（见 utils/itemNames.js 对照表）
  cfg.chest = Object.assign(
    {
      enabled: true,
      station: null,
      stationAlias: '',
      blocks: ['chest', 'trapped_chest', 'barrel'],
      searchRadius: 6,
      keep: ['diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'diamond_sword', 'iron_sword',
        'torch', 'bread', 'cooked_beef', 'golden_apple', 'water_bucket', 'bucket'],
      deposit: [],
      autoScheduleMs: 0, // >0 时定时自动存箱（毫秒），0 = 关
      openTimeoutMs: 8000,
      actionTimeoutMs: 5000,
    },
    cfg.chest
  )

  // ---- antiAfk ----
  cfg.antiAfk = Object.assign(
    { enabled: true, minIntervalMs: 20000, maxIntervalMs: 90000, actions: ['swing', 'look', 'jump', 'walk'], walkRadius: 3 },
    cfg.antiAfk
  )

  // ---- whitelist ----
  // friendCommands：白名单（组2）可用的指令清单，按指令名（见 src/commands/*.js 的 name）；
  //   管理类(admin)指令不受此表影响，永远只归 owners
  // tpAdmins：传送白名单管理员（组3，只能管传送白名单）；tpPlayers：传送白名单成员
  //   （他们唯一特权 = 自己的 tpa/tpahere 机器人自动接受）；可用 !传送管理员 / !传送白名 或面板指定
  cfg.whitelist = Object.assign(
    {
      owners: [],
      tpAdmins: [],
      tpPlayers: [],
      friends: [],
      blacklist: [],
      friendCommands: [
        // 查询 / 移动
        'status', 'stop', 'goto', 'follow', 'move', 'turnleft', 'turnright', 'lookdown',
        // 传送
        'home', 'sethome', 'delhome', 'tpa', 'tpahere',
        // 功能开关 / 动作
        'eat', 'bottle', 'attack', 'afk',
      ],
    },
    cfg.whitelist
  )

  // ---- autoAcceptTpa ----
  // 白名单玩家（owners/friends）对机器人 tpa / tpahere 时自动执行接受命令（默认 /tpaccept）
  cfg.autoAcceptTpa = Object.assign(
    {
      enabled: true,
      command: 'tpaccept',
      cooldownMs: 5000,
    },
    cfg.autoAcceptTpa
  )

  // ---- perf ----
  // 挂机卡顿优化（服务器实体/区块多时省 CPU）：
  //   viewDistance：客户端视距。null = 不改（默认，保持原版 mineflayer 行为）；
  //                 想看得更远可写数字（2-32 chunk）或 'far'/'normal'/'short'/'tiny'
  //   entityFilter：实体过滤。非 keepTypes 里的实体不会进入机器人内存（读不到、存不进、不遍历），
  //                 因此服务器刷再多怪也不会拖累机器人；
  //                 player / item 是跟随、去、传送、防AFK拾取必需的实体，默认保留；
  //                 ★ keepNearRadius（默认 8 格）内的实体一律保留：!攻击 走 bot.entityAtCursor()，
  //                   靠它才能命中；远的一样过滤掉，内存代价被“身边八格”限制住（0 = 关掉近身保留）
  cfg.perf = Object.assign(
    {
      viewDistance: null,
      // 远处区块保留数（单位：区块，1 区块 = 16 格）：机器人每 chunkTrimMs 会把
      // “离自己超过 keepChunks 个区块”的旧区块从内存里卸掉，防止长时间挂机内存一路涨到堆上限崩掉。
      // 调大 = 保留更多地形（内存高）；调小 = 省内存（走回去时服务器会重新下发区块）
      keepChunks: 16,
      chunkTrimMs: 300000, // 清理间隔（毫秒，最小 60000）
      trimChunks: true, // false = 关掉远处区块自动清理
      // 内存看门狗（按 Node 堆上限的比例，目标：快满就先就地清理，尽量不摇线）：
      //   到 cleanRatio 软清理（卸远处区块 + 强制 GC）
      //   到 hardRatio 硬清理（只留身边 2 区块 + 丢掉怪/动物实体 + 再 GC）
      //   到 restartRatio 才先硬清理一次，清不下来才优雅重启（start.bat 5 秒后拉起）
      memory: {
        warnRatio: 0.70,
        cleanRatio: 0.78,
        hardRatio: 0.85,
        restartRatio: 0.95,
        minCleanGapMs: 60000, // 两次自动清理的最小间隔，避免频繁清理拖慢机器人
      },
    },
    cfg.perf
  )
  cfg.perf.memory = Object.assign(
    { warnRatio: 0.70, cleanRatio: 0.78, hardRatio: 0.85, restartRatio: 0.95, minCleanGapMs: 60000 },
    cfg.perf.memory
  )
  cfg.perf.entityFilter = Object.assign(
    // 默认关闭：开启后能判定类型的怪会从内存里清掉（真实释放，不是只把代理遮住），
    // 但每个实体包会多一次拦截判断（同一台机器上 CPU 反而略高），所以按需再开：
    //   !实体过滤 开   （或把这里 enabled 改成 true）
    // keepNearRadius：近身保留半径（格），这个距离内的实体一律不过滤。!攻击 走 bot.entityAtCursor()
    //   （默认 3.5 格）要靠它命中，所以默认留 8 格；0 = 关掉近身保留（!攻击 会空挥）
    // keepNearMax：近身保留的实体数量上限（身边一堆怪时也有个顶）
    { enabled: false, keepTypes: ['player', 'item'], keepNearRadius: 8, keepNearMax: 40, logEveryMs: 60000, sweepMs: 10000, unknownTtlMs: 15000, hiddenTtlMs: 600000 },
    cfg.perf.entityFilter
  )

  // ---- serverWatch ----
  // 服务器在线探测（服务器列表 ping，和客户端“刷新服务器”同一条协议）：
  //   机器人断线后不盲目直连——先探一次服务器是否在线：
  //     · 不在线 → 保持离线，只按 intervalMs 探测（不发登录包），一探测到在线立刻自动重连；
  //     · 在线   → 照常按退避重连。
  //   intervalMs：服务器不在线时的探测间隔；timeoutMs：单次探测超时；
  //   enabled:false = 关掉（回到“不看服务器状态、按退避盲连”的老行为）
  cfg.serverWatch = Object.assign(
    { enabled: true, intervalMs: 10000, timeoutMs: 5000 },
    cfg.serverWatch
  )

  // ---- accounts 校验 ----
  // 允许账号列表为空：此时为“纯面板模式”，面板可脱离 MC 服务器独立运行；
  // 用户先在面板填写服务器IP、添加机器人，再连接（见 start.bat 开箱流程）
  if (!Array.isArray(cfg.accounts)) cfg.accounts = []
  {
    const seen = new Set()
    cfg.accounts.forEach((a, i) => {
      const where = `accounts[${i}]`
      if (!a.username) errors.push(`${where}.username 用户名必填`)
      else if (seen.has(a.username)) errors.push(`${where} 用户名重复：${a.username}`)
      else seen.add(a.username)
      if (a.auth && !VALID_AUTH.includes(a.auth)) errors.push(`${where}.auth 只能是 microsoft 或 offline`)
      if (a.auth === undefined) a.auth = 'microsoft'
      if (a.enabled === undefined) a.enabled = true
    })
  }

  if (errors.length > 0) {
    throw new Error('配置校验失败，共 ' + errors.length + ' 处问题：\n  - ' + errors.join('\n  - '))
  }

  // 账号级 antiAfk 与全局合并
  for (const a of cfg.accounts) {
    a.antiAfk = Object.assign({}, cfg.antiAfk, a.antiAfk || {})
  }

  return cfg
}

module.exports = { loadConfig }
