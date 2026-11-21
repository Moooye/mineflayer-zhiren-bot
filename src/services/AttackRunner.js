// ============================================================
// AttackRunner：朝正前方的定时攻击（防身/挂机挥击，非 killaura）
//   !攻击 <x>   开启：每 x tick（游戏刻，20 tick = 1 秒）攻击一次正前方
//   !攻击 关    关闭
// 行为：只攻击“准星正前方射线命中”的实体（bot.entityAtCursor），
//      不自动瞄准、不转向、不追踪，因此不属于 killaura；
//      准星前没有实体时仅空挥手臂（保持攻击动作）
// 说明：进服默认关闭；断线清理后回到关闭，需指令重新开启
// ============================================================
'use strict'

class AttackRunner {
  constructor (botContext) {
    this.ctx = botContext
    this.enabled = false
    this.intervalTicks = 20 // 默认每 20 tick（1 秒）
    this._counter = 0
  }

  /**
   * 绑定当前 bot 的物理帧：每 tick 计数，达到间隔就攻击一次
   * @returns {function} 清理函数（每次重连重新绑定）
   */
  bindBot (bot) {
    this._counter = 0
    const onPhys = () => {
      if (!this.enabled) return
      this._counter++
      if (this._counter >= this.intervalTicks) { this._counter = 0; this._attackOnce() }
    }
    bot.on('physicsTick', onPhys)
    return () => {
      bot.removeListener('physicsTick', onPhys)
      this.enabled = false
      this._counter = 0
    }
  }

  /**
   * 开启定时攻击
   * @param {number|string} ticks 间隔 tick 数（正整数）
   */
  start (ticks) {
    const t = parseInt(ticks, 10)
    if (!Number.isFinite(t) || t <= 0) {
      return { ok: false, message: '用法：!攻击 <tick数>（正整数）；关闭发 !攻击 关' }
    }
    this.intervalTicks = t
    this.enabled = true
    this._counter = 0
    const seconds = (t / 20).toFixed(2).replace(/\.?0+$/, '')
    return { ok: true, message: `已开启正前方攻击，每 ${t} tick（约 ${seconds} 秒）一次` }
  }

  stop () {
    this.enabled = false
    this._counter = 0
    return { ok: true, message: '正前方攻击已关闭' }
  }

  // 单次攻击：准星射线命中实体则攻击，否则空挥
  _attackOnce () {
    const bot = this.ctx.bot
    if (!bot || this.ctx.status !== 'online') return
    try {
      const target = bot.entityAtCursor() // 默认 3 格（生存攻击距离）
      if (target) bot.attack(target)
      else bot.swingArm() // 无目标空挥
    } catch (e) {
      if (this.ctx.logger) this.ctx.logger.warn(`攻击动作失败：${e.message}`)
    }
  }

  getSnapshot () {
    return { enabled: this.enabled, intervalTicks: this.intervalTicks }
  }

  // 进程退出清理
  stopForShutdown () { this.stop() }
}

module.exports = { AttackRunner }
