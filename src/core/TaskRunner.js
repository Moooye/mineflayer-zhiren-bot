// ============================================================
// TaskRunner：行为任务串行执行器
// 职责：回家/跟随/进食等任务严格串行；每个任务支持超时、中断；
//      快速循环检测（死亡-回家-再死亡类空转）；任务状态可查
// 用法：taskRunner.enqueue({ name, timeoutMs, run(api, control) })
//
// 中断处理（参考 mindcraft 的 ActionManager.requestInterrupt 强化）：
//   任务被取消或超时时，除了通知任务自身（task.cancel 回调）与唤醒可中断等待
//   （control.wait），还会**统一停掉所有可能还在动的动作源**——寻路、挖掘、
//   pvp、左右键持续使用、控制状态（前后左右/跳/潜行）残留。
//   之所以要统一停：各动作源由不同插件/模块持有，只置一个中断标志时，
//   pathfinder 仍会继续寻路、bot.dig 仍会继续挖，表现为“发了 !停止 但机器人还在动”。
// ============================================================
'use strict'
const { sleep } = require('../utils/helpers')

let taskSeq = 0

// 统一中断：把 bot 上所有可能正在执行的动作全部停掉。
// 每一项都单独 try 兜底——某个插件没装（如没 pvp）时不能影响其余动作的停止。
function abortAllActions (bot) {
  if (!bot) return
  try { if (bot.pathfinder) { bot.pathfinder.setGoal(null); bot.pathfinder.stop() } } catch (_) { /* 未装 pathfinder */ }
  try { if (bot.pvp && typeof bot.pvp.stop === 'function') bot.pvp.stop() } catch (_) { /* 未装 pvp */ }
  try { if (bot.collectBlock && typeof bot.collectBlock.cancelTask === 'function') bot.collectBlock.cancelTask() } catch (_) { /* 未装 collectblock */ }
  try { bot.stopDigging() } catch (_) { /* 没在挖 */ }
  try { bot.deactivateItem() } catch (_) { /* 没在用物品 */ }
  try { bot.clearControlStates() } catch (_) { /* 忽略 */ }
}

class TaskRunner {
  /**
   * @param {object} botContext BotContext 实例（任务通过它访问 bot/服务）
   * @param {object} options    { rapidWindowMs, rapidLimit, cooldownMs }
   */
  constructor (botContext, options = {}) {
    this.ctx = botContext
    this.queue = []
    this.current = null
    this.history = []
    this.running = true
    this.rapidWindowMs = options.rapidWindowMs || 60000
    this.rapidLimit = options.rapidLimit || 5
    this.cooldownMs = options.cooldownMs || 60000
    this.pausedKinds = {} // kind -> 恢复时间戳
    this._busy = false
  }

  /**
   * 入队一个任务
   * @param {object} task { name, kind?, timeoutMs=30000, priority=5, run(api,control), cancel? }
   * @returns {Promise<*>} 任务完成结果（被取消则 reject）
   */
  enqueue (task) {
    if (!this.running) return Promise.reject(new Error('TaskRunner 已停止'))
    const t = Object.assign(
      { id: ++taskSeq, kind: task.name, timeoutMs: 30000, priority: 5, cancel: null },
      task
    )
    t.result = new Promise((resolve, reject) => { t._resolve = resolve; t._reject = reject })
    this.queue.push(t)
    // 数字越小优先级越高
    this.queue.sort((a, b) => a.priority - b.priority)
    this._pump()
    return t.result
  }

  async _pump () {
    if (this._busy || !this.running) return
    // 取一个未被暂停的任务
    let idx = -1
    const now = Date.now()
    for (let i = 0; i < this.queue.length; i++) {
      const until = this.pausedKinds[this.queue[i].kind] || 0
      if (until <= now) { idx = i; break }
    }
    if (idx === -1) {
      // 全部在冷却：等最早恢复时间再尝试
      const waits = Object.values(this.pausedKinds).filter(t => t > now)
      if (waits.length && this.queue.length) {
        setTimeout(() => this._pump(), Math.min(5000, Math.max(200, Math.min(...waits) - now)))
      }
      return
    }
    const task = this.queue.splice(idx, 1)[0]
    this._busy = true
    this.current = task
    await this._execute(task)
    this.current = null
    this._busy = false
    this._pump()
  }

  async _execute (task) {
    const startedAt = Date.now()
    task.status = 'running'

    // 中断控制
    const control = {
      aborted: false,
      reason: '',
      isAborted: () => control.aborted,
      // 可中断等待：被取消时立即 reject
      wait: ms => new Promise((resolve, reject) => {
        const tm = setTimeout(resolve, ms)
        control._rejectWait = err => { clearTimeout(tm); reject(err) }
      }),
    }
    task._control = control

    let timer
    const timeoutPromise = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        control.aborted = true
        control.reason = 'timeout'
        try { if (typeof task.cancel === 'function') task.cancel('timeout') } catch (_) { /* 忽略 */ }
        abortAllActions(this.ctx && this.ctx.bot) // 超时：把还在动的动作源也一起停掉
        if (control._rejectWait) control._rejectWait(new Error('中断'))
        reject(new Error(`${task.name} 超时（${task.timeoutMs}ms）`))
      }, task.timeoutMs)
    })

    try {
      const api = this.ctx.getApi ? this.ctx.getApi() : { bot: this.ctx.bot }
      const result = await Promise.race([Promise.resolve(task.run(api, control)), timeoutPromise])
      clearTimeout(timer)
      task.status = 'done'
      this._record(task, 'done', startedAt)
      task._resolve(result)
    } catch (err) {
      clearTimeout(timer)
      const status = control.aborted ? 'cancelled' : 'failed'
      task.status = status
      this._record(task, status, startedAt)
      task._reject(err)
    }
  }

  // 记录历史并做快速循环检测
  _record (task, status, startedAt) {
    this.history.push({ name: task.name, kind: task.kind, status, ts: Date.now(), cost: Date.now() - startedAt })
    if (this.history.length > 200) this.history.splice(0, this.history.length - 200)

    const now = Date.now()
    const recent = this.history.filter(h => h.kind === task.kind && now - h.ts < this.rapidWindowMs)
    if (recent.length >= this.rapidLimit) {
      // 命中快速循环：暂停该类任务一段时间并告警
      this.pausedKinds[task.kind] = now + this.cooldownMs
      if (this.ctx.logger) {
        this.ctx.logger.warn(`检测到「${task.kind}」在 ${this.rapidWindowMs / 1000}s 内重复 ${recent.length} 次，暂停 ${this.cooldownMs / 1000}s 防止空转`)
      }
      // 移除队列中同类待执行任务
      this.queue = this.queue.filter(q => q.kind !== task.kind)
    }
  }

  // 取消当前任务：置中断标志 + 通知任务自身 + 唤醒可中断等待 + 停掉所有动作源
  cancelCurrent (reason = 'cancelled') {
    if (!this.current) {
      // 没有任务在跑，但机器人可能仍在动（比如 !跟随 是持续的 pathfinder 目标，
      // 不属于 TaskRunner 任务）：这里也统一停一次，保证 !停止 一定能停下来
      abortAllActions(this.ctx && this.ctx.bot)
      return
    }
    const c = this.current._control
    c.aborted = true
    c.reason = reason
    try { if (typeof this.current.cancel === 'function') this.current.cancel(reason) } catch (_) { /* 忽略 */ }
    abortAllActions(this.ctx && this.ctx.bot)
    if (c._rejectWait) c._rejectWait(new Error(reason))
  }

  // 取消队列中（含当前）指定名称的任务
  cancelByName (name) {
    if (this.current && (this.current.name === name || this.current.kind === name)) this.cancelCurrent(name)
    const removed = this.queue.filter(q => q.name === name || q.kind === name)
    this.queue = this.queue.filter(q => q.name !== name && q.kind !== name)
    for (const r of removed) { r.status = 'cancelled'; r._reject(new Error('取消：' + name)) }
    if (removed.length) abortAllActions(this.ctx && this.ctx.bot)
  }

  // 供外部（如重连清理）使用：停掉机器人身上所有还在执行的动作
  abortActions () { abortAllActions(this.ctx && this.ctx.bot) }

  // 状态快照
  getSnapshot () {
    return {
      current: this.current ? { name: this.current.name, status: this.current.status } : null,
      pending: this.queue.map(q => ({ name: q.name, priority: q.priority })),
      recent: this.history.slice(-10),
    }
  }

  // 清空待执行队列（重连后旧任务失效）
  clearPending () {
    for (const q of this.queue.splice(0)) { q.status = 'cancelled'; q._reject(new Error('bot 重连，任务取消')) }
  }

  // 停止：取消当前、清空队列
  stop () {
    this.running = false
    if (this.current) this.cancelCurrent('runner-stop')
    for (const q of this.queue.splice(0)) { q.status = 'cancelled'; q._reject(new Error('runner 停止')) }
  }
}

module.exports = { TaskRunner }
