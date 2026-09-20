// Live3D 插件壳的真 Chromium 冒烟(只起 chromium,不碰 Electron):
// 宿主同款 CSP 的页面里 new Function('ctx', main.js)(假宿主 ctx),库 = 本机临时目录(HTTP GET/PUT)。
// 覆盖:伴随面卡片 / 侧板挂载与画布搬家、设置面、模型库视图、真文件选择器(Playwright filechooser)的直接导入、
// VRM + .vrma、Agent 协助导入 → 模拟 agent 写 live3d.json → 轮询载入、模式切换、切语言、dispose 收干净。
// 用法:npm run smoke:shell   (LIVE3D_SCRATCH / LIVE3D_SAMPLES / LIVE3D_SHOTS 与 render-smoke.mjs 同口径;需要 RobotExpressive.glb、
// three-vrm-girl.vrm、test.vrma、Soldier.glb 四个样例)
// 假宿主的 listFiles 与真宿主 pluginStore.listCached 同口径(single-flight + 1.5s 短缓存,旧宿主写文件不清缓存)——
// 「导入完马上重扫拿到复制前的清单」只有这样才测得到。
// 负对照:LIVE3D_MAIN=<旧 main.js> npm run smoke:shell —— 新加的断言(导入后模型库立刻看得见 / 藏起来的卡片不抢画布)必须红。
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MAIN = process.env.LIVE3D_MAIN || join(ROOT, 'main.js')
const GENESIS_DESKTOP = join(ROOT, '..', '..', 'Forsion-Genesis', 'desktop') // 同 render-smoke.mjs:playwright-core 与宿主 CSP 从这里取
const SCRATCH = process.env.LIVE3D_SCRATCH || join(tmpdir(), 'live3d-smoke')
// 样例与 render-smoke.mjs 共用(缺哪个先跑一次 render-smoke,它会按 SOURCES 下载)
const SAMPLES = process.env.LIVE3D_SAMPLES || join(SCRATCH, 'samples')
const SHOTS = process.env.LIVE3D_SHOTS || join(SCRATCH, 'shell-shots')
const VAULT = join(tmpdir(), `live3d-shell-vault-${process.pid}`)
rmSync(VAULT, { recursive: true, force: true })
mkdirSync(VAULT, { recursive: true })
mkdirSync(SHOTS, { recursive: true })

for (const f of ['RobotExpressive.glb', 'three-vrm-girl.vrm', 'test.vrma', 'Soldier.glb']) {
  if (!existsSync(join(SAMPLES, f))) { console.error(`missing sample ${join(SAMPLES, f)} — run scripts/render-smoke.mjs once (it downloads them), or set LIVE3D_SAMPLES`); process.exit(2) }
}

const hostHtml = readFileSync(join(GENESIS_DESKTOP, 'frontend', 'index.html'), 'utf8')
const HOST_CSP = hostHtml.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)[1]

const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${HOST_CSP}" />
<style>
  :root { --accent:#7c6cf0; --accent-ink:#fff; --text:#1f1f24; --text-muted:#5d5d66; --text-faint:#8b8b94; --border:rgba(0,0,0,.1);
          --bg:#f7f6f3; --bg-card:#ffffff; --radius-sm:8px; --radius-md:10px; --radius-lg:16px; --danger:#d64545; --font-ui:system-ui, -apple-system, "PingFang SC", sans-serif; }
  html,body { margin:0; background:var(--bg); font-family:var(--font-ui); }
  .row { display:flex; gap:20px; padding:16px; align-items:flex-start; }
  /* 仿 Desk 卡片:280×394,正文 zoom:0.75 + pointer-events:none;挂载点 = 宿主 DeskCompanionHost 的内联样式 */
  .card, .hcard { width:280px; height:394px; border-radius:20px; overflow:hidden; background:var(--bg-card); border:1px solid var(--border); display:flex; flex-direction:column; }
  .card-head { height:34px; flex:0 0 34px; border-bottom:1px solid var(--border); font-size:12px; display:flex; align-items:center; padding:0 12px; color:var(--text-muted); }
  .card-body { flex:1; min-height:0; display:flex; flex-direction:column; pointer-events:none; zoom:0.75; }
  .panel { width:520px; height:640px; display:flex; flex-direction:column; background:var(--bg-card); border:1px solid var(--border); border-radius:14px; overflow:hidden; }
  .slot { position:relative; flex:1 1 0; min-height:0; min-width:0; overflow:hidden; }
  #settings { width:640px; padding:16px; background:var(--bg-card); border:1px solid var(--border); border-radius:12px; }
  #view { width:1100px; height:720px; margin:16px; border:1px solid var(--border); background:var(--bg); }
</style></head><body>
<div class="row">
  <div class="card"><div class="card-head">Agent Desk</div><div class="card-body"><div class="slot" id="cardSlot"></div></div></div>
  <div class="panel"><div class="card-head">Agent Desk (expanded)</div><div class="slot" id="panelSlot"></div></div>
  <!-- 被 CSS 藏起来的第二张卡片(窄栏 @container 下 display:none 的侧栏聊天):宿主照样会往里挂伴随面 -->
  <div id="hiddenWrap" style="display:none"><div class="hcard"><div class="card-head">Hidden Desk</div><div class="card-body"><div class="slot" id="hiddenSlot"></div></div></div></div>
</div>
<div class="row"><div id="settings"></div></div>
<div id="view"></div>
<script src="/harness.js"></script>
</body></html>`

// 页面里的假宿主(与 pluginStore / DeskCompanionHost 同形)
const HARNESS = `
(() => {
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/')
  const H = window.__h = { notices: [], chats: [], updates: [], reveals: [], commands: [], views: [], settings: [], companions: [], opened: [], data: null,
    locale: 'zh', localeSubs: new Set(), statusSubs: new Set(), watches: new Map(),
    roster: [{ slug: 'xyra', name: 'Xyra' }, { slug: 'other', name: 'Other' }],
    status: { phase: 'idle', sessionId: null, runId: null, since: 0, textChars: 0, reasoningChars: 0 } }
  const get = async (p) => { const r = await fetch('/vault/' + enc(p)); return r.ok ? new Uint8Array(await r.arrayBuffer()) : null }
  const put = async (p, b) => { const r = await fetch('/vault/' + enc(p), { method: 'PUT', body: b }); if (!r.ok) throw new Error('PUT failed ' + r.status) }
  H.ctx = {
    app: {
      notify: (m) => H.notices.push({ m, level: 'info' }),
      workFolder: () => 'Live3D',
      vaultRoot: () => '/Users/me/Vault',
      hostPath: (p) => '/Users/me/Vault/' + p,
      assetUrl: (p) => location.origin + '/vault/' + enc(p),
      readFile: async (p) => { const b = await get(p); return b ? new TextDecoder().decode(b) : null },
      writeFile: (p, t) => put(p, new TextEncoder().encode(t)),
      writeBytes: (p, b) => put(p, b instanceof Uint8Array ? b : new Uint8Array(b)),
      readBytes: get,
      // = pluginStore.listCached:并发合一次、1.5s 内复用(按调用**开始**时刻计),写文件不清缓存(旧宿主)
      listFiles: () => {
        if (H.listHit && Date.now() - H.listHit.at < 1500) return H.listHit.p
        const p = fetch('/list').then((r) => r.json()).then((xs) => xs.filter((p) => !p.endsWith('.md')))
        H.listHit = { at: Date.now(), p }
        return p
      },
      reveal: (p) => H.reveals.push(p),
      watchFile: (p, cb) => { H.watches.set(p, cb); return () => H.watches.delete(p) },
    },
    registerCommand: (c) => H.commands.push(c),
    registerSetting() {},
    registerView: (v) => H.views.push(v),
    openView: (id) => H.opened.push(id),
    registerSettingsView: (v) => H.settings.push(v),
    notify: (m, o) => H.notices.push({ m, level: (o && o.level) || 'info' }),
    getLocale: () => H.locale,
    subscribeLocale: (cb) => { H.localeSubs.add(cb); return () => H.localeSubs.delete(cb) },
    loadData: async () => H.data,
    saveData: async (v) => { H.data = JSON.parse(JSON.stringify(v)) },
    tangu: {
      activeModel: () => null, models: () => [], activeSpace: () => 'tangu', subscribe: () => () => {},
      agents: () => H.roster,
      agentStatus: () => H.status,
      subscribeAgentStatus: (cb) => { H.statusSubs.add(cb); return () => H.statusSubs.delete(cb) },
      startChat: async (o) => { H.chats.push(o); return { ok: true, sessionId: 's-import' } },
    },
    desk: { registerCompanion: (def) => { H.companions.push(def); return { update: (p) => H.updates.push(p), dispose: () => { H.companionDisposed = true } } } },
  }
  // 宿主 DeskCompanionHost:同一 (key, surface) 只 mount 一次;状态变了只推 onStatus
  const slots = new Map()
  H.mountSlot = (id, surface) => {
    const el = document.getElementById(id)
    const subs = new Set()
    const host = { surface, sessionId: () => null, status: () => H.status, onStatus: (cb) => { subs.add(cb); return () => subs.delete(cb) } }
    const off = H.companions[0].mount(el, host)
    slots.set(id, { el, subs, off })
  }
  H.unmountSlot = (id) => { const s = slots.get(id); if (!s) return; try { s.off && s.off() } finally { s.subs.clear(); s.el.replaceChildren(); slots.delete(id) } }
  H.setPhase = (phase) => {
    H.status = { ...H.status, phase, since: Date.now(), messageId: 'm1' }
    for (const s of slots.values()) for (const cb of s.subs) cb(H.status)
    for (const cb of H.statusSubs) cb(H.status)
  }
  H.talk = () => { H.status = { ...H.status, textChars: H.status.textChars + 7 } }
  // 换会话 = 换 Agent:宿主只在 statusKey 变了时推一次(agentSlug 已在键里),这里照同一口径推
  H.setAgent = (agentSlug) => {
    H.status = { ...H.status, agentSlug: agentSlug || undefined, agentName: agentSlug ? agentSlug.toUpperCase() : undefined }
    for (const s of slots.values()) for (const cb of s.subs) cb(H.status)
    for (const cb of H.statusSubs) cb(H.status)
  }
  H.load = async () => {
    const code = await (await fetch('/main.js')).text()
    H.dispose = new Function('ctx', code)(H.ctx)
  }
})()
`

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const send = (code, body, type = 'text/plain') => { res.writeHead(code, { 'content-type': type }); res.end(body) }
  if (url.pathname === '/') return send(200, PAGE, 'text/html')
  if (url.pathname === '/harness.js') return send(200, HARNESS, 'text/javascript')
  if (url.pathname === '/main.js') return send(200, readFileSync(MAIN), 'text/javascript')
  if (url.pathname === '/list') {
    const out = []
    const walk = (d, pre) => { for (const n of readdirSync(d)) { const f = join(d, n); const r = pre ? `${pre}/${n}` : n; if (statSync(f).isDirectory()) walk(f, r); else out.push(r) } }
    walk(VAULT, '')
    return send(200, JSON.stringify(out), 'application/json')
  }
  if (url.pathname.startsWith('/vault/')) {
    const rel = decodeURIComponent(url.pathname.slice(7))
    if (rel.split('/').includes('..')) return send(403, 'no')
    const f = join(VAULT, rel)
    if (req.method === 'PUT') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, Buffer.concat(chunks)); send(200, 'ok') })
      return
    }
    if (!existsSync(f) || !statSync(f).isFile()) return send(404, 'not found')
    const types = { '.png': 'image/png', '.json': 'application/json', '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary' }
    return send(200, readFileSync(f), types[extname(f).toLowerCase()] || 'application/octet-stream')
  }
  send(404, 'nf')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const ORIGIN = `http://127.0.0.1:${server.address().port}`

// ── 小工具 ────────────────────────────────────────────────────────────────────
function decodePng(buf) {
  let off = 8, w = 0, h = 0, ct = 0
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8)
    if (type === 'IHDR') { w = buf.readUInt32BE(off + 8); h = buf.readUInt32BE(off + 12); ct = buf[off + 17] }
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len))
    off += 12 + len
  }
  const bpp = ct === 6 ? 4 : 3, stride = w * bpp
  const raw = inflateSync(Buffer.concat(idat)), px = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0
      let v = line[x]
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
      px[y * stride + x] = v & 255
    }
  }
  return { w, h, bpp, px }
}
/** 截图的颜色指纹:非背景像素按 4×4×4 粗量化后的分布。**换形象要用它而不是逐像素比对** ——
 *  小球会上下浮动,两帧之间逐像素能差 14%,量不出「是不是换了个人」;颜色分布对位移不敏感。
 *  (coverage 也不行:VRM girl 是白 T 恤配白卡片,「不是背景色」的占比和小球几乎一样,实测 0.219 vs 0.216。) */
function colorSig(buf) {
  const { w, h, bpp, px } = decodePng(buf)
  const bg = [px[(2 * w + Math.floor(w / 2)) * bpp], px[(2 * w + Math.floor(w / 2)) * bpp + 1], px[(2 * w + Math.floor(w / 2)) * bpp + 2]]
  const sig = new Float64Array(64)
  let n = 0
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    const o = (y * w + x) * bpp
    const r = px[o], g = px[o + 1], b = px[o + 2]
    if (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) <= 30) continue
    sig[(r >> 6) * 16 + (g >> 6) * 4 + (b >> 6)]++
    n++
  }
  if (n) for (let i = 0; i < sig.length; i++) sig[i] /= n
  return sig
}
/** 两枚颜色指纹的距离,0 = 一模一样,1 = 完全不重叠。 */
function sigDist(a, b) {
  let d = 0
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i])
  return d / 2
}
/** 画面里「不是背景色」的像素占比(背景 = 四角的平均色)。 */
function coverage(buf) {
  const { w, h, bpp, px } = decodePng(buf)
  const at = (x, y) => { const o = (y * w + x) * bpp; return [px[o], px[o + 1], px[o + 2]] }
  const bg = at(Math.floor(w / 2), 2)
  let n = 0
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) { const c = at(x, y); if (Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]) > 30) n++ }
  return n / ((w / 2) * (h / 2))
}
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(pg, fn, arg, ms = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (await pg.evaluate(fn, arg)) return true; await sleep(200) }
  return false
}

const require = createRequire(import.meta.url)
const { chromium } = require(join(GENESIS_DESKTOP, 'node_modules', 'playwright-core'))
function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  try { const p = chromium.executablePath(); if (p && existsSync(p)) return p } catch { /* */ }
  const root = join(homedir(), 'Library/Caches/ms-playwright')
  for (const d of readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = join(root, d, 'chrome-mac-arm64', app)
      if (existsSync(p)) return p
    }
  }
  throw new Error('chromium not found')
}

const browser = await chromium.launch({ executablePath: findChromium(), args: ['--use-angle=metal', '--ignore-gpu-blocklist'] })
const pg = await browser.newPage({ viewport: { width: 1200, height: 1900 }, deviceScaleFactor: 2, locale: 'zh-CN' })
const errors = []
pg.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
// 假库用 HTTP:readFile 查不存在的文件(轮询 live3d.json / README / 去重)会让 Chromium 记一条 404 —— 真宿主走 IPC,没有这条,滤掉
pg.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource: .*404/.test(m.text())) errors.push(`console.error: ${m.text().slice(0, 240)}`) })
const shot = async (sel, name) => { const b = await pg.locator(sel).screenshot({ path: join(SHOTS, `${name}.png`) }); return b }

try {
  await pg.goto(ORIGIN)
  await pg.evaluate(() => window.__h.load())
  await sleep(300)
  const reg = await pg.evaluate(() => ({ c: __h.companions.length, v: __h.views.map((v) => v.id), s: __h.settings.length, cmd: __h.commands.map((c) => c.id) }))
  check('main.js 在宿主 CSP 下装载:伴随面 / 视图 / 设置面 / 5 条命令', reg.c === 1 && reg.v[0] === 'studio' && reg.s === 1 && reg.cmd.length === 5, JSON.stringify(reg))

  // ── 伴随面:卡片 → 小球
  await pg.evaluate(() => __h.mountSlot('cardSlot', 'desk-card'))
  await sleep(900)
  const orbCard = await shot('.card', 'desk-card-orb')
  check('卡片挂载:画着小球(非空)', coverage(orbCard) > 0.05, `coverage ${coverage(orbCard).toFixed(3)}`)
  const canv1 = await pg.evaluate(() => ({ card: document.querySelectorAll('#cardSlot canvas').length, panel: document.querySelectorAll('#panelSlot canvas').length }))
  check('卡片里有且只有一块画布', canv1.card === 1 && canv1.panel === 0, JSON.stringify(canv1))
  const cardSize = await pg.evaluate(() => { const c = document.querySelector('#cardSlot canvas'); const r = c.getBoundingClientRect(); const s = document.querySelector('#cardSlot').getBoundingClientRect(); return { cw: c.width, ch: c.height, rw: r.width, rh: r.height, sw: s.width, sh: s.height, dpr: devicePixelRatio } })
  check('卡片 zoom:0.75 下画布撑满正文、绘图缓冲 = 视觉尺寸 × min(dpr,1.5)', Math.abs(cardSize.rw - cardSize.sw) < 2 && Math.abs(cardSize.cw - Math.round(cardSize.sw * 1.5)) <= 2, JSON.stringify(cardSize))

  // ── 展开侧板:画布搬家,卡片出占位;工具条在侧板
  await pg.evaluate(() => __h.mountSlot('panelSlot', 'desk-panel'))
  await sleep(700)
  const canv2 = await pg.evaluate(() => ({ card: document.querySelectorAll('#cardSlot canvas').length, panel: document.querySelectorAll('#panelSlot canvas').length, ph: document.querySelector('#cardSlot .l3-placeholder')?.textContent || '', tb: !!document.querySelector('#panelSlot .l3-toolbar select'), gl: document.querySelectorAll('canvas').length }))
  check('侧板挂上:画布搬到侧板(不新建上下文),卡片显示占位,侧板有工具条', canv2.card === 0 && canv2.panel === 1 && /另一个面板/.test(canv2.ph) && canv2.tb && canv2.gl === 1, JSON.stringify(canv2))
  const noDrag = await pg.evaluate(() => getComputedStyle(document.querySelector('.l3-toolbar')).getPropertyValue('-webkit-app-region') || getComputedStyle(document.querySelector('.l3-toolbar')).webkitAppRegion)
  check('侧板工具条 -webkit-app-region:no-drag', noDrag === 'no-drag', String(noDrag))
  await shot('.panel', 'desk-panel-orb')
  await pg.evaluate(() => __h.unmountSlot('panelSlot'))
  await sleep(500)
  const canv3 = await pg.evaluate(() => ({ card: document.querySelectorAll('#cardSlot canvas').length, ph: !!document.querySelector('#cardSlot .l3-placeholder') }))
  check('收起侧板:画布回到卡片,占位消失', canv3.card === 1 && !canv3.ph, JSON.stringify(canv3))

  // ── 被 CSS 藏起来的卡片后挂上:不许抢走看得见的那张的画布
  const where = () => pg.evaluate(() => ({ card: document.querySelectorAll('#cardSlot canvas').length, hidden: document.querySelectorAll('#hiddenSlot canvas').length, hiddenPh: !!document.querySelector('#hiddenSlot .l3-placeholder'), cardPh: !!document.querySelector('#cardSlot .l3-placeholder') }))
  await pg.evaluate(() => __h.mountSlot('hiddenSlot', 'desk-card'))
  await sleep(500)
  const hid1 = await where()
  check('藏着的卡片后挂上:画布留在看得见的卡片,藏着的那张只放占位', hid1.card === 1 && hid1.hidden === 0 && hid1.hiddenPh && !hid1.cardPh, JSON.stringify(hid1))
  await pg.evaluate(() => { document.getElementById('hiddenWrap').style.display = '' })
  await sleep(500)
  const hid2 = await where()
  await pg.evaluate(() => { document.getElementById('hiddenWrap').style.display = 'none' })
  await sleep(500)
  const hid3 = await where()
  check('藏着的卡片显出来 → 画布搬过去(最近挂上的看得见的);再藏起来 → 画布回到看得见的卡片', hid2.hidden === 1 && hid2.card === 0 && hid3.card === 1 && hid3.hidden === 0 && !hid3.cardPh, JSON.stringify({ hid2, hid3 }))
  await pg.evaluate(() => __h.unmountSlot('hiddenSlot'))
  await sleep(300)

  // ── 设置面
  await pg.evaluate(() => __h.settings[0].mount(document.getElementById('settings')))
  await sleep(600)
  await shot('#settings', 'settings-zh-empty')
  const sText = await pg.locator('#settings').innerText()
  check('设置面:模式说明 + 绝对路径 + 按钮', /总是显示会完全替换 Agent Desk 的文件展示/.test(sText) && /\/Users\/me\/Vault\/Live3D\/models/.test(sText) && /导入模型/.test(sText), sText.slice(0, 120).replace(/\n/g, ' | '))

  // ── 直接导入:点真按钮 → 真文件选择器(用户手势)→ RobotExpressive.glb
  const [chooser] = await Promise.all([pg.waitForEvent('filechooser', { timeout: 5000 }), pg.locator('#settings [data-act="import"]').click()])
  check('「导入模型…」弹出真文件选择器(同步 click,手势没丢)', !!chooser, chooser ? `multiple=${chooser.isMultiple()}` : '')
  await chooser.setFiles([join(SAMPLES, 'RobotExpressive.glb')])
  const imported = await until(pg, () => __h.data && __h.data.active === 'robotexpressive', null, 30000)
  check('直接导入完成并设为当前形象', imported, JSON.stringify(await pg.evaluate(() => ({ data: __h.data, n: __h.notices.slice(-3) }))))
  // 宿主 listFiles 有 1.5s 缓存:导入不到 1.5s 就走完,紧接着的重扫拿到复制前的清单 → Desk 还是小球、设置里显示「⚠ slug」
  const activeOpt = await pg.evaluate(() => { const s = document.querySelector('#settings select[data-act="active"]'); return s ? s.options[s.selectedIndex]?.textContent || '' : '' })
  check('导入一完成模型库就看得见它(设置里的 Desk 形象是模型名,不是「⚠ slug」)', /robot/i.test(activeOpt) && !activeOpt.includes('⚠'), activeOpt)
  const dir = join(VAULT, 'Live3D/models/robotexpressive')
  const files = existsSync(dir) ? readdirSync(dir).sort() : []
  check('模型文件夹:模型 + analysis.json + preview.png + live3d.json', ['RobotExpressive.glb', 'analysis.json', 'live3d.json', 'preview.png'].every((f) => files.includes(f)), files.join(','))
  const prof = existsSync(join(dir, 'live3d.json')) ? JSON.parse(readFileSync(join(dir, 'live3d.json'), 'utf8')) : {}
  check('自动生成的 live3d.json 映射了片段(idle / tool / waiting …)', prof.live3d === 1 && prof.model === 'RobotExpressive.glb' && !!prof.states?.idle?.clip && Object.keys(prof.states || {}).length >= 4, JSON.stringify(prof.states))
  const prevBuf = existsSync(join(dir, 'preview.png')) ? readFileSync(join(dir, 'preview.png')) : null
  if (prevBuf) {
    const d = decodePng(prevBuf)
    copyFileSync(join(dir, 'preview.png'), join(SHOTS, 'preview-robot.png'))
    let opaque = 0
    for (let i = 3; i < d.px.length; i += 4 * 7) if (d.px[i] > 10) opaque++
    check('preview.png 是 512×512 且拍到了模型(非全透明)', d.w === 512 && d.h === 512 && opaque > 200, `${d.w}x${d.h} opaque~${opaque}`)
  } else check('preview.png 存在', false)
  const imp = await pg.evaluate(() => __h.notices.filter((n) => n.level === 'success').map((n) => n.m))
  check('导入成功有提示', imp.some((m) => /已导入/.test(m)), imp.join(' | '))
  await sleep(1500)
  const robotCard = await shot('.card', 'desk-card-robot-idle')
  check('Desk 卡片换成了导入的模型(非空)', coverage(robotCard) > 0.05, `cov ${coverage(robotCard).toFixed(3)} vs orb ${coverage(orbCard).toFixed(3)}`)
  // 说话:口型拉取 textChars
  await pg.evaluate(() => { __h.setPhase('speaking'); window.__talk = setInterval(() => __h.talk(), 60) })
  await sleep(900)
  await shot('.card', 'desk-card-robot-speaking')
  await pg.evaluate(() => { clearInterval(window.__talk); __h.setPhase('tool') })
  await sleep(900)
  await shot('.card', 'desk-card-robot-tool')
  await pg.evaluate(() => __h.setPhase('idle'))
  await shot('#settings', 'settings-zh-after-import')

  // ── VRM + .vrma(多选)
  const [ch2] = await Promise.all([pg.waitForEvent('filechooser'), pg.locator('#settings [data-act="import"]').click()])
  await ch2.setFiles([join(SAMPLES, 'three-vrm-girl.vrm'), join(SAMPLES, 'test.vrma')])
  const vrmOk = await until(pg, () => __h.data && __h.data.active === 'three-vrm-girl', null, 40000)
  const vprof = existsSync(join(VAULT, 'Live3D/models/three-vrm-girl/live3d.json')) ? JSON.parse(readFileSync(join(VAULT, 'Live3D/models/three-vrm-girl/live3d.json'), 'utf8')) : {}
  check('VRM + .vrma 一起导入:.vrma 进 motions,VRM 口型 aa', vrmOk && vprof.motions?.[0] === 'test.vrma' && vprof.states?.speaking?.mouth === 'aa', JSON.stringify({ motions: vprof.motions, speaking: vprof.states?.speaking, name: vprof.name }))
  await sleep(1500)
  await shot('.card', 'desk-card-vrm-idle')

  // ── 模型库视图
  await pg.evaluate(() => { window.__offView = __h.views[0].mount(document.getElementById('view')) })
  await sleep(1800)
  await shot('#view', 'studio-zh')
  const vText = await pg.locator('#view').innerText()
  check('模型库:列出小球 + 两个导入的模型,标出 Desk 当前', /默认小球/.test(vText) && /RobotExpressive/i.test(vText) && /Desk/.test(vText), vText.slice(0, 160).replace(/\n/g, ' | '))
  await pg.locator('#view [data-act="select"][data-slug="robotexpressive"]').click()
  await sleep(1500)
  await pg.locator('#view [data-act="phase"][data-phase="done"]').click()
  await sleep(700)
  await shot('#view', 'studio-zh-robot-done')
  const info = await pg.locator('#view .l3-info').innerText().catch(() => '')
  check('模型库选中模型后显示体检摘要', /GLB/.test(info) && /动作/.test(info), info)
  const glCount = await pg.evaluate(() => document.querySelectorAll('canvas').length)
  check('此刻只有 Desk + 模型库两块画布(离屏体检舞台已释放)', glCount === 2, `canvas ${glCount}`)

  // ── Agent 协助导入 → 模拟 agent 写 live3d.json → 轮询载入
  const [ch3] = await Promise.all([pg.waitForEvent('filechooser'), pg.locator('#settings [data-act="agent-import"]').click()])
  const fakePmx = join(VAULT + '-pick', 'Miku.pmx')
  mkdirSync(dirname(fakePmx), { recursive: true })
  writeFileSync(fakePmx, 'PMX fake')
  await ch3.setFiles([fakePmx, join(SAMPLES, 'Soldier.glb')])
  const chatOk = await until(pg, () => __h.chats.length === 1, null, 20000)
  const chat = await pg.evaluate(() => __h.chats[0])
  check('Agent 协助导入:startChat(agent=live3d-importer, folder=Live3D, send=true)', chatOk && chat.agent === 'live3d-importer' && chat.folder === 'Live3D' && chat.send === true, JSON.stringify({ agent: chat?.agent, folder: chat?.folder, send: chat?.send }))
  console.log('      prompt:\n        ' + String(chat?.prompt).split('\n').join('\n        '))
  const slug = /models\/([^/]+)\//.exec(chat?.prompt || '')?.[1]
  // 主文件按优先级 glb > pmx → slug 取 soldier;能直接加载 → 有体检
  check('Agent 导入:能直接加载的主文件先做了体检与缩略图', slug && existsSync(join(VAULT, `Live3D/models/${slug}/analysis.json`)) && /analysis\.json:已生成/.test(chat.prompt), slug)
  writeFileSync(join(VAULT, `Live3D/models/${slug}/live3d.json`), JSON.stringify({ live3d: 1, name: 'Agent Soldier', model: 'Soldier.glb', framing: 'full', states: { idle: { clip: 'Idle' }, tool: { clip: 'Walk' } } }, null, 2))
  const agentLoaded = await until(pg, (s) => __h.data && __h.data.active === s, slug, 15000)
  check('agent 写出 live3d.json 后 ≤15s 内自动载入并设为当前', agentLoaded, JSON.stringify(await pg.evaluate(() => __h.notices.slice(-2))))
  await sleep(1500)
  await shot('.card', 'desk-card-agent-soldier')

  // ── 绑定 Agent + 待机姿势(模型库详情)
  await pg.locator('#view [data-act="select"][data-slug="three-vrm-girl"]').click()
  await sleep(1200)
  const bindLabels = await pg.locator('#view .l3-check').allInnerTexts()
  check('模型库:绑定区按宿主名册列出 Agent', bindLabels.length === 2 && bindLabels.join(' ').includes('Xyra'), JSON.stringify(bindLabels))
  await pg.locator('#view [data-act="bind"][data-slug="xyra"]').check()
  const bound = await until(pg, () => true, null, 1)
  await sleep(1200)
  const vprof2 = JSON.parse(readFileSync(join(VAULT, 'Live3D/models/three-vrm-girl/live3d.json'), 'utf8'))
  check('勾选 Agent → 写进这份模型自己的 live3d.json 的 agents', bound && Array.isArray(vprof2.agents) && vprof2.agents.includes('xyra'), JSON.stringify(vprof2.agents))
  // 拖滑块 = 一串 input 后跟一个 change。中途 input 会重画预览,**不许**把滑块自己从 DOM 里摘走,
  // 否则最后那个 change 落到一个已经脱离文档的节点上,拖一次只生效一次(或一次都不生效)。
  // 一次 input 一次往返、中间留出时间:预览的 setProfile 是 async,它的 .then 会重画详情面 ——
  // 只有让那一拍真的发生,才测得到「重画把正在拖的滑块摘走」。(全同步地连发 input 测不出来。)
  const dragSlider = async (k, values) => {
    await pg.evaluate(([key]) => { window.__slider = document.querySelector(`#view [data-act="pose"][data-k="${key}"]`) }, [k])
    for (const v of values) {
      await pg.evaluate((val) => {
        window.__slider.value = String(val)
        window.__slider.dispatchEvent(new Event('input', { bubbles: true }))
      }, v)
      await sleep(350)
    }
    return pg.evaluate(([key]) => {
      const el = window.__slider
      const detached = document.querySelector(`#view [data-act="pose"][data-k="${key}"]`) !== el || !el.isConnected
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return { detached, value: el.value }
    }, [k])
  }
  const drag = await dragSlider('armSpread', [0.4, 0.5, 0.62])
  await sleep(1200)
  const vprof3 = JSON.parse(readFileSync(join(VAULT, 'Live3D/models/three-vrm-girl/live3d.json'), 'utf8'))
  check('拖姿势滑块 → 写进 pose(其余几项保持缺省),拖动中滑块不被重画摘走', !drag.detached && vprof3.pose?.armSpread === 0.62 && vprof3.pose?.elbow === 0.26, JSON.stringify({ drag, pose: vprof3.pose }))

  // 默认形象设回小球 → 只有绑定生效时 Desk 才会显示那个模型
  await pg.locator('#settings select[data-act="active"]').selectOption('')
  await sleep(1500)
  const cardShot = async () => pg.locator('.card').screenshot()
  await pg.evaluate(() => __h.setAgent(null))
  await sleep(1800)
  const shotNone0 = await cardShot()
  await sleep(2500)
  const shotNone = await cardShot()
  await shot('.card', 'desk-card-bound-none')
  await pg.evaluate(() => __h.setAgent('xyra'))
  await sleep(2500)
  const shotXyra = await cardShot()
  await shot('.card', 'desk-card-bound-xyra')
  await pg.evaluate(() => __h.setAgent('other'))
  await sleep(2000)
  const shotOther = await cardShot()
  await shot('.card', 'desk-card-bound-other')
  // 同一个形象两帧之间也有差别(呼吸 / 眨眼 / 小球脉动),所以看的是「换人」与「同一个人动了动」的量级差
  // noise = 同一个形象隔几秒两帧的指纹距离(呼吸 / 眨眼 / 小球浮动)。断言按它自标定,不钉死阈值。
  const sigNone = colorSig(shotNone)
  const d = {
    noise: +sigDist(colorSig(shotNone0), sigNone).toFixed(3),
    bound: +sigDist(sigNone, colorSig(shotXyra)).toFixed(3),
    back: +sigDist(sigNone, colorSig(shotOther)).toFixed(3),
  }
  check('会话换到绑定的 Agent → Desk 换成它的形象', d.bound > 0.5 && d.bound > d.noise * 5, JSON.stringify(d))
  check('换到没绑定的 Agent → 退回默认形象(这里是小球)', d.back < Math.max(0.1, d.noise * 3), JSON.stringify(d))

  // ── 模式切换(设置面单选)
  await pg.locator('#settings input[value="always"]').check()
  await sleep(200)
  const upd = await pg.evaluate(() => __h.updates.slice(-1)[0])
  check('设置面切到「总是显示」→ handle.update({mode:"always"})', upd?.mode === 'always', JSON.stringify(upd))

  // ── 切语言
  await pg.evaluate(() => { __h.locale = 'en'; for (const cb of __h.localeSubs) cb('en') })
  await sleep(400)
  await shot('#settings', 'settings-en')
  await shot('#view', 'studio-en')
  const enText = (await pg.locator('#settings').innerText()) + (await pg.locator('#view').innerText())
  check('切到英文后设置面与模型库都换成英文(无汉字)', !/[㐀-鿿]/.test(enText.replace(/默认小球/g, 'X')), (enText.match(/[㐀-鿿]+/g) || []).slice(0, 5).join(','))

  // ── dispose
  await pg.evaluate(() => { __h.dispose() })
  await sleep(300)
  const after = await pg.evaluate(() => ({ canvases: document.querySelectorAll('canvas').length, style: !!document.querySelector('style[data-live3d]'), inputs: document.querySelectorAll('input[type=file]').length, disposed: !!__h.companionDisposed }))
  check('dispose:画布全收、<style> 移除、没有遗留文件选择器、伴随面已撤', after.canvases === 0 && !after.style && after.inputs === 0 && after.disposed, JSON.stringify(after))
  check('全程没有页面错误 / console.error', errors.length === 0, errors.slice(0, 5).join(' || '))
} catch (e) {
  check('冒烟跑完', false, String(e?.stack || e).slice(0, 600))
} finally {
  await browser.close()
  server.close()
  rmSync(VAULT, { recursive: true, force: true })
  rmSync(VAULT + '-pick', { recursive: true, force: true })
}
const bad = results.filter((r) => !r.ok)
console.log(`\n${results.length - bad.length}/${results.length} passed · shots: ${SHOTS}`)
process.exit(bad.length ? 1 : 0)
