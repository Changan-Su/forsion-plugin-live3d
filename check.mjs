/**
 * 自检:`node check.mjs`(install.sh 装包前必跑;非 0 退出 = 不装)。只依赖本仓(node 内置 + 已装的 esbuild)。
 *
 *  1. **构建产物**能过宿主的装载闸:顶层无 import/export、可被 new Function('ctx', …) 构造、footer 把 dispose return 出去。
 *  2. **版本 / manifest**:manifest = package.json = CHANGELOG 顶节;onboarding 上限与中英步数;minAppVersion 钉住带 ctx.desk 的宿主版本。
 *  3. **裸 ctx 装载(老宿主)不抛 + 负对照**:把 `.desk?.` / `.tangu?.` / `.writeBytes?.` 逐条拆成非可选链,裸 ctx 上必须当场抛
 *     —— 证明上一条不是恒绿。
 *  4. **全量 ctx 装载**:伴随面 / 视图 / 设置面 / 5 条带前缀、无热键的命令都注册上;挂载与卸载不抛;切模式会 handle.update;
 *     dispose 后没有残留的 window/document 监听、定时器、<style>、隐藏 input。
 *  5. **导入流程**(DOM 桩里跑真代码):Live2D 拒收、Blender 工程引导去 Agent、PMX 直接导入、直接导入按优先级挑主文件 + slug 去重 + 逐文件 writeBytes、
 *     旧宿主无 writeBytes → 退桥 / 再退「手动拷」、Agent 协助导入的 startChat 入参与提示词、待办轮询到 live3d.json 自动设为当前。
 *  6. **双语**:MSG 两张表键集一致、en 无汉字、{占位符} 逐字一致;manifest 的 en 字段无汉字。
 *  7. **捆绑 Agent + 全局技能**:config.toml 规矩、SOUL.md;技能在包根 skills/(全局)、Agent 目录里不许有 skills/(会遮住全局版);
 *     SKILL.md frontmatter、profile.ts 的每个字段名、任意 Agent 调用时的找目录 / 上 Desk 说明(按钮与命令名与 i18n 同源)。
 *  8. **打包**:install.sh 先跑 check、cp 不 ln、拷 skills/ 与 agents/;icon.png 是 64–512px 的正方 PNG 且 ≤256KB。
 *  9. **P1 的纯模块单测**(scripts/unit.mjs:profile 好坏含越界、启发式、7 阶段反应表、口型包络)整份并进来跑。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { strict as A } from 'node:assert'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))
const rd = (p) => readFileSync(join(ROOT, p), 'utf8')
const fail = []
let TOTAL = 0
const results = []
const t = async (name, fn) => {
  TOTAL++
  try {
    await fn()
    console.log(`PASS  ${name}`)
  } catch (e) {
    fail.push(name)
    console.log(`FAIL  ${name}\n      ${String(e?.message ?? e).split('\n').slice(0, 3).join('\n      ')}`)
  }
  results.push(name)
}
const HAN = new RegExp('[\\u3400-\\u9fff]')

const main = rd('main.js')
const manifest = JSON.parse(rd('manifest.json'))
const pkg = JSON.parse(rd('package.json'))
const changelog = rd('CHANGELOG.md')
const srcFiles = ['src/index.ts', ...readdirSync(join(ROOT, 'src/ui')).map((f) => `src/ui/${f}`), 'src/library.ts', 'src/i18n.ts', 'src/prompt.ts']
const src = srcFiles.map(rd).join('\n')
const css = rd('src/live3d.css')

// ── 1. 构建产物 ──────────────────────────────────────────────────────────────
await t('main.js 是裸 setup 体(顶层无 import/export)', () => {
  A.ok(!/^\s*(import|export)\s/m.test(main), '顶层出现了 import/export —— 宿主的 new Function 会直接抛')
})
await t("main.js 可被 new Function('ctx', …) 构造", () => {
  new Function('ctx', main)
})
await t('main.js 把 dispose return 出去了(build.mjs 的 footer)', () => {
  A.match(main, /return forsionLive3d\.dispose;?\s*$/, '尾部缺 return —— 禁用插件后监听 / WebGL 不会被收')
})
await t('main.js 像是真打包过 three(改了源码要重跑 npm run build)', () => {
  A.ok(main.length > 500_000, `产物只有 ${main.length} 字节`)
})
// 「main.js 比 src 旧」只提示不拦:git clone 后 mtime 是检出顺序,拿它挡 install.sh 会误伤。
{
  const built = statSync(join(ROOT, 'main.js')).mtimeMs
  const newest = Math.max(...[...srcFiles, 'src/live3d.css', 'src/stage.ts', 'src/loaders.ts', 'src/profile.ts', 'src/contract.ts'].map((f) => statSync(join(ROOT, f)).mtimeMs))
  if (built < newest - 1000) console.log('WARN  src 比 main.js 新 —— 改了源码的话先 npm run build(刚 clone 的仓可忽略)')
}

// ── 2. 版本 / manifest ───────────────────────────────────────────────────────
await t('版本一致:manifest = package.json = CHANGELOG 顶节', () => {
  A.equal(manifest.version, pkg.version)
  const top = /^## (\d+\.\d+\.\d+)/m.exec(changelog)?.[1]
  A.equal(top, manifest.version, `CHANGELOG 顶节是 ${top}`)
})
await t('manifest 基本面:id / 名称 / apiVersion / main;minAppVersion 钉住带 ctx.desk 的宿主版本', () => {
  A.equal(manifest.id, 'live3d')
  A.match(manifest.id, /^[a-z0-9][a-z0-9-]{0,63}$/)
  A.equal(manifest.name, 'Live3D')
  A.equal(manifest.nameEn, 'Live3D')
  A.equal(manifest.apiVersion, 1)
  A.equal(manifest.main, 'main.js')
  // 不钉 = 旧宿主上装得进去、Desk 里却什么都不出现(静默空操作);钉住则由宿主挡下并说明要哪个版本
  A.equal(manifest.minAppVersion, '2.12.0', 'minAppVersion 要钉到第一个带 ctx.desk / ctx.tangu.agents 的宿主版本')
  A.match(changelog, /minAppVersion` 钉在/, 'CHANGELOG 要写明 minAppVersion 钉在哪个宿主版本')
  A.ok(manifest.description && manifest.descriptionEn, '缺 description / descriptionEn')
})
await t('onboarding:intro ≤500、步骤 ≤8、标题 ≤120、说明 ≤500,中英步数一致,settings:true,不推荐自家 Agent', () => {
  const ob = manifest.onboarding
  A.ok(ob.intro.length <= 500 && ob.en.intro.length <= 500)
  A.ok(ob.steps.length >= 1 && ob.steps.length <= 8)
  A.equal(ob.en.steps.length, ob.steps.length)
  for (const s of [...ob.steps, ...ob.en.steps]) {
    A.ok(s.title && s.title.length <= 120, `步骤标题超长:${s.title}`)
    A.ok(!s.description || s.description.length <= 500, `步骤说明超长:${s.title}`)
  }
  A.equal(ob.settings, true)
  A.ok(!ob.recommends, 'recommends 会把用户送去市场装一份重复的自家 Agent')
})
await t('manifest 的英文字段不含汉字', () => {
  const en = [manifest.nameEn, manifest.descriptionEn, manifest.onboarding.en.intro, ...manifest.onboarding.en.steps.flatMap((s) => [s.title, s.description])]
  for (const s of en) A.ok(!HAN.test(s), `英文字段里有汉字:${s.slice(0, 60)}`)
})

// ── DOM 桩 + 假定时器 ─────────────────────────────────────────────────────────
const live = { win: new Map(), doc: new Map(), timeouts: new Map(), intervals: new Map() }
let seq = 1
const listenerBook = (book) => ({
  addEventListener(type, fn) { book.set(`${type}#${seq++}`, { type, fn }) },
  removeEventListener(type, fn) { for (const [k, v] of book) if (v.type === type && v.fn === fn) { book.delete(k); break } },
})
const created = []
function mkEl(tag = 'div') {
  const handlers = new Map()
  const el = {
    tagName: String(tag).toUpperCase(), nodeName: String(tag).toUpperCase(), children: [], parentNode: null,
    className: '', style: { cssText: '', setProperty() {}, removeProperty() {} }, dataset: {}, hidden: false,
    textContent: '', innerHTML: '', value: '', type: '', multiple: false, accept: '', files: null, clicked: 0, attrs: {},
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)) }, remove(...c) { c.forEach((x) => this._s.delete(x)) },
      contains(c) { return this._s.has(c) }, toggle(c, on) { (on ?? !this._s.has(c)) ? this._s.add(c) : this._s.delete(c) },
    },
    setAttribute(k, v) { this.attrs[k] = String(v) }, getAttribute(k) { return this.attrs[k] ?? null }, removeAttribute(k) { delete this.attrs[k] },
    appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = el; el.children.push(c); return c },
    remove() { const p = el.parentNode; if (p) p.children = p.children.filter((x) => x !== el); el.parentNode = null },
    replaceChildren() { for (const c of [...el.children]) c.remove() },
    addEventListener(type, fn) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn) },
    removeEventListener(type, fn) { handlers.get(type)?.delete(fn) },
    fire(type, ev = {}) { for (const fn of [...(handlers.get(type) ?? [])]) fn({ type, target: el, preventDefault() {}, stopPropagation() {}, ...ev }) },
    listenerCount() { let n = 0; for (const s of handlers.values()) n += s.size; return n },
    // 同一选择器回同一个节点(视图按 data-part 分块重画,测试要读回某一块的 innerHTML)
    querySelector(sel) { if (!el._q) el._q = new Map(); if (!el._q.has(sel)) el._q.set(sel, mkEl()); return el._q.get(sel) },
    querySelectorAll: () => [], closest: () => null,
    click() { el.clicked++ }, getContext: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    width: 0, height: 0,
  }
  created.push(el)
  return el
}
let head, body
function installDom() {
  created.length = 0
  live.win.clear(); live.doc.clear(); live.timeouts.clear(); live.intervals.clear()
  head = mkEl('head')
  body = mkEl('body')
  const doc = { ...listenerBook(live.doc), head, body, hidden: false, activeElement: null, documentElement: mkEl('html'),
    createElement: (tag) => mkEl(tag), createElementNS: (_ns, tag) => mkEl(tag), querySelector: () => null }
  globalThis.document = doc
  globalThis.window = { ...listenerBook(live.win), document: doc, devicePixelRatio: 1 }
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  globalThis.requestAnimationFrame = () => 0
  globalThis.cancelAnimationFrame = () => {}
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })
  globalThis.setTimeout = (fn, ms) => { const h = seq++; live.timeouts.set(h, { fn, ms }); return h }
  globalThis.clearTimeout = (h) => { live.timeouts.delete(h) }
  globalThis.setInterval = (fn, ms) => { const h = seq++; live.intervals.set(h, { fn, ms }); return h }
  globalThis.clearInterval = (h) => { live.intervals.delete(h) }
  delete globalThis.amadeus
}
// 节点里没有 WebGL:three 与插件都会 console.error 一次「建不出上下文」—— 预期内,收进数组别刷屏。
const consoleNoise = []
const realConsole = { error: console.error, warn: console.warn }
console.error = (...a) => consoleNoise.push(a.map(String).join(' ').slice(0, 160))
console.warn = (...a) => consoleNoise.push(a.map(String).join(' ').slice(0, 160))
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }
const fireIntervals = async () => { for (const { fn } of [...live.intervals.values()]) fn(); await flush(80) }
const fireTimeouts = async () => { for (const [h, { fn }] of [...live.timeouts]) { live.timeouts.delete(h); fn() } await flush() }

/** 老宿主:只有 app.notify / registerCommand / registerSetting。 */
const bareCtx = () => ({ app: { notify() {} }, registerCommand() {}, registerSetting() {} })

/** 新宿主:内存库 + 全部接缝,调用都记账。 */
function fullCtx({ locale = 'zh', withWriteBytes = true, withStartChat = true, withDesk = true, withReveal = true, startChatResult = { ok: true, sessionId: 's1' } } = {}) {
  const vault = new Map()
  const log = { commands: [], views: [], settings: [], companions: [], updates: [], notices: [], saved: [], chats: [], reveals: [], watches: new Map(), localeSubs: new Set(), statusSubs: new Set(), handleDisposed: 0 }
  const dec = new TextDecoder()
  let data = null
  const ctx = {
    app: {
      notify: (m) => log.notices.push({ m, level: 'info' }),
      workFolder: () => 'Live3D',
      vaultRoot: () => '/Users/me/Vault',
      hostPath: (p) => `/Users/me/Vault/${p}`,
      assetUrl: (p) => `amadeus-asset://v/${encodeURIComponent(p)}`,
      readFile: async (p) => { const v = vault.get(p); return v == null ? null : typeof v === 'string' ? v : dec.decode(v) },
      writeFile: async (p, text) => { vault.set(p, text) },
      listFiles: async () => [...vault.keys()].filter((p) => !p.endsWith('.md')),
      ...(withReveal ? { reveal: (p) => log.reveals.push(p) } : {}),
      watchFile: (p, cb) => { log.watches.set(p, cb); return () => log.watches.delete(p) },
      ...(withWriteBytes ? { writeBytes: async (p, b) => { vault.set(p, b instanceof Uint8Array ? b : new Uint8Array(b)) }, readBytes: async (p) => vault.get(p) ?? null } : {}),
    },
    registerCommand: (c) => log.commands.push(c),
    registerSetting() {},
    registerView: (v) => log.views.push(v),
    openView: (id) => log.opened = id,
    registerSettingsView: (v) => log.settings.push(v),
    notify: (m, o) => log.notices.push({ m, level: o?.level ?? 'info' }),
    getLocale: () => locale,
    subscribeLocale: (cb) => { log.localeSubs.add(cb); return () => log.localeSubs.delete(cb) },
    loadData: async () => data,
    saveData: async (v) => { data = JSON.parse(JSON.stringify(v)); log.saved.push(data) },
    tangu: {
      activeModel: () => null, models: () => [], activeSpace: () => 'tangu', subscribe: () => () => {},
      agentStatus: () => ({ phase: 'idle', sessionId: null, runId: null, since: 0, textChars: 0, reasoningChars: 0 }),
      subscribeAgentStatus: (cb) => { log.statusSubs.add(cb); return () => log.statusSubs.delete(cb) },
      ...(withStartChat ? { startChat: async (o) => { log.chats.push(o); return startChatResult } } : {}),
    },
    ...(withDesk ? {
      desk: {
        registerCompanion: (def) => {
          log.companions.push(def)
          return { update: (p) => log.updates.push(p), dispose: () => { log.handleDisposed++ } }
        },
      },
    } : {}),
  }
  return { ctx, vault, log, data: () => data }
}
const load = (code, ctx) => new Function('ctx', code)(ctx)
const leftovers = () => ({
  win: live.win.size, doc: live.doc.size, timeouts: live.timeouts.size, intervals: live.intervals.size,
  styles: head.children.length, bodyKids: body.children.length,
})

// ── 3. 裸 ctx(老宿主)+ 负对照 ────────────────────────────────────────────────
await t('老宿主(裸 ctx:无 desk / tangu / writeBytes / registerView / loadData)装载不抛,且拿得到 dispose', () => {
  installDom()
  const d = load(main, bareCtx())
  A.equal(typeof d, 'function')
  d()
})
// 每条守卫拆掉后抛的必须是「读缺席成员」那一下(不是别处碰巧炸了):按报错里的属性名对上号
for (const [guard, member] of [['.desk?.', 'registerCompanion'], ['.tangu?.', 'startChat'], ['.writeBytes?.', 'bind']]) {
  await t(`负对照:拆掉 ${guard} 可选链后,裸 ctx 上必须当场抛(证明上一条不是恒绿)`, () => {
    const broken = main.replaceAll(guard, guard.replace('?.', '.'))
    A.notEqual(broken, main, `产物里没找到 ${guard} —— 负对照失效(压缩改了写法?)`)
    new Function('ctx', broken) // 语法仍然合法:抛必须来自运行期缺成员,而不是语法错
    installDom()
    A.throws(() => load(broken, bareCtx()), new RegExp(`reading '${member}'`), `拆掉 ${guard} 却没抛在 ${member} 上 —— 这条守卫没被 setup 走到`)
  })
}

// ── 4. 全量 ctx ──────────────────────────────────────────────────────────────
await t('新宿主:注册伴随面(id avatar,缺省 idle)、模型库视图、设置面、5 条 live3d- 命令且没有热键', async () => {
  installDom()
  const { ctx, log } = fullCtx()
  const d = load(main, ctx)
  await flush()
  A.equal(log.companions.length, 1)
  A.equal(log.companions[0].id, 'avatar')
  A.equal(log.companions[0].mode, 'idle')
  A.equal(typeof log.companions[0].mount, 'function')
  A.deepEqual(log.views.map((v) => v.id), ['studio'])
  A.equal(log.settings.length, 1)
  const ids = log.commands.map((c) => c.id).sort()
  A.deepEqual(ids, ['live3d-agent-import', 'live3d-import', 'live3d-open-studio', 'live3d-refresh', 'live3d-toggle-mode'])
  for (const c of log.commands) {
    A.ok(!('hotkey' in c), `${c.id} 带了 hotkey`)
    A.ok(c.title && typeof c.run === 'function')
  }
  d()
})
await t('源码没有给宿主传 hotkey 字段;命令 id 一律 live3d- 前缀', () => {
  A.ok(!/\bhotkey\s*:/i.test(src))
  for (const m of src.matchAll(/registerCommand\(\{\s*id: '([^']+)'/g)) A.match(m[1], /^live3d-/)
})
await t('英文宿主:命令 / 视图 / 设置面标题全是英文', async () => {
  installDom()
  const { ctx, log } = fullCtx({ locale: 'en' })
  const d = load(main, ctx)
  for (const s of [...log.commands.map((c) => c.title), ...log.views.map((v) => v.title), ...log.settings.map((v) => v.title)]) A.ok(!HAN.test(s), s)
  d()
})
await t('伴随面挂上 / 卸下不抛(节点里没有 WebGL → 显示占位,不崩);卡片与侧板两个挂载点', async () => {
  installDom()
  const { ctx, log } = fullCtx()
  const d = load(main, ctx)
  await flush()
  const status = () => ({ phase: 'speaking', sessionId: null, runId: 'r', since: 0, textChars: 10, reasoningChars: 0 })
  const host = (surface) => ({ surface, sessionId: () => null, status, onStatus: () => () => {} })
  const card = mkEl(), panel = mkEl()
  const offCard = log.companions[0].mount(card, host('desk-card'))
  const offPanel = log.companions[0].mount(panel, host('desk-panel'))
  A.equal(typeof offCard, 'function')
  A.ok(card.children.length === 1 && panel.children.length === 1, '每个挂载点应有一个 l3-slot')
  offPanel()
  offCard()
  A.equal(card.children.length + panel.children.length, 0, '卸载后挂载点里还有残留')
  d()
})
await t('切显示模式:命令 → handle.update({mode}) + saveData;再切回来', async () => {
  installDom()
  const { ctx, log, data } = fullCtx()
  const d = load(main, ctx)
  await flush()
  const toggle = log.commands.find((c) => c.id === 'live3d-toggle-mode')
  toggle.run()
  await flush()
  A.deepEqual(log.updates.at(-1), { mode: 'always' })
  A.equal(data().mode, 'always')
  toggle.run()
  await flush()
  A.deepEqual(log.updates.at(-1), { mode: 'idle' })
  d()
})
await t('读到落盘的 always 模式后补一次 handle.update(注册时 loadData 还没回来)', async () => {
  installDom()
  const f = fullCtx()
  await f.ctx.saveData({ mode: 'always', active: null, pending: {} })
  const d = load(main, f.ctx)
  await flush()
  A.deepEqual(f.log.updates.at(-1), { mode: 'always' })
  d()
})
await t('设置面与模型库视图挂上 / 卸下不抛;设置面写出工作文件夹的绝对路径', async () => {
  installDom()
  const { ctx, log } = fullCtx()
  const d = load(main, ctx)
  await flush()
  const s = mkEl()
  const offS = log.settings[0].mount(s)
  await flush()
  A.match(s.innerHTML, /\/Users\/me\/Vault\/Live3D\/models/, '设置面没显示绝对路径')
  A.match(s.innerHTML, /总是显示会完全替换 Agent Desk 的文件展示/)
  const v = mkEl()
  const offV = log.views[0].mount(v)
  await flush()
  offS()
  offV()
  d()
})
await t('切语言:订阅回调里重画(不抛),dispose 时退订', async () => {
  installDom()
  const { ctx, log } = fullCtx()
  const d = load(main, ctx)
  const s = mkEl()
  const off = log.settings[0].mount(s)
  await flush()
  for (const cb of log.localeSubs) cb('en')
  A.match(s.innerHTML, /completely replaces the Agent Desk file presentation/)
  off()
  d()
  A.equal(log.localeSubs.size, 0)
})
await t('dispose 收干净:没有残留的 window/document 监听、定时器、<style>、body 里的隐藏节点;伴随面 handle 已撤', async () => {
  installDom()
  const { ctx, log } = fullCtx()
  const d = load(main, ctx)
  await flush()
  A.equal(head.children.length, 1, '没注入 <style>')
  const host = { surface: 'desk-panel', sessionId: () => null, status: () => ({ phase: 'idle', sessionId: null, runId: null, since: 0, textChars: 0, reasoningChars: 0 }), onStatus: () => () => {} }
  log.companions[0].mount(mkEl(), host)
  log.views[0].mount(mkEl())
  log.commands.find((c) => c.id === 'live3d-import').run() // 留一个没选完的文件选择器
  await flush()
  A.equal(body.children.length, 1, '选择器 input 没挂上')
  d()
  await flush()
  A.deepEqual(leftovers(), { win: 0, doc: 0, timeouts: 0, intervals: 0, styles: 0, bodyKids: 0 })
  A.equal(log.handleDisposed, 1)
})

// ── 5. 导入流程 ──────────────────────────────────────────────────────────────
const file = (name, bytes = 16, rel) => {
  const f = new File([new Uint8Array(bytes)], name)
  if (rel) Object.defineProperty(f, 'webkitRelativePath', { value: rel })
  return f
}
/** 跑一条命令弹出选择器,喂文件,等流程走完(离屏舞台在节点里建不起来 → 走「加载失败」分支)。 */
async function pickVia(log, cmdId, files) {
  log.commands.find((c) => c.id === cmdId).run()
  const input = body.children.find((c) => c.tagName === 'INPUT')
  A.ok(input, '没弹出文件选择器')
  A.equal(input.clicked, 1, '选择器没在命令里同步 click()(用户手势会丢)')
  input.files = files
  input.fire('change')
  await flush(80)
  return input
}
await t('导入:只有 Live2D 文件 → 拒收并给出授权说明(不复制任何文件)', async () => {
  installDom()
  const { ctx, log, vault } = fullCtx()
  const d = load(main, ctx)
  await flush()
  await pickVia(log, 'live3d-import', [file('hiyori.model3.json'), file('hiyori.moc3')])
  A.ok(log.notices.some((n) => n.level === 'error' && /Live2D/.test(n.m) && /授权|许可/.test(n.m)), JSON.stringify(log.notices))
  A.equal([...vault.keys()].filter((k) => k.startsWith('Live3D/models/')).length, 0)
  d()
})
await t('直接导入:PMX 连同子文件夹里的贴图一起复制,不转交 Agent', async () => {
  installDom()
  const { ctx, log, vault } = fullCtx()
  const d = load(main, ctx)
  await flush()
  await pickVia(log, 'live3d-import', [file('Miku.pmx'), file('tex/体.png'), file('spa/hair_s.spa')])
  for (const f of ['Miku.pmx', 'tex/体.png', 'spa/hair_s.spa']) A.ok(vault.has(`Live3D/models/miku/${f}`), `没复制 ${f}:${[...vault.keys()].join(', ')}`)
  A.equal(log.chats.length, 0)
  d()
})
await t('导入:Blender 工程 → 不直接导入,提示改走 Agent 协助导入', async () => {
  installDom()
  const { ctx, log, vault } = fullCtx()
  const d = load(main, ctx)
  await flush()
  await pickVia(log, 'live3d-import', [file('miku.blend')])
  A.ok(log.notices.some((n) => n.level === 'warning' && /协助导入/.test(n.m)), JSON.stringify(log.notices))
  A.equal([...vault.keys()].filter((k) => k.startsWith('Live3D/models/')).length, 0)
  d()
})
await t('直接导入:.vrm 优先于 .fbx;逐个 writeBytes 进 models/<slug>/;slug 与已有文件夹去重;离屏舞台失败时给「让 Agent 协助处理」', async () => {
  installDom()
  const { ctx, log, vault } = fullCtx()
  vault.set('Live3D/models/alice/live3d.json', '{"live3d":1,"model":"alice.vrm"}')
  vault.set('Live3D/models/alice/alice.vrm', new Uint8Array(4))
  const d = load(main, ctx)
  await flush()
  await pickVia(log, 'live3d-import', [file('Alice.vrm', 64), file('dance.fbx', 99), file('wave.vrma'), file('.DS_Store')])
  const copied = [...vault.keys()].filter((k) => k.startsWith('Live3D/models/alice-2/')).sort()
  A.deepEqual(copied, ['Live3D/models/alice-2/Alice.vrm', 'Live3D/models/alice-2/dance.fbx', 'Live3D/models/alice-2/wave.vrma'])
  A.ok(log.notices.some((n) => n.level === 'error' && /Live3D\/models\/alice-2/.test(n.m)), '加载失败没说文件放哪了')
  A.ok(vault.has('Live3D/README.md'), '没写工作文件夹 README(reveal 前要先把目录建出来)')
  d()
})
await t('直接导入(设置面「导入文件夹…」):选择器带 webkitdirectory,保留去掉顶层文件夹名后的相对路径,slug 取文件夹名', async () => {
  installDom()
  const { ctx, log, vault } = fullCtx()
  const d = load(main, ctx)
  await flush()
  const el = mkEl()
  log.settings[0].mount(el)
  await flush()
  el.fire('click', { target: { closest: () => ({ dataset: { act: 'import-folder' } }) } })
  const inp = body.children.find((c) => c.tagName === 'INPUT')
  A.ok(inp && inp.attrs.webkitdirectory === '', '文件夹选择器没带 webkitdirectory')
  A.equal(inp.clicked, 1)
  inp.files = [file('Helmet.gltf', 10, 'Damaged Helmet/glTF/Helmet.gltf'), file('Helmet.bin', 10, 'Damaged Helmet/glTF/Helmet.bin'), file('a.png', 10, 'Damaged Helmet/glTF/tex/a.png')]
  inp.fire('change')
  await flush(80)
  const got = [...vault.keys()].filter((k) => k.startsWith('Live3D/models/')).sort()
  A.deepEqual(got, ['Live3D/models/damaged-helmet/glTF/Helmet.bin', 'Live3D/models/damaged-helmet/glTF/Helmet.gltf', 'Live3D/models/damaged-helmet/glTF/tex/a.png'])
  d()
})
await t('旧宿主没有 writeBytes:退到 window.amadeus.saveVaultBytes;桥也没有 → 不复制、打开文件夹并说明手动拷', async () => {
  installDom()
  const a = fullCtx({ withWriteBytes: false })
  const bridged = []
  globalThis.window.amadeus = { saveVaultBytes: async (p, b) => { bridged.push(p); a.vault.set(p, b) } }
  const d = load(main, a.ctx)
  await flush()
  await pickVia(a.log, 'live3d-import', [file('bot.glb')])
  A.deepEqual(bridged, ['Live3D/models/bot/bot.glb'])
  d()

  installDom()
  const b = fullCtx({ withWriteBytes: false })
  const d2 = load(main, b.ctx)
  await flush()
  await pickVia(b.log, 'live3d-import', [file('bot.glb')])
  A.equal([...b.vault.keys()].filter((k) => k.startsWith('Live3D/models/')).length, 0)
  A.ok(b.log.reveals.length === 1, '没打开文件夹')
  A.ok(b.log.notices.some((n) => /手动/.test(n.m)), JSON.stringify(b.log.notices))
  d2()
})
await t('Agent 协助导入:复制原文件 → startChat({agent:"live3d-importer", folder:工作文件夹, send:true}),提示词带文件夹 / 绝对路径 / 文件 / 技能名', async () => {
  installDom()
  const { ctx, log, vault, data } = fullCtx()
  const d = load(main, ctx)
  await flush()
  await pickVia(log, 'live3d-agent-import', [file('Miku.blend'), file('tex.png')])
  A.ok(vault.has('Live3D/models/miku/Miku.blend') && vault.has('Live3D/models/miku/tex.png'))
  A.equal(log.chats.length, 1)
  const o = log.chats[0]
  A.equal(o.agent, 'live3d-importer')
  A.equal(o.folder, 'Live3D')
  A.equal(o.send, true)
  for (const needle of ['models/miku/', 'Live3D/models/miku', '/Users/me/Vault/Live3D/models/miku', 'Miku.blend', 'live3d-import', 'models/miku/live3d.json']) A.ok(o.prompt.includes(needle), `提示词缺 ${needle}:\n${o.prompt}`)
  A.ok('miku' in (data().pending ?? {}), '没记成待办(重启后接不上)')
  d()
})
await t('Agent 协助导入:agent 写出 live3d.json → 轮询载入、设为当前、清掉待办;写坏了 → 说明原因、继续等', async () => {
  installDom()
  const { ctx, log, vault, data } = fullCtx()
  const d = load(main, ctx)
  await flush()
  await pickVia(log, 'live3d-agent-import', [file('Miku.blend')])
  vault.set('Live3D/models/miku/live3d.json', '{"live3d":1,"model":"Miku.blend"}') // 写坏:.blend 不是能显示的格式
  await fireIntervals()
  A.ok(log.notices.some((n) => /live3d\.json 有问题/.test(n.m)), JSON.stringify(log.notices.slice(-2)))
  A.ok('miku' in data().pending)
  vault.set('Live3D/models/miku/model.glb', new Uint8Array(4))
  vault.set('Live3D/models/miku/live3d.json', '{"live3d":1,"name":"Miku","model":"model.glb"}')
  await fireIntervals()
  A.equal(data().active, 'miku')
  A.ok(!('miku' in data().pending))
  A.ok(log.notices.some((n) => /写好了「Miku」/.test(n.m)))
  d()
})
await t('Agent 协助导入:宿主没有 startChat → 不抛,记成待办并提示手动开对话', async () => {
  installDom()
  const { ctx, log, data } = fullCtx({ withStartChat: false })
  const d = load(main, ctx)
  await flush()
  await pickVia(log, 'live3d-agent-import', [file('x.zip')])
  A.ok('x' in data().pending)
  A.ok(log.notices.some((n) => /Live3D Importer/.test(n.m)))
  d()
})
await t('Agent 协助导入:startChat 返回 ok:false → 说明原因(不吞)', async () => {
  installDom()
  const { ctx, log } = fullCtx({ startChatResult: { ok: false, error: 'backend offline' } })
  const d = load(main, ctx)
  await flush()
  await pickVia(log, 'live3d-agent-import', [file('y.zip')])
  A.ok(log.notices.some((n) => /backend offline/.test(n.m)), JSON.stringify(log.notices))
  d()
})
await t('直接导入:slug 去重不分大小写 + NFKC(APFS / NTFS 上 models/RobotExpressive/ 与 robotexpressive 是同一个目录)', async () => {
  installDom()
  const { ctx, log, vault } = fullCtx()
  vault.set('Live3D/models/RobotExpressive/RobotExpressive.glb', new Uint8Array(7)) // 用户手建的文件夹
  vault.set('Live3D/models/RobotExpressive/live3d.json', '{"live3d":1,"model":"RobotExpressive.glb"}')
  vault.set('Live3D/models/\u212Aelvin/kelvin.glb', new Uint8Array(3)) // U+212A KELVIN SIGN:APFS 折成 'K'
  const d = load(main, ctx)
  await flush()
  await pickVia(log, 'live3d-import', [file('RobotExpressive.glb', 9)])
  const mine = [...vault.keys()].filter((k) => vault.get(k)?.length === 9)
  A.deepEqual(mine, ['Live3D/models/robotexpressive-2/RobotExpressive.glb'], '导入写进了(大小写不同的)用户文件夹')
  await pickVia(log, 'live3d-import', [file('kelvin.glb', 5)])
  A.ok(vault.has('Live3D/models/kelvin-2/kelvin.glb'), [...vault.keys()].filter((k) => /kelvin/i.test(k)).join(', '))
  d()
})
await t('复制途中插件被卸:收手 —— 不再写其余文件 / README、不建离屏舞台(WebGL)', async () => {
  installDom()
  const { ctx, log, vault } = fullCtx()
  let release
  const gate = new Promise((r) => { release = r })
  let writes = 0
  const realWrite = ctx.app.writeBytes
  ctx.app.writeBytes = async (p, b) => { writes++; await gate; return realWrite(p, b) } // setup 时 bind,必须在装载前换
  const d = load(main, ctx)
  await flush()
  log.commands.find((c) => c.id === 'live3d-import').run()
  const input = body.children.find((c) => c.tagName === 'INPUT')
  input.files = [file('a.glb'), file('b.png'), file('c.png')]
  input.fire('change')
  await flush(40)
  A.equal(writes, 1, '第一份复制没停在闸门上')
  const noise = consoleNoise.length
  d()
  release()
  await flush(80)
  A.equal(writes, 1, '卸载后还在复制')
  A.ok(!vault.has('Live3D/README.md'), '卸载后还写了 README')
  A.equal(consoleNoise.length, noise, `卸载后还去建 WebGL 舞台:${consoleNoise.slice(noise).join(' | ')}`)
  A.ok(!created.some((e) => e.className === 'l3-offscreen'), '卸载后还挂了离屏节点')
})
await t('直接加载失败的原因(英文)带进 Agent 提示词:Agent 协助导入,以及失败提示条上的「让 Agent 协助处理」', async () => {
  installDom()
  const { ctx, log } = fullCtx()
  const d = load(main, ctx)
  await flush()
  const why = 'WebGL is unavailable, so there is no preview.' // 节点里建不出舞台 → analyzeInto 的失败原因
  await pickVia(log, 'live3d-agent-import', [file('Bot.glb')])
  A.equal(log.chats.length, 1)
  A.ok(log.chats[0].prompt.includes(why), `提示词没带加载报错:\n${log.chats[0].prompt}`)
  await pickVia(log, 'live3d-import', [file('Other.glb')])
  const s = mkEl()
  log.settings[0].mount(s)
  await flush()
  A.match(s.innerHTML, /data-act="notice-action"/, '失败提示条上没有「让 Agent 协助处理」')
  s.fire('click', { target: { closest: () => ({ dataset: { act: 'notice-action' } }) } })
  await flush(40)
  A.equal(log.chats.length, 2)
  A.ok(log.chats[1].prompt.includes('models/other/') && log.chats[1].prompt.includes(why), log.chats[1].prompt)
  d()
})
await t('宿主没有 reveal:模型库不放「打开文件夹」;没法写二进制时的提示不说「已为你打开文件夹」(有 reveal 时照常)', async () => {
  installDom()
  const a = fullCtx()
  const d1 = load(main, a.ctx)
  await flush()
  const v1 = mkEl()
  a.log.views[0].mount(v1)
  await flush()
  A.match(v1.querySelector('[data-part="actions"]').innerHTML, /data-act="open-folder"/, '对照组:有 reveal 时应有这颗按钮')
  d1()

  installDom()
  const b = fullCtx({ withWriteBytes: false, withReveal: false })
  const d2 = load(main, b.ctx)
  await flush()
  const v2 = mkEl()
  b.log.views[0].mount(v2)
  await flush()
  A.ok(!/data-act="open-folder"/.test(v2.querySelector('[data-part="actions"]').innerHTML), '没有 reveal 还放了「打开文件夹」')
  await pickVia(b.log, 'live3d-import', [file('bot.glb')])
  const warn = b.log.notices.find((n) => n.level === 'warning' && /Live3D\/models/.test(n.m))
  A.ok(warn, JSON.stringify(b.log.notices))
  A.ok(!/已为你打开/.test(warn.m), warn.m)
  d2()
})
await t('Agent 协助导入:profile 先于模型文件写出 → 不算完成(仍待办、不设当前、不报成功)、缺模型只提示一次、10s 内不整库重扫;模型到了再载入', async () => {
  installDom()
  const { ctx, log, vault, data } = fullCtx()
  let lists = 0
  const realList = ctx.app.listFiles
  ctx.app.listFiles = async () => { lists++; return realList() }
  const realNow = Date.now
  let skew = 0
  Date.now = () => realNow() + skew
  try {
    const d = load(main, ctx)
    await flush()
    await pickVia(log, 'live3d-agent-import', [file('Miku.blend')])
    vault.set('Live3D/models/miku/live3d.json', '{"live3d":1,"name":"Miku","model":"model.glb"}')
    await fireIntervals()
    const missing = () => log.notices.filter((n) => /找不到模型文件「model\.glb」/.test(n.m)).length
    A.ok(!log.notices.some((n) => /写好了/.test(n.m)), '模型文件还没到就报了成功')
    A.ok('miku' in data().pending, '模型没到就清了待办')
    A.notEqual(data().active, 'miku')
    A.equal(missing(), 1, JSON.stringify(log.notices.slice(-2)))
    const l0 = lists
    await fireIntervals()
    A.equal(lists, l0, '同一版 profile、不到 10s 又整库重扫了')
    A.equal(missing(), 1, '同一版 profile 重复提示')
    vault.set('Live3D/models/miku/model.glb', new Uint8Array(4))
    skew += 11_000
    await fireIntervals()
    A.equal(data().active, 'miku', '模型到了也没载入')
    A.ok(!('miku' in data().pending))
    A.ok(log.notices.some((n) => /写好了「Miku」/.test(n.m)))
    d()
  } finally {
    Date.now = realNow
  }
})
await t('Agent 协助导入:扫描拿到旧清单(宿主 listFiles 的 1.5s 缓存)→ 不误报「有问题」、不记成处理过,下一轮看到就载入', async () => {
  installDom()
  const { ctx, log, vault, data } = fullCtx()
  const d = load(main, ctx)
  await flush()
  await pickVia(log, 'live3d-agent-import', [file('Miku.blend')])
  const realList = ctx.app.listFiles
  const before = await realList() // agent 写文件之前的清单
  let staleLeft = 1
  ctx.app.listFiles = async () => (staleLeft-- > 0 ? before : realList())
  vault.set('Live3D/models/miku/model.glb', new Uint8Array(4))
  vault.set('Live3D/models/miku/live3d.json', '{"live3d":1,"name":"Miku","model":"model.glb"}')
  await fireIntervals()
  A.ok(!log.notices.some((n) => /有问题/.test(n.m)), `旧清单被当成写坏了:${JSON.stringify(log.notices.slice(-1))}`)
  A.ok('miku' in data().pending)
  await fireIntervals()
  A.equal(data().active, 'miku', '旧清单那一轮把这一版记成「处理过」,之后永远跳过')
  A.ok(log.notices.some((n) => /写好了「Miku」/.test(n.m)))
  d()
})
await t('模型库:坏 profile / 缺模型文件 / 没有 profile 的文件夹都进问题清单(不静默隐藏)', async () => {
  installDom()
  const { ctx, log, vault } = fullCtx()
  vault.set('Live3D/models/good/live3d.json', '{"live3d":1,"model":"a.glb"}')
  vault.set('Live3D/models/good/a.glb', new Uint8Array(4))
  vault.set('Live3D/models/bad/live3d.json', '{"live3d":1,"model":"../../etc/passwd.glb"}')
  vault.set('Live3D/models/gone/live3d.json', '{"live3d":1,"model":"missing.vrm"}')
  vault.set('Live3D/models/raw/thing.fbx', new Uint8Array(4))
  const d = load(main, ctx)
  await flush()
  const s = mkEl()
  log.settings[0].mount(s)
  await flush()
  const html = s.innerHTML
  A.match(html, /Live3D\/models\/bad\/live3d\.json/)
  A.match(html, /\.\./, '越界路径的原因没显示')
  A.match(html, /找不到模型文件「missing\.vrm」/)
  A.match(html, /Live3D\/models\/raw/)
  A.match(html, /<option value="good"/)
  d()
})

console.error = realConsole.error
console.warn = realConsole.warn
await t('节点桩里的控制台输出只有预期的「WebGL 建不出上下文」', () => {
  const other = consoleNoise.filter((l) => !/WebGL/.test(l))
  A.deepEqual(other, [], other.join('\n'))
})

// ── 6. 双语 ──────────────────────────────────────────────────────────────────
const { build } = await import('esbuild')
const bundled = await build({
  stdin: { contents: "export { MSG } from './src/i18n.ts'", resolveDir: ROOT, loader: 'ts' },
  bundle: true, format: 'esm', write: false, target: 'es2022', platform: 'neutral', logLevel: 'silent',
})
const { MSG } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
await t('i18n:zh / en 键集一致', () => {
  A.deepEqual(Object.keys(MSG.en).sort(), Object.keys(MSG.zh).sort())
})
await t('i18n:en 值不含汉字、不是空串', () => {
  for (const [k, v] of Object.entries(MSG.en)) A.ok(v && !HAN.test(v), `${k}: ${v}`)
})
await t('i18n:{占位符} zh / en 逐字一致', () => {
  const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
  for (const k of Object.keys(MSG.zh)) A.equal(ph(MSG.en[k]), ph(MSG.zh[k]), k)
})
await t('i18n:源码里 t(\'…\') 用到的键都在字典里', () => {
  const used = new Set([...src.matchAll(/\bt\('([a-zA-Z0-9.]+)'/g)].map((m) => m[1]))
  for (const k of used) A.ok(k in MSG.zh, `字典里没有 ${k}`)
})

// ── 7. 捆绑 Agent ────────────────────────────────────────────────────────────
const AGENT = 'agents/live3d-importer'
const toml = rd(`${AGENT}/config.toml`)
const skill = rd('skills/live3d-import/SKILL.md')
await t('Agent 目录名 = 源码里的 IMPORTER_AGENT(宿主只对自家捆绑 Agent 放行 send:true)', () => {
  const slug = /export const IMPORTER_AGENT = '([^']+)'/.exec(rd('src/ui/importer.ts'))?.[1]
  A.equal(`agents/${slug}`, AGENT)
})
await t('config.toml:version 带引号、必填键、auto-edit、推理档 medium、max_iterations 40、created_by user', () => {
  A.match(toml, /^version\s*=\s*"\d+\.\d+\.\d+"/m)
  A.match(toml, /^name\s*=\s*"Live3D Importer"/m)
  A.match(toml, /^description\s*=\s*".{20,}"/m)
  A.match(toml, /^approval_mode\s*=\s*"auto-edit"/m)
  A.match(toml, /^model_reasoning_effort\s*=\s*"medium"/m)
  A.match(toml, /^max_iterations\s*=\s*40$/m)
  A.match(toml, /^created_by\s*=\s*"user"/m)
})
await t("config.toml:developer_instructions 是 ''' 块且 ≥8 行、英文;没有禁用键", () => {
  const block = /developer_instructions\s*=\s*'''\n([\s\S]*?)'''/.exec(toml)?.[1] ?? ''
  A.ok(block.trim().split('\n').length >= 8, `只有 ${block.trim().split('\n').length} 行`)
  A.ok(!HAN.test(block), '模型读的指令必须是英文')
  A.match(block, /use_skill/)
  A.match(block, /live3d-import/)
  A.match(block, /run_python/)
  for (const k of ['tools', 'tools_mode', 'tools_list', 'enabled_skill_ids', 'created_at', 'cloud_sync']) {
    A.ok(!new RegExp(`^${k}\\s*=`, 'm').test(toml), `出现了禁用键 ${k}`)
  }
})
await t('Agent 目录:有 SOUL.md(英文);没有 MEMORY.md / LOG / 点文件', () => {
  const soul = rd(`${AGENT}/SOUL.md`)
  A.ok(soul.trim().length > 20 && !HAN.test(soul))
  for (const f of readdirSync(join(ROOT, AGENT))) A.ok(!/^(MEMORY\.md|LOG.*|\..*)$/.test(f), `不该随包带 ${f}`)
})
await t('全局技能:SKILL 在包根 skills/live3d-import/;agents/live3d-importer/ 里没有 skills/(agent 级同 id 副本播种后永远遮住全局版)', () => {
  A.ok(existsSync(join(ROOT, 'skills/live3d-import/SKILL.md')))
  A.ok(!existsSync(join(ROOT, AGENT, 'skills')), `${AGENT}/skills 不该存在`)
  A.deepEqual(readdirSync(join(ROOT, 'skills')).filter((f) => !f.startsWith('.')), ['live3d-import'])
})
await t('SKILL.md:任意 Agent 调用 —— 自己找工作文件夹、绝对路径不带 ~、只在 cwd 搜的工具别用、先 cd 再跑配方、别碰插件数据、上 Desk 的按钮与命令名(与 i18n 同源)', () => {
  const desc = /^description: (.+)$/m.exec(skill)?.[1] ?? ''
  for (const k of ['Live3D', 'Agent Desk', '.pmx', 'archive', 'file path']) A.ok(desc.includes(k), `description 缺触发词 ${k}(别的 Agent 只看得到这一行)`)
  A.match(skill, /`# Live3D`/)
  A.match(skill, /<vault>\/Live3D/)
  A.match(skill, /without `~`/)
  A.match(skill, /`search_files` and `glob_files` only search your cwd/)
  A.match(skill, /cd "<work folder>" && /)
  A.match(skill, /plugins-data\/live3d\.json/)
  A.match(skill, /## Step 0/)
  A.match(skill, /ignoring case/i)
  A.match(skill, /list_dir models\/<slug>` must show the files/, '插件那句提示词也会被手动粘进别的对话:「cwd = 工作文件夹」必须先核实')
  A.match(skill, /drop the last `\/models`/, '设置页显示的是 models 文件夹,不是工作文件夹')
  A.match(skill, /"<absolute path to the folder>\/\." "models\/<slug>\/"/, '拷文件夹要拷内容(…/.),否则模型多套一层')
  A.match(skill, /\*\*Windows:\*\* `run_bash` runs `cmd\.exe`/)
  A.match(skill, /tell the user the reason/)
  for (const k of ['cmd.openStudio', 'cmd.refresh', 'btn.useInDesk']) {
    A.ok(skill.includes(MSG.en[k]), `SKILL 没写英文界面名 ${MSG.en[k]}`)
    A.ok(skill.includes(MSG.zh[k]), `SKILL 没写中文界面名 ${MSG.zh[k]}`)
  }
})
await t('SKILL.md:frontmatter(name / description ≥40 字 / version / author / category)、≥50 行、## 分节', () => {
  A.match(skill, /^---\nname: .+\n/)
  A.match(skill, /^description: .{40,}$/m)
  A.match(skill, /^version: \d+\.\d+\.\d+$/m)
  A.match(skill, /^author: .+$/m)
  A.match(skill, /^category: .+$/m)
  A.ok(skill.split('\n').length >= 50)
  A.ok((skill.match(/^## /gm) || []).length >= 5)
  const fm = /^---\n([\s\S]*?)\n---/.exec(skill)[1]
  A.ok(!HAN.test(fm), 'frontmatter 必须英文')
})
await t('SKILL.md 写全了 profile.ts 的每个字段名、阶段名、构图 / 竖轴取值与扩展名(与校验器逐字同源)', () => {
  const prof = rd('src/profile.ts')
  const setOf = (name) => {
    const m = new RegExp(`const ${name} = new Set\\(\\[([^\\]]+)\\]\\)`).exec(prof)
    A.ok(m, `profile.ts 里找不到 ${name}`)
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  }
  const fields = [...setOf('KNOWN_TOP'), ...setOf('KNOWN_TRANSFORM'), ...setOf('KNOWN_STATE')]
  A.ok(fields.length >= 16, `只抽到 ${fields.length} 个字段`)
  for (const f of fields) A.ok(skill.includes(`\`${f}\``) || skill.includes(`\`transform.${f}\``), `SKILL.md 没写字段 ${f}`)
  const contract = rd('src/contract.ts')
  const list = (re) => [...(re.exec(contract)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1])
  for (const p of list(/export const PHASES = \[([^\]]+)\]/)) A.ok(skill.includes(`\`${p}\``), `SKILL.md 没写阶段 ${p}`)
  for (const v of list(/export const FRAMINGS[^=]*= \[([^\]]+)\]/)) A.ok(skill.includes(`"${v}"`), `SKILL.md 没写构图 ${v}`)
  for (const e of list(/export const MODEL_EXTS[^=]*= \[([^\]]+)\]/)) A.ok(skill.includes(`.${e}`), `SKILL.md 没写模型扩展名 .${e}`)
  for (const e of list(/export const MOTION_EXTS[^=]*= \[([^\]]+)\]/)) A.ok(skill.includes(`.${e}`), `SKILL.md 没写动作扩展名 .${e}`)
  A.match(skill, /"y"/)
  A.match(skill, /"z"/)
})
await t('SKILL.md 与工作文件夹 README:pose 的四个旋钮与缺省值跟 DEFAULT_POSE 逐字一致(改了缺省别忘了改文档)', () => {
  const m = /export const DEFAULT_POSE: ProfilePose = \{([^}]+)\}/.exec(rd('src/contract.ts'))
  A.ok(m, 'contract.ts 里找不到 DEFAULT_POSE')
  const pairs = [...m[1].matchAll(/(\w+):\s*([\d.]+)/g)].map((x) => [x[1], x[2]])
  A.equal(pairs.length, 4, `DEFAULT_POSE 抽到 ${pairs.length} 项`)
  const readme = rd('src/library.ts')
  for (const [k, v] of pairs) {
    A.ok(skill.includes(`\`${k}\``), `SKILL.md 没写 pose 旋钮 ${k}`)
    A.ok(skill.includes(`\`${v}\``), `SKILL.md 没写 ${k} 的缺省值 ${v}`)
    A.ok(readme.includes(`"${k}": ${v}`), `FOLDER_README 的例子里 ${k} 不是 ${v}`)
  }
  // 「看一眼截图再调一个数」这条来回是这个功能的主路径,技能里必须写着
  A.match(skill, /desk_screenshot/)
  A.ok(/Idle pose/.test(skill), 'SKILL.md 没有待机姿势那一节')
})
await t('SKILL.md:绑定 —— slug 不是显示名、多个形象认领同一个 Agent 按文件夹名字母序、空数组 = 不绑定', () => {
  A.ok(/## Binding/.test(skill), 'SKILL.md 没有绑定那一节')
  A.match(skill, /not its display name/)
  A.match(skill, /alphabetically/)
  A.ok(skill.includes('`agents`'), 'SKILL.md 没写 agents 字段')
  // slug 的形状必须和引擎 / 校验器同源,别在技能里另写一套
  A.match(skill, /lower-case letters, digits and hyphens/)
  A.ok(/isAgentSlug/.test(rd('src/contract.ts')), 'contract.ts 没有 isAgentSlug')
})
await t('SKILL.md 写了会做废的几条:别猜路径 / 别用 run_python / 别对 .vrm 跑 gltf-transform / Live2D 拒收 / 写完自动重载', () => {
  A.match(skill, /Never guess vault or home paths/)
  A.match(skill, /Amadeus Cloud/)
  A.match(skill, /Never use `run_python`/)
  A.match(skill, /Never run gltf-transform on a `\.vrm`/)
  A.match(skill, /Live2D/)
  A.match(skill, /reload/)
})

await t('SKILL.md 格式配方:命令里的文件路径都按工作文件夹写(models/<slug>/…)、不带覆盖参数(全文扫,含 Step 0 的 cd … && 命令)', () => {
  const step3 = skill.slice(skill.indexOf('## Step 3'), skill.indexOf('## Tools'))
  A.ok(step3.length > 500, '找不到 Step 3 一节')
  const body = skill.slice(skill.indexOf('\n---', 4)) // frontmatter 之后全文(Step 0 也有要跑的命令)
  // 行内代码里以这些命令开头、且带着文件参数(有扩展名)的,才算「要跑的命令」;「别用 `unzip -o`」这种点名不算
  const cmds = [...body.matchAll(/`((?:cd|unzip|ditto|tar|mkdir|7z|cp|blender|npx)\b[^`]*)`/g)].map((m) => m[1]).filter((c) => /\.[a-z0-9]{2,5}\b/i.test(c))
  A.ok(cmds.length >= 8, `只抽到 ${cmds.length} 条命令:${cmds.join(' || ')}`)
  for (const c of cmds) {
    A.ok(c.includes('models/<slug>/'), `命令没按工作文件夹写路径(会读写别处):${c}`)
    A.ok(!/^cd\b/.test(c) || /^cd "<work folder>" && /.test(c), `cd 只许进工作文件夹:${c}`)
    A.ok(!/\bmkdir\s+-p\b/.test(c), `建模型文件夹不许 -p(已存在时要失败,别把两个模型混进一个文件夹):${c}`)
    A.ok(!/^unzip\b.*\s-o\b|\s-aoa\b|^7z\b.*\s-y\b|^cp\b.*\s-f\b/.test(c), `命令带覆盖参数:${c}`)
    A.ok(!/\btar\s+-x/.test(c) || /\btar\s+-x[a-z]*k/.test(c), `tar 解压没带 -k(会覆盖已有文件):${c}`)
    A.ok(!/\s-d\s+\.(\s|$)|\s-o\.(\s|$)/.test(c), `解压到当前目录(= 工作文件夹根):${c}`)
  }
  A.match(step3, /never use overwrite flags/i)
})

// ── 8. 打包 ──────────────────────────────────────────────────────────────────
await t('install.sh:缺省 dev、prod 须显式;拒绝从已安装目录运行;先跑 check;cp 不 ln;拷 skills/ 与 agents/', () => {
  const sh = rd('install.sh')
  A.match(sh, /MODE="\$\{1:-dev\}"/)
  A.match(sh, /prod\)\s+HOME_DIR="\$HOME\/\.forsion"/)
  A.match(sh, /正在从已安装目录运行/)
  A.match(sh, /node "\$HERE\/check\.mjs" \|\|/)
  const code = sh.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  // 按去掉注释的正文、锚定目标 $DEST/ 断言(注释掉的 cp、拷进 agents/<slug>/ 造出遮蔽副本都得红)
  A.match(code, /^cp -R "\$HERE\/agents" "\$DEST\/" \|\| exit 1$/m)
  A.match(code, /^cp -R "\$HERE\/skills" "\$DEST\/" \|\| exit 1$/m)
  // 迁移:原样的旧 agent 级副本要删(指纹核对),改过的只警告
  A.match(code, /OLD="\$HOME_DIR\/tangu\/agents\/live3d-importer\/skills\/live3d-import"/)
  A.match(code, /\.seed-stamp/)
  A.ok(!/\bln\s+-s/.test(code), '出现了 ln -s —— 引擎会丢弃符号链接的捆绑目录')
  for (const f of ['main.js', 'manifest.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'icon.png']) A.ok(sh.includes(f), `install.sh 没拷 ${f}`)
})
await t('icon.png:PNG、正方、64–512px、≤256KB', () => {
  const buf = readFileSync(join(ROOT, 'icon.png'))
  A.ok(buf.length <= 256 * 1024, `${buf.length} 字节`)
  A.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20)
  A.equal(w, h)
  A.ok(w >= 64 && w <= 512, `${w}px`)
})
await t('随包文件齐全:README 中文在前 + English 节、LICENSE 是 MIT、.gitignore 排除 node_modules', () => {
  const readme = rd('README.md')
  A.ok(HAN.test(readme.slice(0, 200)), 'README 开头应是中文')
  A.match(readme, /^## English$/m)
  A.match(rd('LICENSE'), /MIT License[\s\S]*2026 Forsion/)
  A.match(rd('.gitignore'), /node_modules/)
  A.ok(existsSync(join(ROOT, 'package-lock.json')))
})
await t('样式纪律:不写 ::-webkit-scrollbar、不用不存在的 --text-secondary、不占 .agent-desk-card、侧板工具条 no-drag', () => {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '') // 顶注里写着「禁写 …」,先剥注释
  A.ok(!/::-webkit-scrollbar/.test(bare))
  A.ok(!/var\(--text-secondary/.test(bare + src))
  A.ok(!/\.agent-desk-card/.test(bare))
  A.match(css, /\.l3-toolbar\s*\{[^}]*-webkit-app-region:\s*no-drag/s)
})

// ── 9. P1 的纯模块单测 ───────────────────────────────────────────────────────
await t('纯模块单测(scripts/unit.mjs:profile 好坏含越界、启发式、7 阶段反应、口型包络)全绿', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/unit.mjs')], { encoding: 'utf8' })
  const m = /(\d+)\/(\d+) passed/.exec(r.stdout)
  A.ok(m, `unit.mjs 没有输出汇总:\n${(r.stdout + r.stderr).slice(-400)}`)
  A.equal(r.status, 0, `unit.mjs 失败:\n${r.stdout.split('\n').filter((l) => l.startsWith('FAIL')).join('\n')}`)
  A.equal(m[1], m[2])
  A.ok(Number(m[2]) >= 40, `只有 ${m[2]} 条单测`)
  console.log(`      (unit.mjs ${m[1]}/${m[2]})`)
})

console.log(`\n${TOTAL - fail.length}/${TOTAL} 通过`)
if (fail.length) {
  console.log('未通过:\n  ' + fail.join('\n  '))
  process.exit(1)
}
process.exit(0)
