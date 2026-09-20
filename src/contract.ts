// Live3D 的数据契约 + 纯路径工具。**零依赖(不 import three、不碰 DOM)**:profile / heuristics /
// reactions / analysis 的纯半边与 node 单测都从这里拿类型,打包进 scripts/unit.mjs 时不会拖进 three。
//
// 磁盘约定(P2 的导入流程与 agent 技能都按这个写):
//   <workFolder>/models/<slug>/live3d.json   —— Profile(人/agent 可手改,parseProfile 校验)
//   <workFolder>/models/<slug>/analysis.json —— Analysis(导入时由 analyze() 生成,给 agent 读)
//   <workFolder>/models/<slug>/preview.png   —— stage.snapshot() 的正面缩略图
//   模型文件与动作文件放在同一个 <slug>/ 下,profile 里一律写**相对 profile 所在文件夹**的路径。

/** Agent 运行阶段(与宿主 TanguAgentPhase 逐字一致)。 */
export const PHASES = ['idle', 'thinking', 'speaking', 'tool', 'waiting', 'error', 'done'] as const
export type Phase = (typeof PHASES)[number]
export const isPhase = (v: unknown): v is Phase => typeof v === 'string' && (PHASES as readonly string[]).includes(v)

/** 宿主 TanguAgentStatus 的子集 —— stage 只需要这些(宿主类型是它的超集,可直接传)。 */
export interface AgentStatusLike {
  phase: Phase
  sessionId: string | null
  tool?: string
  toolStage?: 'args' | 'exec'
  waitingFor?: 'approval' | 'inquiry'
  /** 当前流式气泡 id;变了 = 换了一条消息,口型包络归零重来。 */
  messageId?: string
  /** 当前流式气泡正文的累计字符数(拉取式,stage 逐帧求增量)。 */
  textChars: number
}

/** 某个阶段的反应配置。全部可省略,省略的部分由 reactions.planFor 按阶段缺省补。 */
export interface StateSpec {
  /** 要播的动画片段名;`null` = 明确「不播片段,只用程序化动作」;省略 = 用缺省(通常沿用 idle 片段)。 */
  clip?: string | null
  /** VRM 表情名(VRM1 预设名或自定义名)或非 VRM 模型的 morph 名。 */
  expression?: string
  /** 表情权重 [0,1]。 */
  weight?: number
  /** 说话时驱动口型的表情 / morph 名(VRM 缺省 'aa')。 */
  mouth?: string
  /** 片段只播一遍,播完回 idle 片段(打招呼 / 庆祝这类)。 */
  once?: boolean
}

export type Framing = 'bust' | 'full' | 'face'
export const FRAMINGS: readonly Framing[] = ['bust', 'full', 'face']

/** 待机姿势的微调(2026-09-20+)。模型自带动作片段时片段说了算,这几个数只管「没片段可播」的那一层
 *  程序化姿势 —— 绝大多数 MMD / VRoid 模型都属于这一类。人和 agent 都改得动:看一眼截图,调一个数,存盘即生效。 */
export interface ProfilePose {
  /** 手臂离身侧多远。0 = 紧贴身体,1 = 平举。裙摆 / 盔甲宽的角色调大,手才不会陷进衣服里。 */
  armSpread: number
  /** 手臂往前摆多少。0 = 完全在身侧,1 = 抬到身前。厚实的角色调大一点。 */
  armForward: number
  /** 手肘弯多少。0 = 直挺挺,1 = 弯成直角。 */
  elbow: number
  /** 待机幅度:呼吸、轻晃、手臂缓慢摆动的总倍率。0 = 站着完全不动,2 = 加倍。 */
  liveliness: number
}

/** 程序化待机姿势的缺省。改这里等于改所有没写 pose 的模型 —— 先跑 render-smoke 看截图。
 *  这一组是对着真实模型(MMD / VRM / Mixamo)的截图调出来的:手臂略微外张并前摆、手肘微弯,
 *  让手落在裙摆 / 胯部之外;左右两侧用不同周期缓慢漂移,免得看起来像个挂在衣架上的人偶。 */
export const DEFAULT_POSE: ProfilePose = { armSpread: 0.36, armForward: 0.2, elbow: 0.26, liveliness: 1 }

export interface ProfileTransform {
  /** 归一化(身高≈1.6 单位、脚底落 0)**之后**再乘的缩放。 */
  scale: number
  /** 绕竖轴转多少度(模型不朝镜头时用)。 */
  rotateY: number
  /** 归一化之后的竖直偏移(单位 ≈ 米)。 */
  offsetY: number
  /** 模型的「上」是哪根轴。缺省 'y';OBJ 这类无约定格式躺倒时填 'z'(先绕 X 转 -90° 再归一化)。 */
  upAxis?: 'y' | 'z'
}

/** live3d.json(v1)。路径全部相对 profile 所在文件夹。 */
export interface Profile {
  live3d: 1
  name: string
  /** 模型文件,如 `avatar.vrm`。 */
  model: string
  /** 动作片段来源(.vrma / .fbx / .glb / .gltf),如 `motions/wave.vrma`。 */
  motions: string[]
  /** 绑给哪些 Agent(slug,如 `xyra`)。当前对话的 Agent 命中其中之一 → Desk 上显示这个形象;
   *  一个都没命中 → 显示「默认形象」(设置页选的那个)。空数组 = 不绑定。 */
  agents: string[]
  transform: ProfileTransform
  framing: Framing
  states: Partial<Record<Phase, StateSpec>>
  pose: ProfilePose
}

/** parseProfile 的产物:补齐缺省 + 解析好**库内相对**路径(可直接喂 assetUrl)。 */
export interface ResolvedProfile extends Profile {
  /** profile 所在文件夹(库内相对,无首尾 '/')。 */
  dir: string
  modelPath: string
  motionPaths: string[]
}

export type ModelFormat = 'vrm' | 'gltf' | 'glb' | 'fbx' | 'obj' | 'pmx' | 'pmd'
export type RigKind = 'vrm' | 'mixamo' | 'vroid' | 'mmd' | 'unknown'

export interface ClipInfo {
  /** 片段名(已去掉 `Armature|` 前缀;`mixamo.com` / `Take 001` 这类无意义名已换成来源文件名)。StateSpec.clip 填它。 */
  name: string
  /** 秒。 */
  duration: number
  /** 来自哪个文件(相对 profile 所在文件夹,与 Profile.motions 同一口径;模型自带的片段 = 模型文件)。 */
  source: string
}

/** analysis.json —— 导入时对模型做的一次体检,给 agent 与工作室页读。warnings 是给 agent 看的英文诊断。 */
export interface Analysis {
  live3d: 1
  /** ISO 时间。 */
  generatedAt: string
  /** 模型文件名(相对 profile 文件夹)。 */
  file: string
  format: ModelFormat
  vrm?: { specVersion: '0' | '1'; title?: string; expressions: string[]; humanBones: string[] }
  clips: ClipInfo[]
  morphs: string[]
  bones: { count: number; head?: string; neck?: string; rig?: RigKind }
  meshes: number
  triangles: number
  /** 实际加载到的贴图张数(去重)。 */
  textures: number
  /** 原始单位下的包围盒尺寸 [x, y, z]。 */
  size: [number, number, number]
  upAxisGuess: 'y' | 'z'
  warnings: string[]
  suggested: Profile['states']
}

/** 双语消息(错误 / 警告)。界面按当前语言挑一个。 */
export interface Msg {
  zh: string
  en: string
}

// ── 文件名约定 ────────────────────────────────────────────────────────────────
export const PROFILE_FILE = 'live3d.json'
export const ANALYSIS_FILE = 'analysis.json'
export const PREVIEW_FILE = 'preview.png'
export const MODELS_DIR = 'models'

// PMX / PMD 排最后:同一文件夹里既有 .glb 又有 .pmx 时仍挑 .glb(mainOf 按这个顺序排优先级)。
export const MODEL_EXTS: readonly ModelFormat[] = ['vrm', 'glb', 'gltf', 'fbx', 'obj', 'pmx', 'pmd']
export const MOTION_EXTS: readonly string[] = ['vrma', 'fbx', 'glb', 'gltf']

/** `<workFolder>/models/<slug>` */
export const modelFolder = (workFolder: string, slug: string): string => joinRel(workFolder, `${MODELS_DIR}/${slug}`)

/** 文件名 → 文件夹 slug:小写 ASCII、数字、连字符;全是非 ASCII(比如纯中文名)时退回 `model`。
 *  重名由调用方加 `-2`/`-3` 去重。 */
export function slugify(name: string): string {
  const base = stripExt(baseName(name))
  const s = base
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return s || 'model'
}

// ── 纯路径工具(库内相对路径,'/' 分隔) ─────────────────────────────────────────
/** 反斜杠 → '/'、去掉 './'、合并重复 '/'、去首尾 '/'。不处理 '..'(由 safeRel 拒绝)。 */
export function normRel(p: string): string {
  return String(p ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.')
    .join('/')
}

/** 拼接两段相对路径;`b` 里的 '..' 会向上吃掉 `a` 的段(吃穿根 = 停在根)。 */
export function joinRel(a: string, b: string): string {
  const out = normRel(a).split('/').filter(Boolean)
  for (const seg of normRel(b).split('/')) {
    if (!seg) continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

export const dirOf = (p: string): string => {
  const n = normRel(p)
  const i = n.lastIndexOf('/')
  return i < 0 ? '' : n.slice(0, i)
}
export const baseName = (p: string): string => {
  const n = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  return n.slice(n.lastIndexOf('/') + 1)
}
/** 小写扩展名,不含点;`a.model3.json` → `json`。 */
export const extOf = (p: string): string => {
  const b = baseName(p)
  const i = b.lastIndexOf('.')
  return i <= 0 ? '' : b.slice(i + 1).toLowerCase()
}
export const stripExt = (p: string): string => {
  const b = baseName(p)
  const i = b.lastIndexOf('.')
  return i <= 0 ? b : b.slice(0, i)
}

/** 绝对路径 / 盘符 / URL scheme / '..' 越界 → 不安全。profile 里的路径只许留在自己文件夹里。 */
export function isSafeRel(p: string): boolean {
  if (typeof p !== 'string' || !p.trim()) return false
  const s = p.trim().replace(/\\/g, '/')
  if (s.startsWith('/') || s.startsWith('~')) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return false // C:  http:  amadeus-asset:  file:
  return !s.split('/').some((seg) => seg === '..')
}

// ── Agent 绑定 ────────────────────────────────────────────────────────────────
/** Agent slug 的形状 —— 与引擎 `agents/agentRegistry.ts` 的 SLUG_RE 逐字一致。宽一点就会把
 *  `Bad Slug` / `../x` 这类写进 profile,绑定永远不生效而且没人看得出为什么。 */
export const isAgentSlug = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(v)

/** 一条「谁绑了哪些 Agent」的记录(库条目的子集,便于纯函数单测)。 */
export interface Claim {
  slug: string
  agents: readonly string[]
}

/** 这个 Agent 该用哪个形象。多个形象认领同一个 Agent 时按**形象 slug 字典序**取第一个 ——
 *  与库的显示排序(按名字)无关,换个名字不会悄悄换形象。没人认领 / 不知道是哪个 Agent → null。 */
export function claimFor<T extends Claim>(list: readonly T[], agent: string | null | undefined): T | null {
  if (!agent) return null
  let best: T | null = null
  for (const e of list) {
    if (!e.agents.includes(agent)) continue
    if (!best || e.slug < best.slug) best = e
  }
  return best
}

/** 被多个形象同时认领的 Agent:agent slug → 落选的形象 slug(已排序)。用来在模型库里说一声,不做冲突界面。 */
export function duplicateClaims<T extends Claim>(list: readonly T[]): Map<string, string[]> {
  const by = new Map<string, string[]>()
  for (const e of list) for (const a of e.agents) by.set(a, [...(by.get(a) ?? []), e.slug])
  const dup = new Map<string, string[]>()
  for (const [a, slugs] of by) {
    if (slugs.length < 2) continue
    const sorted = [...slugs].sort()
    dup.set(a, sorted.slice(1))
  }
  return dup
}

/** Live2D 包的特征文件(v1 因授权不支持,见 README)。 */
export const isLive2DPath = (p: string): boolean => /\.(model3\.json|model\.json|moc3|moc)$/i.test(String(p ?? ''))

/** 按扩展名认格式;Live2D → 'live2d';其它不支持的 → null。 */
export function detectFormat(p: string): ModelFormat | 'live2d' | null {
  if (isLive2DPath(p)) return 'live2d'
  const e = extOf(p)
  return (MODEL_EXTS as readonly string[]).includes(e) ? (e as ModelFormat) : null
}

/** Live2D 的拒绝文案(导入页与 loaders 同源)。 */
export const LIVE2D_REFUSAL: Msg = {
  zh: '暂不支持 Live2D 模型:Live2D Cubism SDK 的授权条款要求「可加载任意用户模型」的应用单独申请发行许可,目前无法随插件免费分发。请改用 VRM / GLB / FBX 等 3D 模型。',
  en: 'Live2D models are not supported yet: the Live2D Cubism SDK licence requires a separate publication licence for apps that load arbitrary user models, so it cannot ship with a free plugin. Please use a 3D model instead (VRM, GLB, FBX, etc.).',
}
