// ============================================================
// autoEat：自动进食（自写轻量，不引第三方插件）
// 饥饿值低于阈值（默认 14）自动取食；排除腐肉/毒食；
// 进食作为任务经 TaskRunner 串行执行，期间不与移动任务打架
// ============================================================
'use strict'
const { sleep } = require('../utils/helpers')

// 默认排除：营养价值为负/有负面效果
const DEFAULT_EXCLUDED = ['rotten_flesh', 'poisonous_potato', 'pufferfish', 'spider_eye']

class AutoEat {
  /**
   * @param {object} botContext BotContext
   * @param {object} options   { enabled, startAt:14, checkMs:10000, excludedFoods }
   */
  constructor (botContext, options = {}) {
    this.ctx = botContext
    this.enabled = options.enabled === true // 默认关闭，显式 enabled:true 或 !进食 开 才启用
    this.startAt = options.startAt || 14
    this.checkMs = options.checkMs || 10000
    this.excluded = new Set(options.excludedFoods || DEFAULT_EXCLUDED)
    this._timer = null
    this._eating = false
  }

  start () {
    if (!this.enabled || this._timer) return
    this._timer = setInterval(() => this._maybeEat(), this.checkMs)
  }

  _maybeEat () {
    const bot = this.ctx.bot
    if (!bot || this.ctx.status !== 'online') return
    if (this._eating) return
    if (bot.food == null || bot.food >= this.startAt) return

    // 若有进行中的非进食任务（如持续跟随），先打断；并暂停寻路目标，以便进食保命
    const snap = this.ctx.services.taskRunner.getSnapshot()
    if (snap.current && snap.current.name !== 'auto-eat') {
      this.ctx.services.taskRunner.cancelCurrent('auto-eat-interrupt')
    }
    try { this.ctx.bot.pathfinder.setGoal(null) } catch (_) { /* 忽略 */ }

    // 进食任务入队（串行）
    this._eating = true
    this.ctx.services.taskRunner.enqueue({
      name: 'auto-eat',
      kind: 'eat',
      timeoutMs: 30000,
      run: (api, control) => this.eatOnce(control),
    }).catch(e => {
      if (this.ctx.logger) this.ctx.logger.warn(`自动进食失败：${e.message}`)
    }).then(() => { this._eating = false })
  }

  // 实际进食（可能连续吃多份直到高于阈值）
  async eatOnce (control) {
    const bot = this.ctx.bot
    let ate = 0
    while (bot.food < this.startAt) {
      if (control && control.isAborted()) break
      const item = this._findBestFood()
      if (!item) {
        if (this.ctx.logger) this.ctx.logger.warn('饥饿但背包没有安全食物')
        break
      }
      await bot.equip(item, 'hand')
      await bot.consume()
      ate++
      await sleep(300)
    }
    if (ate > 0 && this.ctx.logger) this.ctx.logger.info(`自动进食完成，共 ${ate} 份，饥饿值 ${bot.food}`)
    return { ate, food: bot.food }
  }

  // 从背包挑一个可食且不在排除列表、营养价值最高的
  _findBestFood () {
    const bot = this.ctx.bot
    let mcData
    try { mcData = require('minecraft-data')(bot.version) } catch (_) { mcData = null }
    const foods = mcData && mcData.foods
      ? (Array.isArray(mcData.foods) ? mcData.foods : Object.values(mcData.foods))
      : []
    const foodMap = new Map(foods.map(f => [f.name, f]))

    const candidates = bot.inventory.items().filter(it => {
      if (this.excluded.has(it.name)) return false
      const f = foodMap.get(it.name)
      return f && f.foodPoints > 0
    })
    if (candidates.length === 0) return null
    candidates.sort((a, b) => (foodMap.get(b.name).foodPoints) - (foodMap.get(a.name).foodPoints))
    return candidates[0]
  }

  stop () {
    if (this._timer) { clearInterval(this._timer); this._timer = null }
  }
}

module.exports = { AutoEat }
