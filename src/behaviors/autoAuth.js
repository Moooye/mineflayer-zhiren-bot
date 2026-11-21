// ============================================================
// autoAuth：进服自动登录 / 注册（适配有登录插件的服务器）
//
// 为什么需要：很多服务器（离线服 / 带 AuthMe 类插件的服）进服后必须先在聊天栏
// 执行 /login <密码> 或 /register <密码> <密码>，否则一直是"未登录"状态：
// 不能动、不能说话、发出去的指令全部无效。挂机机器人必须自动过这一步。
//
// 工作方式（关键是"只在对的时机发一次，绝不乱发密码"）：
//   ① 监听服务器发来的文本（chat / 系统消息），按关键词判断当前该登录还是该注册：
//        - 命中"注册"类文案   → 发 /register <密码> <密码>
//        - 命中"登录"类文案   → 发 /login <密码>
//   ② 发之前先做冷却与去重：同一条提示不重复发、两次尝试之间至少间隔 retryMs，
//      避免服务器刷提示时把密码连发好几遍（会被判刷屏甚至封号）。
//   ③ 只有配了密码才启用；没配密码则完全不动（打印一次提醒）。
//   ④ 登录期间把机器人标记为未登录（isAuthed=false），其它主动行为可据此挂起。
//   ⑤ 成功判定：命中"登录成功/欢迎"类文案 → 置 isAuthed=true。
//
// 安全：密码只从本地配置读，只往服务器发；日志里一律用 *** 代替，不落盘明文。
//
// 配置（config 里 autoAuth 块）：
//   autoAuth: {
//     enabled: true,
//     password: '你的密码',          // 服务器登录插件的密码（必填，不填则整个功能不启用）
//     register: 'auto',              // 'auto' 自动判断该注册还是登录 | true 只注册 | false 只登录
//     loginCommand: 'login',         // 默认 login
//     registerCommand: 'register',   // 默认 register
//     retryMs: 8000,                 // 两次尝试的最小间隔
//     maxAttempts: 5,                // 最多尝试几次（超过就放弃并告警，避免死循环刷密码）
//   }
// ============================================================
'use strict'

// 需要登录的提示特征（中文 + 英文，覆盖 AuthMe / 各类国产登录插件）
const NEED_LOGIN_PATTERNS = [
  /请登录/, /请先登录/, /登录才能/, /使用\s*\/?login/i, /\/login/i,
  /please\s+login/i, /log\s*in\s+to/i, /you\s+need\s+to\s+login/i,
]
// 需要注册的提示特征
const NEED_REGISTER_PATTERNS = [
  /请注册/, /请先注册/, /注册才能/, /不是已注册/, /未注册/, /使用\s*\/?register/i, /\/register/i,
  /please\s+register/i, /not\s+registered/i, /register\s+to/i,
]
// 登录成功的特征
const AUTH_OK_PATTERNS = [
  /登录成功/, /登陆成功/, /欢迎回来/, /欢迎.{0,8}回来/, /已登录/, /注册成功/,
  /successfully\s+logged\s+in/i, /logged\s+in/i, /welcome\s+back/i, /registered/i,
]
// 密码错误的特征（用来提前放弃，不无限重试）
const BAD_PASSWORD_PATTERNS = [
  /密码错误/, /密码不正确/, /错误的密码/, /wrong\s+password/i, /incorrect\s+password/i, /invalid\s+password/i,
]

class AutoAuth {
  /**
   * @param {object} botContext BotContext
   * @param {object} options    { enabled, password, register, loginCommand, registerCommand, retryMs, maxAttempts }
   */
  constructor (botContext, options = {}) {
    this.ctx = botContext
    const o = options || {}
    this.password = String(o.password == null ? '' : o.password)
    // 没配密码就一定不启用：这是安全底线，避免空密码乱发
    this.enabled = o.enabled !== false && !!this.password
    this.registerMode = o.register === undefined ? 'auto' : o.register // 'auto' | true | false
    this.loginCommand = String(o.loginCommand || 'login').replace(/^\/+/, '')
    this.registerCommand = String(o.registerCommand || 'register').replace(/^\/+/, '')
    this.retryMs = Math.max(1000, Number(o.retryMs) || 8000)
    this.maxAttempts = Math.max(1, Number(o.maxAttempts) || 5)

    this.isAuthed = false       // 是否已确认登录成功
    this.attempts = 0           // 已尝试次数
    this.lastAttemptAt = 0
    this.lastAction = ''        // 'login' | 'register' | ''
    this.finished = false       // 放弃后不再尝试
    this._lastText = ''
    this._lastTextAt = 0
  }

  // 只用于日志：绝不打印明文密码
  get maskedPassword () { return this.password ? '***' : '(未配置)' }

  // 每条服务器文本都喂进来（BotContext 的 chat / messagestr）
  // 返回 true 表示本次触发了动作（供调用方记录/调试）
  feed (text) {
    if (!this.enabled || this.finished) return false
    const 原文 = String(text == null ? '' : text).trim()
    if (!原文) return false

    // 去色码后判断
    const 纯文本 = 原文.replace(/\u00a7[0-9a-fk-or]/gi, '')
    const 现在 = Date.now()

    // 登录成功的判定要放在最前面：一旦确认成功，后面不再做任何事
    if (AUTH_OK_PATTERNS.some(re => re.test(纯文本))) {
      if (!this.isAuthed) {
        this.isAuthed = true
        this.finished = true
        if (this.ctx.logger) this.ctx.logger.info('自动登录：已确认登录成功')
        if (this.ctx.chatMonitor) this.ctx.chatMonitor.feed('system', '', '自动登录：已确认登录成功')
      }
      return false
    }

    // 密码错误：直接放弃，不要拿着错密码反复试（会被判恶意尝试）
    if (BAD_PASSWORD_PATTERNS.some(re => re.test(纯文本))) {
      this.finished = true
      if (this.ctx.logger) {
        this.ctx.logger.error(`自动登录失败：服务器提示密码错误（配置里的 autoAuth.password 不对，密码 ${this.maskedPassword}）。已停止自动尝试，请手动改配置后重启`)
      }
      if (this.ctx.chatMonitor) {
        this.ctx.chatMonitor.feed('system', '', '[自动登录] 失败：密码错误，已停止尝试（请检查配置 autoAuth.password）')
      }
      return false
    }

    // 同一条提示短时间内重复到达（chat + messagestr 双事件）只处理一次
    if (纯文本 === this._lastText && 现在 - this._lastTextAt < 3000) return false

    const 该注册 = NEED_REGISTER_PATTERNS.some(re => re.test(纯文本))
    const 该登录 = NEED_LOGIN_PATTERNS.some(re => re.test(纯文本))
    if (!该注册 && !该登录) return false

    this._lastText = 纯文本
    this._lastTextAt = 现在

    // 决定动作
    let 动作
    if (this.registerMode === true) 动作 = 'register'          // 强制只注册
    else if (this.registerMode === false) 动作 = 'login'       // 强制只登录
    else 动作 = 该注册 ? 'register' : 'login'                  // auto：按文案判断

    // 冷却与次数上限
    if (现在 - this.lastAttemptAt < this.retryMs) return false
    if (this.attempts >= this.maxAttempts) {
      this.finished = true
      if (this.ctx.logger) {
        this.ctx.logger.error(`自动登录放弃：已尝试 ${this.attempts} 次仍未成功（可能是密码不对 / 服务器要求验证码 / 需要图形菜单）。机器人将保持未登录状态`)
      }
      if (this.ctx.chatMonitor) {
        this.ctx.chatMonitor.feed('system', '', `[自动登录] 放弃：尝试 ${this.attempts} 次仍未成功，请手动处理`)
      }
      return false
    }

    this.lastAttemptAt = 现在
    this.attempts++
    this.lastAction = 动作
    this._send(动作)
    return true
  }

  _send (动作) {
    const 密码 = this.password
    const 命令 = 动作 === 'register'
      ? `${this.registerCommand} ${密码} ${密码}`  // 注册通常要输两遍
      : `${this.loginCommand} ${密码}`
    // 走聊天队列（限流、净化），不直接 bot.chat
    try {
      this.ctx.services.chatQueue.sendCommand(命令, { priority: 1, dedupe: false })
    } catch (e) {
      if (this.ctx.logger) this.ctx.logger.warn(`自动登录发送失败：${(e && e.message) || e}`)
      return
    }
    // 日志脱敏：只说做了什么，不说密码
    if (this.ctx.logger) {
      this.ctx.logger.info(`自动登录：检测到需${动作 === 'register' ? '注册' : '登录'}，已发送 /${动作 === 'register' ? this.registerCommand : this.loginCommand} ${this.maskedPassword}（第 ${this.attempts}/${this.maxAttempts} 次）`)
    }
    if (this.ctx.chatMonitor) {
      this.ctx.chatMonitor.feed('system', '', `[自动登录] 已发送 /${动作 === 'register' ? this.registerCommand : this.loginCommand}（第 ${this.attempts}/${this.maxAttempts} 次）`)
    }
  }

  // 进服时复位（重连后要重新判断登录状态）
  reset () {
    this.isAuthed = false
    this.finished = false
    this.attempts = 0
    this.lastAttemptAt = 0
    this.lastAction = ''
    this._lastText = ''
    this._lastTextAt = 0
  }

  getSnapshot () {
    return {
      enabled: this.enabled,
      passwordSet: !!this.password,
      registerMode: this.registerMode,
      isAuthed: this.isAuthed,
      attempts: this.attempts,
      maxAttempts: this.maxAttempts,
      finished: this.finished,
      lastAction: this.lastAction,
    }
  }

  stopForShutdown () { /* 无定时器，占位保持与其他服务一致 */ }
}

module.exports = { AutoAuth }
