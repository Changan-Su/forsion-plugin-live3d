/**
 * 渲染冒烟(开发用,不随包发布):`node scripts/render-smoke.mjs [--only robot,vrm0] [--keep-open]`
 *
 * 在**真 Chromium**(playwright-core,取自 Forsion-Genesis/desktop/node_modules;不启动 Electron)里:
 *  1. 用桌面端 frontend/index.html 的 CSP 原样起一页(外加本机静态服务器的来源),两种变体:
 *     strict = 当前 CSP(connect-src 没有 blob:/data:,老宿主)/ open = 编排方加了 `blob: data:` 的新 CSP;
 *  2. 贴图检查:每个带贴图的样例用 loadModel 读一遍,数「材质 map 有图」的数量;**负对照**:strict 下关掉
 *     CSP 贴图兜底(textureHook:false),内嵌贴图的样例必须变成 0 —— 否则「有贴图」什么也证明不了;
 *  3. 渲染:卡片(280×394 视觉像素,正文 zoom:0.75,浅底)+ 侧板(640×820,深底)各一个 stage,
 *     每个样例走一遍 7 个阶段,断言无页面错误、画布中心区不是空白,截图到 scratchpad/live3d-shots/;
 *  4. main.js 能被 new Function('ctx', …) 构造且执行时不抛 Invalid URL(DRACO/KTX2 的 import.meta 坑)。
 *  5. 合成模型段(`--only rig` 单跑;scripts/render-smoke-rig.ts):逐帧量骨骼角度 —— 常量 / 单帧 / 停顿片段每帧都是片段
 *     姿势(不回静止姿势)、摘下重挂第一帧不闪、一次性片段播完平滑放下;口型说完收回 0(jawOpen / VRM 自定义 'oh');
 *     卡片 30fps 封顶 × 75Hz 屏不慢放;小球跟 --accent 变色;FBX 内嵌贴图的 blob: 全部撤销且贴图照画;模型里的
 *     http(s) 引用零请求 + 警告;只在 extensionsUsed 里的 Draco 给双语拒绝。
 *     **负对照**:`LIVE3D_SRC_ROOT=<旧源码目录> node scripts/render-smoke.mjs --only rig` 用同一份台架测旧代码,这些断言必须红。
 *
 * 样例模型不进仓库:缺哪个就按下面 SOURCES 的地址下载到 SAMPLES_DIR,再硬链接进一个临时库目录。
 * helmet-embedded 是脚本现场把 DamagedHelmet 的 .bin 与贴图全转成 data: URI 生成的 glTF-Embedded(测老宿主 CSP 下
 * 的内存转 GLB 那条路)。
 * 环境变量:LIVE3D_SCRATCH(缺省 <tmpdir>/live3d-smoke)/ LIVE3D_SAMPLES / LIVE3D_SHOTS 覆盖目录;
 * CHROMIUM_EXE 指定浏览器;LIVE3D_GL=swiftshader 走软件渲染。
 * LIVE3D_PMX_SAMPLE=<某个 .pmx 的绝对路径>:把它所在的整个文件夹当 `pmx` 样例加进来(MMD 模型普遍「禁止二次配布」,
 *     所以不进 SOURCES、不进仓库;不设就跳过这一段)。
 */
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, linkSync, copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { join, dirname, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { inflateSync, deflateSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRATCH = process.env.LIVE3D_SCRATCH || join(tmpdir(), 'live3d-smoke')
const SAMPLES_DIR = process.env.LIVE3D_SAMPLES || join(SCRATCH, 'samples')
const SHOTS_DIR = process.env.LIVE3D_SHOTS || join(SCRATCH, 'shots')
const WORK = join(SCRATCH, 'work')
const VAULT = join(WORK, 'vault')
const GENESIS_DESKTOP = join(ROOT, '..', '..', 'Forsion-Genesis', 'desktop')
/** 被测源码的根(缺省本仓;负对照时指向旧源码的拷贝 —— 那边没有 node_modules,依赖仍从本仓解析)。 */
const SRC_ROOT = process.env.LIVE3D_SRC_ROOT || ROOT
const args = process.argv.slice(2)
const only = (() => {
  const i = args.indexOf('--only')
  return i >= 0 ? new Set(args[i + 1].split(',')) : null
})()

// ── 样例 ─────────────────────────────────────────────────────────────────────
/** 样例来源(授权:three.js 示例 / pixiv three-vrm 示例 / Khronos 样例;只做本机测试,不随包分发)。 */
const R170 = 'https://raw.githubusercontent.com/mrdoob/three.js/r170/examples/models'
const SOURCES = {
  'RobotExpressive.glb': `${R170}/gltf/RobotExpressive/RobotExpressive.glb`,
  'Xbot.glb': `${R170}/gltf/Xbot.glb`,
  'Soldier.glb': `${R170}/gltf/Soldier.glb`,
  'Samba Dancing.fbx': `${R170}/fbx/Samba%20Dancing.fbx`,
  'VRM1_Constraint_Twist_Sample.vrm': 'https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm',
  'three-vrm-girl.vrm': 'https://raw.githubusercontent.com/pixiv/three-vrm/v0.6.11/packages/three-vrm/examples/models/three-vrm-girl.vrm',
  'test.vrma': 'https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages/three-vrm-animation/examples/models/test.vrma',
  ...Object.fromEntries(['DamagedHelmet.gltf', 'DamagedHelmet.bin', 'Default_AO.jpg', 'Default_albedo.jpg', 'Default_emissive.jpg', 'Default_metalRoughness.jpg', 'Default_normal.jpg']
    .map((f) => [`DamagedHelmet/${f}`, `${R170}/gltf/DamagedHelmet/glTF/${f}`])),
  ...Object.fromEntries(['male02.obj', 'male02.mtl', '01_-_Default1noCulling.JPG', 'male-02-1noCulling.JPG', 'orig_02_-_Defaul1noCulling.JPG']
    .map((f) => [`male02/${f}`, `${R170}/obj/male02/${f}`])),
}

/** textured:模型本身带贴图;embedded:贴图在 GLB/VRM 的 bufferView 里(走 blob:,负对照针对它)。 */
const SAMPLES = [
  { slug: 'orb' },
  { slug: 'robot', model: 'RobotExpressive.glb', files: ['RobotExpressive.glb'] },
  { slug: 'xbot', model: 'Xbot.glb', files: ['Xbot.glb'] },
  { slug: 'soldier', model: 'Soldier.glb', files: ['Soldier.glb'], textured: true, embedded: true },
  { slug: 'samba', model: 'Samba Dancing.fbx', files: ['Samba Dancing.fbx'] },
  { slug: 'vrm1', model: 'VRM1_Constraint_Twist_Sample.vrm', files: ['VRM1_Constraint_Twist_Sample.vrm', 'test.vrma'], motions: ['test.vrma'], textured: true, embedded: true, vrmaDone: true },
  // mouthOh:说话用自定义口型 'oh'(不是缺省 'aa')—— 说完后的 tool 截图里嘴必须合上
  { slug: 'vrm0', model: 'three-vrm-girl.vrm', files: ['three-vrm-girl.vrm', 'test.vrma'], motions: ['test.vrma'], textured: true, embedded: true, vrmaDone: true, mouthOh: true },
  { slug: 'helmet', model: 'DamagedHelmet.gltf', dir: 'DamagedHelmet', files: ['DamagedHelmet.gltf', 'DamagedHelmet.bin', 'Default_AO.jpg', 'Default_albedo.jpg', 'Default_emissive.jpg', 'Default_metalRoughness.jpg', 'Default_normal.jpg'], textured: true },
  { slug: 'male02', model: 'male02.obj', dir: 'male02', files: ['male02.obj', 'male02.mtl', '01_-_Default1noCulling.JPG', 'male-02-1noCulling.JPG', 'orig_02_-_Defaul1noCulling.JPG'], textured: true },
  { slug: 'helmet-embedded', model: 'DamagedHelmet-embedded.gltf', generated: true, textured: true, embedded: true },
  ...(process.env.LIVE3D_PMX_SAMPLE ? [{ slug: 'pmx', model: basename(process.env.LIVE3D_PMX_SAMPLE), copyDir: dirname(process.env.LIVE3D_PMX_SAMPLE), textured: true, mmd: true }] : []),
].filter((s) => !only || only.has(s.slug))
const RIG = !only || only.has('rig')

// ── 准备:下载缺的样例 → 临时库 ──────────────────────────────────────────────
rmSync(WORK, { recursive: true, force: true })
mkdirSync(SHOTS_DIR, { recursive: true })
for (const [rel, url] of Object.entries(SOURCES)) {
  const f = join(SAMPLES_DIR, rel)
  if (existsSync(f)) continue
  mkdirSync(dirname(f), { recursive: true })
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`)
  writeFileSync(f, Buffer.from(await res.arrayBuffer()))
  console.log(`downloaded ${rel}`)
}
for (const s of SAMPLES) {
  if (s.generated) {
    // glTF-Embedded:把 DamagedHelmet 的 .bin 与贴图全塞成 data: URI
    const src = join(SAMPLES_DIR, 'DamagedHelmet')
    const json = JSON.parse(readFileSync(join(src, 'DamagedHelmet.gltf'), 'utf8'))
    for (const b of json.buffers) b.uri = 'data:application/octet-stream;base64,' + readFileSync(join(src, b.uri)).toString('base64')
    for (const im of json.images ?? []) if (im.uri) im.uri = 'data:image/jpeg;base64,' + readFileSync(join(src, decodeURIComponent(im.uri))).toString('base64')
    const dest = join(VAULT, 'Live3D', 'models', s.slug)
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, s.model), JSON.stringify(json))
    continue
  }
  if (s.copyDir) {
    cpSync(s.copyDir, join(VAULT, 'Live3D', 'models', s.slug), { recursive: true })
    continue
  }
  if (!s.files) continue
  const dest = join(VAULT, 'Live3D', 'models', s.slug)
  mkdirSync(dest, { recursive: true })
  for (const f of s.files) {
    const src = join(SAMPLES_DIR, s.dir ?? '', f)
    if (!existsSync(src)) throw new Error(`missing sample ${src} — see ${join(SAMPLES_DIR, 'SOURCES.md')}`)
    try {
      linkSync(src, join(dest, f))
    } catch {
      copyFileSync(src, join(dest, f))
    }
  }
}

// ── 合成模型段的夹具(现场生成,不进仓库)────────────────────────────────────────
/** 4×4 纯色 PNG。 */
function tinyPng(rgb) {
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) } return ~c >>> 0 }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = []
  for (let y = 0; y < 4; y++) { raw.push(0); for (let x = 0; x < 4; x++) raw.push(...rgb) }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from(raw))), chunk('IEND', Buffer.alloc(0))])
}
/** 最小二进制 FBX 7400:一个四边形 + 一张**内嵌**的 4×4 红色 PNG(Video.Content)—— FBXLoader.parseImage 的 blob: 分支。 */
function fbxWithEmbeddedTexture() {
  const P = {
    S: (s) => { const b = Buffer.from(s, 'utf8'); const h = Buffer.alloc(5); h.write('S'); h.writeUInt32LE(b.length, 1); return Buffer.concat([h, b]) },
    R: (b) => { const h = Buffer.alloc(5); h.write('R'); h.writeUInt32LE(b.length, 1); return Buffer.concat([h, b]) },
    L: (n) => { const b = Buffer.alloc(9); b.write('L'); b.writeBigInt64LE(BigInt(n), 1); return b },
    I: (n) => { const b = Buffer.alloc(5); b.write('I'); b.writeInt32LE(n, 1); return b },
    d: (a) => { const b = Buffer.alloc(13 + 8 * a.length); b.write('d'); b.writeUInt32LE(a.length, 1); b.writeUInt32LE(0, 5); b.writeUInt32LE(8 * a.length, 9); a.forEach((v, i) => b.writeDoubleLE(v, 13 + 8 * i)); return b },
    i: (a) => { const b = Buffer.alloc(13 + 4 * a.length); b.write('i'); b.writeUInt32LE(a.length, 1); b.writeUInt32LE(0, 5); b.writeUInt32LE(4 * a.length, 9); a.forEach((v, j) => b.writeInt32LE(v, 13 + 4 * j)); return b },
  }
  const node = (name, props = [], children = []) => ({ name, props, children })
  const NUL = Buffer.alloc(13)
  const enc = (n, offset) => {
    const props = Buffer.concat(n.props)
    const nameB = Buffer.from(n.name, 'ascii')
    let cur = offset + 13 + nameB.length + props.length
    const kids = []
    for (const c of n.children) { const b = enc(c, cur); kids.push(b); cur += b.length }
    if (n.children.length) { kids.push(NUL); cur += 13 }
    const h = Buffer.alloc(13)
    h.writeUInt32LE(cur, 0); h.writeUInt32LE(n.props.length, 4); h.writeUInt32LE(props.length, 8); h[12] = nameB.length
    return Buffer.concat([h, nameB, props, ...kids])
  }
  const nodes = [
    node('Objects', [], [
      node('Geometry', [P.L(100), P.S('quad'), P.S('Mesh')], [
        node('Vertices', [P.d([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0])]),
        node('PolygonVertexIndex', [P.i([0, 1, 2, -4])]),
        node('LayerElementUV', [P.I(0)], [
          node('MappingInformationType', [P.S('ByPolygonVertex')]), node('ReferenceInformationType', [P.S('IndexToDirect')]),
          node('UV', [P.d([0, 0, 1, 0, 1, 1, 0, 1])]), node('UVIndex', [P.i([0, 1, 2, 3])]),
        ]),
      ]),
      node('Model', [P.L(200), P.S('quad'), P.S('Mesh')], [node('Version', [P.I(232)])]),
      node('Material', [P.L(300), P.S('mat'), P.S('')], [node('ShadingModel', [P.S('phong')])]),
      node('Texture', [P.L(400), P.S('tex'), P.S('')], [node('FileName', [P.S('tex.png')]), node('RelativeFilename', [P.S('tex.png')])]),
      node('Video', [P.L(500), P.S('tex'), P.S('Clip')], [node('RelativeFilename', [P.S('tex.png')]), node('Content', [P.R(tinyPng([255, 0, 0]))])]),
    ]),
    node('Connections', [], [
      node('C', [P.S('OO'), P.L(200), P.L(0)]), node('C', [P.S('OO'), P.L(100), P.L(200)]), node('C', [P.S('OO'), P.L(300), P.L(200)]),
      node('C', [P.S('OP'), P.L(400), P.L(300), P.S('DiffuseColor')]), node('C', [P.S('OO'), P.L(500), P.L(400)]),
    ]),
  ]
  const header = Buffer.alloc(27)
  header.write('Kaydara FBX Binary  \x00\x1a\x00', 'latin1'); header.writeUInt32LE(7400, 23)
  let off = 27
  const parts = [header]
  for (const n of nodes) { const b = enc(n, off); parts.push(b); off += b.length }
  parts.push(NUL, Buffer.alloc(208))
  return Buffer.concat(parts)
}
/** 一个三角形的 .gltf(数据 buffer 用 data:)。opts:imageUri(贴图)、bufferUri(外部 buffer)、extensionsUsed。 */
function triangleGltf({ imageUri, bufferUri, extensionsUsed } = {}) {
  const bin = Buffer.alloc(60)
  ;[0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => bin.writeFloatLE(v, i * 4))
  ;[0, 0, 1, 0, 0, 1].forEach((v, i) => bin.writeFloatLE(v, 36 + i * 4))
  const g = {
    asset: { version: '2.0' },
    ...(extensionsUsed ? { extensionsUsed } : {}),
    buffers: [{ byteLength: 60, uri: bufferUri ?? 'data:application/octet-stream;base64,' + bin.toString('base64') }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 24 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, ...(imageUri ? { material: 0 } : {}) }] }],
    ...(imageUri ? { materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }], textures: [{ source: 0 }], images: [{ uri: imageUri }] } : {}),
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  }
  return JSON.stringify(g)
}
/** 模型里写死的联网引用落到这个本机服务器上 —— 数一下被请求了几次(应为 0)。 */
let beaconHits = 0
const RT = join(VAULT, 'Live3D', 'models', 'rt')
if (RIG) {
  mkdirSync(RT, { recursive: true })
  writeFileSync(join(RT, 'embedded-tex.fbx'), fbxWithEmbeddedTexture())
  writeFileSync(join(RT, 'draco-used.gltf'), triangleGltf({ extensionsUsed: ['KHR_draco_mesh_compression'] }))
  writeFileSync(join(RT, 'basisu-used.gltf'), triangleGltf({ extensionsUsed: ['KHR_texture_basisu'] }))
}

// ── 打冒烟包 ─────────────────────────────────────────────────────────────────
const ENTRY = `
import { createStage } from './src/stage'
import { loadModel, registerModelKind } from './src/loaders'
import { createRigHarness } from ${JSON.stringify(join(ROOT, 'scripts', 'render-smoke-rig.ts'))}
import { analyze, collectTextures, textureHasImage } from './src/analysis'
import { parseProfile, serializeProfile, defaultProfileFor } from './src/profile'
import { PHASES } from './src/contract'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const assetUrl = (rel: string) => location.origin + '/vault/' + rel.split('/').map(encodeURIComponent).join('/')
let stages: any[] = []
let chars = 0
// 数 rAF 调用(页面里只有 stage 在用 rAF):暂停策略的仪器
let rafCalls = 0
const origRaf = window.requestAnimationFrame.bind(window)
window.requestAnimationFrame = (cb: FrameRequestCallback) => { rafCalls++; return origRaf(cb) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const rafRate = async (ms = 500) => { await sleep(250); const a = rafCalls; await sleep(ms); return rafCalls - a }

;(window as any).__l3 = {
  PHASES,
  async textureCheck(path: string, motions: string[], hook: boolean) {
    const m = await loadModel({ path, motionPaths: motions, assetUrl, textureHook: hook })
    let mats = 0
    let withMap = 0
    m.root.traverse((o: any) => {
      for (const mat of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
        mats++
        const map = mat.map
        if (map && map.image && (map.image.naturalWidth || map.image.width) > 0) withMap++
      }
    })
    const textures = [...collectTextures(m.root)].filter(textureHasImage).length
    const out = { mats, withMap, textures, warnings: m.warnings, clips: m.clips.map((c: any) => c.name) }
    m.dispose()
    return out
  },
  /** 负对照:不经 embeddedGltfToGlb、直接交给原版 GLTFLoader 的结果('ok' / 错误信息)。 */
  async stockGltf(path: string) {
    const buf = await (await fetch(assetUrl(path))).arrayBuffer()
    try {
      await new GLTFLoader().parseAsync(buf, '')
      return 'ok'
    } catch (e: any) {
      return 'fail: ' + String(e?.message ?? e).slice(0, 120)
    }
  },
  async mount(s: any) {
    for (const st of stages) st.dispose()
    chars = 0
    const card = createStage({ surface: 'card', interactive: false, assetUrl })
    const panel = createStage({ surface: 'panel', interactive: true, assetUrl })
    card.attach(document.getElementById('card-body')!)
    panel.attach(document.getElementById('panel')!)
    stages = [card, panel]
    if (!s.model) {
      for (const st of stages) await st.setProfile(null)
      return { ok: true, analysis: null }
    }
    const dir = 'Live3D/models/' + s.slug
    // ① 最小 profile → 加载 + 体检;② 按体检生成缺省 profile → 序列化 → 再解析 → 套上(同模型不重载)
    const first = parseProfile(JSON.stringify({ live3d: 1, model: s.model, motions: s.motions ?? [] }), dir)
    if (!first.ok) return { ok: false, where: 'parse1', err: first }
    const r = await card.setProfile(first.value)
    if (!r.ok) return { ok: false, where: 'load', err: r }
    const prof = defaultProfileFor(s.model, r.analysis, s.motions ?? [])
    if (s.vrmaDone) prof.states.done = { ...(prof.states.done ?? {}), clip: 'test', once: true }
    if (s.mouthOh) prof.states.speaking = { ...(prof.states.speaking ?? {}), mouth: 'oh' }
    const text = serializeProfile(prof)
    const second = parseProfile(text, dir)
    if (!second.ok) return { ok: false, where: 'parse2', err: second, text }
    const r2 = await card.setProfile(second.value)
    const r3 = await panel.setProfile(second.value)
    if (!r2.ok || !r3.ok) return { ok: false, where: 'reapply', err: r2.ok ? r3 : r2 }
    return { ok: true, analysis: r2.analysis, profile: text }
  },
  setPhase(phase: string) {
    for (const st of stages) {
      st.setStatus({ phase, sessionId: 's1', textChars: chars, messageId: 'm1' })
      st.setStatusSource(phase === 'speaking' ? () => ({ phase, sessionId: 's1', messageId: 'm1', textChars: (chars += 3) }) : null)
    }
  },
  async snapshot() {
    const b = await stages[1].snapshot()
    return b ? b.size : 0
  },
  dispose() {
    for (const st of stages) st.dispose()
    stages = []
  },
  /** 生命周期:暂停 / 恢复 / 搬家 / 取代 / 错误码 / 重复 dispose。 */
  async lifecycle(vrmProfileText: string) {
    for (const st of stages) st.dispose()
    stages = []
    const out: Record<string, unknown> = {}
    const cardBody = document.getElementById('card-body')!
    const panel = document.getElementById('panel')!
    const st = createStage({ surface: 'card', interactive: false, assetUrl })
    st.attach(cardBody)
    await st.setProfile(null)
    out.visibleRate = await rafRate()
    cardBody.style.display = 'none'
    out.hiddenRate = await rafRate()
    cardBody.style.display = ''
    out.reshownRate = await rafRate()
    st.detach()
    out.detachedRate = await rafRate()
    out.canvasAfterDetach = cardBody.querySelectorAll('canvas').length
    st.attach(panel, { surface: 'panel' })
    out.movedRate = await rafRate()
    out.canvasInPanel = panel.querySelectorAll('canvas').length
    const parsed = parseProfile(vrmProfileText, 'Live3D/models/vrm1')
    if (parsed.ok) {
      const p1 = st.setProfile(parsed.value)
      const p2 = st.setProfile(null)
      out.superseded = ((await p1) as any).code
      out.nullAfter = (await p2).ok
    }
    const codeOf = async (path: string) => { try { await loadModel({ path, assetUrl }); return 'loaded' } catch (e: any) { return e.code + '|' + (e.zh ? 'zh' : '') + '|' + (e.en ? 'en' : '') } }
    out.live2d = await codeOf('Live3D/models/x/hiyori.model3.json')
    out.missing = await codeOf('Live3D/models/x/missing.vrm')
    out.unsupported = await codeOf('Live3D/models/x/model.blend')
    const bad = await st.setProfile({ ...(parsed as any).value, modelPath: 'Live3D/models/x/missing.vrm' })
    out.badProfile = (bad as any).code
    st.dispose()
    st.dispose()
    out.canvasAfterDispose = panel.querySelectorAll('canvas').length
    out.disposedRate = await rafRate()
    return out
  },
  rig: createRigHarness({ createStage, loadModel, registerModelKind, assetUrl }),
}
`
mkdirSync(WORK, { recursive: true })
await build({
  stdin: { contents: ENTRY, resolveDir: SRC_ROOT, loader: 'ts' },
  nodePaths: [join(ROOT, 'node_modules')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: join(WORK, 'live3d-smoke.js'),
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': '"https://invalid.local/x/"' },
  logLevel: 'warning',
})

// ── CSP ──────────────────────────────────────────────────────────────────────
const hostHtml = readFileSync(join(GENESIS_DESKTOP, 'frontend', 'index.html'), 'utf8')
const cspMatch = hostHtml.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)
if (!cspMatch) throw new Error('could not find the CSP meta in Forsion-Genesis/desktop/frontend/index.html')
const HOST_CSP = cspMatch[1]
const withConnect = (csp, extra) => csp.replace(/connect-src ([^;]*);/, (_, v) => `connect-src ${v.split(/\s+/).filter((x) => !extra.includes(x)).join(' ')}${extra.length ? ' ' + extra.join(' ') : ''};`)
// 本机静态服务器是 http://127.0.0.1:PORT,和页面同源 → 'self' 已覆盖 script/img/connect;宿主 CSP 本来也放行 http://127.0.0.1:*。
const CSPS = {
  strict: withConnect(HOST_CSP, []).replace(/connect-src ([^;]*)/, (m) => m.replace(/\s(blob:|data:)/g, '')),
  open: withConnect(HOST_CSP, ['blob:', 'data:']),
}
const hostAlreadyOpen = /connect-src[^;]*\bblob:/.test(HOST_CSP)

// ── 静态服务器 ───────────────────────────────────────────────────────────────
const MIME = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.json': 'application/json', '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary' }
const page = readFileSync(join(ROOT, 'scripts', 'render-smoke.html'), 'utf8')
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const send = (code, body, type = 'text/plain') => {
    res.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*' })
    res.end(body)
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const csp = CSPS[url.searchParams.get('csp') || 'strict']
    return send(200, page.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${csp}" />`), 'text/html')
  }
  if (url.pathname === '/live3d-smoke.js') return send(200, readFileSync(join(WORK, 'live3d-smoke.js')), MIME['.js'])
  if (url.pathname.startsWith('/beacon')) {
    beaconHits++
    return send(200, tinyPng([0, 255, 0]), 'image/png')
  }
  if (url.pathname === '/main.js') return send(200, readFileSync(join(ROOT, 'main.js')), MIME['.js'])
  if (url.pathname.startsWith('/vault/')) {
    const rel = decodeURIComponent(url.pathname.slice('/vault/'.length))
    if (rel.split('/').includes('..')) return send(403, 'no')
    const f = join(VAULT, rel)
    if (!existsSync(f) || !statSync(f).isFile()) return send(404, 'not found')
    return send(200, readFileSync(f), MIME[extname(f).toLowerCase()] || 'application/octet-stream')
  }
  send(404, 'not found')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const ORIGIN = `http://127.0.0.1:${server.address().port}`
if (RIG) {
  // 联网引用:贴图与 buffer 都指向本机服务器的 /beacon*(页面 CSP 放行 127.0.0.1:旧代码真的会去请求)
  writeFileSync(join(RT, 'beacon-image.gltf'), triangleGltf({ imageUri: `${ORIGIN}/beacon.png` }))
  writeFileSync(join(RT, 'beacon-buffer.gltf'), triangleGltf({ bufferUri: `${ORIGIN}/beacon.bin` }))
}

// ── PNG 解码(只为像素检查;Playwright 截图 = 8 位 RGB/RGBA、无隔行) ─────────────────
function decodePng(buf) {
  let off = 8
  let w = 0, h = 0, ct = 0
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      ct = data[9]
    } else if (type === 'IDAT') idat.push(data)
    off += 12 + len
  }
  const bpp = ct === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const out = Buffer.alloc(w * h * 4)
  const stride = w * bpp
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v = line[x]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      line[x] = v & 255
    }
    for (let x = 0; x < w; x++) {
      out[(y * w + x) * 4] = line[x * bpp]
      out[(y * w + x) * 4 + 1] = line[x * bpp + 1]
      out[(y * w + x) * 4 + 2] = line[x * bpp + 2]
      out[(y * w + x) * 4 + 3] = bpp === 4 ? line[x * bpp + 3] : 255
    }
    prev = line
  }
  return { w, h, data: out }
}
/** 两张同尺寸截图里明显不同(任一通道差 > 24)的像素占比。 */
function pixelDiff(a, b) {
  const A = decodePng(a)
  const B = decodePng(b)
  if (A.w !== B.w || A.h !== B.h) return 1
  let hit = 0
  for (let i = 0; i < A.data.length; i += 4) {
    if (Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2])) > 24) hit++
  }
  return hit / (A.w * A.h)
}
/** 中心区(宽 60%、高 70%)里和背景色差 > 24 的像素占比。 */
function coverage(png, bg) {
  const { w, h, data } = decodePng(png)
  let n = 0, hit = 0
  for (let y = Math.floor(h * 0.15); y < h * 0.85; y++) {
    for (let x = Math.floor(w * 0.2); x < w * 0.8; x++) {
      const i = (y * w + x) * 4
      n++
      if (Math.max(Math.abs(data[i] - bg[0]), Math.abs(data[i + 1] - bg[1]), Math.abs(data[i + 2] - bg[2])) > 24) hit++
    }
  }
  return hit / n
}

/** 截图里「明显不是背景」的像素的平均颜色。 */
function meanFg(png, bg) {
  const { w, h, data } = decodePng(png)
  let n = 0, r = 0, g = 0, b = 0
  for (let i = 0; i < w * h * 4; i += 4) {
    if (Math.max(Math.abs(data[i] - bg[0]), Math.abs(data[i + 1] - bg[1]), Math.abs(data[i + 2] - bg[2])) <= 60) continue
    n++; r += data[i]; g += data[i + 1]; b += data[i + 2]
  }
  return n ? [r / n, g / n, b / n].map(Math.round) : [0, 0, 0]
}
const dominant = (rgb) => ['r', 'g', 'b'][rgb.indexOf(Math.max(...rgb))]

// ── 合成模型段 ───────────────────────────────────────────────────────────────
async function rigChecks(pg, errors, setTag) {
  console.log('\n== rig(合成模型:骨骼 / 口型 / 帧间隔 / 小球颜色 / blob / 联网引用 / Draco)')
  const before = errors.length
  const rig = (fn, ...a) => pg.evaluate(([f, a]) => window.__l3.rig[f](...a), [fn, a])
  setTag('rig:pose')
  for (const kind of ['constant', 'singlekey', 'hold']) {
    const r = await rig('pose', kind)
    const lo = kind === 'hold' ? 35 : 70
    check(`[rig] ${kind} 片段:每一帧都是片段姿势,不回静止姿势(T-pose ≈ 1°)`, r.frames >= 20 && r.min >= lo, `frames ${r.frames}, arm ${r.min}°..${r.max}°(下限 ${lo}°)`)
  }
  setTag('rig:idlepose')
  const ip = await rig('idlePose')
  // 「手臂被钉死」正是 09-20 之前用户说的「默认动作很怪」。旧代码里手臂只被躯干带着动 0.6~1.1°,新代码 1.8~2.2°。
  // (lockstep = 左右仰角的相关系数,只作诊断量印出来:旧代码 -0.7、新代码 0.29,区分度不够稳,不当断言。)
  check('[rig] 待机姿势:没有片段时手臂自己在摆(≥1.5°,不是被躯干带的那一点)', ip.moveL > 1.5 && ip.moveR > 1.5, JSON.stringify(ip))
  check('[rig] 待机姿势:手肘有弯曲(不是直挺挺一根棍)', ip.baseElbow > 8, JSON.stringify(ip))
  check('[rig] 待机姿势:liveliness 0 = 站着完全不动(上一条的负对照)', ip.stillMove < 0.05, JSON.stringify(ip))
  check('[rig] 待机姿势:armSpread 调大 → 手离身体中线更远', ip.wideHandX > ip.stillHandX + 0.05, JSON.stringify(ip))
  check('[rig] 待机姿势:elbow 调大 → 上臂与前臂夹角更大', ip.bentElbow > ip.baseElbow + 15, JSON.stringify(ip))
  check('[rig] 待机姿势:只改 pose 不重载模型(调一个数不该重新解析 25MB 的 PMX)', ip.loads === ip.loadsAfterFirst && ip.loads >= 1, JSON.stringify(ip))
  setTag('rig:resume')
  const res = await rig('resume')
  const worst = Math.min(...res.flat())
  check('[rig] 摘下重挂:恢复后头几帧仍是片段姿势(不闪静止姿势)', res.every((a) => a.length >= 3) && worst >= 30, JSON.stringify(res))
  setTag('rig:once')
  const once = await rig('onceFinish')
  check('[rig] 一次性片段播完淡回 idle:手臂逐帧平滑放下(不一帧掉下去)', once.frames >= 30 && once.peak >= 70 && once.end <= -40 && once.maxStep <= 40, JSON.stringify(once))
  setTag('rig:mouth')
  for (const kind of ['morph', 'vrm-oh']) {
    const m = await rig('mouth', kind)
    check(`[rig] 口型(${kind === 'morph' ? '非 VRM 的 jawOpen' : "VRM 自定义 mouth 'oh'"}):说话时张嘴,done / idle 后收回 0`, m.peak > 0.2 && m.afterDone < 0.02 && m.afterIdle < 0.02, JSON.stringify(m))
  }
  setTag('rig:slowmo')
  const rate = await rig('slowmo', 75)
  check('[rig] 卡片 30fps 封顶 × 75Hz 屏(帧距 40ms):片段按真实时间走(旧 1/30 钳制 ≈ 0.83 倍慢放)', rate >= 0.93 && rate <= 1.07, `${rate} 片段秒 / 墙钟秒`)
  setTag('rig:orb')
  const bg = [0x1e, 0x1f, 0x22]
  await rig('orb', 'start')
  await rig('orb', 'attach')
  const shotA = await pg.locator('#panel').screenshot()
  await rig('orb', 'skin')
  const shotB = await pg.locator('#panel').screenshot()
  await rig('orb', 'end')
  writeFileSync(join(SHOTS_DIR, 'rig-orb-accent-attach.png'), shotA)
  writeFileSync(join(SHOTS_DIR, 'rig-orb-accent-skin.png'), shotB)
  const cA = meanFg(shotA, bg)
  const cB = meanFg(shotB, bg)
  check('[rig] 小球:挂上时重读 --accent(创建时是绿,挂上前改成红)', dominant(cA) === 'r', `rgb ${cA}`)
  check('[rig] 小球:挂着时换配色(data-skin + 内联 --accent 改蓝)跟着变色', dominant(cB) === 'b', `rgb ${cB}`)
  setTag('rig:fbx')
  const fb = await rig('fbxBlobs', 'Live3D/models/rt/embedded-tex.fbx')
  check('[rig] FBX 内嵌贴图:3 次加载建的 blob: 全部撤销(不撤 = 每次重载钉一份字节)', fb.created >= 3 && fb.live === 0, JSON.stringify(fb))
  check('[rig] FBX 内嵌贴图:撤销在贴图落地之后,贴图照画(4×4 红)', fb.naturalWidth === 4 && fb.pixel[0] > 200 && fb.pixel[1] < 60, JSON.stringify(fb))
  setTag('rig:beacon')
  const hits0 = beaconHits
  const img = await rig('loadResult', 'Live3D/models/rt/beacon-image.gltf')
  const buf = await rig('loadResult', 'Live3D/models/rt/beacon-buffer.gltf')
  await pg.waitForTimeout(300)
  check('[rig] 模型里的 http(s) 贴图引用:不发请求,模型照常加载并记警告', beaconHits === hits0 && /^loaded:.*Refused a reference/.test(img), `hits ${beaconHits - hits0}; ${img.slice(0, 160)}`)
  check('[rig] 模型的 buffer 在网上:不发请求,双语拒绝(unsupported)', beaconHits === hits0 && /^unsupported\|zh\|en\|/.test(buf), `hits ${beaconHits - hits0}; ${buf.slice(0, 160)}`)
  setTag('rig:draco')
  const dr = await rig('loadResult', 'Live3D/models/rt/draco-used.gltf')
  check('[rig] 只在 extensionsUsed 里的 Draco:双语拒绝(不是 GLTFLoader 的英文原文)', /^unsupported\|zh\|en\|.*Draco/.test(dr), dr.slice(0, 160))
  const bu = await rig('loadResult', 'Live3D/models/rt/basisu-used.gltf')
  check('[rig] 负对照:只在 extensionsUsed 里的 KTX2 会回落到普通贴图,照常加载(不许误拒)', /^loaded:/.test(bu), bu.slice(0, 160))
  const errs = errors.slice(before)
  check('[rig] 合成模型段无页面错误', errs.length === 0, errs.slice(0, 3).join(' || '))
}

// ── 跑 ───────────────────────────────────────────────────────────────────────
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

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const glArgs = process.env.LIVE3D_GL === 'swiftshader'
  ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  : process.platform === 'darwin' ? ['--use-angle=metal', '--ignore-gpu-blocklist'] : ['--ignore-gpu-blocklist']
const browser = await chromium.launch({ executablePath: findChromium(), args: glArgs })
try {
  for (const variant of ['strict', 'open']) {
    const pg = await browser.newPage({ viewport: { width: 1000, height: 880 }, deviceScaleFactor: 2, locale: 'zh-CN' })
    const errors = []
    let tag = 'boot'
    pg.on('pageerror', (e) => errors.push(`[${tag}] pageerror: ${e.message}`))
    pg.on('console', (m) => {
      if (m.type() === 'error') errors.push(`[${tag}] console.error: ${m.text().slice(0, 300)}`)
    })
    await pg.goto(`${ORIGIN}/?csp=${variant}`)
    await pg.waitForFunction(() => !!window.__l3)
    console.log(`\n== CSP ${variant}${variant === 'strict' && hostAlreadyOpen ? ' (host CSP already allows blob:; strict strips it)' : ''}`)
    check(`[${variant}] WebGL2 可用`, await pg.evaluate(() => !!document.createElement('canvas').getContext('webgl2')))

    if (variant === 'strict') {
      // main.js 在宿主同款 CSP 下能被 new Function 构造、执行时不因 import.meta 抛(P2 的 index 可能要求 ctx,其它错不算)
      const mainRes = await pg.evaluate(async () => {
        const code = await (await fetch('/main.js')).text()
        let fn
        try {
          fn = new Function('ctx', code)
        } catch (e) {
          return { built: false, err: String(e) }
        }
        try {
          const r = fn({})
          return { built: true, ran: true, returns: typeof r }
        } catch (e) {
          return { built: true, ran: false, err: String(e) }
        }
      })
      check(`[${variant}] main.js 可被 new Function 构造`, mainRes.built, mainRes.err || '')
      check(`[${variant}] main.js 执行不抛 Invalid URL(DRACO/KTX2 import.meta)`, !/Invalid URL/.test(mainRes.err || ''), JSON.stringify(mainRes))
      errors.length = 0
    }

    // ── 贴图 ──
    for (const s of SAMPLES.filter((x) => x.textured)) {
      const path = `Live3D/models/${s.slug}/${s.model}`
      tag = `tex:${s.slug}`
      const motions = (s.motions ?? []).map((m) => `Live3D/models/${s.slug}/${m}`)
      const on = await pg.evaluate(([p, m]) => window.__l3.textureCheck(p, m, true), [path, motions])
      check(`[${variant}] ${s.slug}: 贴图加载(兜底开)`, on.withMap > 0 && on.textures > 0, `maps ${on.withMap}/${on.mats}, textures ${on.textures}${on.warnings.length ? `, warnings: ${on.warnings.join(' | ')}` : ''}`)
      if (s.embedded) {
        tag = `neg:${s.slug}`
        const off = await pg.evaluate(([p, m]) => window.__l3.textureCheck(p, m, false), [path, motions])
        if (variant === 'strict') check(`[${variant}] ${s.slug}: 负对照 —— 关掉兜底后内嵌贴图必须丢`, off.withMap === 0, `maps ${off.withMap}/${off.mats}`)
        else check(`[${variant}] ${s.slug}: 新 CSP 下不靠兜底也有贴图`, off.withMap > 0, `maps ${off.withMap}/${off.mats}`)
        if (s.generated) {
          const stock = await pg.evaluate((p) => window.__l3.stockGltf(p), path)
          if (variant === 'strict') check(`[${variant}] ${s.slug}: 负对照 —— 原版 GLTFLoader 读 data: buffer 在老 CSP 下失败`, stock !== 'ok', stock)
          else check(`[${variant}] ${s.slug}: 新 CSP 下原版 GLTFLoader 也能读`, stock === 'ok', stock)
        }
        // 负对照期间 three 会 console.error 贴图失败 —— 预期内,清掉
        for (let i = errors.length - 1; i >= 0; i--) if (errors[i].startsWith(`[neg:${s.slug}]`)) errors.splice(i, 1)
      }
    }

    // ── 渲染(两个变体都跑:strict 是老宿主,open 是新宿主)──
    for (const s of SAMPLES) {
      tag = `mount:${s.slug}`
      const before = errors.length
      const m = await pg.evaluate((x) => window.__l3.mount(x), s)
      check(`[${variant}] ${s.slug}: 加载 + 体检 + 缺省 profile 往返`, m.ok, m.ok ? `${m.analysis ? `${m.analysis.format}, clips [${m.analysis.clips.map((c) => c.name).join(', ')}], rig ${m.analysis.bones.rig}, tex ${m.analysis.textures}` : 'orb'}` : JSON.stringify(m))
      if (!m.ok) continue
      if (s.mmd) {
        // 骨骼 / morph 不在场景图里 → 程序化层静默失效(永远 A-pose、不眨眼、不张嘴),截图看不出来,这里钉死
        const a = m.analysis
        check(`[${variant}] ${s.slug}: MMD 骨架与口型/眨眼 morph 可用`, a.format === 'pmx' && a.bones.rig === 'mmd' && a.bones.head === '頭' && a.morphs.includes('あ') && a.morphs.includes('まばたき'),
          `format ${a.format}, rig ${a.bones.rig}, head ${a.bones.head}, morphs ${a.morphs.length}`)
        check(`[${variant}] ${s.slug}: 缺省 profile 说话时驱动口型`, /"mouth":\s*"あ"/.test(m.profile ?? ''), (m.profile ?? '').slice(0, 300))
      }
      if (variant === 'strict' && m.profile) writeFileSync(join(SHOTS_DIR, `${s.slug}.live3d.json`), m.profile)
      if (variant === 'strict' && m.analysis) writeFileSync(join(SHOTS_DIR, `${s.slug}.analysis.json`), JSON.stringify(m.analysis, null, 2))
      await pg.mouse.move(120, 300) // 指针在卡片左侧(像在输入框里打字)
      await pg.waitForTimeout(700)
      for (const phase of await pg.evaluate(() => window.__l3.PHASES)) {
        tag = `${s.slug}:${phase}`
        await pg.evaluate((ph) => window.__l3.setPhase(ph), phase)
        await pg.waitForTimeout(phase === 'done' ? 900 : 1100)
        const cardPng = await pg.locator('#card').screenshot()
        const panelPng = await pg.locator('#panel').screenshot()
        if (variant === 'strict') {
          writeFileSync(join(SHOTS_DIR, `${s.slug}-card-${phase}.png`), cardPng)
          writeFileSync(join(SHOTS_DIR, `${s.slug}-panel-${phase}.png`), panelPng)
        }
        const cc = coverage(cardPng, [0xfb, 0xfa, 0xf7])
        const pc = coverage(panelPng, [0x1e, 0x1f, 0x22])
        check(`[${variant}] ${s.slug}/${phase}: 卡片与侧板都画出了东西`, cc > 0.02 && pc > 0.02, `card ${(cc * 100).toFixed(1)}%, panel ${(pc * 100).toFixed(1)}%`)
      }
      if (variant === 'strict' && s.slug === 'vrm1') {
        tag = `interact:${s.slug}`
        await pg.evaluate(() => window.__l3.setPhase('idle'))
        await pg.waitForTimeout(800)
        const box = await pg.locator('#panel').boundingBox()
        const a = await pg.locator('#panel').screenshot()
        await pg.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await pg.mouse.down()
        await pg.mouse.move(box.x + box.width / 2 + 180, box.y + box.height / 2, { steps: 8 })
        await pg.mouse.up()
        await pg.waitForTimeout(900)
        const b = await pg.locator('#panel').screenshot()
        await pg.mouse.wheel(0, -600)
        await pg.waitForTimeout(900)
        const c = await pg.locator('#panel').screenshot()
        writeFileSync(join(SHOTS_DIR, `${s.slug}-panel-dragged.png`), b)
        writeFileSync(join(SHOTS_DIR, `${s.slug}-panel-zoomed.png`), c)
        const diff = pixelDiff(a, b)
        const covB = coverage(b, [0x1e, 0x1f, 0x22])
        const covC = coverage(c, [0x1e, 0x1f, 0x22])
        check(`[${variant}] ${s.slug}: 侧板拖拽会转模型`, diff > 0.05, `${(diff * 100).toFixed(1)}% pixels changed`)
        check(`[${variant}] ${s.slug}: 侧板滚轮会放大`, covC > covB * 1.1, `coverage ${(covB * 100).toFixed(1)}% → ${(covC * 100).toFixed(1)}%`)
        await pg.mouse.move(120, 300)
      }
      tag = `snap:${s.slug}`
      const snap = await pg.evaluate(() => window.__l3.snapshot())
      check(`[${variant}] ${s.slug}: snapshot() 出 PNG`, snap > 1000, `${snap} bytes`)
      const errs = errors.slice(before)
      check(`[${variant}] ${s.slug}: 无页面错误`, errs.length === 0, errs.slice(0, 3).join(' || '))
    }
    if (variant === 'strict' && SAMPLES.some((x) => x.slug === 'vrm1')) {
      tag = 'lifecycle'
      const before = errors.length
      const prof = readFileSync(join(SHOTS_DIR, 'vrm1.live3d.json'), 'utf8')
      const L = await pg.evaluate((t) => window.__l3.lifecycle(t), prof)
      console.log('      lifecycle', JSON.stringify(L))
      check('[lifecycle] 可见时在渲染', L.visibleRate >= 8, `rAF ${L.visibleRate}/0.5s`)
      check('[lifecycle] display:none → 停 rAF', L.hiddenRate === 0, `rAF ${L.hiddenRate}/0.5s`)
      check('[lifecycle] 重新显示 → 恢复', L.reshownRate >= 8, `rAF ${L.reshownRate}/0.5s`)
      check('[lifecycle] detach → 停 rAF 且画布摘下', L.detachedRate === 0 && L.canvasAfterDetach === 0)
      check('[lifecycle] 搬到侧板(同一 GL 上下文)继续渲染', L.movedRate >= 8 && L.canvasInPanel === 1, `rAF ${L.movedRate}/0.5s`)
      check('[lifecycle] 后发的 setProfile 取代先发的', L.superseded === 'superseded' && L.nullAfter === true, `${L.superseded}`)
      check('[lifecycle] Live2D / 缺文件 / 不支持格式 → 双语 LoadError', L.live2d === 'live2d|zh|en' && L.missing === 'not-found|zh|en' && L.unsupported === 'unsupported|zh|en', `${L.live2d} ${L.missing} ${L.unsupported}`)
      check('[lifecycle] 坏 profile → {ok:false} 并退回小球', L.badProfile === 'not-found', `${L.badProfile}`)
      check('[lifecycle] dispose 两次不抛、画布移除、rAF 停', L.canvasAfterDispose === 0 && L.disposedRate === 0)
      // 故意读不存在的文件 → 浏览器打一条 404 的 console.error,这是预期内的
      const errs = errors.slice(before).filter((e) => !/status of 404/.test(e))
      check('[lifecycle] 无页面错误(预期内的 404 除外)', errs.length === 0, errs.slice(0, 3).join(' || '))
    }
    if (variant === 'strict' && RIG) await rigChecks(pg, errors, (x) => (tag = x))
    await pg.evaluate(() => window.__l3.dispose())
    if (args.includes('--keep-open')) await pg.waitForTimeout(600000)
    await pg.close()
  }
} finally {
  await browser.close()
  server.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed; screenshots in ${SHOTS_DIR}`)
if (failed.length) {
  console.log('failed:\n  ' + failed.map((f) => f.name).join('\n  '))
  process.exit(1)
}
