// ============================================================
// ChestManager：箱子 / 木桶自动存取
//
// 依据：mineflayer 官方示例 examples/chest.js 的标准做法
//   findBlock(箱子类方块) → bot.openContainer(方块) → chest.deposit/withdraw → chest.close
// 本模块在此之上补齐了挂机场景需要的东西：
//   ① 寻路过去（走不到就报错，不干等）；
//   ② 每个动作都有超时（开箱、存、取、关），失败自动 close 不留半开的窗口；
//   ③ 「带走什么 / 存什么」的规则引擎（keep / deposit / withdraw）；
//   ④ 同一时间只允许一个容器操作（用 TaskRunner 串行，避免和移动/进食打架）。
//
// 指令：
//   !存箱              走到仓库点，按规则把该存的存进去
//   !取 <物品> <数量>   走到仓库点，取出指定数量（数量不填 = 尽量取）
//   !开箱              只走过去把箱子打开，看看里面有什么（不存不取）
//
// 配置（config 里 chest 块，全部可省）：
//   chest: {
//     enabled: true,
//     station: { x: 100, y: 64, z: -200 },   // 仓库点坐标（必填才能用）
//     stationAlias: '家',                     // 可选：没配坐标时，改用服务器指令回家再找箱子
//     blocks: ['chest','trapped_chest','barrel'],
//     searchRadius: 6,                        // 在仓库点附近多大范围找箱子
//     keep: ['diamond_pickaxe','iron_pickaxe','torch','bread'],  // 永远留在身上，不存
//     deposit: ['cobblestone','dirt','gravel','andesite','diorite','granite','tuff',   // 会自动存进箱子
//               'netherrack','sand','red_sand','flint','stick','rotten_flesh'],
//     autoScheduleMs: 0,                      // >0 时定时自动存箱（0 = 关）
//     openTimeoutMs: 8000,
//     actionTimeoutMs: 5000,
//   }
// ============================================================
'use strict'

const { sleep } = require('../utils/helpers')
const { 解析物品名, 取中文名 } = require('../utils/itemNames')
const { ChestIndex, 索引文件路径 } = require('./ChestIndex')

// 箱子类方块：默认这三种（都走同一个 openContainer 接口）
const DEFAULT_BLOCKS = ['chest', 'trapped_chest', 'barrel']

// 物品名宽松匹配：支持中文别名与模糊匹配
function 归一 (名字) { return String(名字 == null ? '' : 名字).trim().toLowerCase() }

class ChestManager {
  /**
   * @param {object} botContext BotContext
   * @param {object} options    { enabled, station:{x,y,z}, blocks, searchRadius, keep, deposit, autoScheduleMs, ... }
   */
  constructor (botContext, options = {}) {
    this.ctx = botContext
    const o = options || {}
    this.enabled = o.enabled !== false
    this.station = 解析坐标(o.station)
    this.stationAlias = String(o.stationAlias || '').trim()
    this.blocks = (Array.isArray(o.blocks) && o.blocks.length ? o.blocks : DEFAULT_BLOCKS).map(归一)
    this.searchRadius = Math.max(2, Number(o.searchRadius) || 6)
    // 规则：keep（留身上）/ deposit（自动存箱）/ withdraw（取哪些）
    // 名单里**中文英文都能写**（"钻石镐" 或 diamond_pickaxe），统一解析成英文 ID 再比对
    this.keep = new Set(解析名单(o.keep))
    this.deposit = new Set(解析名单(o.deposit))
    this.withdrawList = 解析名单(o.withdraw)
    this.autoScheduleMs = Math.max(0, Number(o.autoScheduleMs) || 0)
    this.openTimeoutMs = Number(o.openTimeoutMs) || 8000
    this.actionTimeoutMs = Number(o.actionTimeoutMs) || 5000
    // 扫箱时每开一个箱子停顿多久（毫秒）：降服务器压力、也更像真人操作
    this.scanPauseMs = Math.max(0, Number(o.scanPauseMs) || 250)

    this._timer = null
    this._busy = false
    this.lastResult = null
    this.stats = { deposited: 0, withdrawn: 0, trips: 0 }
    // 仓库索引（!扫箱 建成后，!取 / !存箱 就能直达目标箱子，不必现场翻）
    this.index = new ChestIndex().load()
    // 扫箱会话状态：null = 没在扫；否则 { startedAt, scanned, empty, failed, 已扫坐标[] }
    this._scanSession = null
  }

  // 是否可用：需要配了仓库点（坐标或别名）
  isConfigured () { return !!(this.station || this.stationAlias) }

  // ---------- 对外：存箱 ----------
  /**
   * 按规则存箱：把「该存的」物品存进箱子
   * @param {object} [opts] { all:true 全部存（除 keep）、manual:true 手动触发（不受 enabled 限制） }
   */
  async depositAll (opts = {}) {
    if (!this.enabled && !opts.manual) return { ok: false, message: '存箱功能未开启（配置 chest.enabled）' }
    if (!this.isConfigured()) return { ok: false, message: '还没配置仓库点：请在配置里填 chest.station 坐标（或用 chest.stationAlias 走回家）' }
    if (this._busy) return { ok: false, message: '上一趟存箱还没结束' }
    this._busy = true
    try {
      const 走到 = await this._goToStation()
      if (!走到.ok) return 走到
      const 箱子 = await this._openChest()
      if (!箱子.ok) return 箱子

      const chest = 箱子.chest
      const 手里 = chest.items() // 机器人背包里（当前窗口的下半部分）
      const 要存 = 手里.filter(物品 => this._shouldDeposit(物品, opts.all))
      const 跳过 = 手里.length - 要存.length
      let 成功 = 0
      const 失败 = []

      for (const 物品 of 要存) {
        try {
          await this._withTimeout(chest.deposit(物品.type, 物品.metadata, 物品.count), this.actionTimeoutMs)
          成功++
          this.stats.deposited++
        } catch (e) {
          失败.push(`${物品.name}×${物品.count}`)
        }
        await sleep(60) // 别把包发太密
      }
      await this._close(chest)
      this.stats.trips++

      const 说明 = 成功 ? `已存 ${成功} 组进箱子` : '没有需要存进去的物品'
      const 补充 = [
        跳过 ? `留身上 ${跳过} 组` : '',
        失败.length ? `${失败.length} 组失败：${失败.slice(0, 3).join('、')}` : '',
      ].filter(Boolean).join('；')
      this.lastResult = { at: Date.now(), action: 'deposit', count: 成功 }
      return { ok: true, message: 说明 + (补充 ? `（${补充}）` : '') }
    } catch (e) {
      return { ok: false, message: '存箱失败：' + ((e && e.message) || e) }
    } finally {
      this._busy = false
    }
  }

  // ---------- 对外：取物 ----------
  /**
   * 从箱子取出指定物品
   * @param {string} 物品名 支持中文（铁锭）或英文 ID（iron_ingot），也可写片段（铁）
   * @param {number|string} [数量] 不填 = 尽量取（取到背包满或箱子空）
   */
  async withdraw (物品名, 数量) {
    const 原输入 = String(物品名 == null ? '' : 物品名).trim()
    if (!原输入) return { ok: false, message: '用法：!取 <物品> [数量]（物品可写中文，如 铁锭 / 钻石）' }

    // 先把中文（或英文 ID / 片段）解析成标准英文 ID
    const 解析 = 解析物品名(原输入)
    let 目标ID = null
    if (解析.ok) {
      目标ID = 解析.id
    } else if (解析.候选.length) {
      // 模糊命中多个：列出候选让用户说清楚，不猜（猜错会取错东西）
      return { ok: false, message: `「${原输入}」对应多个物品，请写全一点：${解析.候选.join('、')}` }
    } else {
      // 对照表里没有：不直接放弃，可能用户写的就是个表外的英文 ID，
      // 允许它继续走"按名字在箱子里找"的兜底逻辑
      目标ID = null
    }

    if (!this.isConfigured()) return { ok: false, message: '还没配置仓库点：请在配置里填 chest.station 坐标（或用 chest.stationAlias 走回家）' }
    if (this._busy) return { ok: false, message: '上一趟存箱/取物还没结束' }
    const 想要 = 数量 === undefined || 数量 === null || String(数量).trim() === ''
      ? Infinity
      : Math.floor(Number(数量))
    if (想要 !== Infinity && (!Number.isFinite(想要) || 想要 <= 0)) {
      return { ok: false, message: `数量「${数量}」不合法：请填正整数，或留空表示尽量取` }
    }

    this._busy = true
    try {
      // ① 有索引就走索引：直达装着该物品的箱子，不在仓库点现翻（上千箱也能 1~3 秒）
      if (this.index.size > 0) {
        const 索引结果 = await this._withdrawByIndex(目标ID, 原输入, 想要)
        if (索引结果) return 索引结果
        // 索引里没有该物品：回落到下面「仓库点附近开箱」的旧逻辑
      }
      const 走到 = await this._goToStation()
      if (!走到.ok) return 走到
      const 箱子 = await this._openChest()
      if (!箱子.ok) return 箱子

      const chest = 箱子.chest
      // 优先用解析出的标准 ID 精确找；没解析出来就按原文在箱子里模糊找
      const 目标 = (目标ID ? this._findInChest(chest, 目标ID) : null) || this._findInChest(chest, 归一(原输入))
      if (!目标) {
        const 现有 = this._listChestShort(chest)
        await this._close(chest)
        return { ok: false, message: `箱子里没有「${原输入}」` + (现有 ? `；箱内有：${现有}` : '（箱子是空的）') }
      }

      const 实际取 = 想要 === Infinity ? 目标.count : Math.min(想要, 目标.count)
      const 显示名 = 取中文名(目标.name) // 回执里用中文名，更直观
      try {
        await this._withTimeout(chest.withdraw(目标.type, 目标.metadata, 实际取), this.actionTimeoutMs)
      } catch (e) {
        await this._close(chest)
        return { ok: false, message: `取出失败：${(e && e.message) || e}` }
      }
      await this._close(chest)
      this.stats.withdrawn += 实际取
      this.stats.trips++
      const 不足 = 想要 !== Infinity && 目标.count < 想要 ? `（箱内只有 ${目标.count} 个）` : ''
      this.lastResult = { at: Date.now(), action: 'withdraw', name: 目标.name, count: 实际取 }
      return { ok: true, message: `已取出 ${显示名} ×${实际取}${不足}` }
    } catch (e) {
      return { ok: false, message: '取物失败：' + ((e && e.message) || e) }
    } finally {
      this._busy = false
    }
  }

  // ---------- 对外：开箱看看 ----------
  async peek () {
    if (!this.isConfigured()) return { ok: false, message: '还没配置仓库点：请在配置里填 chest.station 坐标' }
    if (this._busy) return { ok: false, message: '上一趟操作还没结束' }
    this._busy = true
    try {
      const 走到 = await this._goToStation()
      if (!走到.ok) return 走到
      const 箱子 = await this._openChest()
      if (!箱子.ok) return 箱子
      const 清单 = this._listChest(箱子.chest)
      await this._close(箱子.chest)
      return { ok: true, message: 清单 || '箱子是空的' }
    } catch (e) {
      return { ok: false, message: '开箱失败：' + ((e && e.message) || e) }
    } finally {
      this._busy = false
    }
  }

  // ============================================================
  // 扫箱：建仓库索引
  //
  // 用法：
  //   !扫箱 开始          从当前位置开始扫（会先记住"服务器标签"，换服索引自动作废）
  //   !扫箱 继续          断点续传（跳过已扫过的箱子）
  //   !扫箱 状态          看扫了多少、还剩多少
  //   !扫箱 重来          清空索引重新扫
  //
  // 扫描方式（关键设计）：
  //   不按"逐个翻"，而是**站在一排箱子前面，伸手一次能开一个**，
  //   一边沿着通道往前挪一边开。这样做的好处：
  //     · 服务器只看到"正常玩家边走边开箱"，不像脚本在瞬移扫全屋
  //     · 遇到打不开的箱子（被挡/权限）自动跳过并记日志，不会卡死
  //     · 已扫过的写进索引并立即落盘，掉线后 !扫箱 继续 能接着来
  // ============================================================

  /** 开始一次新扫描（沿用已有索引，只补没扫过的） */
  async startScan (模式 = '开始') {
    if (this._scanSession) return { ok: false, message: '正在扫箱中（可发 !扫箱 状态 看进度，!停止 中止）' }
    const bot = this.ctx.bot
    if (!bot) return { ok: false, message: '机器人不在线' }
    if (!this.isConfigured()) return { ok: false, message: '还没配置仓库点：请先在配置里填 chest.station 坐标' }

    if (模式 === '重来') { this.index.reset(); await this._saveIndex() }

    this._scanSession = {
      startedAt: Date.now(),
      scanned: 0, empty: 0, failed: 0, 跳过: 0,
      已扫坐标: new Set(this.index.boxes.map(b => ChestIndex.坐标键(b))),
      中止: false,
    }
    this.ctx.logger.info('开始扫箱：从当前位置沿箱子墙逐个开箱，已扫 ' + this._scanSession.已扫坐标.size + ' 个会跳过')
    return { ok: true, message: '开始扫箱，从当前位置向前逐个开箱（!扫箱 状态 看进度；!停止 中止）' }
  }

  /** 扫描过程本体：由指令触发后，在后台持续推进 */
  async runScan () {
    const 会话 = this._scanSession
    if (!会话) return
    const bot = this.ctx.bot
    if (!bot) { this._scanSession = null; return }

    const 半径 = this.searchRadius
    const 服务器标签 = this._serverLabel()

    while (!会话.中止 && this.ctx.status === 'online') {
      // ① 找附近还没扫过的箱子（按距离从近到远）
      const 目标 = this._findNextUnscanned(半径)
      if (!目标) {
        // 半径内没有未扫的：尝试往前走一段再找（沿着通道扫过去）
        const 继续走 = await this._scanAdvance()
        if (!继续走) break
        continue
      }
      // ② 走过去（用 pathfinder，失败说明路不平 → 记日志继续找下一个）
      const 到位 = await this._scanWalkTo(目标)
      if (!到位) {
        会话.失败++
        // ★ 必须取 .position：目标 Block 自身没有 x/y/z，直接传会记成 NaN 坐标
        this.index.addBox({ x: 目标.position.x, y: 目标.position.y, z: 目标.position.z }, ['<打不开>'], null)
        continue
      }
      // ③ 开箱、读内容、写索引、关箱
      await this._scanOpenRecord(目标, 会话)
    }

    // 收尾：保存索引 + 汇总
    await this._saveIndex(服务器标签)
    const 统计 = this.index.summary()
    const 秒 = Math.round((Date.now() - 会话.startedAt) / 1000)
    this.ctx.logger.info(`扫箱结束：本趟扫 ${会话.scanned} 个（空箱 ${会话.empty}、打不开 ${会话.失败}、跳过已扫 ${会话.跳过}），索引共 ${统计.箱数} 箱 / ${统计.物品种类} 种物品，用时 ${秒} 秒`)
    if (this.ctx.chatMonitor) this.ctx.chatMonitor.feed('system', '', `[扫箱] 结束：本趟 ${会话.scanned} 个，索引共 ${统计.箱数} 箱 / ${统计.物品种类} 种物品`)
    this._scanSession = null
  }

  /**
   * 列出附近还没扫过的箱子。
   * ★ 用 mineflayer 真实的 bot.findBlocks（复数）——它按八面体迭代器由近到远扫区块。
   * ★ 关键坑：findBlocks 的 count 是"最多返回几个"，且**按距离从近到远截断**。
   *   范围越大、箱子越密时，只取 count 个会全落在"最近的一小片"（很可能都扫过了），
   *   远处未扫的一个都进不来。所以：**范围大就把 count 一起放大**，
   *   让返回列表足以覆盖整个半径，而不是只覆盖最近那一小块。
   */
  _listNearbyChestBlocks (半径, 只要未扫 = true, 最多 = 64) {
    const bot = this.ctx.bot
    if (!bot || typeof bot.findBlocks !== 'function') return []
    const ids = this.blocks
      .map(n => bot.registry && bot.registry.blocksByName && bot.registry.blocksByName[n])
      .filter(Boolean).map(b => b.id)
    if (!ids.length) return []
    try {
      // 按半径估算需要取多少个：半径大就多取（半径 384 的方块级别搜索可能上千个箱子）
      const 取多少个 = Math.max(最多, Math.min(8000, Math.ceil(Math.pow(半径, 3) / 60)))
      const 位置列表 = bot.findBlocks({
        matching: ids,
        maxDistance: 半径,
        count: 取多少个,
      }) || []
      const 可用 = []
      for (const 位置 of 位置列表) {
        if (只要未扫 && this.index.isScanned(位置)) continue
        const 块 = bot.blockAt(位置)
        if (块) 可用.push(块)
      }
      return 可用
    } catch (_) {
      return []
    }
  }

  /**
   * 找附近还没扫过的箱子（返回方块或 null）——扫箱主循环用。
   * ★ 注意：findBlocks 的 count 是"最多返回几个"，它**不做已扫过滤**。
   *   如果只取 1 个，而最近那个恰好已扫过，就会误判"没箱子了"。
   *   所以这里一次多取一些（32 个），再从中挑未扫的。
   */
  _findNextUnscanned (半径) {
    const 列表 = this._listNearbyChestBlocks(半径, true, 32)
    return 列表[0] || null
  }

  /**
   * 推进扫描位置。策略（配合 bot.findBlocks 由近到远的特性）：
   *   ① 当前朝向走一步（沿通道一路扫，最像真人）
   *   ② 四个方向都试完还没未扫的 → 直接用 findBlocks 以更大半径定位最近的未扫箱子，
   *      一路走过去（跨分区靠这步：里面 1025 + 外围 950 相隔几十格也能跳过去）
   */
  async _scanAdvance () {
    const bot = this.ctx.bot
    if (!bot || !bot.entity) return false
    const { GoalNear } = require('mineflayer-pathfinder').goals
    const 当前位置 = bot.entity.position.clone()
    const 步长 = Math.max(3, Math.round(this.searchRadius * 0.8))

    for (const 方向 of ['当前', '右', '后', '左']) {
      const yaw = this._扫箱朝向(方向)
      const 目标 = {
        x: Math.floor(当前位置.x - Math.sin(yaw) * 步长),
        y: Math.floor(当前位置.y),
        z: Math.floor(当前位置.z + Math.cos(yaw) * 步长),
      }
      try {
        await bot.pathfinder.goto(new GoalNear(目标.x, 目标.y, 目标.z, 2))
        if (this._findNextUnscanned(this.searchRadius + 6)) return true
      } catch (_) { /* 走不通就换方向 */ }
    }

    // 跨分区：逐步扩大半径定位最近的未扫箱子，直接走过去（多取几个再过滤，理由同 _findNextUnscanned）
    // 半径一路放到 1024：仓库分几个大区、相隔几百格也能跨过去
    for (const 半径 of [24, 48, 96, 192, 384, 768, 1024]) {
      const 远处 = this._listNearbyChestBlocks(半径, true, 32)[0]
      if (!远处) continue
      const p = 远处.position
      try {
        await bot.pathfinder.goto(new GoalNear(p.x, p.y, p.z, 3))
        this.ctx.logger.info(`跨区扫描：前往 ${Math.round(bot.entity.position.distanceTo(p))} 格外的未扫区域（${p.x},${p.y},${p.z}）`)
        return true
      } catch (_) { /* 走不过去就换更大半径 */ }
    }
    return false
  }

  /** 计算扫箱要试的前进方向（弧度）。'当前' 用机器人当前朝向 */
  _扫箱朝向 (方向) {
    const bot = this.ctx.bot
    const 当前 = (bot && bot.entity && bot.entity.yaw) || 0
    if (方向 === '当前') return 当前
    if (方向 === '右') return 当前 + Math.PI / 2
    if (方向 === '后') return 当前 + Math.PI
    return 当前 - Math.PI / 2 // 左
  }

  /** 走到箱子旁边（能交互的距离） */
  async _scanWalkTo (块) {
    const bot = this.ctx.bot
    if (!bot || !块 || !块.position) return false
    const 距离 = bot.entity.position.distanceTo(块.position)
    if (距离 <= 4) return true // 已经在交互范围内
    try {
      const { GoalNear } = require('mineflayer-pathfinder').goals
      await bot.pathfinder.goto(new GoalNear(块.position.x, 块.position.y, 块.position.z, 3))
      return true
    } catch (_) {
      return false
    }
  }

  /** 开箱 → 读内容 → 写索引 → 关箱 */
  async _scanOpenRecord (块, 会话) {
    const bot = this.ctx.bot
    if (!bot) return
    let chest = null
    try {
      chest = await this._withTimeout(bot.openContainer(块), this.openTimeoutMs)
      const 内容 = chest.containerItems().map(i => 归一(i.name))
      const 位置 = { x: 块.position.x, y: 块.position.y, z: 块.position.z }
      this.index.addBox(位置, 内容, 内容.length ? null : 27)
      if (内容.length) 会话.scanned++
      else { 会话.scanned++; 会话.empty++ }
    } catch (_) {
      会话.failed++
      // 打不开的也记一笔，避免下次扫箱重复尝试卡在这里
      this.index.addBox({ x: 块.position.x, y: 块.position.y, z: 块.position.z }, ['<打不开>'], null)
    } finally {
      if (chest) { try { chest.close() } catch (_) { /* 忽略 */ } }
      await sleep(this.scanPauseMs || 250) // 稍作停顿：既降服务器压力，也更像人
    }
  }

  /** 停止扫描（保留已扫部分，!扫箱 继续 可接上） */
  stopScan () {
    if (!this._scanSession) return { ok: false, message: '现在没在扫箱' }
    this._scanSession.中止 = true
    return { ok: true, message: '已让扫箱停下（已扫的已保存，发 !扫箱 继续 可接着扫）' }
  }

  /** 扫描状态 */
  scanStatus () {
    if (!this._scanSession) {
      const 统计 = this.index.summary()
      return {
        扫描中: false,
        索引箱数: 统计.箱数,
        物品种类: 统计.物品种类,
        文件: 索引文件路径,
      }
    }
    const 会话 = this._scanSession
    const 统计 = this.index.summary()
    return {
      扫描中: true,
      已运行秒: Math.round((Date.now() - 会话.startedAt) / 1000),
      本趟扫: 会话.scanned,
      本趟空箱: 会话.empty,
      本趟打不开: 会话.failed,
      跳过已扫: 会话.跳过,
      索引箱数: 统计.箱数,
      物品种类: 统计.物品种类,
    }
  }

  /** 保存索引到本地；serverLabel 用于标记"这个索引是哪台服的" */
  async _saveIndex (serverLabel) {
    try {
      const 路径 = this.index.save(serverLabel || this._serverLabel())
      this.ctx.logger.info('仓库索引已保存：' + 路径 + '（' + this.index.size + ' 箱）')
      return 路径
    } catch (e) {
      this.ctx.logger.warn('仓库索引保存失败：' + ((e && e.message) || e))
      return null
    }
  }

  _serverLabel () {
    const s = this.ctx.globalCfg && this.ctx.globalCfg.server
    return s ? `${s.host || '?'}:${s.port || '?'}` : ''
  }

  // ---------- 内部 ----------

  // 按索引取物：走到装着该物品的箱子前，开箱取出。
  // 返回 null 表示"索引里没有该物品"，让调用方回落到旧逻辑。
  async _withdrawByIndex (目标ID, 原输入, 想要) {
    const bot = this.ctx.bot
    if (!bot || !bot.entity) return null

    // 索引里没有这个物品 → 回落（返回 null）
    if (!目标ID || this.index.find(目标ID).length === 0) return null

    // 同一物品可能在多个箱子里：选离机器人最近的那个
    const 目标箱 = this.index.findNearest(目标ID, bot.entity.position)
    if (!目标箱) return null
    const 距离 = bot.entity.position.distanceTo(目标箱)
    if (this.ctx.logger) {
      this.ctx.logger.info(`索引定位：${取中文名(目标ID)}（${目标ID}）在 ${Math.round(距离)} 格外，直接过去`)
    }

    // 走过去
    if (距离 > 4) {
      try {
        const { GoalNear } = require('mineflayer-pathfinder').goals
        await this.ctx.services.taskRunner.enqueue({
          name: 'chest-index-goto', kind: 'chest', timeoutMs: 90000,
          run: async () => {
            await bot.pathfinder.goto(new GoalNear(目标箱.x, 目标箱.y, 目标箱.z, 3))
          },
        })
      } catch (e) {
        return { ok: false, message: `索引定位到箱子（${Math.round(距离)} 格外）但走不过去：${(e && e.message) || e}` }
      }
    }

    // ★ 必须按索引坐标开箱，不能用 _openChest（那个只会找"仓库点附近"的箱子，
    //   索引里的箱子可能在几十上百格外，会开错箱子）
    const 箱子 = await this._openChestAt({ x: 目标箱.x, y: 目标箱.y, z: 目标箱.z })
    if (!箱子.ok) return { ok: false, message: `走到箱子前但打不开（${目标箱.x},${目标箱.y},${目标箱.z}）：${箱子.message}` }
    const chest = 箱子.chest

    const 目标 = this._findInChest(chest, 目标ID)
    if (!目标) {
      await this._close(chest)
      // 索引说这里有，实际没有：可能是物品被搬走了。
      // 把这条索引位置标一下，避免下次还往这跑（不删，保留给 !扫箱 复查）
      if (this.ctx.logger) this.ctx.logger.warn(`索引显示 ${目标ID} 在 ${目标箱.x},${目标箱.y},${目标箱.z}，但箱内没有（物品可能被移走）`)
      return { ok: false, message: `按索引找到箱子，但里面已经没有「${取中文名(目标ID)}」了（物品可能被移走，可发 !扫箱 重来 更新索引）` }
    }

    const 实际取 = 想要 === Infinity ? 目标.count : Math.min(想要, 目标.count)
    const 显示名 = 取中文名(目标.name)
    try {
      await this._withTimeout(chest.withdraw(目标.type, 目标.metadata, 实际取), this.actionTimeoutMs)
    } catch (e) {
      await this._close(chest)
      return { ok: false, message: `取出失败：${(e && e.message) || e}` }
    }
    await this._close(chest)
    this.stats.withdrawn += 实际取
    this.stats.trips++
    const 不足 = 想要 !== Infinity && 目标.count < 想要 ? `（箱内只有 ${目标.count} 个）` : ''
    this.lastResult = { at: Date.now(), action: 'withdraw', name: 目标.name, count: 实际取 }
    return { ok: true, message: `已取出 ${显示名} ×${实际取}${不足}` }
  }

  // 走到仓库点（有坐标走坐标；只有别名就用服务器指令回家）
  async _goToStation () {
    const bot = this.ctx.bot
    if (!bot) return { ok: false, message: '机器人不在线' }
    if (this.station) {
      const 距离 = bot.entity ? bot.entity.position.distanceTo(this.station) : Infinity
      if (距离 <= this.searchRadius) return { ok: true } // 已经在箱子旁边，不用走
      try {
        const { GoalNear } = require('mineflayer-pathfinder').goals
        await this.ctx.services.taskRunner.enqueue({
          name: 'chest-goto', kind: 'chest', timeoutMs: 60000,
          run: async () => {
            await bot.pathfinder.goto(new GoalNear(this.station.x, this.station.y, this.station.z, 2))
          },
        })
        return { ok: true }
      } catch (e) {
        return { ok: false, message: `走到仓库点失败（${this.station.x},${this.station.y},${this.station.z}）：${(e && e.message) || e}` }
      }
    }
    // 只配了别名：先回家，再在附近找箱子
    try {
      const r = await this.ctx.services.warpQueue.home(this.stationAlias)
      await sleep(1500) // 等传送落地
      return { ok: true, message: '' , via: r && r.status }
    } catch (e) {
      return { ok: false, message: `回家失败（chest.stationAlias=${this.stationAlias}）：${(e && e.message) || e}` }
    }
  }

  // 按指定坐标打开箱子（索引定位到箱子后用这个，而不是 _openChest）
  async _openChestAt (坐标) {
    const bot = this.ctx.bot
    if (!bot) return { ok: false, message: '机器人不在线' }
    const ids = this.blocks
      .map(n => bot.registry && bot.registry.blocksByName && bot.registry.blocksByName[n])
      .filter(Boolean).map(b => b.id)
    let 块 = null
    try { 块 = bot.blockAt(坐标) } catch (_) { /* 忽略 */ }
    // 坐标上不是箱子：可能是索引过期（箱子被拆/移位），在附近 4 格内找一次兜底
    if (!块 || (ids.length && !ids.includes(块.type))) {
      try { 块 = bot.findBlock({ matching: ids.length ? ids : [1], maxDistance: 4 }) } catch (_) { /* 忽略 */ }
    }
    if (!块) return { ok: false, message: '该位置没有箱子（索引可能过期，可发 !扫箱 重来 更新）' }
    try {
      const chest = await this._withTimeout(bot.openContainer(块), this.openTimeoutMs)
      return { ok: true, chest }
    } catch (e) {
      return { ok: false, message: `打开箱子失败：${(e && e.message) || e}` }
    }
  }

  // 找到并打开箱子（带回超时与自动关闭）
  async _openChest () {
    const bot = this.ctx.bot
    if (!bot) return { ok: false, message: '机器人不在线' }
    const 方块 = this._findChestBlock()
    if (!方块) {
      const 范围 = this.station ? `${this.station.x},${this.station.y},${this.station.z} 附近 ${this.searchRadius} 格` : '身边'
      return { ok: false, message: `没找到箱子（${范围}内没有 ${this.blocks.join('/')}；可调大 chest.searchRadius 或检查坐标）` }
    }
    try {
      const chest = await this._withTimeout(bot.openContainer(方块), this.openTimeoutMs)
      return { ok: true, chest }
    } catch (e) {
      return { ok: false, message: `打开箱子失败：${(e && e.message) || e}` }
    }
  }

  // 找箱子方块：优先在仓库点附近找，找不到再退化成身边找
  _findChestBlock () {
    const bot = this.ctx.bot
    const ids = this.blocks
      .map(n => bot.registry && bot.registry.blocksByName && bot.registry.blocksByName[n])
      .filter(Boolean)
      .map(b => b.id)
    if (!ids.length) return null
    try {
      if (this.station) {
        const 点 = bot.blockAt(this.station)
        if (点 && ids.includes(点.type)) return 点
      }
      return bot.findBlock({ matching: ids, maxDistance: this.searchRadius })
    } catch (_) {
      return null
    }
  }

  // 该物品是否要存进箱子
  _shouldDeposit (物品, 全部存) {
    if (!物品) return false
    const 名 = 归一(物品.name)
    if (this.keep.has(名)) return false // 规则1：keep 的一律留身上
    if (全部存) return true             // !存箱 全部：除 keep 外都存
    if (this.deposit.size) return this.deposit.has(名) // 规则2：配了 deposit 就只存名单内的
    return false // 没配 deposit 且不是「全部存」：什么都不动（避免误存贵重物）
  }

  // 在箱子里找物品（英文 ID 精确名优先，其次模糊匹配）
  _findInChest (chest, 名) {
    const 键 = 归一(名)
    if (!键) return null
    const 全部 = chest.containerItems()
    return 全部.find(物品 => 归一(物品.name) === 键) ||
      全部.find(物品 => 归一(物品.name).includes(键)) ||
      null
  }

  // 箱子内容清单（完整，供 !开箱 / !取 失败时提示）；物品名显示中文（表里有的）
  _listChest (chest) {
    const 全部 = chest.containerItems()
    if (!全部.length) return ''
    // 按数量从多到少排，最多列 20 项
    const 排序 = 全部.slice().sort((a, b) => b.count - a.count)
    const 文本 = 排序.slice(0, 20).map(i => `${取中文名(i.name)}×${i.count}`).join('、')
    return `箱内共 ${全部.length} 组：` + 文本 + (全部.length > 20 ? ' …' : '')
  }

  // 精简版（用于错误提示里附带几个例子），同样显示中文名
  _listChestShort (chest) {
    try {
      const 全部 = chest.containerItems()
      if (!全部.length) return ''
      return 全部.slice(0, 6).map(i => `${取中文名(i.name)}×${i.count}`).join('、') + (全部.length > 6 ? ' …' : '')
    } catch (_) { return '' }
  }

  // 关箱子：失败也不抛（窗口留半开更糟，尽量关）
  async _close (chest) {
    try { chest.close() } catch (_) { /* 忽略 */ }
    await sleep(120) // 等窗口真正关闭，避免紧接着开下一个被拒
  }

  // 给 Promise 加超时（箱子操作在服务器卡顿时会一直挂着）
  _withTimeout (promise, ms) {
    return new Promise((resolve, reject) => {
      const 计时 = setTimeout(() => reject(new Error(`操作超时（${ms}ms）`)), ms)
      Promise.resolve(promise).then(
        值 => { clearTimeout(计时); resolve(值) },
        错 => { clearTimeout(计时); reject(错) }
      )
    })
  }

  // ---------- 定时自动存箱 ----------
  start () {
    if (!this.enabled || !this.autoScheduleMs || !this.isConfigured()) return
    this.stop()
    this._timer = setInterval(() => {
      if (this.ctx.status !== 'online') return
      this.depositAll({ all: false }).then(r => {
        if (this.ctx.logger && r && !r.ok) this.ctx.logger.warn(`定时存箱跳过：${r.message}`)
      }).catch(() => { /* 定时任务失败不影响挂机 */ })
    }, this.autoScheduleMs)
    if (this._timer.unref) this._timer.unref()
    if (this.ctx.logger) {
      this.ctx.logger.info(`定时存箱已开启：每 ${Math.round(this.autoScheduleMs / 60000)} 分钟一次`)
    }
  }

  stop () {
    if (this._timer) { clearInterval(this._timer); this._timer = null }
  }

  getSnapshot () {
    return {
      enabled: this.enabled,
      configured: this.isConfigured(),
      station: this.station,
      stationAlias: this.stationAlias,
      blocks: [...this.blocks],
      keepCount: this.keep.size,
      depositCount: this.deposit.size,
      autoScheduleMs: this.autoScheduleMs,
      busy: this._busy,
      stats: Object.assign({}, this.stats),
      lastResult: this.lastResult,
    }
  }

  stopForShutdown () { this.stop() }
}

// 解析配置里的物品名单：中文名（钻石镐）或英文 ID（diamond_pickaxe）都接受，
// 统一转成英文 ID 便于和物品的 name 比对；解析不了的按原样（小写）保留，
// 这样用户写了个表外的冷门物品 ID 也不会被丢掉。
function 解析名单 (列表) {
  if (!Array.isArray(列表)) return []
  const 结果 = []
  for (const 原始 of 列表) {
    const 文本 = String(原始 == null ? '' : 原始).trim()
    if (!文本) continue
    const 解析 = 解析物品名(文本)
    结果.push(解析.ok ? 解析.id : 归一(文本))
  }
  return 结果
}

// 坐标解析：支持 { x, y, z } 或 [x, y, z]
function 解析坐标 (值) {  if (!值) return null
  let x, y, z
  if (Array.isArray(值)) { [x, y, z] = 值 } else if (typeof 值 === 'object') { ({ x, y, z } = 值) }
  else return null
  const 数字 = [Number(x), Number(y), Number(z)]
  if (数字.some(n => !Number.isFinite(n))) return null
  return { x: 数字[0], y: 数字[1], z: 数字[2] }
}

module.exports = { ChestManager, 解析坐标 }
