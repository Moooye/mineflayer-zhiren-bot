// ============================================================
// 配置模板：复制本文件为 accounts.config.js 后按需修改
//   复制命令（PowerShell）：
//   Copy-Item config\accounts.config.example.js config\accounts.config.js
// ============================================================

module.exports = {
  // ---------- 服务器 ----------
  server: {
    host: 'mc.example.com',
    port: 25565,
    version: false, // false = 自动探测；或明确填 '26.1.2' / '1.20.4'
  },

  // ---------- 启动节奏 ----------
  timing: {
    joinDelayMs: 5000,  // 账号错峰进服间隔
    joinTimeoutMs: 600000, // 单账号上线/首次授权等待
  },

  // ---------- 聊天指令前缀 ----------
  commands: { prefix: '!' },

  // ---------- 聊天限流（防刷屏） ----------
  chatQueue: {
    minIntervalMs: 1500, // 每条消息最小间隔
    dedupeMs: 3000,      // 相同内容冷却去重
    maxQueue: 50,        // 队列上限，溢出丢弃低优先级
  },

  // ---------- 传送队列 ----------
  warp: {
    cooldownMs: 3000,       // 两次传送最小间隔
    moveThreshold: 3,       // 判定传送完成的水平位移（格）
    instantTimeoutMs: 15000,// 即时传送等待
    requestTimeoutMs: 5000, // tpa 请求发送等待
  },

  // ---------- 断线重连 ----------
  reconnect: {
    baseDelayMs: 2000,      // 首次退避
    maxDelayMs: 300000,     // 退避封顶（5 分钟）
    jitter: 0.2,            // ±20% 随机抖动
    maxAttempts: 10,        // 连续失败次数，超限进入长冷却
    longCooldownMs: 1800000,// 长冷却（30 分钟）
    maintenanceDelayMs: 300000,
  },

  taskRunner: { rapidWindowMs: 60000, rapidLimit: 5, cooldownMs: 60000 },

  // ---------- 防 AFK ----------
  antiAfk: {
    enabled: true,
    minIntervalMs: 20000,
    maxIntervalMs: 90000,
    actions: ['swing', 'look', 'jump', 'walk'],
    walkRadius: 3,
  },

  // ---------- 自动进食 ----------
  autoEat: { enabled: true, startAt: 14, checkMs: 10000 },

  // ---------- 问候（挂机建议关闭） ----------
  greetings: {
    greetOnSpawn: false,
    greetText: '大家好，机器人已上线',
    welcomeOnJoin: false,
    welcomeText: '欢迎 {name}',
  },

  // ---------- 白名单 / 权限组 ----------
  whitelist: {
    owners: ['你的管理员玩家名'],          // 最高权限组：全部指令（含管理类）
    friends: [],               // 白名单组：仅能使用 friendCommands 里的指令
    blacklist: [],             // 黑名单：永不响应
    // 白名单组可用的指令，按指令名（见 src/commands/*.js 的 name）；'*' = 不限
    // 管理类(admin)指令不受此表影响，永远只归 owners
    friendCommands: [
      // 查询 / 移动（turnleft/turnright=左右转，lookdown=俯视 [角度]）
      'status', 'stop', 'goto', 'follow', 'move', 'turnleft', 'turnright', 'lookdown',
      // 传送
      'home', 'sethome', 'delhome', 'tpa', 'tpahere',
      // 功能开关 / 动作
      'eat', 'bottle', 'attack', 'afk',
    ],
  },

  // ---------- 事件通知（可选 Webhook） ----------
  notifier: {
    enabled: false,
    webhookUrl: '', // 通用 Webhook；Discord 填其 webhook 地址
    events: ['death', 'giveUp'],
  },

  // ---------- Web 只读状态面板 ----------
  web: { enabled: false, host: '127.0.0.1', port: 9999 },

  // ---------- 账号 ----------
  accounts: [
    {
      username: '账号B',
      enabled: true,
      auth: 'microsoft', // microsoft（正版）| offline（离线，仅离线服可用）
    },
    { username: '账号C', enabled: true, auth: 'microsoft' },
    { username: '账号D', enabled: true, auth: 'microsoft' },
  ],
}
