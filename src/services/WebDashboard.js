// ============================================================
// WebDashboard：Web 状态 + 控制面板（零依赖，Node http）
// 默认仅绑定 127.0.0.1（不对局域网开放）
//   GET  /              状态与控制台页面
//   GET  /api/status    各账号状态 JSON
//   POST /api/control   控制动作（需访问令牌 + 同源 Origin 校验）
// 安全：启动生成随机令牌并注入页面；写操作仅 POST；浏览器请求校验同源 Origin
// ============================================================
'use strict'
const http = require('http')
const { randomToken, STATUS_CN } = require('../utils/helpers')

class WebDashboard {
  /**
   * @param {object} manager BotManager（getStatus / control）
   * @param {object} options { host:'127.0.0.1', port:8848 }
   */
  constructor (manager, options = {}) {
    this.manager = manager
    this.host = options.host || '127.0.0.1'
    this.port = options.port || 8848
    this.server = null
    this.ready = false
    this.token = randomToken(24)
  }

  /**
   * @param {Function} [onReady] 面板真正进入监听后的回调（用于打印地址、自动打开浏览器）
   */
  start (onReady) {
    this.server = http.createServer((req, res) => this._route(req, res))
    // 端口被占用等监听失败必须显式报出：否则面板静默不可用，用户只看到「没有界面」
    this.server.on('error', err => {
      this.ready = false
      const hint = err && err.code === 'EADDRINUSE'
        ? `端口 ${this.port} 已被占用（可能还有一个机器人窗口在运行）。请关闭它，或把配置里的 web.port 改成 8858 后重启。`
        : (err && err.message) || String(err)
      console.error(`\x1b[31m[面板] 启动失败：${hint}\x1b[0m`)
    })
    this.server.listen(this.port, this.host, () => {
      this.ready = true
      if (typeof onReady === 'function') onReady()
    })
  }

  _json (res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }

  // 浏览器同源校验（无 Origin 的非浏览器请求放行，由令牌兜底）
  _originOk (req) {
    const origin = req.headers.origin
    if (!origin) return true
    try { return new URL(origin).host === (req.headers.host || '') } catch (_) { return false }
  }

  _route (req, res) {
    const url = (req.url || '/').split('?')[0]

    if (req.method === 'GET' && url === '/api/status') {
      this._json(res, 200, { ts: Date.now(), server: this.manager.getServer(), whitelist: this.manager.getWhitelist(), accounts: this.manager.getStatus() })
      return
    }

    // bot 数据聚合：给 MC 客户端 mod（BotStatusHud）或本地软件用
    // 结构与 mod 的 BotDataHub 约定一致：{"bots":[...]}，字段缺的一律是 null
    if (req.method === 'GET' && url === '/api/bots') {
      let bots = []
      try {
        bots = this.manager.getBotSnapshots()
      } catch (e) {
        bots = []
      }
      this._json(res, 200, { ts: Date.now(), count: bots.length, bots: bots })
      return
    }

    if (req.method === 'GET' && url === '/api/chat') {
      const since = new URL(req.url, 'http://localhost').searchParams.get('since')
      this._json(res, 200, { ts: Date.now(), messages: this.manager.getPublicChat(since) })
      return
    }

    if (req.method === 'POST' && url === '/api/control') {
      if (!this._originOk(req)) { this._json(res, 403, { ok: false, message: '非法来源（Origin 不匹配）' }); return }
      let body = ''
      req.on('data', c => { body += c; if (body.length > 100000) req.destroy() })
      req.on('end', async () => {
        let data
        try { data = JSON.parse(body || '{}') } catch (_) { this._json(res, 400, { ok: false, message: '请求体不是有效 JSON' }); return }
        if (data.token !== this.token) { this._json(res, 403, { ok: false, message: '访问令牌无效' }); return }
        try {
          const result = await this.manager.control(data.target, data.action, data.args || [])
          this._json(res, 200, result)
        } catch (e) { this._json(res, 500, { ok: false, message: e.message }) }
      })
      return
    }

    if (req.method === 'GET' && url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(this._renderHtml())
      return
    }

    this._json(res, 404, { ok: false, message: '404 Not Found' })
  }

  _renderHtml () {
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>机器人控制台</title>
<style>
 :root{--ac:#4f7df9;--ac-deep:#3b63d9;--ac-soft:#eef3ff;--ink:#1c2434;--ink-2:#4a5568;--ink-3:#8a94a6;
   --line:#e4e9f2;--bg:#f2f5fa;--card:#ffffff;--ok:#188a42;--warn:#b07a12;--bad:#d23b4e;}
 *{box-sizing:border-box;}
 body{font-family:'Segoe UI Variable Text','Segoe UI','Microsoft YaHei',system-ui,sans-serif;color:var(--ink);
   margin:0;padding:28px 20px 48px;background:var(--bg);
   background-image:radial-gradient(1100px 420px at 12% -8%,#dfe9ff 0%,transparent 60%),
                    radial-gradient(900px 380px at 95% -6%,#e8f4ff 0%,transparent 55%);
   background-attachment:fixed;-webkit-font-smoothing:antialiased;}
 .hd,.bar,.wl,.cards,.split{max-width:1280px;margin-left:auto;margin-right:auto;}
 .hd{margin-bottom:22px;}
 h1{font-size:23px;margin:0 0 6px;letter-spacing:.4px;font-weight:800;
   background:linear-gradient(92deg,#2b3a55 0%,var(--ac-deep) 70%,#7a5cf0 100%);
   -webkit-background-clip:text;background-clip:text;color:transparent;}
 .sub{color:var(--ink-3);font-size:12.5px;letter-spacing:.2px;}
 /* 顶栏工具条 */
 .bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:center;background:var(--card);border:1px solid var(--line);
   border-radius:18px;padding:15px 18px;margin-bottom:16px;
   box-shadow:0 1px 2px rgba(23,43,99,.05),0 10px 28px -12px rgba(23,43,99,.14);}
 .bar-label{font-size:13px;font-weight:700;color:#33405c;flex:none;}
 .bar-gap{margin-left:10px;}
 /* 机器人卡片：分页后一页只有一张卡，拉宽到 880px 上限，按钮排得更开 */
 .cards{display:grid;gap:18px;grid-template-columns:minmax(0,880px);justify-content:center;}
 /* 账号分页页签：每个账号单独一页，点页签切换，一次只显示一张卡片 */
 .tabs{display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:center;margin:0 0 16px;}
 .tab{display:inline-flex;align-items:center;gap:6px;line-height:1;padding:9px 18px;font-size:13px;font-weight:700;border-radius:12px;}
 .tab .srv-tag{color:inherit;opacity:.72;font-weight:600;margin-left:2px;}
 .tab.on{background:linear-gradient(90deg,var(--ac) 0%,#7a5cf0 100%);border-color:transparent;color:#fff;box-shadow:0 4px 12px -4px rgba(79,125,249,.5);}
 .tab.on:hover{background:linear-gradient(90deg,var(--ac) 0%,#7a5cf0 100%);}
 .card{background:var(--card);border:1px solid var(--line);min-width:0;position:relative;
   border-radius:18px;padding:18px 16px 14px;
   box-shadow:0 1px 2px rgba(23,43,99,.05),0 12px 30px -14px rgba(23,43,99,.16);
   transition:transform .18s ease,box-shadow .18s ease;}
 .card:hover{transform:translateY(-2px);box-shadow:0 2px 4px rgba(23,43,99,.06),0 18px 38px -14px rgba(23,43,99,.22);}
 .card::before{content:'';position:absolute;inset:0 0 auto 0;height:3px;border-radius:18px 18px 0 0;
   background:linear-gradient(90deg,var(--ac) 0%,#7a5cf0 100%);opacity:.85;}
 .ch{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
 .nm{font-weight:800;font-size:16px;letter-spacing:.2px;}
 .srv-tag{font-size:11px;font-weight:600;color:var(--ink-3);margin-left:6px;}
 .badge{font-size:11px;font-weight:700;padding:4px 12px;border-radius:20px;display:inline-flex;align-items:center;gap:6px;}
 .badge::before{content:'';width:7px;height:7px;border-radius:50%;background:currentColor;
   box-shadow:0 0 0 3px rgba(255,255,255,.55);}
 .st-online{background:#e5f7ec;color:var(--ok);} .st-connecting,.st-reconnecting{background:#fdf3dd;color:var(--warn);}
 .st-ended,.st-giveUp{background:#fdeaec;color:var(--bad);}
 .st-waitServer{background:#e9edff;color:#4257d0;}
 .st-stopped{background:#edf0f5;color:#5c6779;}
 /* 状态下方：本账号的服务器 TPS 与 Ping（红框） */
 .metrics{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12.5px;font-weight:700;
   background:linear-gradient(180deg,#fff8f8 0%,#fffdfd 100%);border:1px solid #f3cfcf;border-radius:11px;
   padding:6px 11px;margin:0 0 10px;}
 .mt-ok{color:var(--ok);} .mt-warn{color:var(--warn);} .mt-bad{color:var(--bad);} .mt-unknown{color:var(--ink-3);font-weight:600;}
 .info{font-size:12.5px;color:var(--ink-2);line-height:1.9;}
 .inputs{display:flex;gap:7px;margin:12px 0;}
 .inp{flex:1;min-width:0;padding:8px 11px;border:1px solid #d7deea;border-radius:10px;font-size:12.5px;
   background:#fbfcfe;color:var(--ink);transition:border-color .15s,box-shadow .15s,background .15s;}
 .inp:focus{outline:none;border-color:var(--ac);background:#fff;box-shadow:0 0 0 3px rgba(79,125,249,.15);}
 .btns{display:flex;flex-direction:column;gap:6px;background:#f6f8fc;border:1px solid #ecf0f7;border-radius:13px;padding:10px;}
 /* 指令分组：无标题，每组一行按钮；说明文字看悬停 tooltip */
 .brow{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}
 /* 状态信息在左、指令折叠组在右：利用卡片右侧空白 */
 .toprow{display:flex;gap:14px;align-items:stretch;margin:2px 0 4px;}
 .topinfo{flex:1 1 240px;min-width:0;}
 .btns{flex:1 1 400px;align-content:flex-start;}
 .srv-cur{font-size:12px;color:#7b8794;margin:6px 0 0;word-break:break-all;}
 /* 背包 / 装备栏 / 副手显示 */
 .inv{margin-top:8px;}
 .inv-none{font-size:11px;color:#c3cad6;}
 .inv-t{font-size:10px;color:#8a94a6;margin:5px 0 2px;font-weight:600;}
 .inv-grid{display:grid;grid-template-columns:repeat(9,minmax(0,1fr));gap:2px;}
 .inv-cell{position:relative;height:30px;background:#f6f8fc;border:1px solid #e4e9f2;border-radius:4px;
   display:flex;align-items:center;justify-content:center;overflow:hidden;min-width:0;}
 .inv-nm{font-size:9px;line-height:1.15;color:#1c2434;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;
   overflow:hidden;text-overflow:ellipsis;max-width:100%;padding:0 1px;word-break:break-all;}
 .inv-ct{position:absolute;right:1px;bottom:-1px;font-size:9px;color:#4a5568;font-weight:700;
   background:rgba(255,255,255,.85);border-radius:3px;padding:0 1px;line-height:1.1;}
 .inv-empty{background:#fbfcfe;}
 .inv-ph{font-size:9px;color:#c3cad6;}
 .inv-eq{display:grid;grid-template-columns:repeat(9,minmax(0,1fr));gap:2px;}
 .inv-eq>div:nth-child(1){grid-column:1/5;}
 .inv-eq>div:nth-child(2){grid-column:6/7;}
 .inv-eq>div .inv-t{margin-top:5px;}
 .inv-eq>div:nth-child(1) .inv-grid{grid-template-columns:repeat(4,minmax(0,1fr));}
 @media (max-width:700px){ .toprow{flex-direction:column;} .btns{flex:0 0 auto;} }
 /* 折叠菜单：每个卡片里的指令按用途分组，点标题展开/收起 */
 details.grp{background:#fff;border:1px solid #e8ecf4;border-radius:12px;transition:border-color .15s;}
 details.grp:hover{border-color:#d5dded;}
 details.grp>summary{cursor:pointer;list-style:none;padding:8px 11px;font-size:12.5px;font-weight:700;
   color:#33405c;display:flex;align-items:center;gap:8px;user-select:none;border-radius:12px;}
 details.grp>summary::-webkit-details-marker{display:none;}
 details.grp>summary::before{content:'▸';font-size:11px;color:var(--ac);transition:transform .18s;}
 details.grp[open]>summary::before{transform:rotate(90deg);}
 details.grp>summary:hover{color:var(--ac-deep);}
 .grp-body{display:flex;gap:7px;flex-wrap:wrap;padding:2px 11px 11px;}
 .cnt{font-size:11.5px;font-weight:400;color:var(--ink-3);}
 /* 卡片内按钮文字不折行：防AFK：暂停 这类长按钮保持一行，排列整齐 */
 .btns button,.btns select{white-space:nowrap;}
 /* 白名单组可用指令（那排勾选框）用 details.grp 折叠；白名单窗口本身不再折叠 */
 #wl-cmds{margin-top:10px;}
 #wl-cmds>.grp-body{gap:12px 16px;padding:2px 11px 12px;}
 .wl-chip.tp{background:#f3efff;border-color:#d8cbf5;color:#6446c9;}
 .wl-chip.tpp{background:#e9f9f0;border-color:#bfe6d2;color:#157a45;}
 .wl-sep{margin-top:16px;border-top:1px dashed #e8ecf4;padding-top:12px;}
 button{cursor:pointer;border:1px solid #d9e2f2;background:#fff;color:var(--ac-deep);border-radius:10px;
   padding:8px 13px;font-size:12.5px;font-weight:600;line-height:1;
   display:inline-flex;align-items:center;justify-content:center;gap:5px;
   box-shadow:0 1px 2px rgba(23,43,99,.06);
   transition:background .15s,border-color .15s,transform .08s,box-shadow .15s;}
 button:hover{background:var(--ac-soft);border-color:#bcd0f5;box-shadow:0 2px 6px rgba(59,99,217,.14);}
 button:active{transform:translateY(1px);box-shadow:none;}
 button:focus-visible{outline:2px solid var(--ac);outline-offset:1px;}
 button.sm{padding:6px 11px;font-size:12px;}
 button.on{background:#e5f7ec;border-color:#bfe6c9;color:var(--ok);box-shadow:none;}
 button.on:hover{background:#d8f2e2;}
 button.danger{background:#fff;color:var(--bad);border-color:#f0ccd1;box-shadow:none;}
 button.danger:hover{background:#fdeaec;border-color:#eeb6be;box-shadow:0 2px 6px rgba(210,59,78,.14);}
 .console-input{flex:1;min-width:200px;padding:9px 12px;border:1px solid #d7deea;border-radius:10px;font-size:13px;
   background:#fbfcfe;color:var(--ink);transition:border-color .15s,box-shadow .15s,background .15s;}
 .console-input:focus{outline:none;border-color:var(--ac);background:#fff;box-shadow:0 0 0 3px rgba(79,125,249,.15);}
 label.lbl{font-size:12px;color:var(--ink-2);}
 select{padding:8px;border:1px solid #d7deea;border-radius:10px;font-size:13px;background:#fbfcfe;color:var(--ink);
   transition:border-color .15s,box-shadow .15s;}
 select:focus{outline:none;border-color:var(--ac);box-shadow:0 0 0 3px rgba(79,125,249,.15);}
 select.authsel{padding:5px 8px;border:1px solid #d9e2f2;border-radius:9px;font-size:12px;font-weight:600;
   color:var(--ac-deep);background:var(--ac-soft);}
 /* 全局勾选框：系统样式 + 主题色 */
 input[type='checkbox']{accent-color:var(--ac);width:14px;height:14px;cursor:pointer;}
 .log-ok{color:var(--ok);} .log-err{color:var(--bad);} .log-time{color:var(--ink-3);}
 .pub-time{color:var(--ink-3);} .pub-user{color:var(--ac-deep);font-weight:700;} .pub-sys{color:var(--warn);}
 .split{display:flex;gap:18px;flex-wrap:wrap;margin-top:18px;}
 .pane{flex:1 1 420px;min-width:0;background:var(--card);border:1px solid var(--line);border-radius:18px;display:flex;
   flex-direction:column;box-shadow:0 1px 2px rgba(23,43,99,.05),0 12px 30px -14px rgba(23,43,99,.16);overflow:hidden;}
 .pane-hd{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #eef1f7;
   background:linear-gradient(180deg,#fbfcfe 0%,#f7f9fc 100%);}
 .pane-title{font-size:13px;font-weight:800;color:#33405c;letter-spacing:.3px;}
 .pane-body{height:360px;overflow:auto;padding:12px 16px;font-family:Consolas,'Cascadia Mono','Courier New',monospace;
   font-size:12.5px;line-height:1.8;}
 .wl{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:16px 18px;margin-bottom:16px;
   box-shadow:0 1px 2px rgba(23,43,99,.05),0 10px 28px -12px rgba(23,43,99,.14);}
 .wl-row{display:flex;gap:16px;flex-wrap:wrap;align-items:center;margin-top:10px;}
 .wl-row label{font-size:12.5px;display:flex;align-items:center;gap:6px;color:var(--ink-2);}
 /* 白名单玩家列表改为每玩家一行（含个人权限面板），其余名单（传送白名单等）仍是横向胶囊流 */
 #wl-list{display:block;}
 .wl-list{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;}
 .wl-chip{display:inline-flex;align-items:center;gap:6px;background:var(--ac-soft);border:1px solid #d5e0f7;border-radius:20px;
   padding:3px 6px 3px 13px;font-size:12.5px;font-weight:600;color:var(--ac-deep);}
 .wl-empty{font-size:12.5px;color:var(--ink-3);}
 /* 白名单每个玩家一行：名字胶囊 + 「权限」按钮 + 移除；点「权限」弹出该玩家的下拉多选面板 */
 .wl-friend{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:9px;position:relative;}
 .wl-tag{font-size:11px;font-weight:700;color:#6446c9;background:#f3efff;border:1px solid #d8cbf5;border-radius:12px;padding:2px 9px;}
 /* 个人权限 = 下拉多选面板：浮在行下方，不把下面内容挤开 */
 .wl-pbox{position:absolute;top:calc(100% + 6px);right:0;z-index:40;width:min(580px,94vw);max-height:min(62vh,460px);overflow:auto;
   background:#fff;border:1px solid #dbe3f2;border-radius:14px;padding:11px 13px;
   box-shadow:0 14px 38px rgba(28,38,72,.20);animation:ppIn .16s ease-out;}
 @keyframes ppIn{from{opacity:0;transform:translateY(-6px);}to{opacity:1;transform:none;}}
 .pbox-hd{font-size:12px;color:var(--ink-2);display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:7px;}
 /* 指令勾选分组：每组一张小卡 + 多列网格，替代原来一整排复选框 */
 .perm-sec{margin:0 0 9px;padding:8px 11px 10px;background:#f9fafd;border:1px solid #eef1f7;border-radius:11px;width:100%;box-sizing:border-box;}
 .perm-sec:last-child{margin-bottom:0;}
 .perm-sec .perm-t{font-size:11.5px;font-weight:700;color:#8a94a6;letter-spacing:.4px;margin:0 0 6px;}
 .perm-sec{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:2px 12px;align-items:center;}
 .perm-sec .perm-t{grid-column:1/-1;}
 .perm-sec label{display:flex;align-items:flex-start;gap:6px;margin:0;padding:3px 5px;border-radius:6px;line-height:1.35;min-width:0;}
 .perm-sec label input{flex:0 0 auto;margin-top:2px;}
 .perm-sec label:hover{background:#eef3ff;}
 .pbox-hd b{color:var(--ac-deep);}
 .wl-pbox .grp-body{display:flex;gap:5px 14px;flex-wrap:wrap;}
 .wl-pbox label{font-size:12px;display:flex;align-items:center;gap:5px;color:var(--ink-2);cursor:pointer;
   padding:2px 6px;border-radius:7px;transition:background .12s;}
 .wl-pbox label:hover{background:#eaefff;}
 .pane-body::-webkit-scrollbar{width:10px;height:10px;}
 .pane-body::-webkit-scrollbar-thumb{background:#ccd6e4;border-radius:8px;border:2px solid #fff;}
 .pane-body::-webkit-scrollbar-thumb:hover{background:#aebcd0;}
 .pane-body::-webkit-scrollbar-track{background:transparent;}
 /* —— 整体美化补充：标题、日志窗、白名单行、输入高度统一 —— */
 .sub{display:flex;align-items:center;gap:7px;}
 .sub::before{content:'';width:7px;height:7px;border-radius:50%;background:linear-gradient(135deg,var(--ok) 0%,#4fd08a 100%);box-shadow:0 0 0 3px rgba(24,138,66,.12);}
 .pane-title{display:inline-flex;align-items:center;gap:7px;}
 .pane-title::before{content:'';width:8px;height:8px;border-radius:3px;background:linear-gradient(135deg,var(--ac) 0%,#7a5cf0 100%);}
 .pane-hd{padding:11px 16px;background:linear-gradient(180deg,#fcfdff 0%,#f6f8fc 100%);}
 .pane-body{background:linear-gradient(180deg,#fdfefe 0%,#fbfcfe 100%);}
 .wl-friend{padding:5px 9px;border-radius:11px;transition:background .15s;}
 .wl-friend:hover{background:#f6f9ff;}
 .wl-chip{transition:box-shadow .15s,transform .08s;}
 .wl-chip:hover{box-shadow:0 2px 8px -2px rgba(59,99,217,.25);}
 .console-input,.bar select{padding:8px 12px;}
 .metrics{background:linear-gradient(180deg,#fff9f9 0%,#fefcfc 100%);border-color:#f5d8d8;border-radius:12px;}
 .card{padding:20px 20px 16px;}
 .grp-body{padding:3px 12px 12px;}
 /* 全页细滚动条（日志窗以外的区域，如白名单长列表） */
 ::-webkit-scrollbar{width:11px;height:11px;}
 ::-webkit-scrollbar-thumb{background:#cdd7e6;border-radius:8px;border:3px solid var(--bg);}
 ::-webkit-scrollbar-thumb:hover{background:#aebcd0;}
 ::-webkit-scrollbar-track{background:transparent;}
</style></head><body>
<header class="hd">
  <h1>多账号机器人 · 控制台</h1>
  <div class="sub">默认仅本机可访问 · 控制操作已启用访问令牌与同源校验 · 每 3 秒自动刷新状态</div>
</header>

<div class="bar">
  <span class="bar-label">指令控制台</span>
  <select id="target">
    <option value="all">全部账号</option>
  </select>
  <input id="cmd" class="console-input" placeholder="输入命令或聊天，例如 /home 或 tpa 管理员玩家（以 / 开头按命令发送）">
  <button onclick="sendConsole()">发送</button>
</div>

<div class="bar">
  <span class="bar-label">默认服务器</span>
  <input id="srv-host" class="console-input" style="min-width:180px" placeholder="新账号默认IP">
  <input id="srv-port" class="console-input" style="max-width:90px" placeholder="端口(可留空)" title="填了才用；留空 = 用默认端口 25565，域名会先按 SRV 记录解析">
  <button onclick="saveServer()">保存并全部重连</button>
  <span class="bar-label bar-gap">添加机器人</span>
  <input id="new-name" class="console-input" style="min-width:140px" placeholder="账号名">
  <select id="new-auth">
    <option value="offline">离线</option>
    <option value="microsoft">正版</option>
  </select>
  <button onclick="addBot()">添加</button>
</div>

<div class="tabs" id="tabs"></div>

<div class="cards" id="cards"></div>

<div class="wl">
  <span class="bar-label">白名单玩家（私聊机器人即可用，无需前缀）</span>
  <span style="font-size:12px;color:#9ca3af;">每个玩家可点「权限」单独勾选他自己的指令；没单独设置的跟随下面的公共勾选</span>
  <details class="grp" id="wl-cmds">
    <summary>白名单组可用指令（公共） <span class="cnt">（点开勾选 / 收起；只对「没单独设置个人权限」的玩家生效；管理类指令只归最高权限者，不在此列）</span></summary>
    <div class="grp-body" id="wl-perms"></div>
  </details>
  <div class="wl-row">
    <input id="wl-name" class="console-input" style="min-width:160px" placeholder="玩家名">
    <button onclick="addFriendUi()">添加白名单</button>
  </div>
  <div class="wl-list" id="wl-list"></div>
  <div class="wl-row wl-sep">
    <strong style="font-size:12.5px;color:#6b7280;">传送白名单（机器人自动接受他的 tpa / tpahere）：</strong>
    <span style="font-size:12px;color:#9ca3af;">（在名单里 = 他向机器人 tpa/tpahere 时自动 /tpaccept；其他权限一律不给）</span>
  </div>
  <div class="wl-row">
    <input id="tpp-name" class="console-input" style="min-width:160px" placeholder="玩家名">
    <button onclick="addTpPlayerUi()">加入传送白名单</button>
  </div>
  <div class="wl-list" id="tpp-list"></div>
  <div class="wl-row wl-sep">
    <strong style="font-size:12.5px;color:#6b7280;">传送白名单管理员：</strong>
    <span style="font-size:12px;color:#9ca3af;">（可用上面那张名单的 加人/移除/看名单（游戏里 !传送白名 / !传送清白 / !传送名单），<b>另外还享有白名单组的全部指令</b>；重连、关服、授权、加白名单组等管理类仍然只归你）</span>
  </div>
  <div class="wl-row">
    <input id="tp-name" class="console-input" style="min-width:160px" placeholder="玩家名">
    <button onclick="addTpAdminUi()">设为白名单管理员</button>
  </div>
  <div class="wl-list" id="tp-list"></div>
</div>

<div class="split">
  <div class="pane">
    <div class="pane-hd">
      <span class="pane-title">控制台日志</span>
      <span><button class="sm" id="log-refresh" title="仅重新拉取并重画这一栏日志（不影响机器人状态、不刷新整页）">刷新</button></span>
    </div>
    <div class="pane-body" id="log"></div>
  </div>
  <div class="pane">
    <div class="pane-hd">
      <span class="pane-title">服务器公屏</span>
      <span><button class="sm" id="pub-pause">暂停滚动</button> <button class="sm" id="pub-clear">清空</button></span>
    </div>
    <div class="pane-body" id="pub-body"></div>
  </div>
</div>

<script>
const TOKEN = ${JSON.stringify(this.token)};
let lastInputs = {};
// 展示用中文映射（仅影响显示，内部 action / 状态值不变）
const STATUS_CN = ${JSON.stringify(STATUS_CN)};
const DIM_CN = {overworld:'主世界','minecraft:overworld':'主世界',the_nether:'下界','minecraft:the_nether':'下界',nether:'下界',the_end:'末地','minecraft:the_end':'末地',end:'末地'};
const ACTION_CN = {console:'控制台',afk:'防AFK',eat:'进食',bottle:'瓶子',follow:'跟随',goto:'前往',home:'回家',stop:'停止',reconnect:'重连',shutdown:'下线',attack:'攻击',clear:'清空',move:'移动','turn-left':'左转','turn-right':'右转','look-down':'俯视','sethome':'设家','delhome':'删家','friend-cmds':'白名单指令','set-friend-perms':'个人权限','set-public-cmd':'公屏组','enable-bot':'启用','disable-bot':'停用',deposit:'存箱',withdraw:'取物',peekchest:'开箱'};
function dimCn(d){ return DIM_CN[d]||DIM_CN['minecraft:'+d]||d||'-'; }

async function apiStatus(){
  const r = await fetch('/api/status'); return await r.json();
}
async function post(target, action, args){
  let j = null;
  try{
    const r = await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token:TOKEN,target,action,args:args||[]})});
    j = await r.json();
    showResult(action, j);
  }catch(e){ log('<span class="log-err">请求失败：'+e.message+'</span>'); }
  refresh();
  return j;
}
function sendConsole(){
  const t = document.getElementById('target').value;
  const text = document.getElementById('cmd').value.trim();
  if(!text) return;
  post(t,'console',[text]);
  document.getElementById('cmd').value='';
}
document.getElementById('cmd').addEventListener('keydown',e=>{ if(e.key==='Enter') sendConsole(); });

// 添加机器人（账号名 + 登录方式 + 可选的目标服务器）
// 「新账号默认IP / 端口」填了 → 就写进这个新账号（自己一个服务器）；
// 不填 → 用顶部的全局默认服务器。同名账号允许加到别的服务器，同一台服务器会提示“账号已存在”。
function addBot(){
  const name=document.getElementById('new-name').value.trim();
  const auth=document.getElementById('new-auth').value;
  const h=(document.getElementById('srv-host').value||'').trim();
  const p=(document.getElementById('srv-port').value||'').trim();
  if(!name){ log('<span class="log-err">请填写账号名</span>'); return; }
  post('all','add-bot',[name,auth,h,p]);
  document.getElementById('new-name').value='';
}
document.getElementById('new-name').addEventListener('keydown',e=>{ if(e.key==='Enter') addBot(); });
// 保存服务器 IP/端口并全部重连
async function saveServer(){
  const h=document.getElementById('srv-host'), p=document.getElementById('srv-port');
  const host=h.value.trim(), port=p.value.trim();
  if(!host){ log('<span class="log-err">请填写服务器IP</span>'); return; }
  const j=await post('all','server',[host,port]);
  // 应用成功后清空：这两个框只在你要改默认服务器时才填，平时保持空白
  if(j && j.result && j.result.ok!==false){ h.value=''; p.value=''; }
}

// ---- 白名单：渲染 / 添加 / 移除 / 权限 ----
let lastWl = null;                 // 最近一次状态里的白名单数据（fillPermBox 用）
const openPerms = {};              // 小写玩家名 -> 是否展开了个人权限面板
// 每个玩家的个人权限面板：只在该玩家的数据（指令目录或个人清单）变化时重建，
// 避免每 3 秒重画把你刚点的勾选冲掉
// 指令勾选分组渲染：按功能分组（状态/移动/家传送/物品/自动/战斗），每组小标题 + 多列网格，
// 避免几十个复选框挤成一团。未知指令自动落到「其他」组
const PERM_GROUPS = [
  ['status', '状态查询'],
  ['move', '移动 / 朝向'],
  ['home', '家 / 传送 / 检测'],
  ['item', '物品 / 装备 / 种树'],
  ['auto', '自动功能'],
  ['combat', '战斗'],
  ['other', '其他'],
]
const PERM_GROUP_OF = {
  status: 'status',
  stop: 'move', follow: 'move', goto: 'move', move: 'move', turnleft: 'move', turnright: 'move', lookdown: 'move', aim: 'move', dismount: 'move',
  home: 'home', sethome: 'home', delhome: 'home', tpa: 'home', tpahere: 'home', detect: 'home',
  hotbar: 'item', offhand: 'item', toss: 'item', equip: 'item', unequip: 'item', use: 'item', continuoususe: 'item', plant: 'item', deposit: 'item', withdraw: 'item', peekchest: 'item', scanchest: 'item', clear: 'item',
  afk: 'auto', eat: 'auto', bottle: 'auto', entityfilter: 'auto',
  attack: 'combat',
  runcmd: 'other', say: 'other',
}
function permGridHtml (cmds, cls, checkedFn) {
  const label = c => '<label title="' + escapeHtml(c.name) + (c.whisperOnly ? '（仅私聊：公屏发来不执行）' : '') + '"><input type="checkbox" class="' + cls + '" value="' + escapeHtml(c.name) + '"' + (checkedFn(c) ? ' checked' : '') + '> ' + escapeHtml(c.usage) + (c.whisperOnly ? ' <b style="color:#b07a12;">需私聊</b>' : '') + '</label>'
  const buckets = {}; PERM_GROUPS.forEach(g => { buckets[g[0]] = [] })
  const rest = []
  for (const c of cmds) {
    const k = PERM_GROUP_OF[c.name]
    if (k && buckets[k]) buckets[k].push(c); else rest.push(c)
  }
  return PERM_GROUPS.filter(g => buckets[g[0]].length)
    .map(g => '<div class="perm-sec"><div class="perm-t">' + g[1] + '</div>' + buckets[g[0]].map(label).join('') + '</div>')
    .join('') +
    (rest.length ? '<div class="perm-sec"><div class="perm-t">其他</div>' + rest.map(label).join('') + '</div>' : '')
}
function fillPermBox (box, n) {
  const w = lastWl; if (!w || !box) return;
  const key = String(n).toLowerCase();
  const mine = (w.friendPerms || {})[key] || null;
  const cmds = (w.catalog || []).filter(c => c.permission !== 'admin');
  const sig = cmds.map(c => c.name + '|' + (c.whisperOnly ? 1 : 0)).join(',') + '#' + (mine ? mine.join('+') : '@group');
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  const has = new Set(mine || []);
  // 没设个人权限时，勾选框按公共勾选显示（= 当前实际生效的指令），一动就会变成个人权限
  const src = mine ? has : new Set(w.friendCommands || []);
  box.innerHTML =
    '<div class="pbox-hd">' + (mine
      ? '<b>' + escapeHtml(n) + ' 的个人权限</b>（只按这里勾的放行，与公共勾选无关）'
      : escapeHtml(n) + ' 未单独设置，当前跟随「白名单组可用指令」公共勾选；勾选任意一项即成为他的个人权限') +
    ' <button class="sm" data-clr="1"' + (mine ? '' : ' disabled') + '>回退公共勾选</button></div>' +
    '<div class="grp-body">' +
    '<label title="* ：除管理类指令外全部放行"><input type="checkbox" class="pperm" value="*"' + (has.has('*') ? ' checked' : '') + '> <b>全部（*）</b></label>' +
    permGridHtml(cmds, 'pperm', c => src.has(c.name)) +
    '</div>';
  box.querySelectorAll('.pperm').forEach(cb => {
    cb.addEventListener('change', () => {
      const picked = [...box.querySelectorAll('.pperm')].filter(x => x.checked).map(x => x.value);
      // 全不勾 = 清除个人权限，回退公共勾选
      post('all', 'set-friend-perms', [n].concat(picked));
    });
  });
  const clr = box.querySelector('[data-clr]');
  if (clr) clr.addEventListener('click', () => { post('all', 'set-friend-perms', [n]); });
}
function wlRender (d) {
  const w = d.whitelist; if (!w) return;
  lastWl = w;
  // 勾选框按指令目录生成：目录没变就不重建，避免每 3 秒把你的勾选重画掉
  const box = document.getElementById('wl-perms');
  const cmds = (w.catalog || []).filter(c => c.permission !== 'admin');
  const sig = cmds.map(c => c.name + '|' + c.usage + '|' + (c.whisperOnly ? 1 : 0)).join(',');
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    // 仅私聊的指令标一个「需私聊」角标：公屏发来不会执行
    box.innerHTML = permGridHtml(cmds, 'wperm', () => false);
    box.querySelectorAll('.wperm').forEach(cb => {
      cb.addEventListener('change', () => {
        const picked = [...box.querySelectorAll('.wperm')].filter(x => x.checked).map(x => x.value);
        post('all', 'friend-cmds', picked);
      });
    });
  }
  const has = w.friendCommands || [];
  box.querySelectorAll('.wperm').forEach(cb => { cb.checked = has.includes(cb.value); });
  // 白名单玩家：一行一个人（名字 + 是否已设个人权限标记 + 公屏组开关 + 权限/移除按钮）。
  // 行只在名单/个人权限标记/公屏组状态变化时重建，展开的面板内容另由 fillPermBox 增量更新
  const list = document.getElementById('wl-list');
  const friends = w.friends || [];
  const perms = w.friendPerms || {};
  const pub = new Set((w.publicCmds || []).map(s => String(s).toLowerCase()));
  const listSig = friends.map(n => {
    const k = String(n).toLowerCase();
    return k + ((perms[k] || perms[n]) ? '*' : '') + (pub.has(k) ? '~' : '');
  }).join(',');
  if (list.dataset.sig !== listSig) {
    list.dataset.sig = listSig;
    list.innerHTML = friends.length ? friends.map(n => {
      const key = String(n).toLowerCase();
      const mine = !!(perms[key] || perms[n]);
      const inPub = pub.has(key);
      return '<div class="wl-friend">' +
        '<span class="wl-chip">' + escapeHtml(n) + '</span>' +
        (mine ? '<span class="wl-tag">个人权限</span>' : '') +
        '<button class="sm wl-pub' + (inPub ? ' on' : '') + '" data-n="' + escapeHtml(n) + '"' +
        ' title="公屏组：勾选后他可以在公屏（带 ! 前缀）触发「需私聊」类指令（瓶子/箱子/检测等）；每只 bot 都会各自执行">公屏' + (inPub ? '：开' : '：关') + '</button>' +
        '<button class="sm wl-perm" data-n="' + escapeHtml(n) + '">权限</button>' +
        '<button class="sm danger wl-rm" data-n="' + escapeHtml(n) + '">移除</button>' +
        '<div class="wl-pbox" data-for="' + escapeHtml(n) + '" style="display:' + (openPerms[key] ? '' : 'none') + '"></div>' +
        '</div>';
    }).join('') : '<span class="wl-empty">暂无白名单玩家</span>';
  }
  list.querySelectorAll('.wl-pbox').forEach(b => {
    const n = b.getAttribute('data-for');
    if (openPerms[String(n).toLowerCase()]) fillPermBox(b, n);
  });
  // 传送白名单（机器人自动接受名单）：白名单管理员添加的人，你也能在面板加/删
  const tpp = w.tpPlayers || [];
  document.getElementById('tpp-list').innerHTML = tpp.length ? tpp.map(n =>
    '<span class="wl-chip tpp">' + escapeHtml(n) + ' <button class="sm danger tpp-rm" data-n="' + escapeHtml(n) + '">移除</button></span>'
  ).join('') : '<span class="wl-empty">暂无传送白名单成员</span>';
  // 传送白名单管理员（组3：只能管上面那张名单）
  const tp = w.tpAdmins || [];
  document.getElementById('tp-list').innerHTML = tp.length ? tp.map(n =>
    '<span class="wl-chip tp">' + escapeHtml(n) + ' <button class="sm danger tp-rm" data-n="' + escapeHtml(n) + '">移除</button></span>'
  ).join('') : '<span class="wl-empty">暂无传送白名单管理员（现在只有你（最高权限者）能指定）</span>';
}
function addFriendUi(){
  const inp=document.getElementById('wl-name'), n=inp.value.trim();
  if(!n){ log('<span class="log-err">请填写玩家名</span>'); return; }
  post('all','add-friend',[n]); inp.value='';
}
function addTpPlayerUi(){
  const inp=document.getElementById('tpp-name'), n=inp.value.trim();
  if(!n){ log('<span class="log-err">请填写玩家名</span>'); return; }
  post('all','add-tp-player',[n]); inp.value='';
}
function addTpAdminUi(){
  const inp=document.getElementById('tp-name'), n=inp.value.trim();
  if(!n){ log('<span class="log-err">请填写玩家名</span>'); return; }
  post('all','add-tp-admin',[n]); inp.value='';
}
document.getElementById('wl-name').addEventListener('keydown',e=>{ if(e.key==='Enter') addFriendUi(); });
document.getElementById('tp-name').addEventListener('keydown',e=>{ if(e.key==='Enter') addTpAdminUi(); });
document.getElementById('tpp-name').addEventListener('keydown',e=>{ if(e.key==='Enter') addTpPlayerUi(); });
document.getElementById('wl-list').addEventListener('click',e=>{
  const rm=e.target.closest('.wl-rm');
  if(rm){ post('all','remove-friend',[rm.dataset.n]); return; }
  // 「公屏」：切换公屏组成员（公屏可触发需私聊类指令）
  const pubBtn=e.target.closest('.wl-pub');
  if(pubBtn){ post('all','set-public-cmd',[pubBtn.dataset.n, pubBtn.classList.contains('on')?'0':'1']); return; }
  // 「权限」：弹出/收起这个玩家的个人权限下拉多选面板（同时只开一个，点面板外自动收起）
  const pb=e.target.closest('.wl-perm');
  if(pb){
    const n=pb.dataset.n, key=String(n).toLowerCase();
    const wasOpen=!!openPerms[key];
    // 先收起全部（下拉行为：同时只开一个）
    document.querySelectorAll('.wl-pbox').forEach(b=>{ b.style.display='none'; });
    Object.keys(openPerms).forEach(k=>{ openPerms[k]=false; });
    openPerms[key]=!wasOpen;
    const row=pb.closest('.wl-friend'), box=row&&row.querySelector('.wl-pbox');
    if(box){
      box.style.display=openPerms[key]?'':'none';
      if(openPerms[key]){ box.dataset.sig=''; fillPermBox(box,n); }
    }
  }
});
// 点面板外任意位置收起下拉（面板内部或「权限」按钮本身除外）
document.addEventListener('click',e=>{
  if(e.target.closest('.wl-pbox')||e.target.closest('.wl-perm')) return;
  document.querySelectorAll('.wl-pbox').forEach(b=>{ b.style.display='none'; });
  Object.keys(openPerms).forEach(k=>{ openPerms[k]=false; });
});
document.getElementById('tp-list').addEventListener('click',e=>{
  const b=e.target.closest('.tp-rm'); if(!b) return;
  post('all','remove-tp-admin',[b.dataset.n]);
});
document.getElementById('tpp-list').addEventListener('click',e=>{
  const b=e.target.closest('.tpp-rm'); if(!b) return;
  post('all','remove-tp-player',[b.dataset.n]);
});
// （白名单勾选框的监听在 wlRender 里按指令目录重建时绑定）

function showResult(action, j){
  let msg='', ok=j.ok;
  if(j.results){ j.results.forEach(x=>{ const r=x.result; msg+=x.username+'：'+(r.message||JSON.stringify(r))+'；'; }); }
  else if(j.result){ ok=j.result.ok!==false; msg=j.result.message||JSON.stringify(j.result); }
  else { msg=j.message||JSON.stringify(j); }
  log('<span class="log-'+(ok?'ok':'err')+'">['+(ACTION_CN[action]||action)+'] '+msg+'</span>');
}
// 控制台日志：新条目插到最前面。
// 同时把原始内容存进 logHistory，供右上角「刷新」重画（否则内容只在 DOM 里，没法重放）。
let logHistory=[];       // [{ time, html }] 时间正序，最新的在最后
const LOG_MAX=500;       // 本地最多留多少条，防长时间挂机把内存吃满
function log(html){
  const box=document.getElementById('log');
  const time=new Date().toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
  logHistory.push({ time, html });
  if(logHistory.length>LOG_MAX) logHistory.splice(0, logHistory.length-LOG_MAX);
  box.innerHTML='<div><span class="log-time">'+time+'</span> '+html+'</div>'+box.innerHTML;
}
// 按 logHistory 重画整栏日志（倒序：最新的在最上面）
function renderLog(){
  const box=document.getElementById('log');
  box.innerHTML=logHistory.slice().reverse()
    .map(x=>'<div><span class="log-time">'+x.time+'</span> '+x.html+'</div>').join('');
}

// ---- 卡片只“建一次”，之后只就地更新会变的部分 ----
// 输入框（服务器IP/端口/玩家名/家名/瓶分钟/攻击tick）建好后刷新一律不碰：
// 每 3 秒重建整张卡片会把你正在输入的内容和光标一起冲掉。
// 服务器IP/端口默认留空，只在你要给这个账号单独指定服务器时才填。
function buildCard(a){
  const k=a.key||a.username;
  const srvTag=a.serverHost?' <span class="srv-tag">@'+a.serverHost+(a.serverPort?':'+a.serverPort:'')+'</span>':'';
  return '<div class="card" data-key="'+k+'" data-name="'+a.username+'">'+
    '<div class="ch"><span class="nm">'+a.username+srvTag+'</span><span class="badge"></span></div>'+
    // 状态下方红框：本账号的服务器 TPS 与自己的 Ping（每 3 秒随状态刷新）
    '<div class="metrics"><span class="tps mt-unknown">TPS -</span><span class="ping mt-unknown">Ping -</span></div>'+
    '<div class="toprow"><div class="topinfo">'+
    '<div class="info"></div>'+
    // 当前实际连接的服务器（只读展示）：上方输入框保持空白，这里告诉你在连哪个服
    '<div class="srv-cur"></div>'+
    // 背包 / 装备栏 / 副手实时显示（随状态 3 秒刷新，内容没变不重画）
    '<div class="inv"></div>'+
    '</div>'+
    // 指令折叠组放到状态信息右侧，利用卡片右边的空白
    '<div class="btns"></div></div>'+
    '<div class="inputs"><input class="inp srv-h" placeholder="该账号服务器IP"><input class="inp srv-p" placeholder="端口" style="flex:0 0 110px" title="填了才用；留空 = 用默认端口 25565，域名会先按 SRV 记录解析"><button class="sm" data-act="set-srv">连接</button></div>'+
    // 其余输入框（玩家名/家名/瓶分钟/攻击tick/取物/俯视角度）已移到右侧，跟用它们的按钮同一行
    '</div>';
}
// 刷新时只重画这些只读信息：坐标 / 血量 / 饥饿 / 维度 / 重连次数
function cardInfoHtml(a){
  const pos=a.position?a.position.join(', '):'-';
  const h=a.health==null?'-':a.health.toFixed(1), f=a.food==null?'-':a.food;
  // 服务器不在线时提示：现在不直连，只在探测，服务器一上线自动重连
  const wait = a.waitingServer ? '<br><span style="color:#3b4cca;">服务器不在线：保持离线中，探测到上线自动重连</span>' : '';
  const offTxt = a.enabled===false ? '<br><span style="color:#8a94a6;">已停用：不会连接、也不自动重连（点上方「启用」恢复）</span>' : '';
  return '坐标 '+pos+'<br>血量 '+h+'　饥饿 '+f+'<br>维度 '+dimCn(a.dimension)+'　'+(a.uptime||'-')+'<br>重连 '+a.reconnectAttempts+' 次'+wait+offTxt;
}
// 指令按用途分行展示：不折叠、不显示组标题，每组一行按钮（提示文字放在悬停 tooltip 里）
function cardBtnsHtml(a){
  const g=(key,title,hint,body)=>'<div class="brow" data-g="'+key+'"'+(hint?' title="'+title+' '+hint+'"':'')+'>'+body+'</div>';
  // —— 按功能与关联分成 6 组：挂机·自动 / 战斗 / 移动·朝向 / 家·传送 / 运行控制 / 账号 ——
  // 输入框跟用它的按钮放同一行：瓶子↔分钟、攻击↔tick、跟随去↔玩家名、俯视↔角度、家传送↔家名、箱子↔物品数量
  const auto='<button class="sm '+(a.antiAfk?'on':'')+'" data-act="afk" data-arg="'+(a.antiAfk?'off':'on')+'">防AFK：'+(a.antiAfk?'运行':'暂停')+'</button>'+
    '<button class="sm '+(a.autoEat?'on':'')+'" data-act="eat" data-arg="'+(a.autoEat?'off':'on')+'">进食：'+(a.autoEat?'开':'关')+'</button>'+
    '<button class="sm '+(a.bottle?'on':'')+'" data-act="bottle-on">瓶子：'+(a.bottle?'运行':'开')+'</button>'+
    '<button class="sm" data-act="bottle-off">瓶子关</button>'+
    '<input class="inp bmin" placeholder="瓶(分钟)" style="flex:0 0 96px" title="点「瓶子：开」时用这个分钟数（灾厄之瓶持续时间）">';
  const combat='<button class="sm '+(a.attack?'on':'')+'" data-act="attack-on">攻击：'+(a.attack?('运行'+a.attackTicks+'t'):'开')+'</button>'+
    '<button class="sm" data-act="attack-off">攻击关</button>'+
    '<input class="inp atk-t" placeholder="攻击(tick)" style="flex:0 0 104px" title="点「攻击：开」时用这个间隔 tick">';
  const move='<input class="inp player" placeholder="玩家名" style="flex:2" title="「跟随」「去」用这个玩家名">'+
    '<button data-act="follow">跟随</button><button data-act="goto">去</button>';
  const orient='<button data-act="turn-left">左转</button><button data-act="turn-right">右转</button>'+
    '<button data-act="look-down" title="朝这个角度低头：正数向下看（如 30），负数向上看，0 = 平视；留空 = 30°">俯视</button>'+
    '<input class="inp look-deg" placeholder="俯视角度(默认30，可填负数)" style="flex:1">';
  const home='<button data-act="home">回家</button><button data-act="sethome">设家</button><button data-act="delhome">删家</button>'+
    '<input class="inp home" placeholder="家名(默认1)" style="flex:1" title="留空就发 1：sethome 1 / home 1 / delhome 1">';
  // 箱子：存箱（按规则）/ 存箱全部 / 取物（物品名与数量在旁边输入框）/ 开箱看看
  const chest = a.chestConfigured
    ? '<button data-act="deposit" title="走到仓库点，按配置 chest.deposit 名单存箱">存箱</button>'+
      '<button data-act="deposit" data-arg="all" title="除 chest.keep 保留名单外，全部存进箱子">全部存</button>'+
      '<button data-act="withdraw" title="从箱子取出「物品」框里的东西（可写中文，如 铁锭 / 钻石），数量看「数量」框（留空=尽量取）">取物</button>'+
      '<button data-act="peekchest" title="只走过去打开箱子看看里面有什么">开箱看看</button>'+
      '<input class="inp chest-item" placeholder="取物：物品名(如 铁锭 / 钻石 / iron_ingot)" style="flex:2">'+
      '<input class="inp chest-count" placeholder="数量(留空=尽量取)" style="flex:0 0 150px">'
    : '<span style="font-size:12px;color:#8a94a6;">未配置仓库点：请在 config 里填 chest.station 坐标（或用 chest.stationAlias 走回家）后重启</span>';
  const run='<button data-act="stop">停止</button><button data-act="reconnect">重连</button>'+
    '<button class="sm '+(a.enabled===false?'':'on')+'" data-act="'+(a.enabled===false?'enable-bot':'disable-bot')+'" title="停用 = 断开且不再自动重连；同名账号加在两台服务器时，用它切换留哪个在线">'+(a.enabled===false?'启用':'停用')+'</button>'+
    '<button data-act="shutdown" class="danger">下线</button>';
  const account='<select class="authsel"><option value="offline"'+(a.auth==='offline'?' selected':'')+'>离线</option><option value="microsoft"'+(a.auth==='microsoft'?' selected':'')+'>正版</option></select>'+
    '<button class="sm danger" data-act="clear">清空</button>'+
    '<button class="sm danger" data-act="remove-bot">删除</button>';
  return g('auto','挂机 · 自动','（瓶子分钟数填在行内输入框）',auto)+
    g('combat','战斗','（攻击间隔 tick 填在行内输入框）',combat)+
    g('move','跟随 / 去','（玩家名填在行内输入框）',move)+
    g('orient','转向 / 俯视','（俯视角度填在行内输入框）',orient)+
    g('home','家 / 传送','（家名填在行内输入框，留空=1）',home)+
    g('chest','箱子 / 仓库','（取物物品名+数量填在行内输入框；需先配 chest.station）',chest)+
    g('run','运行控制','',run)+
    g('account','账号','',account);
}
// 功能项只有状态真变了才重建，避免每 3 秒重画按钮/下拉而打断你正在进行的操作
function cardBtnsSig(a){ return JSON.stringify([a.antiAfk,a.autoEat,a.bottle,a.attack,a.attackTicks,a.auth,a.enabled,a.chestConfigured]); }
// 背包 / 装备栏 / 副手渲染：a.inv 由 BotContext._invSnapshot 生成
// main=槽 0-35（0-8 快捷栏、9-35 背包）、armor=[头,胸,腿,靴]、off=副手；离线为 null
function invHtml(inv){
  if(!inv||!Array.isArray(inv.main)) return '<div class="inv-none">背包数据不可用（离线或未进入世界）</div>';
  const cell=(it,ph)=>it
    ?'<div class="inv-cell" title="'+escapeHtml(it.n)+' x'+it.c+'"><span class="inv-nm">'+escapeHtml(it.n)+'</span>'+(it.c>1?'<span class="inv-ct">'+it.c+'</span>':'')+'</div>'
    :'<div class="inv-cell inv-empty"'+(ph?' title="'+escapeHtml(ph)+'（空）"':'')+'>'+(ph?'<span class="inv-ph">'+escapeHtml(ph)+'</span>':'')+'</div>';
  const hot=inv.main.slice(0,9).map((it,i)=>cell(it,String(i+1))).join('');
  const bag=inv.main.slice(9).map(it=>cell(it,'')).join('');
  const an=['头盔','胸甲','护腿','靴子'];
  const armor=(inv.armor||[]).map((it,i)=>cell(it,an[i])).join('');
  const off=cell(inv.off||null,'副手');
  return '<div class="inv-t">快捷栏</div><div class="inv-grid">'+hot+'</div>'+
    '<div class="inv-t">背包</div><div class="inv-grid">'+bag+'</div>'+
    '<div class="inv-eq"><div><div class="inv-t">装备</div><div class="inv-grid">'+armor+'</div></div>'+
    '<div><div class="inv-t">副手</div><div class="inv-grid">'+off+'</div></div></div>';
}
function updateCard(card,a){
  const badge=card.querySelector('.badge');
  const off=a.enabled===false;
  badge.className='badge '+(off?'st-stopped':'st-'+a.status);
  badge.textContent=off?'已停用':(STATUS_CN[a.status]||a.status);
  // 当前连的服务器：只显示你填的地址，没单独填端口就不补 :25565
  card.querySelector('.srv-cur').textContent='服务器 '+(a.serverHost?(a.serverHost+(a.serverPort?':'+a.serverPort:'')):'-');
  // 红框：TPS（服务器世界时间估算，拿不到显示 -）+ Ping（本连接延迟）
  const tpsEl=card.querySelector('.metrics .tps'), pingEl=card.querySelector('.metrics .ping');
  const cls=(v,ok,warn)=>v==null?'mt-unknown':(v>=ok?'mt-ok':(v>=warn?'mt-warn':'mt-bad'));
  tpsEl.className='tps '+cls(a.tps,19,15);
  tpsEl.textContent='TPS '+(a.tps==null?'-':a.tps.toFixed(1));
  tpsEl.title='服务器 TPS：用服务器世界时间（tick）在 10 秒滑动窗口里估算；服务器卡住会如实变低';
  const pOk=a.ping!=null&&a.ping<100, pWarn=a.ping!=null&&a.ping<200;
  pingEl.className='ping '+(a.ping==null?'mt-unknown':(pOk?'mt-ok':(pWarn?'mt-warn':'mt-bad')));
  pingEl.textContent='Ping '+(a.ping==null?'-':a.ping+'ms');
  pingEl.title='本连接的服务器延迟（服务器广播的 player_info latency，和游戏里 TAB 看到的 Ping 一致）';
  card.querySelector('.info').innerHTML=cardInfoHtml(a);
  // 背包/装备/副手：内容没变就不重画，避免 3 秒轮询时闪烁
  const invEl=card.querySelector('.inv'), isig=JSON.stringify(a.inv||null);
  if(invEl.dataset.sig!==isig){ invEl.innerHTML=invHtml(a.inv); invEl.dataset.sig=isig; }
  const btns=card.querySelector('.btns'), sig=cardBtnsSig(a);
  if(btns.dataset.sig!==sig){
    // 重画前记住组里输入框/下拉的值，重画后还原：否则每 3 秒会把你正在填的内容冲掉
    const vals={};
    btns.querySelectorAll('input.inp,select.authsel').forEach(el=>{
      const k=(el.classList.length>1?el.classList[1]:el.classList[0]); vals[k]=el.value;
    });
    btns.innerHTML=cardBtnsHtml(a);
    Object.keys(vals).forEach(k=>{
      const el=btns.querySelector('.'+k);
      if(el) el.value=vals[k];
    });
    btns.dataset.sig=sig;
  }
}
// 逐张卡片就地更新：已有卡片不重建，已删掉的账号才移除
// 卡片按“账号@服务器:端口”区分：同一个账号挂到两台服时会出现两张卡片，互不干扰
// 账号分页：每个账号单独一页（顶部页签切换），一次只显示一张卡片，记住上次停留的页
let curPage = localStorage.getItem('botpage') || null;
function renderTabs (accounts) {
  const tabs = document.getElementById('tabs');
  const sig = accounts.map(a => a.key || a.username).join(',');
  if (tabs.dataset.sig === sig) return;
  tabs.dataset.sig = sig;
  tabs.innerHTML = accounts.map(a => {
    const k = a.key || a.username;
    return '<button class="tab" data-key="' + escapeHtml(k) + '">' + escapeHtml(a.username) +
      (a.serverHost ? ' <span class="srv-tag">@' + escapeHtml(a.serverHost) + '</span>' : '') + '</button>';
  }).join('');
}
function applyPages () {
  document.querySelectorAll('#cards .card').forEach(c => {
    c.style.display = (curPage == null || c.dataset.key === curPage) ? '' : 'none';
  });
  document.querySelectorAll('#tabs .tab').forEach(t => {
    t.classList.toggle('on', t.dataset.key === curPage);
  });
}
document.getElementById('tabs').addEventListener('click', e => {
  const t = e.target.closest('.tab'); if (!t) return;
  curPage = t.dataset.key;
  try { localStorage.setItem('botpage', curPage); } catch (_) { /* 隐私模式等场景忽略 */ }
  applyPages();
});
function render(d){
  const box=document.getElementById('cards'), accounts=d.accounts||[];
  const exist={};
  [...box.children].forEach(c=>{ exist[c.dataset.key]=c; });
  const live={};
  accounts.forEach(a=>{
    const k=a.key||a.username;
    let card=exist[k];
    if(!card){
      const tmp=document.createElement('div');
      tmp.innerHTML=buildCard(a);
      card=tmp.firstElementChild;
      box.appendChild(card);
    }
    live[k]=true;
    updateCard(card,a);
  });
  [...box.children].forEach(c=>{ if(!live[c.dataset.key]) c.remove(); });
  // 分页：账号列表变化时重建页签；当前页不存在了就回落到第一页
  renderTabs(accounts);
  const keys=accounts.map(a=>a.key||a.username);
  if(curPage==null||!keys.includes(curPage)) curPage=keys[0]||null;
  applyPages();
}
document.getElementById('cards').addEventListener('click',async e=>{
  const btn=e.target.closest('button[data-act]'); if(!btn) return;
  const card=btn.closest('.card'), name=card.dataset.key||card.dataset.name, act=btn.dataset.act;
  // 俯视：角度取卡片上的「俯视角度」输入框（留空 = 默认 30°）
  if(act==='look-down'){
    const d=(card.querySelector('.look-deg').value||'').trim();
    post(name,act,[d]);
    return;
  }
  if(act==='afk'){ post(name,'afk',[btn.dataset.arg]); return; }
  if(act==='eat'){ post(name,'eat',[btn.dataset.arg]); return; }
  if(act==='bottle-off'){ post(name,'bottle',['off']); return; }
  if(act==='bottle-on'){
    let m=card.querySelector('.bmin').value.trim();
    if(!m) m='30';
    post(name,'bottle',['on',m]);
    return;
  }
  if(act==='attack-off'){ post(name,'attack',['off']); return; }
  if(act==='attack-on'){
    let t=card.querySelector('.atk-t').value.trim();
    if(!t) t='20';
    post(name,'attack',[t]);
    return;
  }
  if(act==='clear'){
    if(window.confirm('确定清空 '+name+' 的全部物品（含盔甲/副手）？物品会全部丢出且难以找回。')) post(name,'clear');
    return;
  }
  // 存箱（按规则 / 全部）、开箱看看
  if(act==='deposit'){ post(name,'deposit',[btn.dataset.arg||'']); return; }
  if(act==='peekchest'){ post(name,'peekchest'); return; }
  // 取物：物品名必填，数量留空 = 尽量取
  if(act==='withdraw'){
    const it=(card.querySelector('.chest-item').value||'').trim();
    const ct=(card.querySelector('.chest-count').value||'').trim();
    if(!it){ log('<span class="log-err">请先填要取的物品名（如 iron_ingot）</span>'); return; }
    post(name,'withdraw',[it,ct]);
    return;
  }
  if(act==='remove-bot'){
    if(window.confirm('确定删除机器人 '+name+' ？会立即停止并移除它。')) post(name,'remove-bot',[name]);
    return;
  }
  if(act==='set-srv'){
    const hEl=card.querySelector('.srv-h'), pEl=card.querySelector('.srv-p');
    const sh=hEl.value.trim(), sp=pEl.value.trim();
    if(!sh){ log('<span class="log-err">请填写该账号的服务器IP</span>'); return; }
    const j=await post(name,'set-account-server',[name,sh,sp]);
    // 应用成功后清空：这两个框只在你要改服务器时才填，平时保持空白
    // （失败时保留你填的内容，方便改完再试）
    if(j && j.result && j.result.ok!==false){ hEl.value=''; pEl.value=''; }
    return;
  }
  const player=card.querySelector('.player').value.trim();
  const home=card.querySelector('.home').value.trim();
  if((act==='follow'||act==='goto')&&!player){ log('<span class="log-err">请先填玩家名</span>'); return; }
  if(act==='follow'||act==='goto') post(name,act,[player]);
  else if(act==='home'||act==='sethome'||act==='delhome') post(name,act,home?[home]:[]);
  else post(name,act);
});
// 卡片内“登录方式”下拉切换：改登录方式并立即重连生效
document.getElementById('cards').addEventListener('change',e=>{
  const sel=e.target.closest('select.authsel'); if(!sel) return;
  const card=sel.closest('.card'), name=card.dataset.key||card.dataset.name;
  post(name,'set-auth',[name,sel.value]);
});

// 顶部“默认服务器”的 IP/端口框：默认和刷新时都不回填，只有你自己填了才会用；
// 应用成功后会清空，所以平时看到的就是空白占位提示
async function refresh(){
  const d=await apiStatus();
  render(d);
  // 控制台账号下拉：按“账号@服:端口”列出（同名账号不同服时能分开选），列表没变就不重建
  const sel=document.getElementById('target');
  const keyed=(d.accounts||[]).map(a=>({v:a.key||a.username,t:a.username+(a.serverHost?' @'+a.serverHost+(a.serverPort?':'+a.serverPort:''):'')}));
  const names=keyed.map(x=>x.v).join(',');
  if(sel.dataset.names!==names){
    const cur=sel.value;
    sel.innerHTML='<option value="all">全部账号</option>'+keyed.map(x=>'<option value="'+x.v+'">'+x.t+'</option>').join('');
    if([...sel.options].some(o=>o.value===cur)) sel.value=cur;
    sel.dataset.names=names;
  }
  wlRender(d);
}
refresh();
setInterval(refresh,3000);

// ---- 聊天统一拉取并分流 ----
//   chat / system（公屏聊天、系统广播）→ “服务器公屏”窗口
//   cmd-in（玩家指令：私聊/公屏）/ cmd-out（机器人回复）→ “控制台日志”窗口
let chatLast=0, pubAuto=true;
function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function appendPublic(box,m){
  const div=document.createElement('div');
  if(m.type==='chat'){
    div.innerHTML='<span class="pub-time">'+m.clock+'</span> <span class="pub-user">&lt;'+escapeHtml(m.username)+'&gt;</span> '+escapeHtml(m.message);
  }else{
    div.innerHTML='<span class="pub-time">'+m.clock+'</span> <span class="pub-sys">'+escapeHtml(m.message)+'</span>';
  }
  box.appendChild(div);
}
async function chatRefresh(){
  try{
    const r=await fetch('/api/chat?since='+chatLast), j=await r.json(), box=document.getElementById('pub-body');
    let pubCount=0;
    j.messages.forEach(m=>{
      chatLast=m.id;
      if(m.type==='cmd-in'){
        const ch=m.pub?'公屏':'私聊';
        log('<span class="pub-user">'+escapeHtml(m.username)+' '+ch+(m.pub?'':' '+escapeHtml(m.to||''))+' &gt;</span> '+escapeHtml(m.message));
      }else if(m.type==='cmd-out'){
        // （私聊）/（公屏）标注：一眼看出这条回复在游戏里走的是哪条路
        const via=m.via==='chat'?'（公屏）':(m.via==='whisper'?('（私聊'+(m.form?('：'+String(m.form).split(' ')[0]):'')+'）'):'');
        log('<span class="log-ok">'+escapeHtml(m.username)+' 回复 '+escapeHtml(m.to||'')+via+' &gt;</span> '+escapeHtml(m.message));
      }else{ appendPublic(box,m); pubCount++; }
    });
    if(pubCount){
      while(box.childNodes.length>300) box.removeChild(box.firstChild);
      if(pubAuto) box.scrollTop=box.scrollHeight;
    }
  }catch(e){ /* 单次失败不影响后续 */ }
}
document.getElementById('pub-pause').onclick=function(){ pubAuto=!pubAuto; this.textContent=pubAuto?'暂停滚动':'继续滚动'; };
document.getElementById('pub-clear').onclick=function(){ document.getElementById('pub-body').innerHTML=''; };

// ---- 控制台日志「刷新」：只重画这一栏，不刷新整页、不动机器人 ----
// 做两件事：①补拉一遍服务器消息里属于日志的部分（cmd-in / cmd-out），
//          避免有日志因为轮询中断而漏掉；
//          ②按 logHistory 重画整栏（时间戳与顺序以本地记录为准）。
// 注意：不重置 chatLast。chatLast 是"公屏窗口"的游标，重置会让公屏把旧消息重放一遍。
let logRefreshing=false;
document.getElementById('log-refresh').onclick=async function(){
  const btn=this;
  if(logRefreshing) return;
  logRefreshing=true;
  btn.disabled=true;
  const 原文=btn.textContent;
  btn.textContent='刷新中…';
  try{
    // ① 补拉：用 since=0 取回最近 200 条，只挑属于控制台日志的两类补进记录。
    //    用内容+时间去重，避免和已记录的重复。
    const r=await fetch('/api/chat?since=0');
    const j=await r.json();
    const 已有=new Set(logHistory.map(x=>x.html));
    let 补了=0;
    (j.messages||[]).forEach(m=>{
      let html=null;
      if(m.type==='cmd-in'){
        const ch=m.pub?'公屏':'私聊';
        html='<span class="pub-user">'+escapeHtml(m.username)+' '+ch+(m.pub?'':' '+escapeHtml(m.to||''))+' &gt;</span> '+escapeHtml(m.message);
      }else if(m.type==='cmd-out'){
        const via=m.via==='chat'?'（公屏）':(m.via==='whisper'?('（私聊'+(m.form?('：'+String(m.form).split(' ')[0]):'')+'）'):'');
        html='<span class="log-ok">'+escapeHtml(m.username)+' 回复 '+escapeHtml(m.to||'')+via+' &gt;</span> '+escapeHtml(m.message);
      }
      if(html && !已有.has(html)){
        logHistory.push({ time: m.clock || '', html });
        已有.add(html);
        补了++;
      }
    });
    if(logHistory.length>LOG_MAX) logHistory.splice(0, logHistory.length-LOG_MAX);
    // ② 重画
    renderLog();
    const box=document.getElementById('log');
    box.scrollTop=0; // 最新的在最上面
    log('<span class="log-ok">[日志] 已刷新</span>'+(补了?('（补回 '+补了+' 条）'):''));
  }catch(e){
    log('<span class="log-err">[日志] 刷新失败：'+escapeHtml(e.message)+'</span>');
  }finally{
    btn.textContent=原文;
    btn.disabled=false;
    logRefreshing=false;
  }
};
chatRefresh();
setInterval(chatRefresh,1500);
</script>
</body></html>`
  }

  stop () {
    if (this.server) this.server.close()
    this.ready = false
  }
}

module.exports = { WebDashboard }
