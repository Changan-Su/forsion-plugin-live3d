/**
 * 房间台架(开发用,不随包发布):`node scripts/room-smoke.mjs [选项]`
 *
 * 在**真 Chromium**(playwright-core,取自 Forsion-Genesis/desktop/node_modules)里起一个房间舞台(src/room/roomStage.ts),
 * 按「昼夜:活动」逐个强制执行,**等角色真的走到位、进入该活动**再截图 —— 看起来对不对只能靠截图,这个台架给的是
 * 「每个动作一张图 + 走没走到 + 页面有没有报错」。
 *
 *   --vault <目录>     笔记库根(只读;缺省 = 一个临时库,只有内置场景 + 小球)。可以直接指向 dev 库。
 *   --scene <库内路径>  scene.json;缺省 = 内置小屋。
 *   --model <库内路径>  live3d.json(住客);缺省 = 场景里 character 指的那个,找不到就是小球。
 *   --shots a,b,…      每项 `night:<活动 id>` / `day:<活动 id>` / `night:@think`(Agent 阶段活动)/ `night:idle`(不强制,放它自己过 N 秒)
 *   --size 1280x800    视口
 *   --out <目录>       截图目录(缺省 <scratch>/room-shots)
 *   --screensaver      截图时用屏保镜头
 *   --timeout 25       每个活动最多等几秒走到位
 *   --view az,el,zoom  截特写前把镜头转到这个方位(度)对准角色,再多拍一张 `-view.png`(看正面 / 侧面的动作细节)
 *
 * 断言:无 pageerror / console.error;强制的活动在超时内进入 do;人在房间地板范围内。退出码 = 失败数。
 * 环境变量 LIVE3D_GL=swiftshader 走软件渲染,CHROMIUM_EXE 指定浏览器。
 */
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GENESIS_DESKTOP = join(ROOT, '..', '..', 'Forsion-Genesis', 'desktop')
const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : def
}
const flag = (name) => args.includes(`--${name}`)
const SCRATCH = process.env.LIVE3D_SCRATCH || join(tmpdir(), 'live3d-smoke')
const OUT = opt('out', join(SCRATCH, 'room-shots'))
const VAULT = opt('vault', null)
const SCENE = opt('scene', null)
const MODEL = opt('model', null)
const SHOTS = opt('shots', 'night:idle').split(',').map((s) => s.trim()).filter(Boolean)
const [VW, VH] = opt('size', '1280x800').split('x').map(Number)
const TIMEOUT = Number(opt('timeout', '25')) * 1000
mkdirSync(OUT, { recursive: true })

// ── 打包被测代码(不走插件壳,直接起舞台) ─────────────────────────────────────
const ENTRY = `
import { createRoomStage } from './src/room/roomStage'
import { parseScene } from './src/room/scene'
import { builtinScene } from './src/room/presets'
import { parseProfile } from './src/profile'
const assetUrl = (rel) => location.origin + '/vault/' + rel.split('/').map(encodeURIComponent).join('/')
const read = async (rel) => { const r = await fetch(assetUrl(rel)); return r.ok ? r.text() : null }
let stage = null
window.L3R = {
  async boot({ scene, model, screensaver }) {
    const el = document.getElementById('host')
    stage = createRoomStage({ assetUrl, mode: screensaver ? 'screensaver' : 'view' })
    stage.attach(el)
    let sc = builtinScene()
    if (scene) {
      const text = await read(scene)
      if (text == null) throw new Error('scene not found: ' + scene)
      const dir = scene.split('/').slice(0, -1).join('/')
      const r = parseScene(text, dir, dir.split('/').pop())
      if (!r.ok) throw new Error('scene invalid: ' + r.en)
      sc = r.value
    }
    stage.setTime('night')
    stage.setScene(sc)
    let modelPath = model
    if (!modelPath && sc.character) modelPath = 'Live3D/models/' + sc.character + '/live3d.json'
    let res = { ok: true }
    if (modelPath) {
      const text = await read(modelPath)
      if (text != null) {
        const dir = modelPath.split('/').slice(0, -1).join('/')
        const p = parseProfile(text, dir)
        if (!p.ok) throw new Error('profile invalid: ' + p.en)
        res = await stage.setCharacter(p.value)
      } else res = { ok: false, en: 'profile not found: ' + modelPath }
    }
    return { scene: sc.slug, props: sc.props.length, activities: sc.activities.map((a) => a.id), room: [sc.room.width, sc.room.depth], character: res }
  },
  time(m) { stage.setTime(m) },
  force(id) { stage.force(id) },
  phase(p) { stage.setStatus({ phase: p, sessionId: 's', textChars: 0 }) },
  debug() { return stage.debug() },
  view(a, e, z, f) { stage.debugView(a, e, z, f) },
}
`
mkdirSync(join(SCRATCH, 'room-work'), { recursive: true })
const BUNDLE = join(SCRATCH, 'room-work', 'room-smoke.js')
await build({
  stdin: { contents: ENTRY, resolveDir: ROOT, loader: 'ts' },
  nodePaths: [join(ROOT, 'node_modules')],
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022', outfile: BUNDLE,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': '"https://invalid.local/x/"' },
  logLevel: 'warning',
})

// ── 页面 + 静态服务器(宿主 CSP 原样) ────────────────────────────────────────
const hostHtml = readFileSync(join(GENESIS_DESKTOP, 'frontend', 'index.html'), 'utf8')
const CSP = hostHtml.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1]
if (!CSP) throw new Error('could not find the CSP meta in Forsion-Genesis/desktop/frontend/index.html')
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>html,body{margin:0;height:100%;background:#000}#host{position:fixed;inset:0}</style></head>
<body><div id="host"></div><script src="/room-smoke.js"></script></body></html>`
const MIME = { '.js': 'text/javascript', '.png': 'image/png', '.json': 'application/json', '.bmp': 'image/bmp' }
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const send = (code, body, type = 'text/plain') => {
    res.writeHead(code, { 'content-type': type })
    res.end(body)
  }
  if (url.pathname === '/') return send(200, PAGE, 'text/html')
  if (url.pathname === '/room-smoke.js') return send(200, readFileSync(BUNDLE), MIME['.js'])
  if (url.pathname.startsWith('/vault/') && VAULT) {
    const rel = decodeURIComponent(url.pathname.slice('/vault/'.length))
    if (rel.split('/').includes('..')) return send(403, 'no')
    const f = join(VAULT, rel)
    if (!existsSync(f) || !statSync(f).isFile()) return send(404, 'not found')
    return send(200, readFileSync(f), MIME[extname(f).toLowerCase()] || 'application/octet-stream')
  }
  send(404, 'not found')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))

const require = createRequire(import.meta.url)
const { chromium } = require(join(GENESIS_DESKTOP, 'node_modules', 'playwright-core'))
function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  try {
    const p = chromium.executablePath()
    if (p && existsSync(p)) return p
  } catch { /* fallthrough */ }
  const root = join(homedir(), 'Library/Caches/ms-playwright')
  for (const d of readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = join(root, d, 'chrome-mac-arm64', app)
      if (existsSync(p)) return p
    }
  }
  throw new Error('chromium not found; set CHROMIUM_EXE')
}
const glArgs = process.env.LIVE3D_GL === 'swiftshader'
  ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  : process.platform === 'darwin' ? ['--use-angle=metal', '--ignore-gpu-blocklist'] : ['--ignore-gpu-blocklist']

let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const browser = await chromium.launch({ executablePath: findChromium(), args: glArgs })
try {
  const pg = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1, locale: 'zh-CN' })
  const errors = []
  pg.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  pg.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console.error: ${m.text().slice(0, 300)}`)
  })
  // 页面在后台也照常出帧(document.hasFocus 为假时舞台封顶 30fps,照样画)
  await pg.goto(`http://127.0.0.1:${server.address().port}/`)
  const info = await pg.evaluate((o) => window.L3R.boot(o), { scene: SCENE, model: MODEL, screensaver: flag('screensaver') })
  console.log('boot', JSON.stringify(info))
  check('住客加载成功', info.character?.ok !== false, info.character?.en ?? '')
  for (const shot of SHOTS) {
    const [time, act] = shot.includes(':') ? shot.split(':') : ['night', shot]
    await pg.evaluate((m) => window.L3R.time(m), time)
    const name = `${time}-${act.replace(/[^\w@-]/g, '_')}`
    const t0 = Date.now()
    if (act === 'idle') {
      await pg.waitForTimeout(8000)
    } else if (act.startsWith('phase=')) {
      await pg.evaluate((p) => window.L3R.phase(p), act.slice(6))
      await pg.waitForTimeout(9000)
    } else {
      await pg.evaluate((id) => window.L3R.force(id), act)
      let d
      for (;;) {
        d = await pg.evaluate(() => window.L3R.debug())
        if (d.activity === act && d.mode === 'do') break
        if (Date.now() - t0 > TIMEOUT) break
        await pg.waitForTimeout(250)
      }
      check(`${shot}: 进入活动`, d.activity === act && d.mode === 'do', JSON.stringify(d))
      await pg.waitForTimeout(2200) // 坐稳 / 躺好 / 淡入完
    }
    const d = await pg.evaluate(() => window.L3R.debug())
    check(`${shot}: 人在地板上`, Math.abs(d.x) < info.room[0] / 2 && Math.abs(d.z) < info.room[1] / 2, `x=${d.x.toFixed(2)} z=${d.z.toFixed(2)} fps=${d.fps.toFixed(0)}`)
    await pg.screenshot({ path: join(OUT, `${name}.png`) })
    // 角色特写:以角色为中心裁一块(身高的 2.6 倍见方),看动作细节
    const side = Math.round(Math.min(VW, VH, Math.max(260, d.screen.h * 2.6)))
    const cx = Math.round(Math.min(VW - side, Math.max(0, d.screen.x - side / 2)))
    const cy = Math.round(Math.min(VH - side, Math.max(0, d.screen.y - side / 2)))
    await pg.screenshot({ path: join(OUT, `${name}-close.png`), clip: { x: cx, y: cy, width: side, height: side } })
    if (opt('view')) {
      const [a, e, z] = opt('view').split(',').map(Number)
      await pg.evaluate(([a, e, z, f]) => window.L3R.view(a, e, z, f), [a, e, z, [d.x, 0.5, d.z]])
      await pg.waitForTimeout(400)
      await pg.screenshot({ path: join(OUT, `${name}-view.png`) })
      await pg.evaluate(() => window.L3R.view(45, 30, 1))
    }
    console.log(`shot  ${join(OUT, `${name}.png`)}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  }
  check('页面无报错', errors.length === 0, errors.slice(0, 5).join(' | '))
} finally {
  await browser.close()
  server.close()
}
console.log(failures ? `\n${failures} 项失败` : '\n全部通过')
process.exit(failures)
