// 场景(scene.json)的数据契约与校验。**零依赖**(不碰 three / DOM):解析、缺省、道具锚点都在这里,
// 渲染(props.ts / roomStage.ts)与行为(brain.ts)只吃解析好的 ResolvedScene。
//
// 磁盘约定:<workFolder>/scenes/<slug>/scene.json。人手改、agent 写都行,所以错误一律是双语、能照着改的人话;
// 不认识的字段只警告(新版写的字段旧版读得进来),不认识的道具类型跳过并警告。
//
// 坐标系(米):原点 = 地板中心;+X 往右、+Z 朝观众、+Y 朝上。三面房间 = 地板 + 左墙(x = -width/2)
// + 右墙(z = -depth/2),前面两边敞开给镜头。道具的 rot 是绕 Y 的角度(度),rot = 0 时道具正面朝 +Z。

import type { Msg, Phase } from '../contract'
import { isPhase, PHASES } from '../contract'

export const SCENES_DIR = 'scenes'
export const SCENE_FILE = 'scene.json'

export type TimeMode = 'auto' | 'day' | 'night'
export const TIME_MODES: readonly TimeMode[] = ['auto', 'day', 'night']

/** 身体姿势(活动的「做什么」)。brain 只认名字,poses.ts 负责把名字变成骨骼角度。 */
export const POSES = [
  'stand', 'gaze', 'telescope', 'browse', 'view', 'water', 'stretch', 'yawn', 'nod-off', 'wave', 'talk', 'cheer', 'sigh', 'crouch',
  'sit', 'sit-read', 'sit-work', 'sit-think', 'sit-doze', 'desk-sleep', 'piano', 'hug',
  'lie', 'sleep', 'sunbathe',
] as const
export type PoseName = (typeof POSES)[number]
export const isPose = (v: unknown): v is PoseName => typeof v === 'string' && (POSES as readonly string[]).includes(v)

/** 姿势属于哪种「站法」:决定到了地方要不要坐下 / 躺下,以及锚点要不要贴着座面 / 床面。 */
export type Stance = 'stand' | 'sit' | 'lie'
export function stanceOf(p: PoseName): Stance {
  if (p === 'lie' || p === 'sleep' || p === 'sunbathe') return 'lie'
  if (p.startsWith('sit') || p === 'desk-sleep' || p === 'piano' || p === 'hug') return 'sit'
  return 'stand'
}

export const EMOTES = ['zzz', 'star', 'note', 'heart', 'question', 'exclaim', 'sweat', 'anger', 'sparkle', 'dots'] as const
export type EmoteName = (typeof EMOTES)[number]
const isEmote = (v: unknown): v is EmoteName => typeof v === 'string' && (EMOTES as readonly string[]).includes(v)

export interface WindowSpec {
  wall: 'left' | 'right'
  /** 窗中心沿墙的位置,0..1:0 = 两面墙相交的墙角,1 = 敞开的那头。左墙沿 +Z、右墙沿 +X。 */
  at: number
  width: number
  height: number
  /** 窗台离地多高。 */
  sill: number
}

export interface RoomShell {
  width: number
  depth: number
  /** 墙高。 */
  height: number
  floor: string
  wallLeft: string
  wallRight: string
  /** 踢脚线 / 墙头切面 / 窗框。 */
  trim: string
  /** 地板是不是木条。 */
  planks: boolean
  windows: WindowSpec[]
}

export interface PropSpec {
  type: string
  id?: string
  at: [number, number]
  /** 离地高度(挂墙的道具用;落地的省略)。 */
  y: number
  rot: number
  scale: number
  color?: string
  color2?: string
  /** 款式:海报 starmap / planet,玩偶 bunny / cat / bear / star,书桌上摆什么("camera,brush,globe,books,cup")。 */
  variant?: string
  /** 道具上的字(书法条幅)。 */
  text?: string
}

export interface ActivitySpec {
  id: string
  /** 在哪:道具 id(用它的缺省锚点)、`<道具 id>.<锚点>`、`window` / `window.<序号>`、`center`、`front`。 */
  at: string
  pose: PoseName
  /** 持续时间区间(秒)。 */
  time: [number, number]
  weight: number
  /** 只在白天 / 夜里做。 */
  when?: 'day' | 'night'
  emote?: EmoteName
  /** 做完接哪个活动(比如睡醒 → 伸懒腰);省略 = 按权重再抽。 */
  then?: string
  /** 给人看的名字(状态条显示「他在干什么」):一句话,或 { "zh": …, "en": … }。 */
  label?: Label
  /** 只由 then / Agent 阶段触发,不参加随机抽签。 */
  chained?: boolean
}

/** 给人看的文字:一句话(不分语言),或按界面语言挑的双语对象。 */
export type Label = string | { zh?: string; en?: string }

/** 按界面语言挑一句;双语对象缺哪边就用另一边。 */
export function pickLabel(l: Label | undefined, locale: 'zh' | 'en'): string | undefined {
  if (l === undefined) return undefined
  if (typeof l === 'string') return l
  return (locale === 'zh' ? l.zh ?? l.en : l.en ?? l.zh) || undefined
}

function parseLabel(v: unknown, max: number): Label | null {
  if (typeof v === 'string') return v.slice(0, max)
  if (isObj(v) && Object.keys(v).every((k) => k === 'zh' || k === 'en') && Object.values(v).every((x) => typeof x === 'string')) {
    const o: { zh?: string; en?: string } = {}
    if (typeof v.zh === 'string') o.zh = v.zh.slice(0, max)
    if (typeof v.en === 'string') o.en = v.en.slice(0, max)
    return o.zh || o.en ? o : null
  }
  return null
}

export interface SceneSpec {
  live3d: 1
  kind: 'room'
  name: Label
  /** 住在这里的形象(模型库 slug);null = 用 Desk 的默认形象。 */
  character: string | null
  /** 形象在房间里的身高(米)。Q 版模型大头短腿,1.2 左右和家具比例最像。 */
  height: number
  time: TimeMode
  /** 夜里的主色调(背景、窗外、月光)。 */
  sky: string
  room: RoomShell
  props: PropSpec[]
  activities: ActivitySpec[]
  /** Agent 阶段 → 活动 id(省略的阶段不打断日常)。 */
  agent: Partial<Record<Phase, string>>
}

export interface ResolvedScene extends SceneSpec {
  /** scene.json 所在的库内文件夹。内置场景是 `builtin:<id>`。 */
  dir: string
  slug: string
}

export type SceneParseResult = { ok: true; value: ResolvedScene; warnings: Msg[] } | ({ ok: false } & Msg)

// ── 缺省 ─────────────────────────────────────────────────────────────────────
export const DEFAULT_ROOM: RoomShell = {
  width: 4.2, depth: 4.2, height: 2.7,
  floor: '#b58a64', wallLeft: '#e9e2d6', wallRight: '#e2dacd', trim: '#f7f3ec', planks: true,
  windows: [{ wall: 'right', at: 0.55, width: 1.5, height: 1.3, sill: 0.8 }],
}

/** 没写 activities 时的通用日常(按道具自动挑:有床才睡、有书桌才看书……由 brain 按锚点存不存在过滤)。 */
export const DEFAULT_ACTIVITIES: ActivitySpec[] = [
  { id: 'wander', at: 'center', pose: 'stand', time: [6, 12], weight: 2 },
  { id: 'window', at: 'window', pose: 'gaze', time: [10, 20], weight: 2, emote: 'star' },
  { id: 'read', at: 'desk', pose: 'sit-read', time: [20, 40], weight: 2 },
  { id: 'nap', at: 'bed', pose: 'sleep', time: [30, 60], weight: 2, emote: 'zzz', then: 'wake' },
  { id: 'wake', at: 'center', pose: 'stretch', time: [3, 4], weight: 0, chained: true },
  { id: 'wave', at: 'front', pose: 'wave', time: [3, 5], weight: 1 },
]

export const DEFAULT_AGENT: Partial<Record<Phase, string>> = {
  thinking: '@think', tool: '@work', speaking: '@talk', waiting: '@call', error: '@sigh', done: '@cheer',
}

/** 内置的 Agent 阶段活动(`@` 开头的 id,场景里同名活动会盖掉它们)。「在书桌」的几个没有书桌时退回原地。 */
export const AGENT_ACTIVITIES: ActivitySpec[] = [
  { id: '@think', at: 'desk', pose: 'sit-think', time: [4, 4], weight: 0, emote: 'question', chained: true },
  { id: '@work', at: 'desk', pose: 'sit-work', time: [4, 4], weight: 0, chained: true },
  { id: '@talk', at: 'here', pose: 'talk', time: [4, 4], weight: 0, chained: true },
  { id: '@call', at: 'front', pose: 'wave', time: [4, 4], weight: 0, emote: 'exclaim', chained: true },
  { id: '@sigh', at: 'here', pose: 'sigh', time: [3, 5], weight: 0, emote: 'sweat', chained: true },
  { id: '@cheer', at: 'here', pose: 'cheer', time: [2.5, 3.5], weight: 0, emote: 'sparkle', chained: true },
]

// ── 道具锚点(纯数据:brain 算路径、roomStage 摆道具都用它) ──────────────────────
/** 一个锚点:道具局部坐标(米),face = 站 / 坐 / 躺在这里时面朝的方向(度,道具局部,0 = +Z),
 *  y = 座面 / 床面高度,approach = 从哪儿走过来(局部坐标;省略 = 锚点正前方 0.45m)。 */
export interface Anchor {
  x: number
  z: number
  face: number
  y?: number
  approach?: [number, number]
}

/** 道具类型 → 占地(局部 x/z 半宽,算寻路障碍)+ 锚点。**新道具类型必须在这里登记**,props.ts 的建模器按同一套尺寸造。 */
export interface PropInfo {
  /** 占地半宽 [hx, hz](局部,rot 前)。0 = 不挡路(挂墙 / 地毯)。 */
  half: [number, number]
  /** 贴墙 / 挂墙的道具:y 缺省的离地高度。 */
  wallY?: number
  anchors: Record<string, Anchor>
  /** at: "<id>" 时用哪个锚点。 */
  main?: string
}

export const PROP_INFO: Record<string, PropInfo> = {
  bed: {
    half: [0.55, 1.05],
    main: 'lie',
    anchors: {
      // 床头在 -Z 端:躺下时头朝床头,面朝上;坐在床沿面朝 +X
      lie: { x: 0, z: -0.18, face: 180, y: 0.38, approach: [0.85, 0.1] },
      sit: { x: 0.5, z: 0.2, face: 90, y: 0.38, approach: [0.95, 0.2] },
    },
  },
  desk: {
    // 书桌 + 椅子一体:工作锚点就是椅面,面朝桌子(-Z)
    half: [0.62, 0.62],
    main: 'work',
    anchors: { work: { x: 0, z: 0.28, face: 180, y: 0.36, approach: [0.55, 0.62] } },
  },
  chair: { half: [0.24, 0.24], main: 'sit', anchors: { sit: { x: 0, z: 0, face: 0, y: 0.36, approach: [0, 0.5] } } },
  piano: {
    half: [0.68, 0.5],
    main: 'play',
    anchors: { play: { x: 0, z: 0.3, face: 180, y: 0.34, approach: [0.6, 0.62] } },
  },
  telescope: { half: [0.28, 0.28], main: 'look', anchors: { look: { x: 0, z: 0.42, face: 180, approach: [0.15, 0.85] } } },
  bookshelf: { half: [0.5, 0.2], main: 'browse', anchors: { browse: { x: 0, z: 0.6, face: 180 } } },
  shelf: { half: [0, 0], wallY: 1.35, anchors: {} },
  nightstand: { half: [0.22, 0.2], anchors: {} },
  rug: { half: [0, 0], main: 'lie', anchors: { lie: { x: 0, z: 0, face: 180, y: 0.02, approach: [0.8, 0.3] }, sit: { x: 0, z: 0, face: 0, y: 0.02 } } },
  beanbag: { half: [0.36, 0.36], main: 'sit', anchors: { sit: { x: 0, z: 0.05, face: 0, y: 0.26, approach: [0, 0.65] } } },
  plant: { half: [0.2, 0.2], main: 'water', anchors: { water: { x: 0, z: 0.55, face: 180 } } },
  lamp: { half: [0.16, 0.16], anchors: {} },
  poster: { half: [0, 0], wallY: 1.45, main: 'view', anchors: { view: { x: 0, z: 0.75, face: 180 } } },
  photos: { half: [0, 0], wallY: 1.5, main: 'view', anchors: { view: { x: 0, z: 0.75, face: 180 } } },
  scroll: { half: [0, 0], wallY: 1.35, main: 'view', anchors: { view: { x: 0, z: 0.75, face: 180 } } },
  sword: { half: [0, 0], wallY: 1.45, main: 'view', anchors: { view: { x: 0, z: 0.75, face: 180 } } },
  clock: { half: [0, 0], wallY: 2.05, anchors: {} },
  lights: { half: [0, 0], wallY: 2.3, anchors: {} },
  rod: { half: [0.12, 0.12], anchors: {} },
  plush: { half: [0, 0], anchors: {} },
  bird: { half: [0, 0], main: 'greet', anchors: { greet: { x: 0, z: 0.55, face: 180 } } },
  flowers: { half: [0, 0], main: 'water', anchors: { water: { x: 0, z: 0.55, face: 180 } } },
  radio: { half: [0, 0], anchors: {} },
  box: { half: [0.2, 0.2], anchors: {} },
}

export const PROP_TYPES = Object.keys(PROP_INFO)

// ── 校验 ─────────────────────────────────────────────────────────────────────
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isColor = (v: unknown): v is string => typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim())
const fail = (zh: string, en: string): SceneParseResult => ({ ok: false, zh, en })
const ID_RE = /^[a-z0-9@][a-z0-9_-]{0,47}$/i

const KNOWN_TOP = new Set(['live3d', 'kind', 'name', 'character', 'height', 'time', 'sky', 'room', 'props', 'activities', 'agent'])
const KNOWN_ROOM = new Set(['width', 'depth', 'height', 'floor', 'wallLeft', 'wallRight', 'trim', 'planks', 'windows'])
const KNOWN_PROP = new Set(['type', 'id', 'at', 'y', 'rot', 'scale', 'color', 'color2', 'variant', 'text'])
const KNOWN_ACT = new Set(['id', 'at', 'pose', 'time', 'weight', 'when', 'emote', 'then', 'label', 'chained'])

function num(v: unknown, lo: number, hi: number): boolean {
  return finite(v) && v >= lo && v <= hi
}

/** 解析 scene.json。`dir` = 所在的库内文件夹,`slug` = 文件夹名。 */
export function parseScene(text: string, dir: string, slug: string): SceneParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    return fail(`scene.json 不是合法的 JSON:${why}`, `scene.json is not valid JSON: ${why}`)
  }
  if (!isObj(raw)) return fail('scene.json 的最外层必须是一个对象 { … }', 'scene.json must contain a JSON object { … } at the top level')
  if (raw.live3d !== 1) {
    return fail(`不认识的场景版本(live3d = ${JSON.stringify(raw.live3d)});本插件只读 "live3d": 1`, `Unsupported scene version (live3d = ${JSON.stringify(raw.live3d)}); this plugin reads "live3d": 1`)
  }
  if (raw.kind !== undefined && raw.kind !== 'room') return fail('"kind" 目前只能是 "room"', '"kind" must be "room" for now')
  const warnings: Msg[] = []
  for (const k of Object.keys(raw)) if (!KNOWN_TOP.has(k)) warnings.push({ zh: `忽略了不认识的字段「${k}」`, en: `Ignored unknown field "${k}"` })

  let name: Label = slug
  if (raw.name !== undefined) {
    const n = parseLabel(typeof raw.name === 'string' ? raw.name.trim() : raw.name, 60)
    if (n === null) return fail('"name" 必须是文字,或 { "zh": …, "en": … }', '"name" must be a string or { "zh": …, "en": … }')
    if (n) name = n
  }
  let character: string | null = null
  if (raw.character !== undefined && raw.character !== null) {
    if (typeof raw.character !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(raw.character)) {
      return fail('"character" 必须是模型库里某个形象的文件夹名(小写字母、数字、连字符),或 null = 用 Desk 默认形象', '"character" must be the folder name of a model in the library (lower-case letters, digits, hyphens), or null for the Desk default')
    }
    character = raw.character
  }
  let height = 1.25
  if (raw.height !== undefined) {
    if (!num(raw.height, 0.3, 3)) return fail('"height"(形象身高,米)必须在 0.3 到 3 之间', '"height" (character height in metres) must be between 0.3 and 3')
    height = raw.height as number
  }
  let time: TimeMode = 'auto'
  if (raw.time !== undefined) {
    if (!(TIME_MODES as readonly unknown[]).includes(raw.time)) return fail('"time" 只能是 "auto"、"day" 或 "night"', '"time" must be "auto", "day" or "night"')
    time = raw.time as TimeMode
  }
  let sky = '#141b33'
  if (raw.sky !== undefined) {
    if (!isColor(raw.sky)) return fail('"sky" 必须是 #rrggbb 颜色', '"sky" must be a #rrggbb colour')
    sky = (raw.sky as string).trim()
  }

  // room
  const room: RoomShell = { ...DEFAULT_ROOM, windows: DEFAULT_ROOM.windows.map((w) => ({ ...w })) }
  if (raw.room !== undefined) {
    const r = raw.room
    if (!isObj(r)) return fail('"room" 必须是对象', '"room" must be an object')
    for (const k of Object.keys(r)) if (!KNOWN_ROOM.has(k)) warnings.push({ zh: `忽略了 room 里不认识的字段「${k}」`, en: `Ignored unknown field "${k}" in room` })
    for (const [k, lo, hi] of [['width', 2, 12], ['depth', 2, 12], ['height', 1.6, 6]] as const) {
      if (r[k] === undefined) continue
      if (!num(r[k], lo, hi)) return fail(`"room.${k}" 必须在 ${lo} 到 ${hi} 米之间`, `"room.${k}" must be between ${lo} and ${hi} metres`)
      room[k] = r[k] as number
    }
    for (const k of ['floor', 'wallLeft', 'wallRight', 'trim'] as const) {
      if (r[k] === undefined) continue
      if (!isColor(r[k])) return fail(`"room.${k}" 必须是 #rrggbb 颜色`, `"room.${k}" must be a #rrggbb colour`)
      room[k] = (r[k] as string).trim()
    }
    if (r.planks !== undefined) {
      if (typeof r.planks !== 'boolean') return fail('"room.planks" 必须是 true 或 false', '"room.planks" must be true or false')
      room.planks = r.planks
    }
    if (r.windows !== undefined) {
      if (!Array.isArray(r.windows)) return fail('"room.windows" 必须是数组', '"room.windows" must be an array')
      room.windows = []
      for (let i = 0; i < r.windows.length; i++) {
        const w = r.windows[i]
        const at = `room.windows[${i}]`
        if (!isObj(w)) return fail(`"${at}" 必须是对象`, `"${at}" must be an object`)
        if (w.wall !== 'left' && w.wall !== 'right') return fail(`"${at}.wall" 只能是 "left" 或 "right"`, `"${at}.wall" must be "left" or "right"`)
        const win: WindowSpec = { wall: w.wall, at: 0.5, width: 1.4, height: 1.3, sill: 0.8 }
        for (const [k, lo, hi] of [['at', 0, 1], ['width', 0.4, 6], ['height', 0.4, 4], ['sill', 0, 2.5]] as const) {
          if (w[k] === undefined) continue
          if (!num(w[k], lo, hi)) return fail(`"${at}.${k}" 必须在 ${lo} 到 ${hi} 之间`, `"${at}.${k}" must be between ${lo} and ${hi}`)
          win[k] = w[k] as number
        }
        room.windows.push(win)
      }
    }
  }
  for (const [i, w] of room.windows.entries()) {
    const len = w.wall === 'left' ? room.depth : room.width
    if (w.width > len - 0.2) return fail(`第 ${i + 1} 扇窗比墙还宽`, `Window ${i + 1} is wider than its wall`)
    if (w.sill + w.height > room.height - 0.1) return fail(`第 ${i + 1} 扇窗顶出了墙(窗台 + 窗高 > 墙高)`, `Window ${i + 1} sticks out of the wall (sill + height > wall height)`)
  }

  // props
  const props: PropSpec[] = []
  const ids = new Set<string>()
  if (raw.props !== undefined) {
    if (!Array.isArray(raw.props)) return fail('"props" 必须是道具数组', '"props" must be an array of props')
    for (let i = 0; i < raw.props.length; i++) {
      const p = raw.props[i]
      const at = `props[${i}]`
      if (!isObj(p)) return fail(`"${at}" 必须是对象`, `"${at}" must be an object`)
      for (const k of Object.keys(p)) if (!KNOWN_PROP.has(k)) warnings.push({ zh: `忽略了 ${at} 里不认识的字段「${k}」`, en: `Ignored unknown field "${k}" in ${at}` })
      if (typeof p.type !== 'string') return fail(`"${at}.type" 必须是道具类型名`, `"${at}.type" must be a prop type`)
      // Object.hasOwn:按用户写的字符串查表,"__proto__" / "constructor" 不能被当成道具类型(会拿到原型对象)
      if (!Object.hasOwn(PROP_INFO, p.type)) {
        warnings.push({ zh: `跳过了不认识的道具类型「${p.type}」;可用:${PROP_TYPES.join('、')}`, en: `Skipped unknown prop type "${p.type}"; available: ${PROP_TYPES.join(', ')}` })
        continue
      }
      if (!Array.isArray(p.at) || p.at.length !== 2 || !p.at.every((v) => num(v, -20, 20))) {
        return fail(`"${at}.at" 必须是 [x, z] 两个数(米,原点在地板中心)`, `"${at}.at" must be [x, z] in metres from the floor centre`)
      }
      const prop: PropSpec = { type: p.type, at: [p.at[0] as number, p.at[1] as number], y: PROP_INFO[p.type].wallY ?? 0, rot: 0, scale: 1 }
      if (p.id !== undefined) {
        if (typeof p.id !== 'string' || !ID_RE.test(p.id) || p.id.startsWith('@')) return fail(`"${at}.id" 只能用字母、数字、- 和 _`, `"${at}.id" may only use letters, digits, - and _`)
        if (ids.has(p.id)) return fail(`道具 id「${p.id}」重复了`, `Prop id "${p.id}" is used twice`)
        if (p.id === 'window' || p.id === 'center' || p.id === 'front' || p.id === 'here') return fail(`道具 id 不能叫「${p.id}」(保留字)`, `A prop cannot be called "${p.id}" (reserved)`)
        ids.add(p.id)
        prop.id = p.id
      }
      if (p.y !== undefined) {
        if (!num(p.y, 0, 6)) return fail(`"${at}.y" 必须在 0 到 6 米之间`, `"${at}.y" must be between 0 and 6 metres`)
        prop.y = p.y as number
      }
      if (p.rot !== undefined) {
        if (!finite(p.rot)) return fail(`"${at}.rot" 必须是角度(数字)`, `"${at}.rot" must be an angle (number)`)
        prop.rot = p.rot as number
      }
      if (p.scale !== undefined) {
        if (!num(p.scale, 0.2, 5)) return fail(`"${at}.scale" 必须在 0.2 到 5 之间`, `"${at}.scale" must be between 0.2 and 5`)
        prop.scale = p.scale as number
      }
      for (const k of ['color', 'color2'] as const) {
        if (p[k] === undefined) continue
        if (!isColor(p[k])) return fail(`"${at}.${k}" 必须是 #rrggbb 颜色`, `"${at}.${k}" must be a #rrggbb colour`)
        prop[k] = (p[k] as string).trim()
      }
      for (const k of ['variant', 'text'] as const) {
        if (p[k] === undefined) continue
        if (typeof p[k] !== 'string') return fail(`"${at}.${k}" 必须是文字`, `"${at}.${k}" must be a string`)
        prop[k] = (p[k] as string).slice(0, 64)
      }
      props.push(prop)
    }
  }

  // activities
  let activities: ActivitySpec[] = DEFAULT_ACTIVITIES.map((a) => ({ ...a }))
  if (raw.activities !== undefined) {
    if (!Array.isArray(raw.activities)) return fail('"activities" 必须是活动数组', '"activities" must be an array of activities')
    activities = []
    const seen = new Set<string>()
    for (let i = 0; i < raw.activities.length; i++) {
      const a = raw.activities[i]
      const at = `activities[${i}]`
      if (!isObj(a)) return fail(`"${at}" 必须是对象`, `"${at}" must be an object`)
      for (const k of Object.keys(a)) if (!KNOWN_ACT.has(k)) warnings.push({ zh: `忽略了 ${at} 里不认识的字段「${k}」`, en: `Ignored unknown field "${k}" in ${at}` })
      if (typeof a.id !== 'string' || !ID_RE.test(a.id)) return fail(`"${at}.id" 必须是活动名(字母、数字、- 和 _)`, `"${at}.id" must be an activity name (letters, digits, - and _)`)
      if (seen.has(a.id)) return fail(`活动 id「${a.id}」重复了`, `Activity id "${a.id}" is used twice`)
      seen.add(a.id)
      if (typeof a.at !== 'string' || !a.at.trim()) return fail(`"${at}.at" 必须写在哪(道具 id / window / center / front / here)`, `"${at}.at" must say where (a prop id, window, center, front or here)`)
      if (!isPose(a.pose)) return fail(`"${at}.pose"「${String(a.pose)}」不是姿势;可用:${POSES.join('、')}`, `"${at}.pose" "${String(a.pose)}" is not a pose; available: ${POSES.join(', ')}`)
      const act: ActivitySpec = { id: a.id, at: a.at.trim(), pose: a.pose, time: [8, 16], weight: 1 }
      if (a.time !== undefined) {
        const tt = a.time
        const pair = Array.isArray(tt) ? tt : [tt, tt]
        if (pair.length !== 2 || !pair.every((v) => num(v, 0.5, 3600)) || (pair[0] as number) > (pair[1] as number)) {
          return fail(`"${at}.time" 必须是秒数或 [最短, 最长](0.5–3600)`, `"${at}.time" must be seconds or [min, max] (0.5–3600)`)
        }
        act.time = [pair[0] as number, pair[1] as number]
      }
      if (a.weight !== undefined) {
        if (!num(a.weight, 0, 100)) return fail(`"${at}.weight" 必须在 0 到 100 之间`, `"${at}.weight" must be between 0 and 100`)
        act.weight = a.weight as number
      }
      if (a.when !== undefined) {
        if (a.when !== 'day' && a.when !== 'night') return fail(`"${at}.when" 只能是 "day" 或 "night"`, `"${at}.when" must be "day" or "night"`)
        act.when = a.when
      }
      if (a.emote !== undefined) {
        if (!isEmote(a.emote)) return fail(`"${at}.emote" 不认识;可用:${EMOTES.join('、')}`, `Unknown "${at}.emote"; available: ${EMOTES.join(', ')}`)
        act.emote = a.emote
      }
      if (a.then !== undefined) {
        if (typeof a.then !== 'string' || !ID_RE.test(a.then)) return fail(`"${at}.then" 必须是另一个活动的 id`, `"${at}.then" must be another activity id`)
        act.then = a.then
      }
      if (a.label !== undefined) {
        const l = parseLabel(a.label, 60)
        if (l === null) return fail(`"${at}.label" 必须是文字,或 { "zh": …, "en": … }`, `"${at}.label" must be a string or { "zh": …, "en": … }`)
        act.label = l
      }
      if (a.chained !== undefined) {
        if (typeof a.chained !== 'boolean') return fail(`"${at}.chained" 必须是 true 或 false`, `"${at}.chained" must be true or false`)
        act.chained = a.chained
      }
      activities.push(act)
    }
  }
  // then 指向的活动必须存在(内置 @ 活动也算)
  const actIds = new Set([...activities.map((a) => a.id), ...AGENT_ACTIVITIES.map((a) => a.id)])
  for (const a of activities) {
    if (a.then && !actIds.has(a.then)) return fail(`活动「${a.id}」的 then 指向不存在的活动「${a.then}」`, `Activity "${a.id}" has then → "${a.then}", which does not exist`)
  }

  // agent
  const agent: Partial<Record<Phase, string>> = { ...DEFAULT_AGENT }
  if (raw.agent !== undefined) {
    if (!isObj(raw.agent)) return fail('"agent" 必须是对象:阶段名 → 活动 id', '"agent" must be an object: phase → activity id')
    for (const [k, v] of Object.entries(raw.agent)) {
      if (!isPhase(k) || k === 'idle') {
        return fail(`"agent" 里的「${k}」不是阶段名;可用:${PHASES.filter((p) => p !== 'idle').join('、')}`, `"${k}" in "agent" is not a phase; use ${PHASES.filter((p) => p !== 'idle').join(', ')}`)
      }
      if (v === null) {
        delete agent[k]
        continue
      }
      if (typeof v !== 'string' || !actIds.has(v)) return fail(`"agent.${k}" 必须是某个活动的 id`, `"agent.${k}" must be an activity id`)
      agent[k] = v
    }
  }

  return {
    ok: true,
    warnings,
    value: { live3d: 1, kind: 'room', name, character, height, time, sky, room, props, activities, agent, dir, slug },
  }
}

/** 按 id 找活动:场景里的优先,其次内置 @ 活动。 */
export function activityById(scene: Pick<SceneSpec, 'activities'>, id: string | undefined): ActivitySpec | null {
  if (!id) return null
  return scene.activities.find((a) => a.id === id) ?? AGENT_ACTIVITIES.find((a) => a.id === id) ?? null
}

/** 此刻是白天还是夜里:auto 按本地时间(6:00–18:30 白天)。 */
export function isNight(mode: TimeMode, now: Date = new Date()): boolean {
  if (mode === 'day') return false
  if (mode === 'night') return true
  const h = now.getHours() + now.getMinutes() / 60
  return h < 6 || h >= 18.5
}
