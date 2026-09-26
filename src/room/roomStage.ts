// 房间舞台:一个三面剖开的小房间(scene.json)+ 住在里面的形象,形象按 brain 的日常走来走去、坐下、躺下,
// 跟着 Agent 状态插队。视角对着「等距小房间」调:镜头在敞开的那个墙角外面、斜上方俯视,FOV 小(接近正交的味道)。
//
// 与 Desk 舞台(stage.ts)共用形象工厂 createModelAvatar(同一套骨骼 / 表情 / 口型),这里多出来的是:
//  - 身体姿势层(poses.ts → FrameInput.body)与形象根的摆放(mover:位置 / 偏航 / 仰倒);
//  - 静态阴影:家具的阴影图只在建房间 / 换昼夜时烘一次(shadowMap.autoUpdate = false),角色不投真阴影,
//    脚下一块柔和的圆形影子 —— 57 万面的 MMD 模型每帧再进一遍阴影 pass 太贵;
//  - 窗外的光:白天太阳、夜里月光从窗洞斜照进来(墙投影,再加一块只投影不显示的天花板 —— 剖开的房间没有顶,
//    不挡的话光会越过墙头照亮整片地板)。
//
// 生命周期同 stage.ts:attach / detach 搬画布不重建;看不见就停 rAF;dispose 释放一切。

import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { AgentStatusLike, Phase, ResolvedProfile } from '../contract'
import { isPhase } from '../contract'
import { createModelAvatar, frameDelta, type Avatar, type SetProfileResult } from '../stage'
import { createOrb, readAccent } from '../orb'
import { loadModel, toMsg, type LoadedModel } from '../loaders'
import { createMouthEnvelope, mouthFlap, planFor, PROC, type ProcPlan } from '../reactions'
import { pickExpression } from '../heuristics'
import { isNight, type EmoteName, type ResolvedScene, type TimeMode, PROP_INFO } from './scene'
import { createBrain, type Brain, propToWorld } from './brain'
import { buildGrid, type NavGrid, type Obstacle } from './nav'
import { createAnimator, type Animator, type Held, type LookMode, type Mood } from './poses'
import { Kit, backgroundTexture, buildProp, buildShell, type BuiltProp, type LightHint } from './props'

const DEG = Math.PI / 180
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)
const damp = (cur: number, target: number, rate: number, dt: number): number => cur + (target - cur) * (1 - Math.exp(-rate * dt))

export type RoomMode = 'view' | 'screensaver'

export interface RoomStageOptions {
  assetUrl: (rel: string) => string
  mode?: RoomMode
}

export interface RoomDebug {
  /** 角色在画面上的位置(CSS 像素,相对画布左上角)与大致高度 —— 台架裁特写用。 */
  screen: { x: number; y: number; h: number }
  activity: string | null
  mode: string
  pose: string
  x: number
  z: number
  night: boolean
  fps: number
  frames: number
}

export interface RoomStage {
  attach(el: HTMLElement, o?: { mode?: RoomMode }): void
  detach(): void
  /** 换房间(null = 不画房间,只清空)。同一份场景重复传是空操作。 */
  setScene(scene: ResolvedScene | null): void
  /** 换住客。null = 小球。同一模型不重载(只换 states / pose)。 */
  setCharacter(p: ResolvedProfile | null): Promise<SetProfileResult>
  setStatus(s: AgentStatusLike): void
  setStatusSource(fn: (() => AgentStatusLike) | null): void
  /** 覆盖场景的昼夜(null = 按场景自己的 time)。 */
  setTime(mode: TimeMode | null): void
  night(): boolean
  /** 指定下一件事(null = 回到随机日常)。 */
  force(activityId: string | null): void
  /** 此刻在做的活动(给状态条用):id + 姿势名 + 场景里写的 label。 */
  doing(): { id: string; pose: string; label?: import('./scene').Label } | null
  debug(): RoomDebug
  /** 台架专用:把镜头摆到指定方位(度)/ 缩放,不受交互的角度限制。 */
  debugView(azDeg: number, elDeg: number, zoom: number, focus?: [number, number, number]): void
  dispose(): void
}

// ── 情绪 → 模型里的表情名 ────────────────────────────────────────────────────
/** 每种情绪由几组通道拼成,每组按顺序取模型里第一个存在的名字。 */
const MOOD_CHANNELS: Record<Mood, Array<{ names: string[]; k: number }>> = {
  happy: [{ names: ['happy', 'joy', '笑い', 'にっこり', 'Fcl_ALL_Joy'], k: 1 }, { names: ['にこ', 'mouthSmile', 'Fcl_MTH_Joy', 'ω'], k: 0.7 }],
  smile: [{ names: ['にこ', 'にっこり', 'mouthSmile', 'Fcl_MTH_Joy', 'ω', 'happy'], k: 0.8 }],
  sleepy: [{ names: ['じと目', 'eyeSquint', 'Fcl_EYE_Joy', 'relaxed'], k: 1 }],
  yawn: [{ names: ['△', 'おお', 'お', 'oh', 'ou', 'Fcl_MTH_O', 'aa', 'あ', 'jawOpen'], k: 1 }],
  grumpy: [{ names: ['じと目', 'angry', 'Fcl_ALL_Angry'], k: 1 }, { names: ['む', '∧', 'ん', 'mouthPucker', 'Fcl_MTH_Angry'], k: 0.9 }],
  sad: [{ names: ['sad', 'sorrow', '困る', '悲しい', 'Fcl_ALL_Sorrow'], k: 1 }],
  surprised: [{ names: ['surprised', 'びっくり', '瞳小', 'Fcl_ALL_Surprised'], k: 1 }, { names: ['おお', 'お', 'oh'], k: 0.5 }],
  serene: [{ names: ['笑い', 'relaxed', 'Fcl_EYE_Joy', 'happy'], k: 0.8 }],
}

function moodResolver(available: readonly string[]): (mood: Partial<Record<Mood, number>>) => Record<string, number> {
  const table = new Map<Mood, Array<{ name: string; k: number }>>()
  for (const m of Object.keys(MOOD_CHANNELS) as Mood[]) {
    const out: Array<{ name: string; k: number }> = []
    for (const ch of MOOD_CHANNELS[m]) {
      const name = ch.names.find((n) => available.includes(n)) ?? pickExpression(ch.names.slice(0, 1), available)
      if (name) out.push({ name, k: ch.k })
    }
    table.set(m, out)
  }
  return (mood) => {
    const r: Record<string, number> = {}
    for (const [m, w] of Object.entries(mood) as Array<[Mood, number]>) {
      if (!(w > 0.001)) continue
      for (const { name, k } of table.get(m) ?? []) r[name] = Math.min(1, Math.max(r[name] ?? 0, w * k))
    }
    return r
  }
}

// ── 情绪符号(头顶的 Zzz / 星星 / 音符……) ────────────────────────────────────
const EMOTE_GLYPH: Record<EmoteName, { text: string; color: string; n: number }> = {
  zzz: { text: 'Z', color: '#dfe8ff', n: 3 },
  star: { text: '✦', color: '#ffe9a8', n: 3 },
  note: { text: '♪', color: '#ffffff', n: 2 },
  heart: { text: '♥', color: '#ff8fa8', n: 1 },
  question: { text: '?', color: '#ffffff', n: 1 },
  exclaim: { text: '!', color: '#ffd166', n: 1 },
  sweat: { text: '💧', color: '#8fd0ff', n: 1 },
  anger: { text: '💢', color: '#ff6b6b', n: 1 },
  sparkle: { text: '✧', color: '#fff3c4', n: 4 },
  dots: { text: '…', color: '#ffffff', n: 1 },
}

class EmoteLayer {
  private group = new THREE.Group()
  private sprites: THREE.Sprite[] = []
  private current: EmoteName | null = null
  private since = 0
  private textures = new Map<string, THREE.Texture>()

  constructor(parent: THREE.Object3D, private size: number) {
    parent.add(this.group)
  }

  private tex(e: EmoteName): THREE.Texture {
    let t = this.textures.get(e)
    if (t) return t
    const g = EMOTE_GLYPH[e]
    const c = document.createElement('canvas')
    c.width = c.height = 128
    const x = c.getContext('2d')!
    x.font = `bold ${e === 'dots' ? 90 : 96}px "PingFang SC", "Apple Color Emoji", "Segoe UI Emoji", system-ui, sans-serif`
    x.textAlign = 'center'
    x.textBaseline = 'middle'
    x.lineWidth = 10
    x.strokeStyle = 'rgba(20,24,40,0.55)'
    x.strokeText(g.text, 64, 70)
    x.fillStyle = g.color
    x.fillText(g.text, 64, 70)
    t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    this.textures.set(e, t)
    return t
  }

  set(e: EmoteName | null, t: number): void {
    if (e === this.current) return
    this.current = e
    this.since = t
    for (const s of this.sprites) {
      this.group.remove(s)
      s.material.dispose()
    }
    this.sprites = []
    if (!e) return
    const g = EMOTE_GLYPH[e]
    for (let i = 0; i < g.n; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex(e), transparent: true, depthWrite: false, depthTest: false }))
      s.renderOrder = 10
      this.group.add(s)
      this.sprites.push(s)
    }
  }

  update(t: number, at: THREE.Vector3): void {
    this.group.position.copy(at)
    const e = this.current
    if (!e) return
    const age = t - this.since
    const S = this.size
    this.sprites.forEach((s, i) => {
      const m = s.material
      let x = 0
      let y = 0
      let sc = S
      let a = 1
      if (e === 'zzz') {
        const u = ((age * 0.45 + i / 3) % 1)
        x = u * S * 1.3
        y = u * S * 1.6
        sc = S * (0.55 + u * 0.6)
        a = Math.sin(u * Math.PI)
      } else if (e === 'star' || e === 'sparkle') {
        const ang = i * 2.1 + age * 0.4
        x = Math.cos(ang) * S * 0.9
        y = S * 0.4 + Math.sin(ang * 1.3) * S * 0.35
        const tw = 0.5 + 0.5 * Math.sin(age * 3 + i * 1.7)
        sc = S * (0.35 + 0.35 * tw)
        a = 0.35 + 0.65 * tw
      } else if (e === 'note') {
        const u = ((age * 0.35 + i / 2) % 1)
        x = Math.sin(u * 6 + i) * S * 0.4 + (i ? S * 0.5 : -S * 0.3)
        y = u * S * 1.5
        sc = S * 0.6
        a = Math.sin(u * Math.PI)
      } else if (e === 'heart' || e === 'exclaim' || e === 'anger') {
        const pop = Math.min(1, age / 0.25)
        sc = S * (0.5 + 0.35 * pop + (e === 'anger' ? 0.06 * Math.sin(age * 12) : 0))
        y = S * 0.3 + (e === 'heart' ? age * S * 0.25 : 0)
        a = e === 'heart' ? Math.max(0, 1 - Math.max(0, age - 1.4)) : 1
        x = e === 'anger' ? S * 0.45 : 0
      } else if (e === 'question' || e === 'dots') {
        y = S * 0.3 + Math.sin(age * 2.2) * S * 0.08
        sc = S * 0.6
      } else if (e === 'sweat') {
        x = -S * 0.55
        y = S * 0.1 - ((age * 0.3) % 1) * S * 0.3
        sc = S * 0.45
      }
      s.position.set(x, y, 0)
      s.scale.setScalar(sc)
      m.opacity = a
    })
  }

  dispose(): void {
    this.set(null, 0)
    for (const t of this.textures.values()) t.dispose()
    this.group.removeFromParent()
  }
}

// ── 手里拿的东西 ─────────────────────────────────────────────────────────────
function heldItems(): Record<Exclude<Held, null>, THREE.Group> {
  const book = new THREE.Group()
  const cover = new THREE.MeshStandardMaterial({ color: '#3f5d8c', roughness: 0.8 })
  const pages = new THREE.MeshStandardMaterial({ color: '#f7f2e6', roughness: 1 })
  for (const s of [-1, 1]) {
    const half = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.13, 0.012), cover)
    half.position.set(s * 0.05, 0, 0)
    half.rotation.y = -s * 0.35
    book.add(half)
    const pg = new THREE.Mesh(new THREE.BoxGeometry(0.092, 0.12, 0.01), pages)
    pg.position.set(s * 0.046, 0, 0.008)
    pg.rotation.y = -s * 0.35
    book.add(pg)
  }
  const plush = new THREE.Group()
  const fur = new THREE.MeshStandardMaterial({ color: '#f6f3ee', roughness: 1 })
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.09, 14, 10), fur)
  plush.add(body)
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.075, 14, 10), fur)
  head.position.y = 0.12
  plush.add(head)
  for (const x of [-0.035, 0.035]) {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), fur)
    ear.scale.set(0.8, 2.5, 0.6)
    ear.position.set(x, 0.22, 0)
    plush.add(ear)
  }
  return { book, plush }
}

function disposeGroup(g: THREE.Object3D): void {
  g.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.isMesh) {
      m.geometry?.dispose()
      const mats = Array.isArray(m.material) ? m.material : [m.material]
      for (const x of mats) x?.dispose()
    }
  })
}

/** 圆形软影的贴图(中间深、边缘透明)。 */
function blobTexture(): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  const grd = g.createRadialGradient(64, 64, 4, 64, 64, 62)
  grd.addColorStop(0, 'rgba(10,12,24,0.55)')
  grd.addColorStop(0.6, 'rgba(10,12,24,0.25)')
  grd.addColorStop(1, 'rgba(10,12,24,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, 128, 128)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

/** 漂浮的小光点(白天是光里的灰尘,夜里是星屑)。 */
function makeMotes(n: number, box: THREE.Box3): { points: THREE.Points; tick(t: number): void; dispose(): void } {
  const pos = new Float32Array(n * 3)
  const seed = new Float32Array(n * 3)
  const size = box.getSize(new THREE.Vector3())
  for (let i = 0; i < n; i++) {
    seed[i * 3] = box.min.x + Math.random() * size.x
    seed[i * 3 + 1] = box.min.y + Math.random() * size.y
    seed[i * 3 + 2] = box.min.z + Math.random() * size.z
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  const c = document.createElement('canvas')
  c.width = c.height = 32
  const g = c.getContext('2d')!
  const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16)
  grd.addColorStop(0, 'rgba(255,255,255,1)')
  grd.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, 32, 32)
  const tex = new THREE.CanvasTexture(c)
  const mat = new THREE.PointsMaterial({ size: 0.035, map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: '#fff3d0', opacity: 0.7 })
  const points = new THREE.Points(geo, mat)
  points.frustumCulled = false
  return {
    points,
    tick(t) {
      for (let i = 0; i < n; i++) {
        const k = i * 3
        pos[k] = seed[k] + Math.sin(t * 0.13 + i) * 0.25
        pos[k + 1] = box.min.y + ((seed[k + 1] - box.min.y + t * 0.03 * (0.5 + (i % 5) * 0.2)) % size.y)
        pos[k + 2] = seed[k + 2] + Math.cos(t * 0.11 + i * 1.3) * 0.25
      }
      geo.attributes.position.needsUpdate = true
    },
    dispose() {
      geo.dispose()
      mat.dispose()
      tex.dispose()
    },
  }
}

// ── 舞台 ─────────────────────────────────────────────────────────────────────
export function createRoomStage(opts: RoomStageOptions): RoomStage {
  let mode: RoomMode = opts.mode ?? 'view'
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.5))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap // r186:软阴影 = PCF + shadow.radius(PCFSoftShadowMap 已弃用)
  renderer.shadowMap.autoUpdate = false
  const canvas = renderer.domElement
  canvas.className = 'live3d-room-canvas'
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;outline:none;touch-action:none;'

  const scene3 = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(24, 1, 0.1, 200)
  const pmrem = new THREE.PMREMGenerator(renderer)
  let envRT = pmrem.fromScene(new RoomEnvironment(), 0.04)
  scene3.environment = envRT.texture

  // 房间与光(换场景 / 换昼夜时整组重建)
  let roomRoot: THREE.Group | null = null
  let kit: Kit | null = null
  let built: BuiltProp[] = []
  let lightsRoot: THREE.Group | null = null
  let motes: ReturnType<typeof makeMotes> | null = null
  let bgTex: THREE.Texture | null = null
  let spec: ResolvedScene | null = null
  let specKey = ''
  let timeOverride: TimeMode | null = null
  let nightNow = false
  let grid: NavGrid | null = null
  let brain: Brain | null = null

  // 形象
  const mover = new THREE.Group()
  mover.rotation.order = 'YXZ'
  const scaler = new THREE.Group()
  mover.add(scaler)
  scene3.add(mover)
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false }))
  blob.rotation.x = -Math.PI / 2
  blob.renderOrder = 1
  scene3.add(blob)
  const held = heldItems()
  for (const h of Object.values(held)) {
    h.visible = false
    scaler.add(h)
  }
  let avatar: Avatar = createOrb(readAccent())
  let isOrb = true
  scaler.add(avatar.root)
  let profile: ResolvedProfile | null = null
  let loadedKey = ''
  let gen = 0
  let animator: Animator | null = null
  let resolveMood = moodResolver(avatar.caps.expressions)
  let emotes: EmoteLayer | null = null
  let charScale = 1
  let metrics = { height: 1.25, hipY: 0.2, back: 0.2 }

  // 状态
  let status: AgentStatusLike = { phase: 'idle', sessionId: null, textChars: 0 }
  let source: (() => AgentStatusLike) | null = null
  const env = createMouthEnvelope()
  const look = { yaw: 0, pitch: 0 }
  let free = { yaw: 0, pitch: 0, next: 0 }
  const reducedMq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null

  // 镜头
  let az = 45 * DEG
  let el = 30 * DEG
  let zoom = 1
  let azT = az
  let elT = el
  let zoomT = 1
  const target = new THREE.Vector3()
  let fitDist = 10
  let drag: { id: number; x: number; y: number; moved: number } | null = null

  // 循环
  let host: HTMLElement | null = null
  let ro: ResizeObserver | null = null
  let io: IntersectionObserver | null = null
  let visible = true
  let sized = false
  let needResize = true
  let contextLost = false
  let raf = 0
  let lastFrame = 0
  let disposed = false
  let resumed = true
  let frames = 0
  let fps = 0
  let fpsAcc = { t: 0, n: 0 }
  const timer = new THREE.Timer()
  timer.connect(document)

  // ── 房间 ──
  function clearRoom(): void {
    if (roomRoot) {
      scene3.remove(roomRoot)
      // 几何 / 材质:Kit 发的由 kit.dispose 统一收;不是 Kit 发的(窗玻璃、窗外的画、窗帘、隐形天花板……)在这里收。
      // 重复 dispose 是安全的空操作。
      const k = kit
      roomRoot.traverse((o) => {
        const m = o as THREE.Mesh
        if (!m.isMesh) return
        if (m.geometry && !k?.ownsGeometry(m.geometry)) m.geometry.dispose()
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) if (mat && !k?.owns(mat)) mat.dispose()
      })
    }
    if (lightsRoot) scene3.remove(lightsRoot)
    lightsRoot?.traverse((o) => (o as THREE.DirectionalLight).shadow?.map?.dispose())
    motes?.dispose()
    if (motes) scene3.remove(motes.points)
    kit?.dispose()
    bgTex?.dispose()
    roomRoot = lightsRoot = null
    kit = null
    motes = null
    bgTex = null
    built = []
  }

  function buildRoom(): void {
    clearRoom()
    const s = spec
    if (!s) return
    nightNow = isNight(timeOverride ?? s.time)
    kit = new Kit(nightNow)
    roomRoot = new THREE.Group()
    roomRoot.name = 'live3d-room'
    const shell = buildShell(kit, s.room, s.sky)
    roomRoot.add(shell.group)
    const lampHints: Array<LightHint & { world: THREE.Vector3 }> = []
    s.props.forEach((p, i) => {
      const b = buildProp(kit!, p, i)
      if (!b) return
      if (p.type === 'bird') b.group.traverse((o) => (o.castShadow = false))
      roomRoot!.add(b.group)
      built.push(b)
      b.group.updateMatrixWorld(true)
      for (const h of b.lights) lampHints.push({ ...h, world: b.group.localToWorld(h.at.clone()) })
    })
    scene3.add(roomRoot)

    // 不显示、只投影的天花板:剖开的房间没有顶,窗外的斜光会越过墙头把整片地板照亮
    const W = s.room.width
    const D = s.room.depth
    const H = s.room.height
    const ceil = new THREE.Mesh(new THREE.BoxGeometry(W + 0.4, 0.05, D + 0.4), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }))
    ceil.position.set(0, H + 0.03, 0)
    ceil.castShadow = true
    ceil.receiveShadow = false
    roomRoot.add(ceil)

    // 光
    lightsRoot = new THREE.Group()
    const night = nightNow
    const hemi = new THREE.HemisphereLight(night ? '#7f8fc4' : '#ffffff', night ? '#1d2233' : '#b9a58f', night ? 0.75 : 1.5)
    lightsRoot.add(hemi)
    const amb = new THREE.AmbientLight(night ? '#3b4675' : '#fff6e8', night ? 0.35 : 0.35)
    lightsRoot.add(amb)
    // 从镜头那边来的一点补光(角色脸别黑)
    const fill = new THREE.DirectionalLight(night ? '#8fa2e0' : '#fff4e2', night ? 0.35 : 0.7)
    fill.position.set(W * 1.5, H * 2, D * 1.5)
    lightsRoot.add(fill)
    // 窗外的主光
    const win = shell.windows[0]
    const sun = new THREE.DirectionalLight(night ? '#a9bfff' : '#fff0d2', night ? 1.3 : 3.4)
    if (win) {
      const out = win.normal.clone().multiplyScalar(-1)
      const side = new THREE.Vector3(-win.normal.z, 0, win.normal.x) // 沿墙方向:光斜着进来,光斑不正对窗
      sun.position.copy(win.center).addScaledVector(out, 5).addScaledVector(side, 1.8).add(new THREE.Vector3(0, 4.2, 0))
      sun.target.position.copy(win.center).addScaledVector(win.normal, 1.4).add(new THREE.Vector3(0, -win.center.y, 0))
    } else {
      sun.position.set(-2, 6, -4)
      sun.target.position.set(0, 0, 0)
    }
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    const R = Math.max(W, D) * 1.1
    Object.assign(sun.shadow.camera, { left: -R, right: R, top: R, bottom: -R, near: 0.5, far: 20 })
    sun.shadow.bias = -0.0006
    sun.shadow.normalBias = 0.02
    sun.shadow.radius = 4
    lightsRoot.add(sun, sun.target)
    // 夜里点灯:挑最多三盏打真光,其余只靠自发光
    if (night) {
      for (const h of lampHints.slice(0, 3)) {
        const pl = new THREE.PointLight(h.color, h.intensity, h.distance, 1.6)
        pl.position.copy(h.world)
        lightsRoot.add(pl)
      }
    }
    scene3.add(lightsRoot)
    renderer.toneMappingExposure = night ? 1.15 : 1.0
    scene3.environmentIntensity = night ? 0.18 : 0.4
    bgTex = backgroundTexture(kit, night, s.sky)
    scene3.background = bgTex

    motes = makeMotes(night ? 70 : 50, new THREE.Box3(new THREE.Vector3(-W / 2, 0.2, -D / 2), new THREE.Vector3(W / 2, H * 0.9, D / 2)))
    ;(motes.points.material as THREE.PointsMaterial).color.set(night ? '#cfe0ff' : '#fff1c9')
    scene3.add(motes.points)

    renderer.shadowMap.needsUpdate = true
    needResize = true
    tintCharacter()
  }

  function obstacles(s: ResolvedScene): Obstacle[] {
    const out: Obstacle[] = []
    for (const p of s.props) {
      const info = PROP_INFO[p.type]
      if (!info || (!info.half[0] && !info.half[1])) continue
      if (p.y > 0.3) continue // 挂在墙上 / 放在家具上的不挡路
      out.push({ x: p.at[0], z: p.at[1], hx: info.half[0] * p.scale, hz: info.half[1] * p.scale, rot: p.rot * DEG })
    }
    return out
  }

  function cameraXZ(): [number, number] {
    return [camera.position.x, camera.position.z]
  }

  function rebuildBrain(): void {
    const s = spec
    if (!s) {
      brain = null
      grid = null
      return
    }
    grid = buildGrid(s.room.width, s.room.depth, obstacles(s), Math.max(0.14, metrics.height * 0.14))
    brain = createBrain({ scene: s, grid, camera: cameraXZ, night: () => nightNow })
    brain.setPhase(status.phase)
  }

  // ── 形象 ──
  function measureCharacter(): void {
    const a = avatar.anchors
    const h0 = Math.max(1e-3, a.box.max.y - a.box.min.y)
    const H = spec?.height ?? 1.25
    charScale = H / h0
    scaler.scale.setScalar(charScale)
    const hipY = a.hip ? (a.hip.y - a.box.min.y) * charScale : H * 0.3
    // 躺下时垫多高:按**躯干**厚度,不按包围盒 —— Q 版的头(连头发)比身子厚一倍多,按包围盒垫身子会悬在床上方;
    // 头往后仰一点陷进枕头(poses 里躺姿的 head 负 x)。
    const back = Math.min(((a.box.max.z - a.box.min.z) / 2) * charScale, H * 0.09)
    metrics = { height: H, hipY, back }
    animator = createAnimator(metrics)
    blob.scale.setScalar(Math.max(0.35, (a.box.max.x - a.box.min.x) * charScale * 0.9))
    emotes?.dispose()
    emotes = new EmoteLayer(scene3, H * 0.16)
    // 手持物件的位置(形象局部,未缩放前的单位):胸前 / 膝上
    const hip = a.hip ?? new THREE.Vector3(0, h0 * 0.3, 0)
    const top = a.box.max.y
    const head = a.head ?? new THREE.Vector3(0, top * 0.45, 0)
    held.book.position.set(0, hip.y + (head.y - hip.y) * 0.55, (a.box.max.z - a.box.min.z) * 0.32)
    held.book.rotation.x = -0.9
    held.book.scale.setScalar(1 / charScale * (H / 1.25))
    held.plush.position.set(0, hip.y + (head.y - hip.y) * 0.25, (a.box.max.z - a.box.min.z) * 0.3)
    held.plush.scale.setScalar(1 / charScale * (H / 1.25))
    resolveMood = moodResolver(avatar.caps.expressions)
    avatar.root.traverse((o) => {
      o.castShadow = false
      o.receiveShadow = false
    })
  }

  /** 夜里给住客压暗、偏蓝。MMD 的卡通材质不看光照角度(色阶图 + 环境色两成当自发光),在夜里的蓝房间里会像自己在发光;
   *  按昼夜把 color / ambient 乘一个色调,原值记在 userData 里,换昼夜时从原值重算(不累乘)。 */
  function tintCharacter(): void {
    const f = nightNow ? new THREE.Color(0.66, 0.68, 0.78) : new THREE.Color(0.96, 0.95, 0.93)
    avatar.root.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      for (const mat of (Array.isArray(m.material) ? m.material : [m.material]) as Array<THREE.Material & { color?: THREE.Color; ambient?: THREE.Color; userData: Record<string, unknown> }>) {
        if (!mat?.color) continue
        const base = (mat.userData.l3Base ??= { color: mat.color.clone(), ambient: mat.ambient?.clone() }) as { color: THREE.Color; ambient?: THREE.Color }
        mat.color.copy(base.color).multiply(f)
        if (mat.ambient && base.ambient) mat.ambient.copy(base.ambient).multiply(f).multiplyScalar(nightNow ? 0.5 : 1)
      }
    })
  }

  function swapAvatar(next: Avatar, orb: boolean): void {
    const old = avatar
    avatar = next
    isOrb = orb
    scaler.add(next.root)
    old.dispose()
    measureCharacter()
    tintCharacter()
    avatar.applyPlan(planFor(status.phase, isOrb ? undefined : profile?.states, avatar.caps, null))
    rebuildBrain()
    resumed = true
  }

  // ── 镜头 ──
  function roomCorners(): THREE.Vector3[] {
    const s = spec
    const W = s?.room.width ?? 4
    const D = s?.room.depth ?? 4
    const H = s?.room.height ?? 2.6
    const pts: THREE.Vector3[] = []
    for (const x of [-W / 2 - 0.12, W / 2]) for (const z of [-D / 2 - 0.12, D / 2]) pts.push(new THREE.Vector3(x, -0.14, z))
    pts.push(new THREE.Vector3(-W / 2, H, -D / 2), new THREE.Vector3(-W / 2, H, D / 2), new THREE.Vector3(W / 2, H, -D / 2))
    return pts
  }

  /** 让整个房间刚好装进画面:先定方向,再迭代距离与中心(透视投影不是线性的,几轮就收敛)。 */
  function fit(): void {
    const pts = roomCorners()
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))
    const center = new THREE.Box3().setFromPoints(pts).getCenter(new THREE.Vector3())
    target.copy(center)
    let d = 12
    const margin = mode === 'screensaver' ? 0.78 : 0.86
    for (let it = 0; it < 6; it++) {
      camera.position.copy(target).addScaledVector(dir, d)
      camera.lookAt(target)
      camera.updateMatrixWorld(true)
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      for (const p of pts) {
        const v = p.clone().project(camera)
        minX = Math.min(minX, v.x)
        maxX = Math.max(maxX, v.x)
        minY = Math.min(minY, v.y)
        maxY = Math.max(maxY, v.y)
      }
      const ext = Math.max((maxX - minX) / 2, (maxY - minY) / 2)
      // 画面中心对准房间投影的中心:沿镜头的右 / 上方向挪目标点
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
      const halfH = Math.tan((camera.fov * DEG) / 2) * d
      const halfW = halfH * camera.aspect
      target.addScaledVector(right, ((minX + maxX) / 2) * halfW).addScaledVector(up, ((minY + maxY) / 2) * halfH)
      d *= ext / margin
    }
    fitDist = d
    placeCamera()
  }

  function placeCamera(): void {
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))
    camera.position.copy(target).addScaledVector(dir, fitDist / zoom)
    camera.lookAt(target)
    camera.near = Math.max(0.05, fitDist / zoom / 50)
    camera.far = fitDist * 6
    camera.updateProjectionMatrix()
  }

  // ── 循环 ──
  const measureHost = (): { w: number; h: number } => {
    const r = (host ?? canvas).getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height) }
  }
  const applySize = (): void => {
    needResize = false
    const { w, h } = measureHost()
    sized = w > 1 && h > 1
    if (!sized) return
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.5))
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    fit()
  }
  const shouldRun = (): boolean => !!host && visible && sized && !contextLost && !disposed && !(typeof document !== 'undefined' && document.hidden)
  const updateLoop = (): void => {
    const want = shouldRun()
    if (want && !raf) {
      resumed = true
      raf = requestAnimationFrame(frame)
    } else if (!want && raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
  }

  const _v = new THREE.Vector3()
  const _q = new THREE.Quaternion()

  function lookFor(modeL: LookMode, t: number, placeLook: [number, number, number] | null): { yaw: number; pitch: number } {
    // 世界里的一个点 → 形象朝向系里的偏航 / 俯仰(+Z 朝前、+X 是角色左手)
    const toLocal = (p: THREE.Vector3): { yaw: number; pitch: number } => {
      mover.updateMatrixWorld(true)
      const headW = _v.set(0, avatar.anchors.head?.y ?? avatar.anchors.box.max.y * 0.6, 0).multiplyScalar(charScale)
      mover.localToWorld(headW)
      const d = p.clone().sub(headW).applyQuaternion(_q.copy(mover.quaternion).invert())
      return { yaw: clamp(Math.atan2(d.x, d.z), -65 * DEG, 65 * DEG), pitch: clamp(Math.atan2(d.y, Math.hypot(d.x, d.z)), -35 * DEG, 40 * DEG) }
    }
    switch (modeL) {
      case 'camera':
        return toLocal(camera.position)
      case 'target':
        return placeLook ? toLocal(new THREE.Vector3(...placeLook)) : { yaw: 0, pitch: 0.3 }
      case 'up':
        return { yaw: -0.25, pitch: 0.32 }
      case 'down':
        return { yaw: 0, pitch: -0.3 }
      case 'forward':
        return { yaw: 0, pitch: 0 }
      default: {
        if (t > free.next) free = { yaw: (Math.random() - 0.5) * 1.1, pitch: (Math.random() - 0.4) * 0.3, next: t + 2.5 + Math.random() * 4 }
        // 偶尔看一眼镜头
        return Math.sin(t * 0.21) > 0.85 ? toLocal(camera.position) : { yaw: free.yaw, pitch: free.pitch }
      }
    }
  }

  function frame(ts: number): void {
    raf = requestAnimationFrame(frame)
    const cap = mode === 'screensaver' || (typeof document.hasFocus === 'function' && !document.hasFocus()) ? 30 : 60
    if (ts - lastFrame < 1000 / cap - 2) return
    lastFrame = ts
    timer.update(ts)
    const fd = frameDelta(timer.getDelta())
    let dt = fd.dt
    if (resumed || fd.resume) {
      dt = 0
      resumed = false
      avatar.onResume?.()
    }
    if (needResize) applySize()
    if (!sized) {
      updateLoop()
      return
    }
    const t = timer.getElapsed()
    frames++
    fpsAcc.n++
    fpsAcc.t += dt
    if (fpsAcc.t >= 1) {
      fps = fpsAcc.n / fpsAcc.t
      fpsAcc = { t: 0, n: 0 }
    }

    // 昼夜自动切换(auto:每分钟看一次钟)
    if (spec && Math.floor(t / 60) !== Math.floor((t - dt) / 60) && isNight(timeOverride ?? spec.time) !== nightNow) buildRoom()

    // 镜头
    if (mode === 'screensaver') {
      azT = 45 * DEG + Math.sin((t * 2 * Math.PI) / 90) * 14 * DEG
      elT = 30 * DEG + Math.sin((t * 2 * Math.PI) / 70) * 4 * DEG
      zoomT = 1.06 + Math.sin((t * 2 * Math.PI) / 110) * 0.05
    }
    const a0 = az
    const e0 = el
    const z0 = zoom
    az = damp(az, azT, 6, dt)
    el = damp(el, elT, 6, dt)
    zoom = damp(zoom, zoomT, 6, dt)
    if (Math.abs(az - a0) + Math.abs(el - e0) > 1e-5) fit()
    else if (Math.abs(zoom - z0) > 1e-5) placeCamera()

    // 口型
    let mouth = 0
    if (status.phase === 'speaking') {
      let s: AgentStatusLike | null = null
      try {
        s = source?.() ?? null
      } catch {
        s = null
      }
      if (s) env.sample(s.textChars, t, s.messageId)
      else env.sample(Math.floor(t * 30), t, 'synthetic')
      mouth = mouthFlap(env.value, t)
    } else env.decay(t)

    // 行为 → 姿势 → 骨骼
    if (brain && animator) {
      const fr = brain.update(dt)
      const an = animator.step(fr, dt, t)
      mover.position.set(an.root.x, an.root.y, an.root.z)
      mover.rotation.set(an.root.pitch, an.root.yaw, 0)
      const lt = lookFor(an.look, t, fr.look)
      look.yaw = damp(look.yaw, lt.yaw, 5, dt)
      look.pitch = damp(look.pitch, lt.pitch, 5, dt)
      const proc: ProcPlan = { ...PROC.idle, look: 'camera', sway: 0.25, nod: status.phase === 'speaking' ? 0.35 : 0 }
      const expr = resolveMood(an.mood)
      avatar.update({ t, dt, look, mouth, proc, reduced: !!reducedMq?.matches, body: { ...an.body, expr } })
      for (const [k, g] of Object.entries(held) as Array<[Exclude<Held, null>, THREE.Group]>) g.visible = an.held === k && !isOrb
      // 脚下的影子:站着贴地、坐着在椅子底下、躺着就不要了(床有真阴影)
      blob.visible = fr.stance !== 'lie' || fr.settle < 0.3
      blob.position.set(an.root.x, 0.012, an.root.z)
      ;(blob.material as THREE.MeshBasicMaterial).opacity = fr.stance === 'sit' ? 0.6 : 1
      // 头顶符号
      mover.updateMatrixWorld(true)
      const top = _v.set(0, avatar.anchors.box.max.y * 1.02, 0).multiplyScalar(charScale)
      mover.localToWorld(top)
      top.y = Math.max(top.y, an.root.y) + metrics.height * 0.08
      emotes?.set(an.emote, t)
      emotes?.update(t, top)
    }
    for (const b of built) b.tick?.(t, dt)
    motes?.tick(t)
    renderer.render(scene3, camera)
  }

  // ── 交互 ──
  const onDown = (e: PointerEvent): void => {
    if (mode !== 'view' || e.button !== 0) return
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 }
    try {
      canvas.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }
  const onMove = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return
    const dx = e.clientX - drag.x
    const dy = e.clientY - drag.y
    drag.moved += Math.abs(dx) + Math.abs(dy)
    drag.x = e.clientX
    drag.y = e.clientY
    azT = clamp(azT - dx * 0.006, 5 * DEG, 85 * DEG)
    elT = clamp(elT + dy * 0.004, 12 * DEG, 62 * DEG)
    canvas.style.cursor = 'grabbing'
  }
  const onUp = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return
    const click = drag.moved < 5
    drag = null
    canvas.style.cursor = ''
    if (click) pick(e.clientX, e.clientY)
  }
  const onWheel = (e: WheelEvent): void => {
    if (mode !== 'view') return
    e.preventDefault()
    zoomT = clamp(zoomT * Math.exp(-e.deltaY * 0.0015), 0.8, 2.6)
  }
  const onDbl = (): void => {
    if (mode !== 'view') return
    azT = 45 * DEG
    elT = 30 * DEG
    zoomT = 1
  }
  /** 点到角色(屏幕上的包围框)→ 戳一下。 */
  function pick(cx: number, cy: number): void {
    if (!brain) return
    const r = canvas.getBoundingClientRect()
    const a = avatar.anchors
    const pts = [
      new THREE.Vector3(a.box.min.x, a.box.min.y, 0), new THREE.Vector3(a.box.max.x, a.box.max.y, 0),
      new THREE.Vector3(a.box.min.x, a.box.max.y, 0), new THREE.Vector3(a.box.max.x, a.box.min.y, 0),
    ]
    mover.updateMatrixWorld(true)
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const p of pts) {
      const v = mover.localToWorld(p.multiplyScalar(charScale)).project(camera)
      const x = r.left + ((v.x + 1) / 2) * r.width
      const y = r.top + ((1 - v.y) / 2) * r.height
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
    }
    if (cx >= minX && cx <= maxX && cy >= minY && cy <= maxY) brain.poke()
  }
  const onLost = (e: Event): void => {
    e.preventDefault()
    contextLost = true
    updateLoop()
  }
  const onRestored = (): void => {
    contextLost = false
    envRT.dispose()
    envRT = pmrem.fromScene(new RoomEnvironment(), 0.04)
    scene3.environment = envRT.texture
    renderer.shadowMap.needsUpdate = true
    needResize = true
    updateLoop()
  }
  const onWinResize = (): void => {
    needResize = true
    if (!raf) {
      applySize()
      updateLoop()
    }
  }
  const onVisibility = (): void => updateLoop()
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointercancel', onUp)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('dblclick', onDbl)
  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)

  measureCharacter()

  const stage: RoomStage = {
    attach(el, o) {
      if (disposed) return
      if (o?.mode) {
        mode = o.mode
        if (mode === 'view') {
          azT = 45 * DEG
          elT = 30 * DEG
          zoomT = 1
        }
      }
      canvas.style.cursor = ''
      if (host === el) {
        needResize = true
        return
      }
      if (host) stage.detach()
      host = el
      el.appendChild(canvas)
      visible = true
      needResize = true
      ro = new ResizeObserver(() => {
        needResize = true
        if (!raf) {
          applySize()
          updateLoop()
        }
      })
      ro.observe(el)
      io = new IntersectionObserver((entries) => {
        visible = entries.some((x) => x.isIntersecting)
        updateLoop()
      })
      io.observe(el)
      window.addEventListener('resize', onWinResize)
      document.addEventListener('visibilitychange', onVisibility)
      applySize()
      updateLoop()
    },
    detach() {
      if (!host) return
      ro?.disconnect()
      io?.disconnect()
      ro = io = null
      window.removeEventListener('resize', onWinResize)
      document.removeEventListener('visibilitychange', onVisibility)
      canvas.remove()
      host = null
      drag = null
      updateLoop()
    },
    setScene(s) {
      const key = s ? JSON.stringify(s) : ''
      if (key === specKey) return
      specKey = key
      spec = s
      if (!s) {
        clearRoom()
        brain = null
        return
      }
      measureCharacter()
      buildRoom()
      rebuildBrain()
      fit()
    },
    async setCharacter(p) {
      const my = ++gen
      if (disposed) return { ok: false, code: 'disposed', zh: '舞台已销毁', en: 'The stage has been disposed' }
      if (!p) {
        profile = null
        loadedKey = ''
        if (!isOrb) swapAvatar(createOrb(readAccent()), true)
        return { ok: true, analysis: null }
      }
      const key = JSON.stringify([p.modelPath, p.motionPaths, p.transform])
      if (!isOrb && key === loadedKey && profile) {
        profile = p
        avatar.setStates?.(p.states)
        avatar.setPose?.(p.pose)
        return { ok: true, analysis: null }
      }
      let loaded: LoadedModel
      try {
        loaded = await loadModel({ path: p.modelPath, motionPaths: p.motionPaths, assetUrl: opts.assetUrl })
      } catch (e) {
        if (my !== gen || disposed) return { ok: false, code: 'superseded', zh: '已被新的加载取代', en: 'Superseded by a newer load' }
        const m = toMsg(e)
        profile = null
        loadedKey = ''
        if (!isOrb) swapAvatar(createOrb(readAccent()), true)
        return { ok: false, code: m.code, zh: m.zh, en: m.en }
      }
      if (my !== gen || disposed) {
        loaded.dispose()
        return { ok: false, code: disposed ? 'disposed' : 'superseded', zh: '已被新的加载取代', en: 'Superseded by a newer load' }
      }
      try {
        const next = createModelAvatar({ loaded, profile: p })
        profile = p
        loadedKey = key
        swapAvatar(next, false)
        return { ok: true, analysis: null }
      } catch (e) {
        loaded.dispose()
        const m = toMsg(e)
        return { ok: false, code: m.code, zh: m.zh, en: m.en }
      }
    },
    setStatus(s) {
      const next: AgentStatusLike = isPhase(s?.phase) ? s : { ...s, phase: 'idle' as Phase }
      const changed = next.phase !== status.phase
      status = next
      if (!changed) return
      avatar.applyPlan(planFor(status.phase, isOrb ? undefined : profile?.states, avatar.caps, null))
      if (status.phase !== 'speaking') env.reset()
      brain?.setPhase(status.phase)
    },
    setStatusSource(fn) {
      source = fn
    },
    setTime(m) {
      if (m === timeOverride) return
      timeOverride = m
      if (spec) buildRoom()
    },
    night: () => nightNow,
    force(id) {
      brain?.force(id)
    },
    doing() {
      const f = brain?.frame()
      const a = f?.activity
      if (!f || !a) return null
      return { id: a.id, pose: f.mode === 'walk' ? 'walk' : f.pose, label: a.label }
    },
    debug() {
      const f = brain?.frame()
      mover.updateMatrixWorld(true)
      const r = canvas.getBoundingClientRect()
      const c = mover.localToWorld(new THREE.Vector3(0, (avatar.anchors.box.max.y * 0.5) * charScale, 0)).project(camera)
      const top = mover.localToWorld(new THREE.Vector3(0, avatar.anchors.box.max.y * charScale, 0)).project(camera)
      const bot = mover.localToWorld(new THREE.Vector3(0, 0, 0)).project(camera)
      return {
        screen: { x: ((c.x + 1) / 2) * r.width, y: ((1 - c.y) / 2) * r.height, h: Math.abs(top.y - bot.y) / 2 * r.height },
        activity: brain?.current() ?? null, mode: f?.mode ?? 'none', pose: f?.pose ?? 'none',
        x: f?.x ?? 0, z: f?.z ?? 0, night: nightNow, fps, frames,
      }
    },
    debugView(a, e, z, focus) {
      azT = az = a * DEG
      elT = el = e * DEG
      zoomT = zoom = z
      fit()
      if (focus) {
        target.set(...focus)
        placeCamera()
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      gen++
      stage.detach()
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('dblclick', onDbl)
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      clearRoom()
      emotes?.dispose()
      avatar.dispose()
      for (const g of Object.values(held)) disposeGroup(g)
      disposeGroup(blob)
      timer.dispose()
      envRT.dispose()
      pmrem.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
    },
  }
  return stage
}

/** 场景里道具的世界坐标(台架用:检查角色真的走到了书桌前)。 */
export function anchorWorld(scene: ResolvedScene, id: string): [number, number] | null {
  const p = scene.props.find((x) => x.id === id)
  return p ? propToWorld(p, 0, 0) : null
}
