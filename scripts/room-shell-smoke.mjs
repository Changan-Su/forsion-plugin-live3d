// 3D 小屋的插件壳冒烟(只起 chromium,不碰 Electron):宿主同款 CSP 的页面里 new Function('ctx', main.js),
// 挂满屏的 room 视图,库 = --vault 指向的真笔记库(**只读**:插件写的文件只进服务器内存,不落盘)。
// 走一遍:进门(住客加载)→ Agent 思考(去书桌)→ 说话 → 回 idle → 切白天 → 手动启动屏保 → 按键退出。每步一张截图。
//
// 用法:node scripts/room-shell-smoke.mjs --vault <笔记库根> [--scene <scenes 下的文件夹名>] [--out <截图目录>] [--size 1280x800]
//   不给 --vault = 空库(内置小屋 + 小球)。场景里 character 指的模型要在这个库的 Live3D/models/ 下。
// 断言:无 pageerror / console.error;HUD 出现「他在干什么」;思考阶段 HUD 换成书桌上的活动;屏保层盖上又撤掉;
//       叫醒屏保的按键没有漏到页面上。
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GENESIS_DESKTOP = join(ROOT, '..', '..', 'Forsion-Genesis', 'desktop')
const args = process.argv.slice(2)
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : d
}
const VAULT = opt('vault', null)
const SCENE = opt('scene', null)
const OUT = opt('out', join(process.env.LIVE3D_SCRATCH || join(tmpdir(), 'live3d-smoke'), 'room-shell'))
const [VW, VH] = opt('size', '1280x800').split('x').map(Number)
mkdirSync(OUT, { recursive: true })

const HOST_CSP = readFileSync(join(GENESIS_DESKTOP, 'frontend', 'index.html'), 'utf8').match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)[1]
const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${HOST_CSP}" />
<style>
  :root { --accent:#7c6cf0; --on-accent:#fff; --text:#1f1f24; --text-muted:#5d5d66; --text-faint:#8b8b94; --border:rgba(0,0,0,.1);
          --bg:#f7f6f3; --bg-card:#ffffff; --font-ui:system-ui, -apple-system, "PingFang SC", sans-serif; }
  html,body { margin:0; height:100%; background:var(--bg); font-family:var(--font-ui); }
  #view { position:fixed; inset:0; }
  #typed { position:fixed; left:-9999px; }
</style></head><body><div id="view"></div><input id="typed"><script src="/harness.js"></script></body></html>`

const HARNESS = `
(() => {
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/')
  const H = window.__h = { views: [], commands: [], settings: [], notices: [], statusSubs: new Set(), data: ${JSON.stringify(SCENE ? { mode: 'idle', active: null, pending: {}, scene: SCENE } : null)},
    status: { phase: 'idle', sessionId: 's1', runId: null, since: 0, textChars: 0, reasoningChars: 0 } }
  const get = async (p) => { const r = await fetch('/vault/' + enc(p)); return r.ok ? new Uint8Array(await r.arrayBuffer()) : null }
  H.ctx = {
    app: {
      notify: (m) => H.notices.push(m),
      workFolder: () => 'Live3D',
      vaultRoot: () => '/vault',
      assetUrl: (p) => location.origin + '/vault/' + enc(p),
      readFile: async (p) => { const b = await get(p); return b ? new TextDecoder().decode(b) : null },
      writeFile: async (p, t) => { await fetch('/vault/' + enc(p), { method: 'PUT', body: t }) },
      readBytes: get,
      listFiles: () => fetch('/list').then((r) => r.json()),
      watchFile: () => () => {},
      reveal: () => {},
    },
    registerCommand: (c) => H.commands.push(c),
    registerSetting() {},
    registerView: (v) => H.views.push(v),
    openView: () => {},
    registerSettingsView: (v) => H.settings.push(v),
    notify: (m) => H.notices.push(m),
    getLocale: () => 'zh',
    subscribeLocale: () => () => {},
    loadData: async () => H.data,
    saveData: async (v) => { H.data = JSON.parse(JSON.stringify(v)) },
    tangu: {
      activeModel: () => null, models: () => [], activeSpace: () => 'live3d', subscribe: () => () => {}, agents: () => [],
      agentStatus: () => H.status,
      subscribeAgentStatus: (cb) => { H.statusSubs.add(cb); return () => H.statusSubs.delete(cb) },
    },
  }
  H.setPhase = (phase) => {
    H.status = { ...H.status, phase, since: Date.now(), messageId: 'm' + Date.now() }
    for (const cb of H.statusSubs) cb(H.status)
  }
  H.talk = () => { H.status = { ...H.status, textChars: H.status.textChars + 9 } }
  H.load = async () => {
    const code = await (await fetch('/main.js')).text()
    H.dispose = new Function('ctx', code)(H.ctx)
    await new Promise((r) => setTimeout(r, 50))
    H.unmount = H.views.find((v) => v.id === 'room').mount(document.getElementById('view'))
  }
  H.hud = () => ({ name: document.querySelector('[data-part="name"]')?.textContent, doing: document.querySelector('[data-part="doing"]')?.textContent,
    notes: document.querySelector('[data-part="notes"]')?.textContent, saver: !!document.querySelector('.l3-saver') })
  H.click = (sel) => document.querySelector(sel).click()
})()
`

const mem = new Map() // 插件写的文件只进内存(不碰真库)
const listVault = () => {
  const out = [...mem.keys()]
  if (!VAULT) return out
  const base = join(VAULT, 'Live3D')
  const walk = (d, pre) => {
    if (!existsSync(d)) return
    for (const n of readdirSync(d)) {
      const f = join(d, n)
      const r = `${pre}/${n}`
      if (statSync(f).isDirectory()) walk(f, r)
      else out.push(r)
    }
  }
  walk(base, 'Live3D')
  return [...new Set(out)]
}
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const send = (code, body, type = 'text/plain') => { res.writeHead(code, { 'content-type': type }); res.end(body) }
  if (url.pathname === '/') return send(200, PAGE, 'text/html')
  if (url.pathname === '/harness.js') return send(200, HARNESS, 'text/javascript')
  if (url.pathname === '/main.js') return send(200, readFileSync(join(ROOT, 'main.js')), 'text/javascript')
  if (url.pathname === '/list') return send(200, JSON.stringify(listVault()), 'application/json')
  if (url.pathname.startsWith('/vault/')) {
    const rel = decodeURIComponent(url.pathname.slice(7))
    if (rel.split('/').includes('..')) return send(403, 'no')
    if (req.method === 'PUT') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => { mem.set(rel, Buffer.concat(chunks)); send(200, 'ok') })
      return
    }
    if (mem.has(rel)) return send(200, mem.get(rel))
    const f = VAULT ? join(VAULT, rel) : null
    if (!f || !existsSync(f) || !statSync(f).isFile()) return send(404, 'not found')
    return send(200, readFileSync(f), extname(f) === '.json' ? 'application/json' : 'application/octet-stream')
  }
  send(404, 'not found')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))

const require = createRequire(import.meta.url)
const { chromium } = require(join(GENESIS_DESKTOP, 'node_modules', 'playwright-core'))
const exe = (() => {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = join(homedir(), 'Library/Caches/ms-playwright')
  for (const d of readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = join(root, d, 'chrome-mac-arm64', app)
      if (existsSync(p)) return p
    }
  }
  throw new Error('chromium not found; set CHROMIUM_EXE')
})()

let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] })
try {
  const pg = await browser.newPage({ viewport: { width: VW, height: VH }, locale: 'zh-CN' })
  const errors = []
  pg.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  pg.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console.error: ${m.text().slice(0, 240)}`) })
  await pg.goto(`http://127.0.0.1:${server.address().port}/`)
  await pg.evaluate(() => window.__h.load())
  const hud = () => pg.evaluate(() => window.__h.hud())
  const shot = (n) => pg.screenshot({ path: join(OUT, `${n}.png`) })
  // 进门:等住客加载完、HUD 出现「他在干什么」
  let h
  for (let i = 0; i < 120; i++) {
    h = await hud()
    if (h.doing && !/进门/.test(h.doing)) break
    await pg.waitForTimeout(500)
  }
  check('进门:HUD 显示场景名与「他在干什么」', !!h.name && !!h.doing && !/进门/.test(h.doing), JSON.stringify(h))
  check('没有加载失败 / 场景问题提示', !/失败|问题/.test(h.notes ?? ''), h.notes ?? '')
  await pg.waitForTimeout(6000)
  await shot('1-arrive')
  // Agent 思考 → 去书桌
  await pg.evaluate(() => window.__h.setPhase('thinking'))
  let thinking = ''
  for (let i = 0; i < 60; i++) {
    thinking = (await hud()).doing ?? ''
    if (/托着腮|thinking|Thinking/.test(thinking)) break
    await pg.waitForTimeout(500)
  }
  check('Agent 思考:走到书桌前托腮', /托着腮/.test(thinking), thinking)
  await pg.waitForTimeout(2500)
  await shot('2-thinking')
  await pg.evaluate(() => window.__h.setPhase('tool'))
  await pg.waitForTimeout(2500)
  const tool = (await hud()).doing ?? ''
  check('思考 → 调工具:同一张书桌原地换成干活', /干活/.test(tool), tool)
  await shot('3-tool')
  await pg.evaluate(() => window.__h.setPhase('speaking'))
  for (let i = 0; i < 12; i++) {
    await pg.evaluate(() => window.__h.talk())
    await pg.waitForTimeout(250)
  }
  await shot('4-speaking')
  await pg.evaluate(() => window.__h.setPhase('idle'))
  await pg.waitForTimeout(4000)
  // 切白天
  await pg.evaluate(() => window.__h.click('[data-act="time"][data-v="day"]'))
  await pg.waitForTimeout(3000)
  await shot('5-day')
  // 屏保:手动启动(页面里 evaluate 不是用户手势 → 全屏会被拒 → 铺满窗口,这正是空闲自启的样子)
  await pg.evaluate(() => window.__h.commands.find((c) => c.id === 'live3d-screensaver').run())
  await pg.waitForTimeout(3500)
  check('屏保:盖上一层', (await hud()).saver)
  await shot('6-screensaver')
  await pg.focus('#typed')
  await pg.keyboard.press('KeyA')
  await pg.waitForTimeout(600)
  check('屏保:按键退出', !(await hud()).saver)
  const typed = await pg.evaluate(() => document.getElementById('typed').value)
  check('叫醒屏保的键没漏进输入框', typed === '', JSON.stringify(typed))
  await pg.waitForTimeout(1500)
  await shot('7-back')
  await pg.evaluate(() => { window.__h.unmount(); window.__h.dispose() })
  check('页面无报错', errors.length === 0, errors.slice(0, 4).join(' | '))
} finally {
  await browser.close()
  server.close()
}
console.log(failures ? `\n${failures} 项失败` : '\n全部通过')
process.exit(failures)
