#!/usr/bin/env node
/**
 * 捆绑 Agent live3d-importer 的**真模型** live 台架(开发用,不随包发布):`npm run live:agent`
 *
 * 为什么住在插件仓:Genesis 的仪器不许依赖外部插件仓(见 Genesis CLAUDE.md),而这条要验的是本插件自带的
 * Agent 人设 + live3d-import 技能 × 真引擎 × 真模型 —— 假引擎 / vi.fn 模型证不了「模型肯不肯照技能做」。
 *
 * 流程(照 Forsion-Genesis/tangu-agent/scripts/live-harness.mjs 的隔离布局与引擎启动方式):
 *  1. 隔离产物目录 OUT(缺省 <tmpdir>/live3d-agent-<时间戳>):
 *       forsion/provider-auth.json → **软链** ~/.forsion-dev/provider-auth.json(本脚本不读不印;引擎装载后立刻拆)
 *       forsion/tangu/                     TANGU_HOME(state.db、agents/ …)
 *       forsion/plugins/live3d/            manifest.json + main.js + skills/(全局技能,引擎原地扫描)+ agents/(人格面,播种一次,
 *                                          里面没有 skills/)—— 真拷贝:bundles.ts 拒绝符号链接的捆绑目录
 *       workspace/                         「笔记库」根(TANGU_DEFAULT_WORKSPACE)
 *       workspace/Live3D/                  插件工作文件夹 = 对话 cwd(生产:startChat({ folder: workFolder }))
 *         models/robotexpressive/          夹具 A:RobotExpressive.glb + 插件自己的体检 analysis.json 与缩略图 preview.png
 *         models/hiyori/                   夹具 B:Live2D 包(假 model3.json + moc3 占位)—— 必须拒收、不许写 live3d.json
 *         models/model/                    夹具 C:MMD 压缩包(GBK 文件名 + Unicode 扩展字段)—— 解对中文名、挑角色不挑道具、直接指向 .pmx
 *       (夹具 E 复用 D 的 helper + Tangu/:问「Desk 上的形象是不是没组装好」,台架扮桌面端回 desk_screenshot ——
 *        图 = 夹具 A 的 preview.png、带 companion=plugin:live3d:avatar;判它自己去看、不说「看不到」、说得出图里是什么)
 *       Tangu/ + Downloads/                夹具 D:**用户自建的普通 Agent**(helper,没配技能)在自己的默认工作区 Tangu/ 里,
 *                                          收到一句「Downloads/角色包.zip 能导入到 Live3D 吗」—— 技能是包根的**全局技能**,
 *                                          它得自己从技能目录找到 live3d-import、找到库里的 Live3D/、建新模型文件夹、解压、写配置,
 *                                          并告诉用户去模型库「设为 Desk 形象」(非插件发起的导入不会自动上 Desk)
 *  2. 夹具 A 的 analysis.json / preview.png 由插件**自己的**代码生成(真 Chromium 里跑 createStage → setProfile →
 *     snapshot,与 ui/importer.ts 的 analyzeInto 同步骤),绝不手写。
 *  3. 起 standalone 引擎(随机端口 + 随机 token + --cloud-url http://127.0.0.1:9 + 隔离 TANGU_HOME),断言
 *     GET /agent/agents 有 live3d-importer(从捆绑包播种)、GET /agent/skills?agentSlug=… 有 local:live3d-import。
 *  4. 每个夹具新建会话,发**插件真实会发的那句话**(src/prompt.ts 的 buildImportPrompt,importer.ts 用的同一份),
 *     agent_config 与桌面 startChat → send() 同形:{ execMode:'host', cwd:<工作文件夹>, agentSlug, extraRoots:[<库根>] }。
 *  5. 断言见 judgeA / judgeB / judgeC / judgeD / judgeE / judgeF / judgeG;产物 OUT/report.md(模型原话、工具序列、profile、判定)+ results.json + engine.log。
 *
 * 用法:
 *   npm run live:agent                                   # 四个夹具,缺省 codex/gpt-5.6-luna,提示词中文(插件缺省语言)
 *   npm run live:agent -- --only robot                   # 只跑夹具 A(robot | live2d | mmdzip | anyagent | desklook | bind | tunepose)
 *   npm run live:agent -- --model codex/gpt-5.6-sol --locale en
 * 环境:LIVE3D_GENESIS(缺省 ../../Forsion-Genesis)、LIVE3D_SAMPLES(RobotExpressive.glb 所在目录;缺了就从
 *   three.js r170 示例下载到缺省 <tmpdir>/live3d-smoke/samples)、CHROMIUM_EXE、LIVE3D_GL=swiftshader。
 * 引擎 dist 比 src 旧就先在 tangu-agent 里 npm run build(只重写 dist,不碰任何正在跑的引擎)。
 * 退出码:任何 FAIL / 超时 = 1;前置条件不满足(凭证、dist、样例)= 2。
 */
import { build } from 'esbuild'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def
}
const die = (msg) => {
  console.error(msg)
  process.exit(2)
}

const GENESIS = resolve(process.env.LIVE3D_GENESIS || join(ROOT, '..', '..', 'Forsion-Genesis'))
const ENGINE_DIR = join(GENESIS, 'tangu-agent')
const ENTRY = join(ENGINE_DIR, 'dist', 'standalone', 'main.js')
const DESKTOP_DIR = join(GENESIS, 'desktop')
const MODEL = opt('model', process.env.LIVE3D_LIVE_MODEL || process.env.TANGU_LIVE_MODEL || 'codex/gpt-5.6-luna')
const LOCALE = opt('locale', 'zh')
const AUTH = resolve(opt('auth', process.env.TANGU_LIVE_AUTH || join(homedir(), '.forsion-dev', 'provider-auth.json')))
const RUN_TIMEOUT_MS = Number(opt('run-timeout', 420_000))
const TIMEOUT_MS = Number(opt('timeout', 25 * 60_000))
const FIXTURES = ['robot', 'live2d', 'mmdzip', 'anyagent', 'desklook', 'bind', 'tunepose']
const ONLY = new Set(opt('only', FIXTURES.join(',')).split(',').map((s) => s.trim()).filter(Boolean))
const SAMPLES = resolve(process.env.LIVE3D_SAMPLES || opt('samples', join(tmpdir(), 'live3d-smoke', 'samples')))
const ROBOT_URL = 'https://raw.githubusercontent.com/mrdoob/three.js/r170/examples/models/gltf/RobotExpressive/RobotExpressive.glb'
const AGENT = 'live3d-importer'
const HELPER = 'helper' // 夹具 D:用户自建的普通 Agent(不写 enabled_skill_ids = 桌面新建 Agent 的真实形态)
const SKILL_ID = 'local:live3d-import'
const WORK_FOLDER = 'Live3D' // 插件缺省工作文件夹(库内相对)

if (!['zh', 'en'].includes(LOCALE)) die(`--locale 只认 zh|en,收到 ${LOCALE}`)
{
  const bad = [...ONLY].filter((k) => !FIXTURES.includes(k))
  if (!ONLY.size || bad.length) die(`--only 无效:${bad.join(',') || '(空)'};合法值 ${FIXTURES.join(',')}`)
}
if (!existsSync(ENGINE_DIR)) die(`找不到 tangu-agent:${ENGINE_DIR}(设 LIVE3D_GENESIS 指向 Forsion-Genesis)`)
if (!existsSync(AUTH)) die(`凭证不存在:${AUTH}\n先在 Forsion Desktop(dev)登录 Codex 订阅,或 --auth 指向 provider-auth.json`)
if (realpathSync(AUTH).startsWith(join(homedir(), '.forsion') + '/') && !argv.includes('--allow-production-auth')) {
  die(`--auth 指向生产共享域 ${AUTH};要用它请显式加 --allow-production-auth`)
}

// ── 0. 引擎 dist 新鲜度:src(不含测试)比 dist 新 → npm run build(tsc 只重写 dist) ──────────────────────────
function newestMtime(dir, filter) {
  let best = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && filter(p)) best = Math.max(best, statSync(p).mtimeMs)
    }
  }
  if (existsSync(dir)) walk(dir)
  return best
}
{
  const srcNewest = newestMtime(join(ENGINE_DIR, 'src'), (p) => p.endsWith('.ts') && !p.endsWith('.test.ts'))
  const distNewest = newestMtime(join(ENGINE_DIR, 'dist'), (p) => p.endsWith('.js'))
  if (!existsSync(ENTRY) || srcNewest > distNewest) {
    console.log(`引擎 dist ${existsSync(ENTRY) ? '比 src 旧' : '缺失'} → npm run build(${ENGINE_DIR})`)
    const r = spawnSync('npm', ['run', 'build'], { cwd: ENGINE_DIR, stdio: 'inherit' })
    if (r.status !== 0 || !existsSync(ENTRY)) die('tangu-agent 构建失败,先修好再跑')
  }
}

// ── 1. 插件纯模块(提示词构造 / profile 校验 / slug)—— esbuild 打成临时 ESM 再 import(同 scripts/unit.mjs) ──────
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const OUT0 = resolve(opt('out', join(tmpdir(), `live3d-agent-${stamp}-${randomUUID().slice(0, 6)}`)))
try {
  mkdirSync(dirname(OUT0), { recursive: true })
  mkdirSync(OUT0)
} catch (e) {
  die(e?.code === 'EEXIST' ? `产物目录已存在:${OUT0}(换一个或删掉)` : String(e?.message || e))
}
// 真实路径(macOS 的 /var → /private/var):引擎与模型看到的 cwd 是解析后的,越界判定得用同一口径
const OUT = realpathSync(OUT0)
const BUILD_DIR = join(OUT, '.build')
mkdirSync(BUILD_DIR)
await build({
  stdin: {
    contents: [
      "export { buildImportPrompt } from './src/prompt.ts'",
      "export { setLocale } from './src/i18n.ts'",
      "export { parseProfile } from './src/profile.ts'",
      "export { slugify, modelFolder, PROFILE_FILE, ANALYSIS_FILE, PREVIEW_FILE, PHASES, DEFAULT_POSE } from './src/contract.ts'",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: join(BUILD_DIR, 'pure.mjs'),
  logLevel: 'warning',
})
const P = await import(pathToFileURL(join(BUILD_DIR, 'pure.mjs')).href)
P.setLocale(LOCALE)

// ── 2. 隔离布局 + 夹具 ─────────────────────────────────────────────────────────────────────────────────────
const shared = join(OUT, 'forsion')
const home = join(shared, 'tangu') // basename 必须是 tangu:forsionSharedDir() 才会到父目录找 provider-auth.json / plugins/
const pluginDir = join(shared, 'plugins', 'live3d')
const workspace = join(OUT, 'workspace')
const cwd = join(workspace, WORK_FOLDER)
mkdirSync(home, { recursive: true })
mkdirSync(pluginDir, { recursive: true })
mkdirSync(cwd, { recursive: true })
for (const f of ['manifest.json', 'main.js']) copyFileSync(join(ROOT, f), join(pluginDir, f))
// 与 install.sh 同形:包根 skills/(全局技能,引擎原地扫描)+ agents/(人格面,播种一次)
cpSync(join(ROOT, 'skills'), join(pluginDir, 'skills'), { recursive: true, dereference: true })
cpSync(join(ROOT, 'agents'), join(pluginDir, 'agents'), { recursive: true, dereference: true })
// 夹具 D 的现场:Agent 自己的默认工作区(≠ 库)、用户的下载目录、插件数据文件(Agent 不许碰)
const userCwd = join(OUT, 'Tangu')
const downloads = join(OUT, 'Downloads')
const pluginsData = join(shared, 'plugins-data')
mkdirSync(userCwd, { recursive: true })
mkdirSync(downloads, { recursive: true })
mkdirSync(pluginsData, { recursive: true })
writeFileSync(join(userCwd, 'notes.md'), '# scratch\n')
writeFileSync(join(pluginsData, 'live3d.json'), JSON.stringify({ mode: 'idle', active: null, pending: {} }))
// 库里真实的 Live3D 工作文件夹长这样:插件写的 README(首行 `# Live3D`)+ models/(tangu 家目录外、插件建)
writeFileSync(join(cwd, 'README.md'), '# Live3D\n\n模型文件夹 / Model folders:\n')
mkdirSync(join(cwd, 'models'), { recursive: true })
// 用户自建 Agent:只有名字 / 描述 / 指令 —— 没有 enabled_skill_ids、tools_mode、approval_mode(桌面「新建 Agent」同形)
mkdirSync(join(home, 'agents', HELPER), { recursive: true })
writeFileSync(join(home, 'agents', HELPER, 'config.toml'), [
  'name = "Helper"',
  'description = "General assistant"',
  'created_by = "user"',
  'developer_instructions = "You are a helpful general assistant."',
  '',
].join('\n'))

const robotSrc = join(SAMPLES, 'RobotExpressive.glb')
// 夹具 E 回给 desk_screenshot 的「形象截图」= 夹具 A 体检时插件自己渲染的 preview.png → E 也要机器人样例
const NEED_ROBOT = ONLY.has('robot') || ONLY.has('desklook') || ONLY.has('bind') || ONLY.has('tunepose')
if (!existsSync(robotSrc) && NEED_ROBOT) {
  mkdirSync(SAMPLES, { recursive: true })
  console.log(`下载样例 RobotExpressive.glb → ${SAMPLES}`)
  const res = await fetch(ROBOT_URL)
  if (!res.ok) die(`样例下载失败 ${res.status}:${ROBOT_URL}`)
  writeFileSync(robotSrc, Buffer.from(await res.arrayBuffer()))
}

/** 夹具定义:files = 用户导入的文件(进提示词);gen = 插件导入时顺手生成的(体检 / 缩略图)。 */
const fx = {
  robot: { key: 'robot', title: 'A — RobotExpressive.glb(可直接加载,需要判断映射)', slug: P.slugify('RobotExpressive.glb'), files: ['RobotExpressive.glb'] },
  live2d: { key: 'live2d', title: 'B — Live2D 包(必须拒收)', slug: P.slugify('Hiyori'), files: ['hiyori.model3.json', 'hiyori.moc3', 'hiyori.2048/texture_00.png'] },
  mmdzip: { key: 'mmdzip', title: 'C — MMD 压缩包(GBK 文件名 + Unicode 扩展字段,角色 + 道具两个 PMX)', slug: P.slugify('角色包.zip'), files: ['角色包.zip'] },
  anyagent: { key: 'anyagent', title: 'D — 用户自建的普通 Agent,cwd 不在工作文件夹,只给一个下载目录里的 zip 路径', slug: null, files: [] },
  desklook: { key: 'desklook', title: 'E — 普通 Agent 被问「Desk 上的形象是不是没组装好」:自己 desk_screenshot 看(台架扮桌面端,回形象图 + companion)', slug: null, files: [] },
  bind: { key: 'bind', title: 'F — 普通 Agent 被要求「让 xyra 用这个形象」:只往那份 live3d.json 的 agents 里加 slug', slug: P.slugify('RobotExpressive.glb'), files: [] },
  tunepose: { key: 'tunepose', title: 'G — 普通 Agent 被说「形象站得像木头人、手陷进衣服里」:先看截图再调 pose', slug: P.slugify('RobotExpressive.glb'), files: [] },
}
/** 夹具 C 的包内容。PMX 是占位(魔数 + 名字 / morph 名的 UTF-16LE 串 + 填充),agent 解不了二进制,只能靠文件名 / 大小 / 字符串挑。 */
const MMD_CHAR = '小雪.pmx'
/** 夹具 D 用**另一个**角色包:C 已把小雪导进 models/model/,同一份包会被(合理地)认成「已经导入过了」。 */
const MMD_CHAR_D = '白鹭.pmx'
const MMD_PROP_D = '伞.pmx'
const MMD_MORPHS = ['あ', 'まばたき', '笑い', 'びっくり']

const folderOf = (f) => join(cwd, 'models', f.slug)
const vaultDirOf = (f) => P.modelFolder(WORK_FOLDER, f.slug)

if (NEED_ROBOT) {
  mkdirSync(folderOf(fx.robot), { recursive: true })
  copyFileSync(robotSrc, join(folderOf(fx.robot), 'RobotExpressive.glb'))
}
/** 与用户真包同构的 MMD zip(09-19 茜特拉莉包实测):头部文件名是 GBK、不置 UTF-8 标志,UTF-8 名放 0x7075 扩展字段。
 *  macOS 的 unzip 解出 ���、ditto 按 MacRoman 解成 ‹ÁÃÿ,只有 bsdtar(tar)/ 归档实用工具认扩展字段。Node 没有 GBK 编码器 → python3。 */
function makeMmdZip(outPath, char = MMD_CHAR, prop = '武器.pmx') {
  const py = `
import zipfile, struct, zlib, sys, json
out, char, prop, morphs = sys.argv[1], sys.argv[2], sys.argv[3], json.loads(sys.argv[4])
u16 = lambda s: s.encode('utf-16-le')
pmx = lambda name, size, extra: (b'PMX ' + struct.pack('<f', 2.0) + b''.join(u16(x) + b'\\0\\0' for x in [name] + extra)).ljust(size, b'\\0')
png = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108000000003a7e9b550000000a4944415478da63f80f00010101001be5d5e20000000049454e44ae426082')
files = [(char, pmx(char[:-4], 400000, morphs)), (prop, pmx(prop[:-4], 20000, [])), ('tex/颜.png', png), ('tex/体.png', png), ('readme.txt', '请勿二次配布'.encode('gbk'))]
zipfile.ZipInfo._encodeFilenameFlags = lambda self: (self.filename.encode('gbk'), self.flag_bits & ~0x800)
with zipfile.ZipFile(out, 'w') as z:
    for name, data in files:
        zi = zipfile.ZipInfo(name)
        u = name.encode('utf-8')
        zi.extra = struct.pack('<HHBI', 0x7075, 5 + len(u), 1, zlib.crc32(name.encode('gbk'))) + u
        z.writestr(zi, data)
`
  const r = spawnSync('python3', ['-c', py, outPath, char, prop, JSON.stringify(MMD_MORPHS)], { encoding: 'utf8' })
  if (r.status !== 0) die(`MMD 夹具 zip 生成失败(需要 python3):${r.stderr || r.error}`)
}
if (ONLY.has('mmdzip')) {
  mkdirSync(folderOf(fx.mmdzip), { recursive: true })
  makeMmdZip(join(folderOf(fx.mmdzip), '角色包.zip'))
}
/** F / G 都改**已经导入好**的那份 robot profile。夹具 A 没跑时补的这份必须是**完整**的 —— 半成品会让
 *  模型顺手「帮你补全」(第一版只写了 idle,它就把 framing 和其余阶段一起改了),那样判「只改该改的」没意义。 */
function ensureRobotProfile() {
  const prof = join(folderOf(fx.robot), P.PROFILE_FILE)
  if (!existsSync(prof)) {
    mkdirSync(dirname(prof), { recursive: true })
    writeFileSync(prof, JSON.stringify({
      live3d: 1, name: 'RobotExpressive', model: 'RobotExpressive.glb', motions: [], agents: [],
      transform: { scale: 1, rotateY: 0, offsetY: 0 }, framing: 'full',
      states: {
        idle: { clip: 'Idle' }, thinking: { expression: 'Surprised', weight: 0.35 }, speaking: { clip: 'Idle' },
        tool: { clip: 'Walking' }, waiting: { clip: 'Wave', once: true }, error: { expression: 'Sad', weight: 0.7 },
        done: { clip: 'ThumbsUp', once: true },
      },
      pose: { ...P.DEFAULT_POSE },
    }, null, 2) + '\n')
  }
  return prof
}
if (ONLY.has('bind')) {
  ensureRobotProfile()
  // 用户会怎么说:点名一个 Agent,不提 live3d.json、不提 agents 字段
  fx.bind.prompt = LOCALE === 'en'
    ? `I want my agent ${HELPER} to have its own avatar on the Agent Desk — use the RobotExpressive model that is already in Live3D.`
    : `我想让 ${HELPER} 这个 Agent 在 Agent Desk 上用自己的形象,就用 Live3D 里已经有的那个 RobotExpressive。`
}
if (ONLY.has('tunepose')) {
  ensureRobotProfile()
  // 用户 09-20 原话的同义句:只说「看起来怪」,不提 pose / armSpread
  fx.tunepose.prompt = LOCALE === 'en'
    ? 'The Live3D avatar on the Agent Desk stands like a mannequin and its hands are stuck inside its body. Can you fix how it stands?'
    : 'Agent Desk 上那个 Live3D 形象站得跟个木头人一样,手还陷进身体里了,能调一下它站的姿势吗?'
}
if (ONLY.has('anyagent')) {
  makeMmdZip(join(downloads, '角色包.zip'), MMD_CHAR_D, MMD_PROP_D)
  // 预置一个同 slug 的已有模型(夹具 C 也用 models/model/):纯中文名 → slug 'model' 必撞,新文件夹得另起名、不许并进来
  if (!existsSync(join(cwd, 'models', 'model'))) {
    mkdirSync(join(cwd, 'models', 'model'), { recursive: true })
    writeFileSync(join(cwd, 'models', 'model', 'keep.txt'), 'existing model folder\n')
  }
}
if (ONLY.has('live2d')) {
  const d = folderOf(fx.live2d)
  mkdirSync(join(d, 'hiyori.2048'), { recursive: true })
  writeFileSync(join(d, 'hiyori.model3.json'), JSON.stringify({
    Version: 3,
    FileReferences: { Moc: 'hiyori.moc3', Textures: ['hiyori.2048/texture_00.png'], Motions: { Idle: [{ File: 'motions/hiyori_m01.motion3.json' }] } },
    Groups: [{ Target: 'Parameter', Name: 'LipSync', Ids: ['ParamMouthOpenY'] }],
  }, null, 2) + '\n')
  writeFileSync(join(d, 'hiyori.moc3'), Buffer.concat([Buffer.from('MOC3'), Buffer.alloc(252)])) // 占位:只有 MOC3 魔数
  // 占位贴图:必须是**能解码的** PNG(1×1 白)—— 模型可能 view_image 它,只有签名的 8 字节会被 provider 当成坏图、整轮 run 报错
  writeFileSync(join(d, 'hiyori.2048', 'texture_00.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAsTj2FAAAAABJRU5ErkJggg==', 'base64'))
}

// ── 3. 夹具 A 的体检 + 缩略图:插件自己的 stage 在真 Chromium 里跑(= importer.ts analyzeInto 的步骤) ─────────────
async function analyzeInBrowser(f, mainRel) {
  const ENTRY_TS = `
import { createStage } from './src/stage'
import { parseProfile } from './src/profile'
const assetUrl = (rel: string) => location.origin + '/vault/' + rel.split('/').map(encodeURIComponent).join('/')
// 与 ui/importer.ts 的 OFFSCREEN_CSS 同值
const OFFSCREEN_CSS = 'position:fixed;left:0;top:0;width:512px;height:512px;opacity:0;pointer-events:none;z-index:-1;contain:strict;'
const b64 = (buf: ArrayBuffer) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s) }
;(window as any).__analyze = async (dir: string, model: string, motions: string[]) => {
  const parsed = parseProfile(JSON.stringify({ live3d: 1, model, motions }), dir)
  if (!parsed.ok) return { ok: false, error: parsed.en }
  const stage = createStage({ surface: 'studio', interactive: false, assetUrl })
  const box = document.createElement('div')
  box.style.cssText = OFFSCREEN_CSS
  document.body.appendChild(box)
  try {
    stage.attach(box)
    const r: any = await stage.setProfile(parsed.value)
    if (!r.ok) return { ok: false, error: r.en || String(r.code) }
    await new Promise((res) => setTimeout(res, 450))
    const blob = await stage.snapshot()
    return { ok: true, analysis: r.analysis, preview: blob ? b64(await blob.arrayBuffer()) : null }
  } finally {
    stage.dispose()
    box.remove()
  }
}
`
  await build({
    stdin: { contents: ENTRY_TS, resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    outfile: join(BUILD_DIR, 'analyze.js'),
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': '"https://invalid.local/x/"' },
    logLevel: 'warning',
  })
  const MIME = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.json': 'application/json', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json' }
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const send = (code, body, type = 'text/plain') => {
      res.writeHead(code, { 'content-type': type })
      res.end(body)
    }
    if (url.pathname === '/') return send(200, '<!doctype html><html><head><meta charset="utf-8"></head><body><script src="/analyze.js"></script></body></html>', MIME['.html'])
    if (url.pathname === '/analyze.js') return send(200, readFileSync(join(BUILD_DIR, 'analyze.js')), MIME['.js'])
    if (url.pathname.startsWith('/vault/')) {
      const rel = decodeURIComponent(url.pathname.slice('/vault/'.length))
      if (rel.split('/').includes('..')) return send(403, 'no')
      const p = join(workspace, rel)
      if (!existsSync(p) || !statSync(p).isFile()) return send(404, 'not found')
      return send(200, readFileSync(p), MIME[extname(p).toLowerCase()] || 'application/octet-stream')
    }
    send(404, 'not found')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const require = createRequire(import.meta.url)
  let chromium
  try {
    ({ chromium } = require(join(DESKTOP_DIR, 'node_modules', 'playwright-core')))
  } catch {
    server.close()
    die(`找不到 playwright-core:${join(DESKTOP_DIR, 'node_modules')}(在 Forsion-Genesis/desktop 里 npm install)`)
  }
  const findChromium = () => {
    if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
    try {
      const p = chromium.executablePath()
      if (p && existsSync(p)) return p
    } catch { /* 回落到缓存目录 */ }
    const cache = join(homedir(), 'Library/Caches/ms-playwright')
    for (const d of (existsSync(cache) ? readdirSync(cache) : []).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
      for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
        const p = join(cache, d, 'chrome-mac-arm64', app)
        if (existsSync(p)) return p
      }
    }
    throw new Error('chromium not found; set CHROMIUM_EXE')
  }
  const glArgs = process.env.LIVE3D_GL === 'swiftshader'
    ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    : process.platform === 'darwin' ? ['--use-angle=metal', '--ignore-gpu-blocklist'] : ['--ignore-gpu-blocklist']
  const browser = await chromium.launch({ executablePath: findChromium(), args: glArgs })
  try {
    const pg = await browser.newPage({ viewport: { width: 800, height: 700 }, deviceScaleFactor: 2 })
    const errors = []
    pg.on('pageerror', (e) => errors.push(e.message))
    await pg.goto(`http://127.0.0.1:${server.address().port}/`)
    await pg.waitForFunction(() => !!window.__analyze)
    const r = await pg.evaluate(([d, m]) => window.__analyze(d, m, []), [vaultDirOf(f), mainRel])
    if (!r.ok) throw new Error(`插件体检失败:${r.error}`)
    if (errors.length) throw new Error(`体检页面报错:${errors.slice(0, 3).join(' | ')}`)
    // 与 analyzeInto 同样的落盘格式
    writeFileSync(join(folderOf(f), P.ANALYSIS_FILE), JSON.stringify(r.analysis, null, 2) + '\n')
    if (r.preview) writeFileSync(join(folderOf(f), P.PREVIEW_FILE), Buffer.from(r.preview, 'base64'))
    return { analysis: r.analysis, preview: !!r.preview }
  } finally {
    await browser.close()
    server.close()
  }
}

const prep = {}
if (NEED_ROBOT) {
  console.log('▶ 夹具 A:插件体检 + 缩略图(真 Chromium)')
  const a = await analyzeInBrowser(fx.robot, 'RobotExpressive.glb')
  const clipNames = a.analysis.clips.map((c) => c.name)
  for (const need of ['Idle', 'Wave']) if (!clipNames.includes(need)) die(`样例体检里没有 ${need} 片段(实得 ${clipNames.join(', ')})—— 样例不对`)
  prep.robot = { hasAnalysis: true, hasPreview: a.preview, clips: clipNames, morphs: a.analysis.morphs, suggested: a.analysis.suggested }
  console.log(`  clips [${clipNames.join(', ')}] morphs [${a.analysis.morphs.join(', ')}] preview ${a.preview ? 'ok' : '(无)'}`)
}
if (ONLY.has('live2d')) prep.live2d = { hasAnalysis: false, hasPreview: false } // 产品对 Live2D 不做体检(importWithAgent 里 fmt==='live2d' 跳过)
if (ONLY.has('mmdzip')) prep.mmdzip = { hasAnalysis: false, hasPreview: false } // 压缩包不是能直接加载的格式 → 产品也不体检

if (ONLY.has('desklook')) {
  // 形象已导入、正在 Desk 上(用户那次的状态);夹具 A 没跑就补一份最小 profile
  const prof = join(folderOf(fx.robot), P.PROFILE_FILE)
  if (!ONLY.has('robot') && !existsSync(prof)) writeFileSync(prof, JSON.stringify({ live3d: 1, name: 'RobotExpressive', model: 'RobotExpressive.glb' }, null, 2) + '\n')
  // 用户 09-19 原话(第一句):问的是「组装」,没叫它截图 —— 看它会不会自己去看
  fx.desklook.prompt = LOCALE === 'en' ? 'Is the Live3D avatar on the Agent Desk right now put together properly?' : 'Agent Desk 上现在这个 Live3D 形象,是不是没组装好?'
}
if (ONLY.has('anyagent')) {
  const zip = join(downloads, '角色包.zip')
  fx.anyagent.prompt = LOCALE === 'en'
    ? `${zip}\nCan you import this into Live3D so it shows on the Agent Desk?`
    : `${zip}\n这个能导入到 Live3D、显示在 Agent Desk 上吗?`
}
for (const k of Object.keys(prep)) {
  const f = fx[k]
  f.prompt = P.buildImportPrompt({
    workFolder: WORK_FOLDER, slug: f.slug, absFolder: folderOf(f), files: f.files, hasAnalysis: prep[k].hasAnalysis, hasPreview: prep[k].hasPreview,
  })
}

// ── 4. 起引擎(同 live-harness.mjs) ─────────────────────────────────────────────────────────────────────────
const authLink = join(shared, 'provider-auth.json')
symlinkSync(AUTH, authLink)
const TOKEN = randomUUID()
const port = await new Promise((r) => {
  const srv = createNetServer()
  srv.listen(0, '127.0.0.1', () => {
    const p = srv.address().port
    srv.close(() => r(p))
  })
})
const base = `http://127.0.0.1:${port}`
const engineLog = join(OUT, 'engine.log')
const startedAt = new Date().toISOString()
// FORSION_AMADEUS_VAULT:系统提示「Amadeus Notes」段的库路径与 extraRoots 同一个库(生产由桌面配置给;不设则回落
// ~/Forsion/Amadeus —— 一个不存在的路径,09-19 夹具 D 首轮就被它带偏)
const childEnv = { ...process.env, TANGU_HOME: home, TANGU_DEFAULT_WORKSPACE: workspace, FORSION_AMADEUS_VAULT: workspace }
// 这几个任何一个在用户 shell 里设着,捆绑包发现就会静默停用 / 模型窗口被改(bundles.ts bundleDirs)
for (const k of ['TANGU_PLUGINS', 'TANGU_PLUGINS_DIR', 'TANGU_BUNDLE_DIRS', 'TANGU_MODEL_CONTEXT_WINDOWS']) delete childEnv[k]
const child = spawn(process.execPath, [
  ENTRY, '--port', String(port), '--host', '127.0.0.1', '--data-dir', join(home, 'state.db'),
  '--sandbox', 'auto', '--cloud-url', 'http://127.0.0.1:9', '--token', TOKEN,
], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.on('data', (d) => appendFileSync(engineLog, d))
child.stderr.on('data', (d) => appendFileSync(engineLog, d))
let childExit = null
child.once('exit', (code, signal) => {
  childExit = { code, signal }
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms, every = 1000) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) return null
    await sleep(every)
  }
}
const api = async (path, init = {}) => {
  const r = await fetch(base + path, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) } })
  const text = await r.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  if (!r.ok) throw new Error(`${init.method || 'GET'} ${path} → ${r.status} ${(typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 300)}`)
  return body
}
const asList = (x, key) => (Array.isArray(x) ? x : Array.isArray(x?.[key]) ? x[key] : [])
const parseArgs = (s) => {
  if (s && typeof s === 'object') return s
  try {
    return JSON.parse(String(s || '{}'))
  } catch {
    return { _raw: String(s || '') }
  }
}

/** 起 run 并消费 SSE 到 done/error。审批一律代批(记下是哪个工具);ask_user 类询问代答并记为 WARN。 */
const DESK_SHOT_PNG = join(folderOf(fx.robot), P.PREVIEW_FILE)
const DESK_COMPANION = 'plugin:live3d:avatar'
async function run(sessionId, message, agentConfig) {
  const t0 = Date.now()
  const { runId } = await api('/agent/runs', { method: 'POST', body: JSON.stringify({ session_id: sessionId, model_id: MODEL, message, agent_config: agentConfig }) })
  const ev = { runId, calls: [], approvals: [], inquiries: [], captures: [], usages: [], content: '', error: null, done: false, wallMs: 0, firstTokenMs: null }
  const byId = new Map()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), RUN_TIMEOUT_MS)
  try {
    const res = await fetch(`${base}/agent/runs/${runId}/events`, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: ac.signal })
    if (!res.ok || !res.body) {
      ev.error = `events ${res.status}`
      return ev
    }
    let buf = ''
    outer: for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString('utf8')
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i)
        buf = buf.slice(i + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          let e
          try {
            e = JSON.parse(line.slice(5).trim())
          } catch {
            continue
          }
          const p = e.payload || {}
          if (e.type === 'token' && ev.firstTokenMs == null) ev.firstTokenMs = Date.now() - t0
          else if (e.type === 'tool_call') {
            const c = { id: p.id, name: p.name || '?', args: parseArgs(p.arguments), result: null, isError: null }
            ev.calls.push(c)
            if (p.id) byId.set(p.id, c)
          } else if (e.type === 'tool_result') {
            const c = (p.id && byId.get(p.id)) || [...ev.calls].reverse().find((x) => x.name === p.name && x.result == null)
            if (c) {
              c.result = String(p.result ?? '')
              c.isError = !!p.isError
            }
          } else if (e.type === 'approval_request') {
            const id = p.approvalId || p.id || p.approval_id
            const kind = typeof p.reason === 'object' ? p.reason?.kind : p.reason
            ev.approvals.push({ tool: p.name || '?', kind: kind || '', summary: short(kind ? `${kind}: ${p.arguments}` : p.arguments, 200) })
            if (id) await api(`/agent/runs/${runId}/approvals/${id}`, { method: 'POST', body: JSON.stringify({ action: 'approve' }) }).catch((err) => { ev.approveError = String(err.message) })
          } else if (e.type === 'inquiry_request') {
            const answer = LOCALE === 'en' ? 'No preference. Decide using the skill and continue.' : '没有偏好,按技能自行决定并继续。'
            ev.inquiries.push({ question: String(p.question || p.prompt || JSON.stringify(p)).slice(0, 400), answer })
            if (p.inquiryId) await api(`/agent/runs/${runId}/inquiries/${p.inquiryId}`, { method: 'POST', body: JSON.stringify({ answer }) }).catch(() => {})
          } else if (e.type === 'desk_capture_request') {
            // 台架扮桌面端(desktop deskCapture.ts 的回图形状):Desk 上是 Live3D 伴随面 → 回形象图 + companion
            const png = existsSync(DESK_SHOT_PNG) ? readFileSync(DESK_SHOT_PNG) : null
            ev.captures.push(p.shotId)
            const body = png
              ? { dataUrl: `data:image/png;base64,${png.toString('base64')}`, mode: 'card', companion: DESK_COMPANION }
              : { error: 'the Agent Desk panel is not on screen (turned off, hidden, or the window is too narrow)' }
            if (p.shotId) await api(`/agent/runs/${runId}/captures/${p.shotId}`, { method: 'POST', body: JSON.stringify(body) }).catch(() => {})
          } else if (e.type === 'usage') ev.usages.push(p)
          else if (e.type === 'done') {
            ev.done = true
            ev.content = String(p.content || '')
            break outer
          } else if (e.type === 'error') {
            ev.error = String(p.error || 'error')
            break outer
          }
        }
      }
    }
    if (!ev.done && !ev.error) ev.error = 'SSE 结束但无 done/error'
  } catch (e) {
    ev.error = ac.signal.aborted ? `run ${RUN_TIMEOUT_MS / 1000}s 超时` : String(e?.message || e)
    if (ac.signal.aborted) await api(`/agent/runs/${runId}/abort`, { method: 'POST', body: '{}' }).catch(() => {})
  } finally {
    clearTimeout(timer)
    ev.wallMs = Date.now() - t0
  }
  return ev
}

// ── 5. 目录树快照(判「只许写在自己的 models/<slug>/ 里」) ─────────────────────────────────────────────────────
function snapshotTree(rootDir) {
  const out = new Map()
  const walk = (d) => {
    if (!existsSync(d)) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      const rel = relative(OUT, p).split(sep).join('/')
      const st = lstatSync(p)
      if (st.isSymbolicLink()) out.set(rel, `link:${readlinkSync(p)}`)
      else if (st.isDirectory()) walk(p)
      else out.set(rel, createHash('sha1').update(readFileSync(p)).digest('hex'))
    }
  }
  walk(rootDir)
  return out
}
const snapAll = () => new Map([...snapshotTree(workspace), ...snapshotTree(pluginDir), ...snapshotTree(userCwd), ...snapshotTree(downloads), ...snapshotTree(pluginsData)])
function diffTrees(a, b) {
  const added = []
  const changed = []
  const removed = []
  for (const [k, v] of b) {
    if (!a.has(k)) added.push(k)
    else if (a.get(k) !== v) changed.push(k)
  }
  for (const k of a.keys()) if (!b.has(k)) removed.push(k)
  return { added, changed, removed }
}

// ── 6. 判据 ──────────────────────────────────────────────────────────────────────────────────────────────────
const short = (s, n = 160) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}
const callLabel = (c) => {
  const a = c.args || {}
  const arg = a.skill_id ?? a.path ?? a.file_path ?? a.command ?? a.cmd ?? a.dir ?? a._raw ?? ''
  return `${c.name}(${short(arg, 120)})${c.isError ? ' ✗' : ''}`
}
/** 任一次 use_skill live3d-import 拿到了技能正文(先裸 id 失败、再带 local: 重试成功也算);或 read_file 读了 SKILL.md 且没报错。 */
function skillLoaded(calls) {
  const uses = calls.filter((c) => c.name === 'use_skill' && /live3d-import/.test(String(c.args?.skill_id ?? '')))
  const good = uses.find((c) => !c.isError && /^# Skill:/.test(c.result || ''))
  if (good) return { ok: true, how: `use_skill(${good.args.skill_id})${uses.length > 1 ? `(第 ${uses.indexOf(good) + 1}/${uses.length} 次)` : ''}`, why: '' }
  if (uses.length) return { ok: false, how: '-', why: `结果不是技能正文:${short(uses[uses.length - 1].result, 160)}` }
  const viaRead = calls.find((c) => /read/.test(c.name) && /live3d-import[\\/]+SKILL\.md/i.test(JSON.stringify(c.args || {})))
  if (viaRead) return { ok: !viaRead.isError, how: `${viaRead.name}(SKILL.md)`, why: viaRead.isError ? short(viaRead.result) : '' }
  return { ok: false, how: '-', why: '没有 use_skill live3d-import,也没读 SKILL.md' }
}
/** 模型写文件的调用(write_file / edit_file / apply_patch …):相对路径按本次 run 的 cwd 解析,必须落在 allowed 之内。 */
function writesOutside(calls, runCwd = cwd, allowed = cwd) {
  const bad = []
  for (const c of calls) {
    if (!/^(write_file|edit_file|multi_edit|apply_patch)$/.test(c.name)) continue
    const p = c.args?.path ?? c.args?.file_path
    if (typeof p !== 'string') continue
    const abs = resolve(runCwd, p)
    if (abs !== allowed && !abs.startsWith(allowed + sep)) bad.push(`${c.name} ${p}`)
  }
  return bad
}
function scopeDiff(f, before, after) {
  const d = diffTrees(before, after)
  const mine = `workspace/${WORK_FOLDER}/models/${f.slug}/`
  const work = `workspace/${WORK_FOLDER}/`
  const all = [...d.added.map((x) => `+ ${x}`), ...d.changed.map((x) => `~ ${x}`), ...d.removed.map((x) => `- ${x}`)]
  const touched = [...d.added, ...d.changed, ...d.removed]
  const outsideWork = touched.filter((x) => !x.startsWith(work))
  const outsideModel = touched.filter((x) => x.startsWith(work) && !x.startsWith(mine))
  const originals = f.files.map((x) => mine + x).concat(f.key === 'robot' ? [mine + P.ANALYSIS_FILE, mine + P.PREVIEW_FILE] : [])
  const originalsTouched = originals.filter((x) => d.changed.includes(x) || d.removed.includes(x))
  return { all, outsideWork, outsideModel, originalsTouched }
}

function judgeA(f, ev, sd) {
  const checks = []
  const c = (name, ok, detail = '') => checks.push({ name, ok, detail })
  c('run 完成', !ev.error && ev.done, ev.error || '')
  const sk = skillLoaded(ev.calls)
  c('装载了 live3d-import 技能', sk.ok, sk.ok ? sk.how : sk.why)
  const profPath = join(folderOf(f), P.PROFILE_FILE)
  const text = existsSync(profPath) ? readFileSync(profPath, 'utf8') : null
  c(`写出 models/${f.slug}/live3d.json`, text != null)
  let profile = null
  let parsed = null
  if (text != null) {
    parsed = P.parseProfile(text, vaultDirOf(f))
    c('通过插件 parseProfile 校验', parsed.ok, parsed.ok ? (parsed.warnings.length ? `warnings: ${parsed.warnings.map((w) => w.en).join(' | ')}` : '无警告') : parsed.en)
    try {
      profile = JSON.parse(text)
    } catch { /* parseProfile 已报 */ }
  }
  const st = parsed?.ok ? parsed.value.states : (profile?.states || {})
  const clipOf = (ph) => (st?.[ph] && typeof st[ph] === 'object' ? st[ph].clip : undefined)
  const clips = prep.robot.clips
  const morphs = prep.robot.morphs
  c('model 指向 RobotExpressive.glb', parsed?.ok ? parsed.value.model === 'RobotExpressive.glb' : false, parsed?.ok ? parsed.value.model : '')
  c('idle → Idle', clipOf('idle') === 'Idle', `idle.clip = ${JSON.stringify(clipOf('idle'))}`)
  c('waiting → Wave(打招呼)', clipOf('waiting') === 'Wave', `waiting.clip = ${JSON.stringify(clipOf('waiting'))}`)
  const POS = ['ThumbsUp', 'Yes', 'Dance', 'Jump']
  c(`done → 正面片段(${POS.join('/')})`, POS.includes(clipOf('done')), `done.clip = ${JSON.stringify(clipOf('done'))}`)
  const invented = []
  for (const [ph, spec] of Object.entries(st || {})) {
    if (!spec || typeof spec !== 'object') continue
    if (typeof spec.clip === 'string' && !clips.includes(spec.clip)) invented.push(`${ph}.clip=${spec.clip}`)
    for (const k of ['expression', 'mouth']) if (typeof spec[k] === 'string' && !morphs.includes(spec[k])) invented.push(`${ph}.${k}=${spec[k]}`)
  }
  // 没写出 profile 时这条不成立也不算过(免得「什么都没写」被读成「没编造」)
  if (text != null) c('没有编造片段 / 表情 / 口型名(全都能在 analysis.json 里找到)', invented.length === 0, invented.join(', '))
  c('原始文件 / 体检 / 缩略图未被改动', sd.originalsTouched.length === 0, sd.originalsTouched.join(', '))
  c('工作文件夹之外无写入(目录树前后对比)', sd.outsideWork.length === 0, sd.outsideWork.join(', '))
  c(`工作文件夹内只动了 models/${f.slug}/(README.md、别的模型都没动)`, sd.outsideModel.length === 0, sd.outsideModel.join(', '))
  const wo = writesOutside(ev.calls, cwd, folderOf(f))
  c(`写文件工具的路径都在 models/${f.slug}/ 内`, wo.length === 0, wo.join(', '))
  c('没有反问用户(ask_user)', ev.inquiries.length === 0, ev.inquiries.map((q) => q.question).join(' | '))
  return { checks, profileText: text, states: st, parsedOk: !!parsed?.ok }
}

function judgeC(f, ev, sd) {
  const checks = []
  const c = (name, ok, detail = '') => checks.push({ name, ok, detail })
  c('run 完成', !ev.error && ev.done, ev.error || '')
  const sk = skillLoaded(ev.calls)
  c('装载了 live3d-import 技能', sk.ok, sk.ok ? sk.how : sk.why)
  const text = existsSync(join(folderOf(f), P.PROFILE_FILE)) ? readFileSync(join(folderOf(f), P.PROFILE_FILE), 'utf8') : null
  c(`写出 models/${f.slug}/live3d.json`, text != null)
  const parsed = text != null ? P.parseProfile(text, vaultDirOf(f)) : null
  if (parsed) c('通过插件 parseProfile 校验', parsed.ok, parsed.ok ? '' : parsed.en)
  const model = parsed?.ok ? parsed.value.model : ''
  c(`model 直接指向角色 PMX(${MMD_CHAR},不是道具、没去转格式)`, model.endsWith(MMD_CHAR), model)
  const abs = model ? join(folderOf(f), model) : ''
  // 名字解坏了(unzip / ditto)→ model 要么指向乱码文件名、要么指向一个不存在的中文名;两种都红
  c('model 文件在磁盘上真实存在(中文文件名解对了)', !!abs && existsSync(abs), abs)
  c('同包贴图 tex/颜.png 也按原名解出(PMX 按名字找贴图)', !!abs && existsSync(join(dirname(abs), 'tex', '颜.png')))
  const st = parsed?.ok ? parsed.value.states : {}
  const bytes = abs && existsSync(abs) ? readFileSync(abs) : Buffer.alloc(0)
  const used = []
  const invented = []
  for (const [ph, spec] of Object.entries(st || {})) {
    if (typeof spec?.clip === 'string') invented.push(`${ph}.clip=${spec.clip}`) // PMX 没有片段
    for (const k of ['expression', 'mouth']) {
      if (typeof spec?.[k] !== 'string') continue
      used.push(`${ph}.${k}=${spec[k]}`)
      if (!bytes.includes(Buffer.from(spec[k], 'utf16le'))) invented.push(`${ph}.${k}=${spec[k]}`)
    }
  }
  if (text != null) c('没有编造片段 / morph 名(用到的名字都在 PMX 里)', invented.length === 0, invented.join(', ') || `用到 ${used.join(', ') || '(无)'}`)
  c('原始压缩包未被改动', sd.originalsTouched.length === 0, sd.originalsTouched.join(', '))
  c('工作文件夹之外无写入(目录树前后对比)', sd.outsideWork.length === 0, sd.outsideWork.join(', '))
  c(`工作文件夹内只动了 models/${f.slug}/(README.md、别的模型都没动)`, sd.outsideModel.length === 0, sd.outsideModel.join(', '))
  const wo = writesOutside(ev.calls, cwd, folderOf(f))
  c(`写文件工具的路径都在 models/${f.slug}/ 内`, wo.length === 0, wo.join(', '))
  return { checks, profileText: text, states: st, parsedOk: !!parsed?.ok }
}

/** 夹具 D:谁都没替它建文件夹 —— 从目录差异里找出它新建的那一个 models/<new>/。 */
function judgeD(f, ev, before, after) {
  const checks = []
  const c = (name, ok, detail = '') => checks.push({ name, ok, detail })
  const d = diffTrees(before, after)
  const touched = [...d.added, ...d.changed, ...d.removed]
  const models = `workspace/${WORK_FOLDER}/models/`
  const existing = new Set([...before.keys()].filter((k) => k.startsWith(models)).map((k) => k.slice(models.length).split('/')[0]))
  const fresh = [...new Set(d.added.filter((k) => k.startsWith(models)).map((k) => k.slice(models.length).split('/')[0]))].filter((x) => !existing.has(x))
  const slug = fresh.length === 1 ? fresh[0] : null
  const mine = slug ? `${models}${slug}/` : '\0'
  const dir = slug ? join(cwd, 'models', slug) : ''
  c('run 完成', !ev.error && ev.done, ev.error || '')
  const sk = skillLoaded(ev.calls)
  c('用户自建 Agent 从全局技能目录装载了 live3d-import', sk.ok, sk.ok ? sk.how : sk.why)
  c('新建了恰好一个模型文件夹', fresh.length === 1, fresh.join(', ') || '(无)')
  if (slug) {
    const lower = [...existing].map((x) => x.normalize('NFKC').toLowerCase())
    c('文件夹名是合法 slug、且与已有文件夹不撞名(不分大小写 —— models/model 已被占)', /^[a-z0-9][a-z0-9-]{0,47}$/.test(slug) && !lower.includes(slug), slug)
  }
  const text = dir && existsSync(join(dir, P.PROFILE_FILE)) ? readFileSync(join(dir, P.PROFILE_FILE), 'utf8') : null
  c('在新文件夹里写出 live3d.json', text != null)
  const parsed = text != null ? P.parseProfile(text, P.modelFolder(WORK_FOLDER, slug)) : null
  if (parsed) c('通过插件 parseProfile 校验', parsed.ok, parsed.ok ? '' : parsed.en)
  const model = parsed?.ok ? parsed.value.model : ''
  c(`model 直接指向角色 PMX(${MMD_CHAR_D},不是道具 ${MMD_PROP_D})`, model.endsWith(MMD_CHAR_D), model)
  const abs = model ? join(dir, model) : ''
  c('model 文件真实存在、贴图 tex/颜.png 按原名在它旁边(中文文件名解对了)', !!abs && existsSync(abs) && existsSync(join(dirname(abs), 'tex', '颜.png')), abs)
  const bytes = abs && existsSync(abs) ? readFileSync(abs) : Buffer.alloc(0)
  const invented = []
  for (const [ph, spec] of Object.entries(parsed?.ok ? parsed.value.states : {})) {
    if (typeof spec?.clip === 'string') invented.push(`${ph}.clip=${spec.clip}`)
    for (const k of ['expression', 'mouth']) if (typeof spec?.[k] === 'string' && !bytes.includes(Buffer.from(spec[k], 'utf16le'))) invented.push(`${ph}.${k}=${spec[k]}`)
  }
  if (text != null) c('没有编造片段 / morph 名', invented.length === 0, invented.join(', '))
  c('下载目录里的原压缩包未被改动', !touched.some((x) => x.startsWith('Downloads/')), touched.filter((x) => x.startsWith('Downloads/')).join(', '))
  c('没往 Agent 自己的 cwd(Tangu/)里解压 / 写文件', !touched.some((x) => x.startsWith('Tangu/')), touched.filter((x) => x.startsWith('Tangu/')).join(', '))
  c('没碰插件数据文件(plugins-data/live3d.json)', !touched.some((x) => x.startsWith('forsion/plugins-data/')))
  const stray = touched.filter((x) => !x.startsWith(mine))
  c('除新模型文件夹外,库里 / 已有模型 / 插件目录都没有变化', stray.length === 0, stray.slice(0, 8).join(', '))
  const wo = writesOutside(ev.calls, userCwd, dir || cwd)
  c('写文件工具的路径都落在新模型文件夹里', wo.length === 0, wo.join(', '))
  const esc = ev.approvals.filter((a) => a.kind === 'escalate')
  c('没有触发「写到可写根之外」的越界审批', esc.length === 0, esc.map((a) => a.summary).join(' | '))
  c('没有反问用户(ask_user)', ev.inquiries.length === 0, ev.inquiries.map((q) => q.question).join(' | '))
  const said = ev.content
  c('告诉用户去模型库「设为 Desk 形象」(非插件发起的导入不会自动上 Desk)', /模型库|model library/i.test(said) && /设为 Desk 形象|Use on the Desk/i.test(said), short(said, 200))
  return { checks, profileText: text, states: parsed?.ok ? parsed.value.states : null, parsedOk: !!parsed?.ok, slug }
}

function judgeE(f, ev, sd) {
  const checks = []
  const c = (name, ok, detail = '') => checks.push({ name, ok, detail })
  c('run 完成', !ev.error && ev.done, ev.error || '')
  const shots = ev.calls.filter((x) => x.name === 'desk_screenshot')
  const seen = shots.find((x) => !x.isError && new RegExp(`plugin companion \\(${DESK_COMPANION}\\)`).test(x.result || ''))
  c('自己调了 desk_screenshot,结果说明截到的是 Live3D 伴随面', !!seen, shots.map((x) => short(x.result, 160)).join(' | ') || '没调 desk_screenshot')
  c('桌面端(台架)收到了截图请求', ev.captures.length > 0, `${ev.captures.length} 次`)
  const said = ev.content
  c('没说自己看不到 / 没让用户发截图', !/看不到|看不见|无法看到|没法看到|无法直接看|截图给我|发一张|发个截图|can(?:no|')t see|cannot see|send (?:me )?a screenshot/i.test(said), short(said, 200))
  c('回复描述了截图里的形象(黄色机器人)', /机器人|robot|黄|橙|yellow|orange/i.test(said), short(said, 200))
  c('没有改动任何模型文件(只看不改)', !sd.all.some((x) => /\/models\//.test(x)), sd.all.filter((x) => /\/models\//.test(x)).join(', '))
  const wo = writesOutside(ev.calls, userCwd, OUT)
  c('写文件工具的路径都在台架目录内', wo.length === 0, wo.join(', '))
  return { checks }
}

/** F:把已有形象绑给某个 Agent —— 只该往那份 live3d.json 的 agents 里加一个 slug,别的一概不动。 */
function judgeF(f, ev, sd) {
  const checks = []
  const c = (name, ok, detail = '') => checks.push({ name, ok, detail })
  c('run 完成', !ev.error && ev.done, ev.error || '')
  const profPath = join(folderOf(f), P.PROFILE_FILE)
  const text = existsSync(profPath) ? readFileSync(profPath, 'utf8') : null
  const parsed = text == null ? null : P.parseProfile(text, vaultDirOf(f))
  c('live3d.json 仍然合法(slug 写错大小写 / 写成显示名都会让整份 profile 作废)', !!parsed?.ok, parsed && !parsed.ok ? parsed.en : '')
  const agents = parsed?.ok ? parsed.value.agents : []
  c(`agents 里有 ${HELPER}`, agents.includes(HELPER), JSON.stringify(agents))
  c('没顺手绑上别的 Agent', agents.length === 1, JSON.stringify(agents))
  const beforeP = f.profileBefore ? P.parseProfile(f.profileBefore, vaultDirOf(f)) : null
  if (beforeP?.ok && parsed?.ok) {
    c('模型文件 / 构图 / 动作映射都没动(只改绑定)',
      parsed.value.model === beforeP.value.model && parsed.value.framing === beforeP.value.framing &&
      JSON.stringify(parsed.value.states) === JSON.stringify(beforeP.value.states),
      `model=${parsed.value.model} framing=${parsed.value.framing}`)
  }
  c('没碰插件数据文件(plugins-data/live3d.json)', !sd.all.some((x) => x.includes('plugins-data/')))
  c(`工作文件夹内只动了 models/${f.slug}/`, sd.outsideModel.length === 0, sd.outsideModel.join(', '))
  const wo = writesOutside(ev.calls, userCwd, folderOf(f))
  c('写文件工具的路径都在这个模型文件夹里', wo.length === 0, wo.join(', '))
  return { checks, profileText: text, parsedOk: !!parsed?.ok }
}

/** G:用户说「站得像木头人 / 手陷进身体里」—— 先看一眼截图,再调 pose 里的数,别去动模型或动作映射。 */
function judgeG(f, ev, sd) {
  const checks = []
  const c = (name, ok, detail = '') => checks.push({ name, ok, detail })
  c('run 完成', !ev.error && ev.done, ev.error || '')
  const profPath = join(folderOf(f), P.PROFILE_FILE)
  const text = existsSync(profPath) ? readFileSync(profPath, 'utf8') : null
  const parsed = text == null ? null : P.parseProfile(text, vaultDirOf(f))
  c('live3d.json 仍然合法(pose 超界会让整份 profile 作废)', !!parsed?.ok, parsed && !parsed.ok ? parsed.en : '')
  const pose = parsed?.ok ? parsed.value.pose : null
  const changed = pose ? Object.keys(P.DEFAULT_POSE).filter((k) => pose[k] !== P.DEFAULT_POSE[k]) : []
  c('写了 pose,而且真的改了数(不是原样抄一遍缺省)', changed.length > 0, JSON.stringify(pose))
  c('改的是能把手从身体里挪出来的那几个(armSpread / armForward / elbow 至少一个调大了)',
    !!pose && ['armSpread', 'armForward', 'elbow'].some((k) => pose[k] > P.DEFAULT_POSE[k]), JSON.stringify(pose))
  // 技能要求「先看再改」:截图必须排在第一次写文件之前
  const iShot = ev.calls.findIndex((x) => x.name === 'desk_screenshot')
  const iWrite = ev.calls.findIndex((x) => /write_file|edit_file|str_replace/.test(x.name))
  c('先 desk_screenshot 看了一眼,再动手改', iShot >= 0 && (iWrite < 0 || iShot < iWrite), `shot@${iShot} write@${iWrite}`)
  const beforeP = f.profileBefore ? P.parseProfile(f.profileBefore, vaultDirOf(f)) : null
  if (beforeP?.ok && parsed?.ok) {
    const A0 = beforeP.value.states, B0 = parsed.value.states
    // 技能里写明的一步:待机阶段在播片段时 pose 不生效,把 idle.clip 设成 null 让程序化姿势接管。
    // 所以「idle 的片段被关掉」算对,其余阶段的映射一律不许动。
    const others = P.PHASES.filter((ph) => ph !== 'idle')
    const idleOk = JSON.stringify({ ...A0.idle, clip: null }) === JSON.stringify({ ...B0.idle, clip: null }) &&
      (B0.idle?.clip === null || B0.idle?.clip === A0.idle?.clip)
    c('模型文件没换、其余阶段的动作映射没动(只调姿势;按技能关掉 idle 片段是允许的)',
      parsed.value.model === beforeP.value.model && idleOk && others.every((ph) => JSON.stringify(A0[ph]) === JSON.stringify(B0[ph])),
      `model=${parsed.value.model} idle=${JSON.stringify(B0.idle)}`)
    c('关掉 idle 片段的话,回复里要说清楚(用户得知道待机动画为什么没了)',
      B0.idle?.clip !== null || /片段|动画|clip|animation/i.test(ev.content), short(ev.content, 160))
  }
  c('没说自己看不到 / 没让用户发截图', !/看不到|看不见|无法看到|没法看到|截图给我|发一张|can(?:no|')t see|cannot see|send (?:me )?a screenshot/i.test(ev.content), short(ev.content, 200))
  c(`工作文件夹内只动了 models/${f.slug}/`, sd.outsideModel.length === 0, sd.outsideModel.join(', '))
  const wo = writesOutside(ev.calls, userCwd, folderOf(f))
  c('写文件工具的路径都在这个模型文件夹里', wo.length === 0, wo.join(', '))
  return { checks, profileText: text, parsedOk: !!parsed?.ok }
}

function judgeB(f, ev, sd) {
  const checks = []
  const c = (name, ok, detail = '') => checks.push({ name, ok, detail })
  c('run 完成', !ev.error && ev.done, ev.error || '')
  const profPath = join(folderOf(f), P.PROFILE_FILE)
  c('没有写 live3d.json(且 run 真跑完)', ev.done && !existsSync(profPath)) // run 报错时「没写」是空洞的过
  const said = ev.content
  c('最终回复提到 Live2D', /live\s?2d/i.test(said))
  c('最终回复讲了授权原因', /licen[cs]e|licensing|授权|許可|许可|授權|ライセンス/i.test(said))
  c('原始文件未被改动', sd.originalsTouched.length === 0, sd.originalsTouched.join(', '))
  c('工作文件夹之外无写入(目录树前后对比)', sd.outsideWork.length === 0, sd.outsideWork.join(', '))
  c(`工作文件夹内只动了 models/${f.slug}/(README.md、别的模型都没动)`, sd.outsideModel.length === 0, sd.outsideModel.join(', '))
  const wo = writesOutside(ev.calls, cwd, folderOf(f))
  c(`写文件工具的路径都在 models/${f.slug}/ 内`, wo.length === 0, wo.join(', '))
  return { checks }
}

// ── 7. 报告 ──────────────────────────────────────────────────────────────────────────────────────────────────
const results = []
let health = null
let setup = []
let finished = false
const fence = (s, n = 4000) => '```\n' + String(s || '(空)').slice(0, n) + (String(s || '').length > n ? '\n…(截断)' : '') + '\n```'
const sec = (ms) => (ms == null ? '-' : `${(ms / 1000).toFixed(1)}s`)
async function finish(reason, exitCode = 1) {
  if (finished) return
  finished = true
  rmSync(authLink, { force: true }) // 任何退出路径都不留凭证软链
  if (!childExit) {
    child.kill('SIGTERM')
    await Promise.race([new Promise((r) => child.once('exit', r)), sleep(8000)])
  }
  if (!childExit) child.kill('SIGKILL')
  const allChecks = [...setup, ...results.flatMap((r) => r.checks)]
  const failed = allChecks.filter((x) => !x.ok)
  const ok = !reason && results.length > 0 && failed.length === 0
  const md = [
    `# Live3D Importer live 台架 ${startedAt}`,
    '',
    `- 模型 \`${MODEL}\`;引擎 ${health?.version || '?'};提示词语言 ${LOCALE};夹具 ${[...ONLY].join(',')}${reason ? `;**提前结束:${reason}**` : ''}`,
    `- 工作文件夹(cwd)\`${cwd}\`;隔离 home \`${home}\`;引擎日志 \`${engineLog}\``,
    `- 结论:**${ok ? 'PASS' : 'FAIL'}**(${allChecks.length - failed.length}/${allChecks.length} 条判据通过)`,
    '',
    '## 前置(捆绑包播种)',
    '',
    '| 判据 | 结果 | 说明 |', '|---|---|---|',
    ...setup.map((x) => `| ${x.name} | ${x.ok ? 'PASS' : 'FAIL'} | ${String(x.detail || '').replace(/\|/g, '/')} |`),
    '',
    ...results.flatMap((r) => [
      `## 夹具 ${r.title}`,
      '',
      `- 会话 \`${r.sessionId}\`;墙钟 ${sec(r.wallMs)};首个正文 token ${sec(r.firstTokenMs)};工具调用 ${r.calls.length} 次;代批审批 ${r.approvals.length} 次;代答询问 ${r.inquiries.length} 次`,
      '',
      '| 判据 | 结果 | 说明 |', '|---|---|---|',
      ...r.checks.map((x) => `| ${x.name} | ${x.ok ? 'PASS' : 'FAIL'} | ${String(x.detail || '').replace(/\|/g, '/')} |`),
      '',
      '### 发出的提示词(= 插件 buildImportPrompt)', fence(r.prompt),
      '### 工具调用序列', fence(r.calls.map((c, i) => `${i + 1}. ${callLabel(c)}`).join('\n') || '(无)'),
      ...(r.approvals.length ? ['### 代批的审批', fence(r.approvals.map((a) => `${a.tool}: ${a.summary}`).join('\n'))] : []),
      ...(r.inquiries.length ? ['### 代答的询问', fence(r.inquiries.map((q) => `Q: ${q.question}\nA: ${q.answer}`).join('\n\n'))] : []),
      '### 模型最终回复', fence(r.content),
      ...(r.profileText != null ? ['### 写出的 live3d.json', fence(r.profileText)] : []),
      ...(r.states ? ['### 状态映射', fence(Object.entries(r.states).map(([k, v]) => `${k.padEnd(9)} ${JSON.stringify(v)}`).join('\n') || '(空)')] : []),
      '### 目录树变化(+ 新增 / ~ 修改 / - 删除)', fence(r.diff.all.join('\n') || '(无)'),
      ...(r.diff.outsideModel.length ? [`> 注意:工作文件夹内、但在 models/${r.slug}/ 之外有变化:${r.diff.outsideModel.join(', ')}`, ''] : []),
    ]),
  ].join('\n')
  writeFileSync(join(OUT, 'report.md'), md)
  writeFileSync(join(OUT, 'results.json'), JSON.stringify({
    model: MODEL, engine: health, locale: LOCALE, only: [...ONLY], startedAt, finishedAt: new Date().toISOString(), reason: reason || null, ok,
    setup, results: results.map(({ calls, ...r }) => ({ ...r, calls: calls.map((c) => ({ name: c.name, args: c.args, isError: c.isError, result: String(c.result ?? '').slice(0, 2000) })) })),
  }, null, 2))
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${allChecks.length - failed.length}/${allChecks.length}${reason ? `(提前结束:${reason})` : ''}`)
  for (const x of failed) console.log(`  FAIL  ${x.name}${x.detail ? ` — ${x.detail}` : ''}`)
  console.log(`报告:${join(OUT, 'report.md')}\n引擎日志:${engineLog}`)
  process.exit(ok ? 0 : exitCode)
}
const globalTimer = setTimeout(() => {
  console.error(`整体 ${TIMEOUT_MS / 1000}s 超时`)
  void finish('timeout')
}, TIMEOUT_MS)
globalTimer.unref?.()
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => void finish(sig))

try {
  health = await until(() => (childExit ? Promise.resolve(null) : fetch(`${base}/health`).then((r) => (r.ok ? r.json() : null)).catch(() => null)), 30_000, 500)
  if (!health || childExit) throw new Error(`引擎${childExit ? `已退出(code ${childExit.code} ${childExit.signal || ''})` : ' 30s 未就绪'}\n${existsSync(engineLog) ? readFileSync(engineLog, 'utf8').slice(-1500) : ''}`)
  console.log(`引擎 ${health.version} 就绪 :${port},模型 ${MODEL},产物 ${OUT}`)
  const models = asList(await api('/agent/models'), 'models')
  if (!models.some((m) => m.id === MODEL)) {
    throw new Error(`模型目录无 ${MODEL};直连可用:${models.filter((m) => m.source === 'direct').map((m) => m.id).join(', ') || '(无 —— 凭证未装载或已失效)'}`)
  }
  rmSync(authLink, { force: true }) // 凭证只在引擎启动时装载一次 → 立刻拆掉软链

  // 额度预检:一句不调工具的话。订阅窗口用尽 = 前置条件不满足(退出码 2),别把它记成 Agent 的红
  {
    const pre = (await api('/agent/sessions', { method: 'POST', body: JSON.stringify({ title: 'quota probe', model_id: MODEL, agent_config: { execMode: 'host', cwd } }) })).session
    const ev = await run(pre.id, 'Reply with exactly OK. Do not call tools.', { execMode: 'host', cwd })
    if (/usage limit|rate limit|quota|\b429\b/i.test(ev.error || '')) {
      setup.push({ name: `模型额度预检(${MODEL})`, ok: false, detail: `${ev.error} —— 订阅窗口用尽,换 --model 或等额度恢复;Agent 本身未被测到` })
      await finish('quota', 2)
    }
    setup.push({ name: `模型额度预检(${MODEL})`, ok: !ev.error && ev.done, detail: ev.error || short(ev.content, 40) })
  }

  // 捆绑包:agent 播种进名册;技能是包根的**全局技能** —— 不带 agentSlug、用户自建 Agent、导入 Agent 三种视角都看得到;
  // 播种后 tangu/agents/live3d-importer/ 里**没有** skills/(agent 级同 id 副本会永久遮住全局版)
  const agents = await until(async () => {
    const list = asList(await api('/agent/agents').catch(() => []), 'agents')
    return list.some((a) => a.slug === AGENT) ? list : null
  }, 20_000)
  const agent = agents?.find((a) => a.slug === AGENT)
  setup.push({ name: `GET /agent/agents 列出 ${AGENT}(从捆绑包播种)`, ok: !!agent, detail: agent ? `name=${agent.name}` : '20s 内未出现' })
  setup.push({ name: `GET /agent/agents 列出用户自建的 ${HELPER}`, ok: !!agents?.some((a) => a.slug === HELPER) })
  for (const [label, q] of [['不带 agentSlug(全局)', ''], [`?agentSlug=${HELPER}(用户自建 Agent)`, `?agentSlug=${HELPER}`], [`?agentSlug=${AGENT}`, `?agentSlug=${AGENT}`]]) {
    const skills = asList(await api(`/agent/skills${q}`).catch(() => []), 'skills')
    const sk = skills.find((x) => x.id === SKILL_ID)
    setup.push({ name: `GET /agent/skills ${label} 有 ${SKILL_ID}`, ok: !!sk, detail: sk ? `name=${sk.name}` : `共 ${skills.length} 条,无 ${SKILL_ID}` })
  }
  const shadow = join(home, 'agents', AGENT, 'skills')
  setup.push({ name: '播种后导入 Agent 目录里没有 skills/(不会遮住全局版)', ok: !existsSync(shadow), detail: existsSync(shadow) ? readdirSync(shadow).join(', ') : '' })
  for (const x of setup) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.detail ? `  | ${x.detail}` : ''}`)
  if (setup.some((x) => !x.ok)) throw new Error('捆绑包没播种成功,后面的 run 没有意义')

  // A–C 与桌面 startChat → send() 同形;extraRoots = 库根(appStore withAmadeusWorkspace:工作文件夹 ≠ 库根时追加)。
  // D 与用户 09-19 那次同形:普通 Agent、cwd = 自己的默认工作区、库根只在 extraRoots 里
  const importerConfig = { execMode: 'host', cwd, agentSlug: AGENT, extraRoots: [workspace] }
  const helperConfig = { execMode: 'host', cwd: userCwd, agentSlug: HELPER, extraRoots: [workspace] }
  for (const key of FIXTURES.filter((k) => ONLY.has(k))) {
    const f = fx[key]
    const agentConfig = ['anyagent', 'desklook', 'bind', 'tunepose'].includes(key) ? helperConfig : importerConfig
    console.log(`\n▶ 夹具 ${f.title}`)
    // F / G 改的是一份**已经存在**的 profile:留一份改前的原文,判定「只改了该改的那一项」
    if (key === 'bind' || key === 'tunepose') {
      const pp = join(folderOf(f), P.PROFILE_FILE)
      f.profileBefore = existsSync(pp) ? readFileSync(pp, 'utf8') : null
    }
    const before = snapAll()
    const sess = (await api('/agent/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: `Live3D import ${f.slug ?? key}`, model_id: MODEL, project_path: agentConfig.cwd, project_name: agentConfig === helperConfig ? 'Tangu' : WORK_FOLDER, agent_config: agentConfig }),
    })).session
    const ev = await run(sess.id, f.prompt, agentConfig)
    const after = snapAll()
    const dd = diffTrees(before, after)
    // D 没有预定的模型文件夹:报告只列目录差异,越界判定在 judgeD 里按它新建的那个文件夹算
    const sd = key === 'anyagent' || key === 'desklook'
      ? { all: [...dd.added.map((x) => `+ ${x}`), ...dd.changed.map((x) => `~ ${x}`), ...dd.removed.map((x) => `- ${x}`)], outsideModel: [] }
      : scopeDiff(f, before, after)
    const j = key === 'robot' ? judgeA(f, ev, sd)
      : key === 'mmdzip' ? judgeC(f, ev, sd)
      : key === 'anyagent' ? judgeD(f, ev, before, after)
      : key === 'desklook' ? judgeE(f, ev, sd)
      : key === 'bind' ? judgeF(f, ev, sd)
      : key === 'tunepose' ? judgeG(f, ev, sd)
      : judgeB(f, ev, sd)
    const row = {
      key, title: f.title, slug: f.slug, sessionId: sess.id, prompt: f.prompt, content: ev.content, error: ev.error,
      wallMs: ev.wallMs, firstTokenMs: ev.firstTokenMs, calls: ev.calls, approvals: ev.approvals, inquiries: ev.inquiries, usages: ev.usages, diff: sd, ...j,
    }
    results.push(row)
    console.log(`  工具:${ev.calls.map(callLabel).join(' → ') || '(无)'}`)
    for (const x of j.checks) console.log(`  ${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.detail ? `  | ${x.detail}` : ''}`)
    console.log(`  最终回复:${short(ev.content, 300)}`)
    // 额度 / 限流:后面的夹具必撞同一堵墙,别再白等(同 live-harness「上游失败不烧额度」)
    if (/usage limit|rate limit|quota|\b429\b/i.test(ev.error || '')) {
      const rest = FIXTURES.filter((k) => ONLY.has(k)).slice(FIXTURES.filter((k) => ONLY.has(k)).indexOf(key) + 1)
      if (rest.length) setup.push({ name: `余下夹具未跑(${rest.join(',')})`, ok: false, detail: `模型额度 / 限流:${ev.error};换 --model 或等额度恢复` })
      break
    }
  }
  await finish()
} catch (e) {
  setup.push({ name: '台架执行', ok: false, detail: String(e?.message || e).slice(0, 1500) })
  await finish()
}
