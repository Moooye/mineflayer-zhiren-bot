// ============================================================
// greetings：进服问候 / 玩家加入欢迎
// 注意：挂机场景默认全部关闭（避免主动发言刷屏）；需要时在配置开启
// 所有发言经 ChatQueue，受限流约束
// ============================================================
'use strict'

class Greetings {
  /**
   * @param {object} botContext BotContext
   * @param {object} options   { greetOnSpawn:false, greetText, welcomeOnJoin:false, welcomeText }
   */
  constructor (botContext, options = {}) {
    this.ctx = botContext
    this.greetOnSpawn = options.greetOnSpawn === true
    this.greetText = options.greetText || '大家好，机器人已上线'
    this.welcomeOnJoin = options.welcomeOnJoin === true
    this.welcomeText = options.welcomeText || '欢迎 {name}'
  }

  // spawn 后问候
  onSpawn () {
    if (!this.greetOnSpawn) return
    this.ctx.services.chatQueue.send(this.greetText, { priority: 9 })
  }

  // 玩家加入欢迎
  onPlayerJoin (playerName) {
    if (!this.welcomeOnJoin) return
    const text = this.welcomeText.replace('{name}', playerName)
    this.ctx.services.chatQueue.send(text, { priority: 9 })
  }
}

module.exports = { Greetings }
