// ============================================================
// ChestIndex：仓库索引 —— 用「!扫箱」把整个仓库扫一遍，
//              之后「!取 / !存箱」按索引直达目标箱子，不现场翻找。
//
// 为什么需要它：
//   仓库很大（上千个箱子）、每个箱子只放一种物品时，
//   现成的 findBlock 只会开「最近的那一个」，要的东西在别的箱里就永远取不到；
//   而现场逐个翻 1000 个箱子，一次要好几分钟，且极易触发服务器反作弊。
//   所以：扫一次建立「物品 → 箱子坐标」的索引存本地，之后每次取物 1~3 秒直达。
//
// 索引文件：项目根目录 chest-index.json
//   结构：
//   {
//     "version": 1,
//     "createdAt": "2026-10-15T10:00:00.000Z",
//     "server": "mc.example.com:25565",     // 只在同一服务器上复用
//     "scannedBoxes": 1975,                 // 已扫容器数
//     "items": {
//        "diamond":   [ {x,y,z}, ... ],     // 一个物品可能在多个箱子里 → 多个候选
//        "iron_ingot":[ {x,y,z}, ... ]
//     },
//     "boxes": [                             // 每个箱子的详细记录（供 !扫箱 续传与复查）
//        { "x":..,"y":..,"z":.., "items":["diamond"], "at":"...", "slots": 54 }
//     ]
//   }
//   同一物品有多个候选时，取物会选「离机器人最近」的那个。
// ============================================================
'use strict'

const fs = require('fs')
const path = require('path')

// 索引文件放在项目根目录（和 config / logs 平级）
const 索引文件路径 = path.join(__dirname, '..', '..', 'chest-index.json')
const 索引版本 = 1

class ChestIndex {
  constructor () {
    this.items = {}      // 物品ID -> [坐标, 坐标…]
    this.boxes = []      // [{ x,y,z, items, at, slots }]
    this.createdAt = ''
    this.server = ''
  }

  // 从本地文件加载；文件不存在 / 损坏时返回空索引（不抛错，重启不该被拖住）
  load () {
    try {
      if (!fs.existsSync(索引文件路径)) return this
      const 原始 = JSON.parse(fs.readFileSync(索引文件路径, 'utf8'))
      if (原始 && 原始.version === 索引版本) {
        this.items = 原始.items || {}
        this.boxes = 原始.boxes || []
        this.createdAt = 原始.createdAt || ''
        this.server = 原始.server || ''
      } else {
        // 版本不一致（结构可能变了）：作废重来，避免用旧结构解析出怪数据
        this.reset()
      }
    } catch (_) {
      // 文件损坏：同样作废（调用方会在保存时覆盖它）
      this.reset()
    }
    return this
  }

  // 保存到本地；写失败只抛给调用方去记录日志，不影响扫箱主流程
    save (serverLabel) {
    if (serverLabel) this.server = serverLabel
    if (!this.createdAt) this.createdAt = new Date().toISOString()
    const 数据 = {
      version: 索引版本,
      createdAt: this.createdAt,
      server: this.server,
      scannedBoxes: this.boxes.length,
      items: this.items,
      boxes: this.boxes,
    }
    // 先写临时文件再改名：避免写一半断电/崩溃把索引写坏（留下坏文件比没文件更糟）
    const 临时 = 索引文件路径 + '.tmp'
    fs.writeFileSync(临时, JSON.stringify(数据), 'utf8')
    fs.renameSync(临时, 索引文件路径)
    return 索引文件路径
  }

  reset () {
    this.items = {}
    this.boxes = []
    this.createdAt = ''
    this.server = ''
  }

  // 记一个箱子：内部去重（同一坐标重复扫时只更新内容）
  addBox (坐标, 物品列表, 容器槽数) {
    const 键 = ChestIndex.坐标键(坐标)
    const 记录 = {
      x: 坐标.x, y: 坐标.y, z: 坐标.z,
      items: 物品列表.slice(),
      at: new Date().toISOString(),
      slots: 容器槽数 || null,
    }
    const 已有下标 = this.boxes.findIndex(b => ChestIndex.坐标键(b) === 键)
    if (已有下标 >= 0) this.boxes[已有下标] = 记录
    else this.boxes.push(记录)

    // 重建该坐标的物品映射（先删掉这个坐标的旧记录，避免物品被挪走后仍残留）
    for (const 物品 of Object.keys(this.items)) {
      this.items[物品] = this.items[物品].filter(p => ChestIndex.坐标键(p) !== 键)
      if (!this.items[物品].length) delete this.items[物品]
    }
    // 再写入这次的物品 → 坐标
    for (const 物品 of 物品列表) {
      if (!this.items[物品]) this.items[物品] = []
      if (!this.items[物品].some(p => ChestIndex.坐标键(p) === 键)) {
        this.items[物品].push({ x: 坐标.x, y: 坐标.y, z: 坐标.z })
      }
    }
  }

  // 查物品 → 返回候选坐标列表（没有则空数组）
  find (物品ID) {
    const 键 = String(物品ID || '').toLowerCase()
    return this.items[键] || []
  }

  // 查物品 → 取离「当前位置」最近的那个坐标（这才是取物时真正要用的）
  findNearest (物品ID, 当前位置) {
    const 候选 = this.find(物品ID)
    if (!候选.length) return null
    if (!当前位置) return 候选[0]
    let 最近 = null, 最近距离 = Infinity
    for (const p of 候选) {
      const d = Math.hypot(p.x - 当前位置.x, p.y - 当前位置.y, p.z - 当前位置.z)
      if (d < 最近距离) { 最近距离 = d; 最近 = p }
    }
    return 最近
  }

  // 某个坐标是否已扫过（扫箱断点续传靠它跳过）
  isScanned (坐标) {
    const 键 = ChestIndex.坐标键(坐标)
    return this.boxes.some(b => ChestIndex.坐标键(b) === 键)
  }

  get size () { return this.boxes.length }

  // 简要统计（供 !扫箱 结束后的汇总）
  summary () {
    const 物品种类 = Object.keys(this.items).length
    const 空箱 = this.boxes.filter(b => b.items.length === 0).length
    return { 箱数: this.boxes.length, 物品种类, 空箱 }
  }

  static 坐标键 (p) {
    return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
  }
}

module.exports = { ChestIndex, 索引文件路径, 索引版本 }
