// 房间外壳 + 道具建模。全部程序化(方块 / 圆柱 / 球 + 画布贴图),不带任何外部资源 —— 插件离线、体积小,
// 场景文件里写个 type 就有东西。尺寸与 scene.ts 的 PROP_INFO(占地 / 锚点)同源:改尺寸两边一起改。
//
// 风格对着「三面剖开的小房间」调:低饱和的平涂色、粗糙度高、墙头与地板的切面比墙面浅一档(剖面感)、
// 边角不做圆角(低多边形味)。夜里灯罩 / 小灯串 / 星星是自发光材质,真正打光的只有少数几盏(见 LightHint)。

import * as THREE from 'three'
import type { PropSpec, RoomShell, WindowSpec } from './scene'

const DEG = Math.PI / 180

// ── 小工具 ───────────────────────────────────────────────────────────────────
/** 可复现的伪随机(书脊颜色、照片内容……每次打开都一样)。 */
export function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const hashStr = (s: string): number => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/** 材质与贴图的登记处:整个房间一份,dispose 时统一释放(换场景 / 卸载)。 */
export class Kit {
  private mats = new Map<string, THREE.Material>()
  readonly owned: Array<{ dispose(): void }> = []
  /** 本次建房的几何缓存(同尺寸的书脊、琴键共用一份)。随 Kit 一起释放 —— 做成全局的话,反复改房间尺寸
   *  每次都留下一批新尺寸的几何,永远不释放。 */
  readonly geos = new Map<string, THREE.BufferGeometry>()
  constructor(readonly night: boolean) {}

  mat(color: string | number, o: { rough?: number; metal?: number; emissive?: string | number; glow?: number; opacity?: number; side?: THREE.Side; map?: THREE.Texture; flat?: boolean } = {}): THREE.Material {
    const key = JSON.stringify([color, o.rough, o.metal, o.emissive, o.glow, o.opacity, o.side, o.map?.uuid, o.flat])
    let m = this.mats.get(key)
    if (!m) {
      const sm = new THREE.MeshStandardMaterial({
        color: new THREE.Color(color as THREE.ColorRepresentation),
        roughness: o.rough ?? 0.85,
        metalness: o.metal ?? 0,
        map: o.map ?? null,
        flatShading: o.flat ?? false,
        side: o.side ?? THREE.FrontSide,
      })
      if (o.emissive !== undefined) {
        sm.emissive = new THREE.Color(o.emissive as THREE.ColorRepresentation)
        sm.emissiveIntensity = o.glow ?? 1
      }
      if (o.opacity !== undefined && o.opacity < 1) {
        sm.transparent = true
        sm.opacity = o.opacity
        sm.depthWrite = false
      }
      m = sm
      this.mats.set(key, m)
    }
    return m
  }

  /** 不受光照的材质(窗外的天、发光的小灯)。 */
  basic(color: string | number, o: { map?: THREE.Texture; opacity?: number; additive?: boolean } = {}): THREE.Material {
    const key = JSON.stringify(['basic', color, o.map?.uuid, o.opacity, o.additive])
    let m = this.mats.get(key)
    if (!m) {
      const bm = new THREE.MeshBasicMaterial({ color: new THREE.Color(color as THREE.ColorRepresentation), map: o.map ?? null, fog: false })
      if (o.opacity !== undefined) {
        bm.transparent = true
        bm.opacity = o.opacity
        bm.depthWrite = false
      }
      if (o.additive) {
        bm.blending = THREE.AdditiveBlending
        bm.transparent = true
        bm.depthWrite = false
      }
      m = bm
      this.mats.set(key, m)
    }
    return m
  }

  /** 画布贴图(w×h 像素)。draw 用 2D 上下文画。 */
  tex(w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, o: { repeat?: [number, number]; nearest?: boolean } = {}): THREE.Texture {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const g = c.getContext('2d')!
    draw(g, w, h)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 4
    if (o.repeat) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      t.repeat.set(o.repeat[0], o.repeat[1])
    }
    if (o.nearest) t.magFilter = THREE.NearestFilter
    this.owned.push(t)
    return t
  }

  /** 这份材质 / 几何是不是本 Kit 发的(房间拆除时:Kit 的统一 dispose,不是的由拆除方自己 dispose)。 */
  owns(m: THREE.Material): boolean {
    for (const x of this.mats.values()) if (x === m) return true
    return false
  }
  ownsGeometry(g: THREE.BufferGeometry): boolean {
    for (const x of this.geos.values()) if (x === g) return true
    return false
  }

  dispose(): void {
    for (const m of this.mats.values()) m.dispose()
    this.mats.clear()
    for (const g of this.geos.values()) g.dispose()
    this.geos.clear()
    for (const o of this.owned.splice(0)) o.dispose()
  }
}

/** 正在建的那间房的几何缓存(buildShell / buildProp 同步执行期间指向 kit.geos)。 */
let geoScope: Map<string, THREE.BufferGeometry> | null = null
function withKit<T>(k: Kit, fn: () => T): T {
  const prev = geoScope
  geoScope = k.geos
  try {
    return fn()
  } finally {
    geoScope = prev
  }
}
/** 几何按尺寸缓存在当前 Kit 里(同一间房里同尺寸的共用一份)。不在建房期间调用 = 不缓存(调用方自己管)。 */
function geo(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  if (!geoScope) return make()
  let g = geoScope.get(key)
  if (!g) {
    g = make()
    geoScope.set(key, g)
  }
  return g
}
const boxG = (w: number, h: number, d: number): THREE.BufferGeometry => geo(`b${w.toFixed(3)},${h.toFixed(3)},${d.toFixed(3)}`, () => new THREE.BoxGeometry(w, h, d))
const cylG = (rt: number, rb: number, h: number, seg = 16): THREE.BufferGeometry => geo(`c${rt},${rb},${h},${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg))
const sphG = (r: number, ws = 16, hs = 12): THREE.BufferGeometry => geo(`s${r},${ws},${hs}`, () => new THREE.SphereGeometry(r, ws, hs))

interface MeshOpts { shadow?: boolean; receive?: boolean }
function mesh(g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, o: MeshOpts = {}): THREE.Mesh {
  const me = new THREE.Mesh(g, m)
  me.position.set(x, y, z)
  me.castShadow = o.shadow ?? true
  me.receiveShadow = o.receive ?? true
  return me
}
/** 以底面中心定位的方块(家具都这么搭,读起来像尺寸表)。 */
function blk(k: Kit, parent: THREE.Object3D, w: number, h: number, d: number, color: string | number, x: number, y: number, z: number, o: { rough?: number; metal?: number; emissive?: string; glow?: number; map?: THREE.Texture; shadow?: boolean } = {}): THREE.Mesh {
  const me = mesh(boxG(w, h, d), k.mat(color, o), x, y + h / 2, z, { shadow: o.shadow })
  parent.add(me)
  return me
}

/** 调暗 / 调亮一个颜色(0..1 的倍数)。 */
function shade(color: string, f: number): string {
  const c = new THREE.Color(color)
  c.multiplyScalar(f)
  return `#${c.getHexString()}`
}

// ── 贴图 ─────────────────────────────────────────────────────────────────────
function starField(g: CanvasRenderingContext2D, w: number, h: number, rnd: () => number, n: number, maxR = 1.6, alpha = 1): void {
  for (let i = 0; i < n; i++) {
    const r = 0.3 + rnd() ** 3 * maxR
    g.globalAlpha = alpha * (0.35 + rnd() * 0.65)
    g.fillStyle = '#ffffff'
    g.beginPath()
    g.arc(rnd() * w, rnd() * h, r, 0, Math.PI * 2)
    g.fill()
  }
  g.globalAlpha = 1
}
function fourStar(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  g.fillStyle = color
  g.beginPath()
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4
    const rr = i % 2 ? r * 0.28 : r
    g.lineTo(x + Math.sin(a) * rr, y - Math.cos(a) * rr)
  }
  g.closePath()
  g.fill()
}

export function planksTexture(k: Kit, color: string): THREE.Texture {
  return k.tex(512, 512, (g, w, h) => {
    const rnd = seeded(7)
    const rows = 8
    for (let r = 0; r < rows; r++) {
      let x = -rnd() * 200
      while (x < w) {
        const len = 180 + rnd() * 220
        const f = 0.9 + rnd() * 0.2
        g.fillStyle = shade(color, f)
        g.fillRect(x, (r * h) / rows, len, h / rows)
        // 木纹
        g.globalAlpha = 0.08
        g.fillStyle = shade(color, 0.6)
        for (let i = 0; i < 4; i++) g.fillRect(x + rnd() * len, (r * h) / rows + rnd() * (h / rows), 40 + rnd() * 80, 1.5)
        g.globalAlpha = 1
        g.fillStyle = shade(color, 0.72)
        g.fillRect(x, (r * h) / rows, 2, h / rows)
        x += len
      }
      g.fillStyle = shade(color, 0.7)
      g.fillRect(0, (r * h) / rows, w, 2)
    }
  }, { repeat: [1, 1] })
}

function starPattern(k: Kit, base: string, dot: string, seed = 3): THREE.Texture {
  return k.tex(256, 256, (g, w, h) => {
    g.fillStyle = base
    g.fillRect(0, 0, w, h)
    const rnd = seeded(seed)
    for (let i = 0; i < 16; i++) fourStar(g, rnd() * w, rnd() * h, 4 + rnd() * 7, dot)
    starField(g, w, h, rnd, 40, 1.2, 0.5)
  }, { repeat: [2, 2] })
}

/** 窗外:夜里是星空 + 月亮,白天是天空渐变 + 云。 */
export function skyTexture(k: Kit, night: boolean, sky: string): THREE.Texture {
  return k.tex(512, 512, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, 0, h)
    if (night) {
      grd.addColorStop(0, shade(sky, 0.7))
      grd.addColorStop(0.7, sky)
      grd.addColorStop(1, shade(sky, 1.6))
    } else {
      grd.addColorStop(0, '#8fc3ec')
      grd.addColorStop(0.75, '#cfe6f6')
      grd.addColorStop(1, '#f5e9d8')
    }
    g.fillStyle = grd
    g.fillRect(0, 0, w, h)
    const rnd = seeded(11)
    if (night) {
      starField(g, w, h * 0.85, rnd, 260, 1.8)
      for (let i = 0; i < 6; i++) fourStar(g, rnd() * w, rnd() * h * 0.7, 5 + rnd() * 5, '#fff7d6')
      // 月亮(弯月:大圆减去一个偏移的圆)
      g.fillStyle = '#fff4cf'
      g.shadowColor = '#fff4cf'
      g.shadowBlur = 30
      g.beginPath()
      g.arc(w * 0.72, h * 0.24, 38, 0, Math.PI * 2)
      g.fill()
      g.shadowBlur = 0
      g.globalCompositeOperation = 'destination-out'
      g.beginPath()
      g.arc(w * 0.72 + 20, h * 0.24 - 12, 34, 0, Math.PI * 2)
      g.fill()
      g.globalCompositeOperation = 'source-over'
      // 远处城市的剪影(临空市)
      g.fillStyle = shade(sky, 0.45)
      let x = 0
      while (x < w) {
        const bw = 20 + rnd() * 40
        const bh = 30 + rnd() * 90
        g.fillRect(x, h - bh, bw, bh)
        g.fillStyle = '#ffd98a'
        for (let j = 0; j < 6; j++) if (rnd() > 0.55) g.fillRect(x + 4 + rnd() * (bw - 10), h - bh + 8 + rnd() * (bh - 16), 3, 4)
        g.fillStyle = shade(sky, 0.45)
        x += bw + 2
      }
    } else {
      g.fillStyle = '#ffffff'
      for (let i = 0; i < 5; i++) {
        const cx = rnd() * w
        const cy = 60 + rnd() * h * 0.45
        g.globalAlpha = 0.75
        for (let j = 0; j < 5; j++) {
          g.beginPath()
          g.arc(cx + (j - 2) * 22 + rnd() * 10, cy + rnd() * 10, 18 + rnd() * 16, 0, Math.PI * 2)
          g.fill()
        }
      }
      g.globalAlpha = 1
      g.fillStyle = '#9dbf8f'
      for (let x = 0; x < w; x += 18) {
        const th = 40 + rnd() * 50
        g.beginPath()
        g.arc(x, h - 10, th * 0.6, Math.PI, 0)
        g.fill()
      }
    }
  })
}

// ── 房间外壳 ─────────────────────────────────────────────────────────────────
export interface ShellParts {
  group: THREE.Group
  /** 窗户中心(世界)与朝内的法线:定向光从这里照进来。 */
  windows: Array<{ center: THREE.Vector3; normal: THREE.Vector3; spec: WindowSpec }>
}

const WALL_T = 0.12
const FLOOR_T = 0.14

/** 一面带窗洞的墙:沿 u 轴(长 len)、竖直 H、厚 WALL_T;窗洞按 along 排。返回的 group 在墙的局部系里(u = +X)。 */
function wallWithHoles(k: Kit, len: number, H: number, color: string, trim: string, holes: Array<{ c: number; w: number; sill: number; h: number }>): THREE.Group {
  const g = new THREE.Group()
  const mat = k.mat(color, { rough: 0.95 })
  const add = (x0: number, x1: number, y0: number, y1: number): void => {
    if (x1 - x0 < 1e-3 || y1 - y0 < 1e-3) return
    const m = mesh(boxG(x1 - x0, y1 - y0, WALL_T), mat, (x0 + x1) / 2, (y0 + y1) / 2, -WALL_T / 2)
    g.add(m)
  }
  const sorted = [...holes].sort((a, b) => a.c - b.c)
  let x = 0
  for (const h of sorted) {
    const a = h.c - h.w / 2
    const b = h.c + h.w / 2
    add(x, a, 0, H)
    add(a, b, 0, h.sill)
    add(a, b, h.sill + h.h, H)
    x = b
  }
  add(x, len, 0, H)
  // 墙头切面:浅一档的顶盖,剖面感
  g.add(mesh(boxG(len, 0.025, WALL_T + 0.01), k.mat(trim, { rough: 0.8 }), len / 2, H + 0.0125, -WALL_T / 2, { shadow: false }))
  // 踢脚线
  const base = k.mat(trim, { rough: 0.7 })
  x = 0
  for (const h of sorted) {
    const a = h.c - h.w / 2
    if (h.sill < 0.1) {
      if (a - x > 0.01) g.add(mesh(boxG(a - x, 0.07, 0.02), base, (x + a) / 2, 0.035, 0.01, { shadow: false }))
      x = h.c + h.w / 2
    }
  }
  if (len - x > 0.01) g.add(mesh(boxG(len - x, 0.07, 0.02), base, (x + len) / 2, 0.035, 0.01, { shadow: false }))
  return g
}

/** 窗:窗框 + 十字棂 + 窗台 + 玻璃 + 两片窗帘 + 窗外的天(一块不受光的画)。局部系:窗洞中心在原点,+Z 朝屋里。 */
function windowUnit(k: Kit, w: WindowSpec, trim: string, sky: THREE.Texture, curtain: string): THREE.Group {
  const g = new THREE.Group()
  const fm = k.mat(trim, { rough: 0.6 })
  const f = 0.06
  g.add(mesh(boxG(w.width + f * 2, f, WALL_T + 0.04), fm, 0, w.height / 2 + f / 2, -WALL_T / 2))
  g.add(mesh(boxG(w.width + f * 2, f, WALL_T + 0.04), fm, 0, -w.height / 2 - f / 2, -WALL_T / 2))
  g.add(mesh(boxG(f, w.height, WALL_T + 0.04), fm, -w.width / 2 - f / 2, 0, -WALL_T / 2))
  g.add(mesh(boxG(f, w.height, WALL_T + 0.04), fm, w.width / 2 + f / 2, 0, -WALL_T / 2))
  // 窗棂
  g.add(mesh(boxG(0.035, w.height, 0.04), fm, 0, 0, -WALL_T / 2, { shadow: true }))
  g.add(mesh(boxG(w.width, 0.035, 0.04), fm, 0, w.height * 0.12, -WALL_T / 2, { shadow: true }))
  // 窗台(往屋里伸出来,能放小鸟和花)
  g.add(mesh(boxG(w.width + 0.2, 0.04, 0.2), k.mat(shade(trim, 0.97), { rough: 0.6 }), 0, -w.height / 2 - 0.02, 0.04))
  // 玻璃
  const glass = mesh(new THREE.PlaneGeometry(w.width, w.height), k.mat('#bcd6ee', { opacity: 0.12, rough: 0.1 }), 0, 0, -WALL_T / 2, { shadow: false, receive: false })
  g.add(glass)
  // 窗外:一块不受光的画,只比窗洞大一圈、紧贴在墙外 —— 大了会从墙头上面露出来(剖开的房间没有顶)
  const out = mesh(new THREE.PlaneGeometry(w.width * 1.35, w.height * 1.3), k.basic('#ffffff', { map: sky }), 0, 0, -WALL_T - 0.08, { shadow: false, receive: false })
  g.add(out)
  // 窗帘:两片带褶的布,挂在窗框外侧
  const cm = k.mat(curtain, { rough: 1, side: THREE.DoubleSide })
  for (const side of [-1, 1]) {
    const cw = 0.34
    const ch = w.height + 0.35
    const pg = new THREE.PlaneGeometry(cw, ch, 12, 1)
    const pos = pg.getAttribute('position') as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i++) pos.setZ(i, Math.sin((pos.getX(i) / cw) * Math.PI * 6) * 0.025)
    pg.computeVertexNormals()
    const c = mesh(pg, cm, side * (w.width / 2 + cw / 2 - 0.02), 0.08, 0.09, { shadow: true })
    g.add(c)
    // 窗帘杆
  }
  g.add(mesh(cylG(0.012, 0.012, w.width + 0.9, 8), k.mat('#8d7b67', { rough: 0.5, metal: 0.3 }), 0, w.height / 2 + 0.2, 0.1).rotateZ(Math.PI / 2))
  return g
}

export function buildShell(k: Kit, room: RoomShell, sky: string, curtain = '#9fb3d6'): ShellParts {
  return withKit(k, () => buildShellIn(k, room, sky, curtain))
}
function buildShellIn(k: Kit, room: RoomShell, sky: string, curtain: string): ShellParts {
  const W = room.width
  const D = room.depth
  const H = room.height
  const group = new THREE.Group()
  group.name = 'live3d-room-shell'

  // 地板:一块厚板,顶面木条,侧面切面色
  const top = room.planks ? planksTexture(k, room.floor) : undefined
  if (top) top.repeat.set(W / 2.2, D / 2.2)
  const floorTop = k.mat(room.planks ? '#ffffff' : room.floor, { rough: 0.8, map: top })
  const floorSide = k.mat(shade(room.floor, 0.62), { rough: 0.9 })
  const slab = new THREE.Mesh(boxG(W + WALL_T, FLOOR_T, D + WALL_T), [floorSide, floorSide, floorTop, floorSide, floorSide, floorSide])
  slab.position.set(-WALL_T / 2, -FLOOR_T / 2, -WALL_T / 2)
  slab.receiveShadow = true
  group.add(slab)
  // 地板前沿一道浅色切边
  group.add(mesh(boxG(W + WALL_T, 0.02, 0.02), k.mat(shade(room.floor, 1.2)), -WALL_T / 2, -0.01, D / 2, { shadow: false }))
  group.add(mesh(boxG(0.02, 0.02, D + WALL_T), k.mat(shade(room.floor, 1.2)), W / 2, -0.01, -WALL_T / 2, { shadow: false }))

  const skyTex = skyTexture(k, k.night, sky)
  const windows: ShellParts['windows'] = []
  const holesOf = (wall: 'left' | 'right', len: number) =>
    room.windows.filter((w) => w.wall === wall).map((w) => ({ c: w.at * len, w: w.width, sill: w.sill, h: w.height }))

  // 左墙:在 x = -W/2,屋里在 +X 一侧。旋转做不到「u 沿 +Z 且内侧朝 +X」(那是镜像),所以让 u 从敞开的前端
  // 铺向墙角:rotation.y = π/2 把局部 (u, n) 转到世界 (n, -u) —— x = -W/2 + n、z = D/2 - u。窗洞位置跟着从前端量。
  const left = wallWithHoles(k, D, H, room.wallLeft, room.trim, holesOf('left', D).map((h) => ({ ...h, c: D - h.c })))
  left.rotation.y = Math.PI / 2
  left.position.set(-W / 2, 0, D / 2)
  group.add(left)
  // 右墙:在 z = -D/2,沿 +X
  const right = wallWithHoles(k, W + WALL_T, H, room.wallRight, room.trim, holesOf('right', W).map((h) => ({ ...h, c: h.c + WALL_T })))
  right.position.set(-W / 2 - WALL_T, 0, -D / 2)
  group.add(right)

  for (const w of room.windows) {
    const unit = windowUnit(k, w, room.trim, skyTex, curtain)
    const cy = w.sill + w.height / 2
    if (w.wall === 'left') {
      unit.rotation.y = Math.PI / 2
      unit.position.set(-W / 2, cy, -D / 2 + w.at * D)
      windows.push({ center: unit.position.clone(), normal: new THREE.Vector3(1, 0, 0), spec: w })
    } else {
      unit.position.set(-W / 2 + w.at * W, cy, -D / 2)
      windows.push({ center: unit.position.clone(), normal: new THREE.Vector3(0, 0, 1), spec: w })
    }
    group.add(unit)
  }
  return { group, windows }
}

// ── 道具 ─────────────────────────────────────────────────────────────────────
/** 道具想要的光源(夜里点亮):roomStage 挑最近 / 最亮的几盏真正打光,其余只发光。 */
export interface LightHint {
  /** 道具局部坐标。 */
  at: THREE.Vector3
  color: string
  intensity: number
  distance: number
}

export interface BuiltProp {
  group: THREE.Group
  lights: LightHint[]
  /** 每帧推进(小鸟蹦跶、时钟走字)。 */
  tick?(t: number, dt: number): void
}

type Builder = (k: Kit, p: PropSpec, rnd: () => number) => BuiltProp

const WOOD = '#9a7250'
const WOOD_DARK = '#6e4d34'

const b = (_k: Kit): { g: THREE.Group; lights: LightHint[] } => ({ g: new THREE.Group(), lights: [] })

const BUILDERS: Record<string, Builder> = {
  bed(k, p) {
    const { g, lights } = b(k)
    const frame = p.color2 ?? WOOD
    const duvet = p.color ?? '#34457a'
    blk(k, g, 1.1, 0.2, 2.1, frame, 0, 0, 0, { rough: 0.7 })
    blk(k, g, 1.04, 0.14, 2.02, '#f4f2ee', 0, 0.2, 0.02)
    // 床头板(软包)
    blk(k, g, 1.14, 0.78, 0.1, shade(duvet, 1.25), 0, 0, -1.05)
    blk(k, g, 1.18, 0.05, 0.12, frame, 0, 0.78, -1.05)
    // 被子:盖住床尾 2/3,被头翻折一道
    const dt = starPattern(k, duvet, '#e8d9a6', 5)
    blk(k, g, 1.1, 0.06, 1.35, '#ffffff', 0, 0.33, 0.35, { map: dt, rough: 1 })
    blk(k, g, 1.1, 0.075, 0.18, '#eef1f7', 0, 0.33, -0.36, { rough: 1 })
    blk(k, g, 0.04, 0.2, 1.35, duvet, 0.55, 0.19, 0.35, { rough: 1 })
    // 枕头
    for (const x of [-0.25, 0.25]) {
      const pil = mesh(sphG(0.2, 14, 8), k.mat(x < 0 ? '#ffffff' : '#dfe8f6', { rough: 1 }), x, 0.4, -0.78)
      pil.scale.set(1, 0.38, 0.7)
      g.add(pil)
    }
    return { group: g, lights }
  },

  desk(k, p) {
    const { g, lights } = b(k)
    const wood = p.color ?? WOOD
    const chair = p.color2 ?? '#e9e3d9'
    // 桌面在 -Z 那半边(局部 z ∈ [-0.62, -0.07]),椅子在 +Z
    const tz = -0.34
    blk(k, g, 1.2, 0.04, 0.55, wood, 0, 0.62, tz, { rough: 0.6 })
    for (const [x, z] of [[-0.56, tz - 0.23], [0.56, tz - 0.23], [-0.56, tz + 0.23], [0.56, tz + 0.23]]) blk(k, g, 0.04, 0.62, 0.04, shade(wood, 0.8), x, 0, z)
    // 抽屉柜
    blk(k, g, 0.34, 0.5, 0.5, shade(wood, 0.92), 0.4, 0.1, tz)
    blk(k, g, 0.3, 0.005, 0.005, shade(wood, 0.6), 0.4, 0.42, tz + 0.253, { shadow: false })
    blk(k, g, 0.3, 0.005, 0.005, shade(wood, 0.6), 0.4, 0.26, tz + 0.253, { shadow: false })
    // 椅子(背对镜头,椅背在 +Z)
    const cz = 0.3
    blk(k, g, 0.4, 0.05, 0.4, chair, 0, 0.32, cz)
    for (const [x, z] of [[-0.17, cz - 0.17], [0.17, cz - 0.17], [-0.17, cz + 0.17], [0.17, cz + 0.17]]) blk(k, g, 0.035, 0.32, 0.035, shade(chair, 0.75), x, 0, z)
    blk(k, g, 0.4, 0.36, 0.04, chair, 0, 0.37, cz + 0.19)
    // 台灯
    const lx = -0.42
    blk(k, g, 0.12, 0.02, 0.12, '#2f3542', lx, 0.66, tz - 0.12, { metal: 0.3, rough: 0.5 })
    const arm = mesh(cylG(0.008, 0.008, 0.34, 6), k.mat('#2f3542', { metal: 0.3, rough: 0.5 }), lx, 0.83, tz - 0.12)
    g.add(arm)
    const shadeM = mesh(cylG(0.04, 0.09, 0.1, 16, ), k.mat('#f3e7cf', { emissive: '#ffcf8a', glow: k.night ? 1.4 : 0.05, rough: 0.9 }), lx + 0.05, 1.0, tz - 0.08)
    shadeM.rotation.z = -0.35
    g.add(shadeM)
    lights.push({ at: new THREE.Vector3(lx + 0.06, 0.92, tz - 0.06), color: '#ffc27a', intensity: 2.2, distance: 2.4 })
    return { group: g, lights }
  },

  chair(k, p) {
    const { g, lights } = b(k)
    const c = p.color ?? '#e9e3d9'
    blk(k, g, 0.4, 0.05, 0.4, c, 0, 0.32, 0)
    for (const [x, z] of [[-0.17, -0.17], [0.17, -0.17], [-0.17, 0.17], [0.17, 0.17]]) blk(k, g, 0.035, 0.32, 0.035, shade(c, 0.75), x, 0, z)
    blk(k, g, 0.4, 0.36, 0.04, c, 0, 0.37, -0.19)
    return { group: g, lights }
  },

  piano(k, p) {
    const { g, lights } = b(k)
    const body = p.color ?? '#2b2a33'
    const glossy = { rough: 0.35, metal: 0.05 }
    const pz = -0.3
    blk(k, g, 1.3, 0.98, 0.42, body, 0, 0, pz, glossy)
    blk(k, g, 1.36, 0.05, 0.46, body, 0, 0.98, pz, glossy)
    // 键盘架 + 白键 + 黑键
    blk(k, g, 1.24, 0.06, 0.2, body, 0, 0.5, pz + 0.3, glossy)
    blk(k, g, 1.16, 0.025, 0.14, '#f7f5f0', 0, 0.56, pz + 0.33, { rough: 0.4 })
    for (let i = 0; i < 20; i++) {
      if ([2, 6, 9, 13, 16].includes(i % 17)) continue
      blk(k, g, 0.025, 0.02, 0.08, '#16161a', -0.55 + i * 0.058, 0.585, pz + 0.3, { rough: 0.4, shadow: false })
    }
    // 谱架与乐谱
    const sheet = k.tex(128, 96, (c, w, h) => {
      c.fillStyle = '#fbf8f0'
      c.fillRect(0, 0, w, h)
      c.strokeStyle = '#333'
      c.lineWidth = 1
      for (let s = 0; s < 3; s++) for (let l = 0; l < 5; l++) {
        c.beginPath()
        c.moveTo(6, 14 + s * 28 + l * 4)
        c.lineTo(w - 6, 14 + s * 28 + l * 4)
        c.stroke()
      }
      c.fillStyle = '#222'
      const r = seeded(4)
      for (let i = 0; i < 24; i++) c.fillRect(8 + r() * (w - 16), 12 + Math.floor(r() * 3) * 28 + r() * 14, 3, 3)
    })
    const sh = mesh(new THREE.PlaneGeometry(0.34, 0.24), k.mat('#ffffff', { map: sheet, rough: 1 }), 0, 0.78, pz + 0.215)
    sh.rotation.x = -0.12
    g.add(sh)
    // 琴凳
    blk(k, g, 0.62, 0.05, 0.3, body, 0, 0.3, 0.3, glossy)
    for (const x of [-0.27, 0.27]) blk(k, g, 0.04, 0.3, 0.26, shade(body, 0.8), x, 0, 0.3)
    return { group: g, lights }
  },

  telescope(k, p) {
    const { g, lights } = b(k)
    const tube = p.color ?? '#eef1f6'
    const metal = { metal: 0.6, rough: 0.35 }
    // 三脚架
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.3
      const legM = mesh(cylG(0.012, 0.014, 0.8, 6), k.mat('#3a3f4b', metal), Math.sin(a) * 0.14, 0.38, Math.cos(a) * 0.14)
      legM.rotation.set(Math.cos(a) * 0.35, 0, -Math.sin(a) * 0.35)
      g.add(legM)
    }
    const head = new THREE.Group()
    head.position.set(0, 0.8, 0)
    head.rotation.x = 0.62 // 物镜(-Z 端)往上翘,目镜落在 Q 版身高的眼睛位置
    g.add(head)
    const t = mesh(cylG(0.055, 0.045, 0.78, 20), k.mat(tube, { rough: 0.3, metal: 0.2 }), 0, 0, -0.12)
    t.rotation.x = Math.PI / 2
    head.add(t)
    const ring = mesh(cylG(0.062, 0.062, 0.05, 20), k.mat('#c9a45c', metal), 0, 0, -0.5)
    ring.rotation.x = Math.PI / 2
    head.add(ring)
    const eye = mesh(cylG(0.018, 0.018, 0.12, 10), k.mat('#2b2f38', metal), 0, 0.02, 0.3)
    eye.rotation.x = Math.PI / 2
    head.add(eye)
    return { group: g, lights }
  },

  bookshelf(k, p, rnd) {
    const { g, lights } = b(k)
    const wood = p.color ?? WOOD
    const Hs = 1.6
    const Ws = 1.0
    const dz = 0.36
    blk(k, g, 0.04, Hs, dz, wood, -Ws / 2 + 0.02, 0, 0)
    blk(k, g, 0.04, Hs, dz, wood, Ws / 2 - 0.02, 0, 0)
    blk(k, g, Ws, 0.02, dz, shade(wood, 0.8), 0, 0, -dz / 2 + 0.01)
    blk(k, g, Ws, Hs, 0.02, shade(wood, 0.8), 0, 0, -dz / 2 + 0.01)
    const shelves = [0, 0.4, 0.8, 1.2, Hs - 0.03]
    for (const y of shelves) blk(k, g, Ws - 0.04, 0.03, dz, wood, 0, y, 0)
    const palette = ['#3f5d8c', '#c7b28a', '#7a4e5c', '#e8e1d2', '#546b57', '#2d3a58', '#b98b61', '#8aa3c7', '#d9c6a4']
    for (let s = 0; s < 4; s++) {
      let x = -Ws / 2 + 0.06
      const y0 = shelves[s] + 0.03
      const end = s === 1 ? 0.1 : Ws / 2 - 0.06
      while (x < end) {
        const bw = 0.025 + rnd() * 0.03
        const bh = 0.2 + rnd() * 0.12
        if (rnd() < 0.08) {
          // 斜靠的一本
          const bk = blk(k, g, bw, bh, 0.2, palette[Math.floor(rnd() * palette.length)], x + 0.04, y0, 0, { shadow: false })
          bk.rotation.z = -0.3
          x += 0.1
          continue
        }
        blk(k, g, bw, bh, 0.2 + rnd() * 0.04, palette[Math.floor(rnd() * palette.length)], x + bw / 2, y0, 0.02, { shadow: false })
        x += bw + 0.004
      }
    }
    // 第二层右边:一个小星球摆件 + 相框
    const planet = mesh(sphG(0.07, 16, 12), k.mat('#8fb0e0', { rough: 0.5 }), 0.3, 0.52, 0.02)
    g.add(planet)
    const ringM = mesh(new THREE.TorusGeometry(0.1, 0.008, 6, 32), k.mat('#e7cf8e', { rough: 0.4, metal: 0.4 }), 0.3, 0.52, 0.02)
    ringM.rotation.x = 1.2
    g.add(ringM)
    k.owned.push(ringM.geometry)
    return { group: g, lights }
  },

  shelf(k, p, rnd) {
    const { g, lights } = b(k)
    const wood = p.color ?? WOOD
    blk(k, g, 0.9, 0.03, 0.2, wood, 0, 0, 0.1)
    for (const x of [-0.35, 0.35]) blk(k, g, 0.02, 0.08, 0.14, '#3a3f4b', x, -0.08, 0.07, { metal: 0.4, rough: 0.5 })
    let x = -0.4
    const palette = ['#e8e1d2', '#3f5d8c', '#c7b28a', '#8aa3c7']
    while (x < -0.05) {
      const bw = 0.025 + rnd() * 0.02
      blk(k, g, bw, 0.15 + rnd() * 0.06, 0.14, palette[Math.floor(rnd() * palette.length)], x + bw / 2, 0.03, 0.1, { shadow: false })
      x += bw + 0.004
    }
    return { group: g, lights }
  },

  nightstand(k, p) {
    const { g, lights } = b(k)
    const wood = p.color ?? '#efe9df'
    blk(k, g, 0.44, 0.42, 0.4, wood, 0, 0, 0)
    blk(k, g, 0.4, 0.005, 0.005, shade(wood, 0.7), 0, 0.3, 0.203, { shadow: false })
    // 小台灯(圆球)
    blk(k, g, 0.08, 0.1, 0.08, '#d9cdb8', -0.1, 0.42, -0.05)
    const bulb = mesh(sphG(0.09, 16, 12), k.mat('#fff3dc', { emissive: '#ffd28f', glow: k.night ? 1.6 : 0.05, rough: 0.9 }), -0.1, 0.61, -0.05)
    g.add(bulb)
    lights.push({ at: new THREE.Vector3(-0.1, 0.62, 0.05), color: '#ffcc88', intensity: 1.6, distance: 2 })
    // 闹钟(他给鸟起名「小闹钟」,自己却不爱用)
    const clock = mesh(cylG(0.05, 0.05, 0.035, 18), k.mat('#e8b04b', { rough: 0.5, metal: 0.3 }), 0.1, 0.47, 0.05)
    clock.rotation.x = Math.PI / 2 - 0.25
    g.add(clock)
    return { group: g, lights }
  },

  rug(k, p) {
    const { g, lights } = b(k)
    const base = p.color ?? '#2c3a66'
    const dot = p.color2 ?? '#e9d9a8'
    const t = k.tex(512, 512, (c, w, h) => {
      c.fillStyle = '#00000000'
      c.clearRect(0, 0, w, h)
      c.fillStyle = base
      c.beginPath()
      c.arc(w / 2, h / 2, w / 2 - 2, 0, Math.PI * 2)
      c.fill()
      c.strokeStyle = shade(base, 1.5)
      c.lineWidth = 10
      c.beginPath()
      c.arc(w / 2, h / 2, w / 2 - 22, 0, Math.PI * 2)
      c.stroke()
      const r = seeded(9)
      for (let i = 0; i < 26; i++) {
        const a = r() * Math.PI * 2
        const rr = r() * (w / 2 - 50)
        fourStar(c, w / 2 + Math.cos(a) * rr, h / 2 + Math.sin(a) * rr, 6 + r() * 10, dot)
      }
      // 中间一轮弯月
      c.fillStyle = dot
      c.beginPath()
      c.arc(w / 2, h / 2, 46, 0, Math.PI * 2)
      c.fill()
      c.fillStyle = base
      c.beginPath()
      c.arc(w / 2 + 22, h / 2 - 12, 42, 0, Math.PI * 2)
      c.fill()
    })
    const m = new THREE.Mesh(new THREE.CircleGeometry(0.9, 48), k.mat('#ffffff', { map: t, rough: 1, opacity: 0.999 }))
    k.owned.push(m.geometry)
    m.rotation.x = -Math.PI / 2
    m.position.y = 0.006
    m.receiveShadow = true
    g.add(m)
    return { group: g, lights }
  },

  beanbag(k, p) {
    const { g, lights } = b(k)
    const m = mesh(sphG(0.38, 20, 14), k.mat(p.color ?? '#d8c7a8', { rough: 1 }), 0, 0.2, 0)
    m.scale.set(1, 0.55, 1)
    g.add(m)
    const back = mesh(sphG(0.3, 18, 12), k.mat(p.color ?? '#d8c7a8', { rough: 1 }), 0, 0.34, -0.2)
    back.scale.set(1, 0.7, 0.55)
    g.add(back)
    return { group: g, lights }
  },

  plant(k, p, rnd) {
    const { g, lights } = b(k)
    const pot = p.color2 ?? '#e8e1d6'
    blk(k, g, 0.3, 0.3, 0.3, pot, 0, 0, 0, { rough: 0.8 })
    blk(k, g, 0.27, 0.02, 0.27, '#5a4432', 0, 0.29, 0, { shadow: false })
    const leaf = k.mat(p.color ?? '#4f7d57', { rough: 0.8, side: THREE.DoubleSide })
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + rnd()
      const h = 0.45 + rnd() * 0.45
      const stem = mesh(cylG(0.008, 0.01, h, 5), k.mat('#557a4a'), Math.sin(a) * 0.06, 0.3 + h / 2, Math.cos(a) * 0.06)
      stem.rotation.set(Math.cos(a) * 0.35, 0, -Math.sin(a) * 0.35)
      g.add(stem)
      const lf = mesh(sphG(0.13, 10, 6), leaf, Math.sin(a) * (0.08 + h * 0.35), 0.3 + h, Math.cos(a) * (0.08 + h * 0.35))
      lf.scale.set(1, 0.15, 0.62)
      lf.rotation.set(0.4 * Math.cos(a), a, 0.4)
      g.add(lf)
    }
    return { group: g, lights }
  },

  lamp(k, p) {
    const { g, lights } = b(k)
    blk(k, g, 0.26, 0.03, 0.26, '#2f3542', 0, 0, 0, { metal: 0.3, rough: 0.5 })
    g.add(mesh(cylG(0.012, 0.012, 1.4, 8), k.mat('#2f3542', { metal: 0.4, rough: 0.4 }), 0, 0.72, 0))
    const sh = mesh(cylG(0.13, 0.2, 0.26, 20, ), k.mat(p.color ?? '#f2e6cf', { emissive: '#ffcf8a', glow: k.night ? 1.2 : 0.04, rough: 1, side: THREE.DoubleSide }), 0, 1.5, 0)
    g.add(sh)
    lights.push({ at: new THREE.Vector3(0, 1.4, 0), color: '#ffcb82', intensity: 2.6, distance: 3.4 })
    return { group: g, lights }
  },

  poster(k, p) {
    const { g, lights } = b(k)
    const kind = p.variant ?? 'starmap'
    const t = k.tex(256, 340, (c, w, h) => {
      const r = seeded(hashStr(kind))
      if (kind === 'planet') {
        c.fillStyle = '#1b2448'
        c.fillRect(0, 0, w, h)
        starField(c, w, h, r, 120, 1.4)
        const grd = c.createRadialGradient(w * 0.4, h * 0.45, 10, w / 2, h / 2, 90)
        grd.addColorStop(0, '#f6d7a8')
        grd.addColorStop(1, '#b0683d')
        c.fillStyle = grd
        c.beginPath()
        c.arc(w / 2, h / 2, 80, 0, Math.PI * 2)
        c.fill()
        c.strokeStyle = '#e8cf95'
        c.lineWidth = 5
        c.beginPath()
        c.ellipse(w / 2, h / 2, 125, 28, -0.3, 0, Math.PI * 2)
        c.stroke()
      } else {
        // 星图:深蓝底 + 星座连线 + 坐标网格(他背过整张星图)
        c.fillStyle = '#16204a'
        c.fillRect(0, 0, w, h)
        c.strokeStyle = 'rgba(200,210,255,0.18)'
        c.lineWidth = 1
        c.beginPath()
        c.arc(w / 2, h / 2, 110, 0, Math.PI * 2)
        c.arc(w / 2, h / 2, 70, 0, Math.PI * 2)
        c.stroke()
        for (let i = 0; i < 12; i++) {
          c.beginPath()
          c.moveTo(w / 2, h / 2)
          c.lineTo(w / 2 + Math.cos((i * Math.PI) / 6) * 120, h / 2 + Math.sin((i * Math.PI) / 6) * 120)
          c.stroke()
        }
        starField(c, w, h, r, 90, 1.3)
        c.strokeStyle = 'rgba(255,236,180,0.8)'
        c.fillStyle = '#fff3c4'
        c.lineWidth = 1.5
        for (let s = 0; s < 4; s++) {
          const cx = 40 + r() * (w - 80)
          const cy = 50 + r() * (h - 100)
          const pts = Array.from({ length: 4 + Math.floor(r() * 3) }, () => [cx + (r() - 0.5) * 90, cy + (r() - 0.5) * 90])
          c.beginPath()
          pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)))
          c.stroke()
          for (const [x, y] of pts) fourStar(c, x, y, 5, '#fff3c4')
        }
        c.fillStyle = '#e8d9a6'
        c.font = 'bold 18px Georgia, serif'
        c.textAlign = 'center'
        c.fillText('STAR MAP', w / 2, h - 18)
      }
    })
    const W = 0.56 * p.scale
    const H = 0.74 * p.scale
    blk(k, g, W + 0.05, H + 0.05, 0.025, p.color ?? '#2a2622', 0, -H / 2 - 0.025, 0.0125, { shadow: false })
    const pic = mesh(new THREE.PlaneGeometry(W, H), k.mat('#ffffff', { map: t, rough: 0.9 }), 0, 0, 0.027, { shadow: false })
    k.owned.push(pic.geometry)
    g.add(pic)
    return { group: g, lights }
  },

  photos(k, p, rnd) {
    const { g, lights } = b(k)
    // 一根绳 + 夹着的照片(他在二手相机店的暗房里洗的:日出、海、鸟、花海)
    const n = 5
    const span = 1.1 * p.scale
    const cord = new THREE.CatmullRomCurve3([new THREE.Vector3(-span / 2, 0, 0.01), new THREE.Vector3(0, -0.07, 0.01), new THREE.Vector3(span / 2, 0, 0.01)])
    const cm = new THREE.Mesh(new THREE.TubeGeometry(cord, 20, 0.004, 4), k.mat('#8a7a66'))
    k.owned.push(cm.geometry)
    g.add(cm)
    const scenes = ['sunrise', 'sea', 'bird', 'flowers', 'night', 'sunrise']
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n
      const x = -span / 2 + u * span
      const y = -0.07 * Math.sin(u * Math.PI) - 0.01
      const kind = scenes[i % scenes.length]
      const t = k.tex(96, 112, (c, w, h) => {
        c.fillStyle = '#fbfaf6'
        c.fillRect(0, 0, w, h)
        const grd = c.createLinearGradient(0, 8, 0, 84)
        const [a, bb] = kind === 'sunrise' ? ['#f7b27a', '#fbe3b4'] : kind === 'sea' ? ['#7fb2d8', '#2f6a93'] : kind === 'night' ? ['#1b2448', '#3c4d86'] : kind === 'flowers' ? ['#bcd6f0', '#c7a6de'] : ['#cfe3f2', '#9cc6a0']
        grd.addColorStop(0, a)
        grd.addColorStop(1, bb)
        c.fillStyle = grd
        c.fillRect(8, 8, w - 16, 76)
        if (kind === 'sunrise') {
          c.fillStyle = '#fff1cf'
          c.beginPath()
          c.arc(w / 2, 64, 14, Math.PI, 0)
          c.fill()
        } else if (kind === 'bird') {
          c.fillStyle = '#fff'
          c.beginPath()
          c.arc(w / 2, 52, 13, 0, Math.PI * 2)
          c.fill()
          c.fillStyle = '#e8a33c'
          c.fillRect(w / 2 + 11, 50, 6, 3)
        } else if (kind === 'flowers') {
          for (let j = 0; j < 30; j++) {
            c.fillStyle = ['#8f6cc9', '#b58fe0', '#6f8fd8'][j % 3]
            c.fillRect(10 + rnd() * (w - 20), 50 + rnd() * 32, 3, 3)
          }
        } else if (kind === 'night') starField(c, w, 84, rnd, 30, 1)
      })
      const ph = mesh(new THREE.PlaneGeometry(0.15 * p.scale, 0.175 * p.scale), k.mat('#ffffff', { map: t, rough: 0.8 }), x, y - 0.09 * p.scale, 0.012, { shadow: false })
      k.owned.push(ph.geometry)
      ph.rotation.z = (rnd() - 0.5) * 0.18
      g.add(ph)
      blk(k, g, 0.015, 0.03, 0.01, '#c9a45c', x, y - 0.02, 0.016, { shadow: false })
    }
    return { group: g, lights }
  },

  scroll(k, p) {
    const { g, lights } = b(k)
    const text = (p.text ?? '星河').slice(0, 4)
    const t = k.tex(128, 360, (c, w, h) => {
      c.fillStyle = '#f3ead7'
      c.fillRect(0, 0, w, h)
      c.fillStyle = '#c7b28a'
      c.fillRect(0, 0, w, 16)
      c.fillRect(0, h - 16, w, 16)
      c.fillStyle = '#1d1a18'
      c.font = `${Math.min(92, 260 / text.length)}px "STKaiti", "Kaiti SC", "KaiTi", "BiauKai", serif`
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      const step = (h - 70) / text.length
      ;[...text].forEach((ch, i) => c.fillText(ch, w / 2, 40 + step * (i + 0.5)))
      c.fillStyle = '#b3342d'
      c.fillRect(w / 2 + 18, h - 60, 16, 16)
    })
    const W = 0.34 * p.scale
    const H = 0.96 * p.scale
    const pic = mesh(new THREE.PlaneGeometry(W, H), k.mat('#ffffff', { map: t, rough: 1 }), 0, -H / 2, 0.012, { shadow: false })
    k.owned.push(pic.geometry)
    g.add(pic)
    for (const y of [0, -H]) {
      const rod = mesh(cylG(0.012, 0.012, W + 0.06, 8), k.mat(WOOD_DARK), 0, y, 0.02)
      rod.rotation.z = Math.PI / 2
      g.add(rod)
    }
    return { group: g, lights }
  },

  sword(k, p) {
    const { g, lights } = b(k)
    // 墙上的剑架与他的剑:银色剑身,刃口有一道淡蓝的光(光系 Evol)
    const L = 0.95 * p.scale
    for (const x of [-0.28, 0.28]) blk(k, g, 0.05, 0.06, 0.07, WOOD_DARK, x * p.scale, -0.06, 0.035)
    const blade = mesh(boxG(L * 0.72, 0.035, 0.008), k.mat('#e7edf6', { metal: 0.85, rough: 0.2 }), 0.08 * p.scale, 0, 0.08)
    g.add(blade)
    const edge = mesh(boxG(L * 0.7, 0.006, 0.01), k.mat('#bfe3ff', { emissive: '#8fd0ff', glow: k.night ? 2.2 : 0.6 }), 0.08 * p.scale, 0.016, 0.08, { shadow: false })
    g.add(edge)
    const guard = mesh(boxG(0.02, 0.12, 0.03), k.mat('#c9a45c', { metal: 0.7, rough: 0.3 }), -L * 0.3, 0, 0.08)
    g.add(guard)
    const grip = mesh(cylG(0.013, 0.013, L * 0.22, 8), k.mat('#23283a', { rough: 0.6 }), -L * 0.42, 0, 0.08)
    grip.rotation.z = Math.PI / 2
    g.add(grip)
    const gem = mesh(sphG(0.018, 10, 8), k.mat('#6fb8ff', { emissive: '#6fb8ff', glow: 1.5 }), -L * 0.54, 0, 0.08)
    g.add(gem)
    return { group: g, lights }
  },

  clock(k, p) {
    const { g, lights } = b(k)
    const R = 0.17 * p.scale
    const face = mesh(cylG(R, R, 0.03, 32), k.mat(p.color ?? '#f7f3ea', { rough: 0.6 }), 0, 0, 0.015, { shadow: false })
    face.rotation.x = Math.PI / 2
    g.add(face)
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 0.012, 6, 32), k.mat('#c9a45c', { metal: 0.6, rough: 0.35 }))
    rim.position.z = 0.03
    k.owned.push(rim.geometry)
    g.add(rim)
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2
      g.add(mesh(boxG(0.012, i % 3 ? 0.02 : 0.035, 0.005), k.mat('#2a2622'), Math.sin(a) * R * 0.82, Math.cos(a) * R * 0.82, 0.033, { shadow: false }).rotateZ(-a))
    }
    const hand = (len: number, w: number): THREE.Object3D => {
      const piv = new THREE.Group()
      piv.position.z = 0.038
      piv.add(mesh(boxG(w, len, 0.004), k.mat('#2a2622'), 0, len / 2 - 0.01, 0, { shadow: false }))
      g.add(piv)
      return piv
    }
    const hh = hand(R * 0.5, 0.014)
    const mh = hand(R * 0.78, 0.009)
    const tick = (): void => {
      const d = new Date()
      const m = d.getMinutes() + d.getSeconds() / 60
      mh.rotation.z = -(m / 60) * Math.PI * 2
      hh.rotation.z = -(((d.getHours() % 12) + m / 60) / 12) * Math.PI * 2
    }
    tick()
    let acc = 0
    return {
      group: g, lights,
      tick(_t, dt) {
        acc += dt
        if (acc > 5) {
          acc = 0
          tick()
        }
      },
    }
  },

  lights(k, p) {
    const { g, lights } = b(k)
    // 一串小灯:沿局部 X 垂成两段弧
    const span = 1.8 * p.scale
    const bulbs = 16
    const pts: THREE.Vector3[] = []
    for (let i = 0; i <= bulbs; i++) {
      const u = i / bulbs
      pts.push(new THREE.Vector3(-span / 2 + u * span, -Math.abs(Math.sin(u * Math.PI * 2)) * 0.12, 0.02))
    }
    const cord = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 0.003, 4), k.mat('#6b6255'))
    k.owned.push(cord.geometry)
    g.add(cord)
    const on = k.mat('#fff2c8', { emissive: p.color ?? '#ffd98f', glow: k.night ? 2.4 : 0.3 })
    for (let i = 1; i < bulbs; i++) g.add(mesh(sphG(0.016, 8, 6), on, pts[i].x, pts[i].y - 0.015, 0.025, { shadow: false }))
    return { group: g, lights }
  },

  rod(k, p) {
    const { g, lights } = b(k)
    // 鱼竿斜靠在墙角,旁边一个钓具箱
    const L = 1.9 * p.scale
    const rod = mesh(cylG(0.006, 0.014, L, 6), k.mat('#3c3a36', { rough: 0.5 }), 0, L / 2 * Math.cos(0.22), -L / 2 * Math.sin(0.22))
    rod.rotation.x = -0.22
    g.add(rod)
    const reel = mesh(cylG(0.035, 0.035, 0.03, 12), k.mat('#b8bcc4', { metal: 0.7, rough: 0.3 }), 0.03, 0.35, -0.08)
    reel.rotation.z = Math.PI / 2
    g.add(reel)
    blk(k, g, 0.34, 0.16, 0.2, p.color ?? '#4f7d74', 0.25, 0, 0.05, { rough: 0.6 })
    blk(k, g, 0.12, 0.02, 0.03, '#2c3a3a', 0.25, 0.16, 0.05)
    return { group: g, lights }
  },

  plush(k, p) {
    const { g, lights } = b(k)
    const kind = p.variant ?? 'bunny'
    const c = p.color ?? (kind === 'bunny' ? '#f6f3ee' : kind === 'cat' ? '#e9c89a' : kind === 'bear' ? '#b8875e' : '#f2d27a')
    const m = k.mat(c, { rough: 1 })
    const s = p.scale
    if (kind === 'star') {
      const shape = new THREE.Shape()
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2
        const r = (i % 2 ? 0.05 : 0.12) * s
        if (i) shape.lineTo(Math.sin(a) * r, Math.cos(a) * r)
        else shape.moveTo(Math.sin(a) * r, Math.cos(a) * r)
      }
      const st = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.06 * s, bevelEnabled: true, bevelSize: 0.015 * s, bevelThickness: 0.015 * s, bevelSegments: 2 }), m)
      k.owned.push(st.geometry)
      st.position.y = 0.13 * s
      st.castShadow = true
      g.add(st)
      return { group: g, lights }
    }
    const body = mesh(sphG(0.1 * s, 14, 10), m, 0, 0.1 * s, 0)
    body.scale.set(1, 0.95, 0.85)
    g.add(body)
    const head = mesh(sphG(0.085 * s, 14, 10), m, 0, 0.24 * s, 0.01 * s)
    g.add(head)
    const ear = (x: number): void => {
      if (kind === 'bunny') {
        const e = mesh(sphG(0.03 * s, 8, 6), m, x * s, 0.36 * s, 0)
        e.scale.set(0.8, 2.6, 0.6)
        e.rotation.z = -x * 3
        g.add(e)
      } else if (kind === 'cat') {
        const e = mesh(cylG(0, 0.03 * s, 0.05 * s, 4), m, x * s, 0.32 * s, 0)
        g.add(e)
      } else g.add(mesh(sphG(0.028 * s, 8, 6), m, x * s, 0.31 * s, 0))
    }
    ear(-0.045)
    ear(0.045)
    const eyeM = k.mat('#2a2622', { rough: 0.4 })
    for (const x of [-0.03, 0.03]) g.add(mesh(sphG(0.009 * s, 6, 4), eyeM, x * s, 0.25 * s, 0.08 * s, { shadow: false }))
    return { group: g, lights }
  },

  bird(k, p, rnd) {
    const { g, lights } = b(k)
    // 胖乎乎的小鸟(他给常来串门的鸟起了名字:「小闹钟」「胖球」)
    const c = p.color ?? '#f4f1e8'
    const bodyG = new THREE.Group()
    g.add(bodyG)
    const body = mesh(sphG(0.06, 14, 10), k.mat(c, { rough: 0.9 }), 0, 0.055, 0)
    body.scale.set(1, 0.92, 1.05)
    bodyG.add(body)
    const headG = new THREE.Group()
    headG.position.set(0, 0.1, 0.02)
    bodyG.add(headG)
    headG.add(mesh(sphG(0.04, 12, 8), k.mat(c, { rough: 0.9 })))
    const beak = mesh(cylG(0, 0.012, 0.03, 6), k.mat('#e8a33c'), 0, -0.005, 0.045)
    beak.rotation.x = Math.PI / 2
    headG.add(beak)
    for (const x of [-0.022, 0.022]) headG.add(mesh(sphG(0.007, 6, 4), k.mat('#1c1a18'), x, 0.01, 0.03, { shadow: false }))
    const cheek = k.mat(p.color2 ?? '#f2b8b0')
    for (const x of [-0.03, 0.03]) headG.add(mesh(sphG(0.009, 6, 4), cheek, x, -0.005, 0.025, { shadow: false }))
    for (const x of [-0.055, 0.055]) {
      const wing = mesh(sphG(0.035, 8, 6), k.mat(shade(c, 0.88), { rough: 0.9 }), x, 0.055, -0.005)
      wing.scale.set(0.35, 0.8, 1.1)
      bodyG.add(wing)
    }
    const tail = mesh(boxG(0.04, 0.012, 0.05), k.mat(shade(c, 0.85)), 0, 0.05, -0.07)
    tail.rotation.x = 0.5
    bodyG.add(tail)
    let next = 1 + rnd() * 2
    let act = 0
    let kind = 0
    return {
      group: g, lights,
      tick(t) {
        if (t > next) {
          kind = Math.floor(rnd() * 4)
          act = t
          next = t + 1.2 + rnd() * 3
        }
        const u = Math.min(1, (t - act) / 0.45)
        const bump = Math.sin(u * Math.PI)
        bodyG.position.y = kind === 0 ? bump * 0.04 : 0 // 蹦一下
        headG.rotation.x = kind === 1 ? bump * 0.8 : 0 // 啄一下
        headG.rotation.y = kind === 2 ? Math.sin(t * 3) * 0.6 * (1 - u) + 0.4 * Math.sign(Math.sin(act)) * bump : headG.rotation.y * 0.95
        bodyG.rotation.y = kind === 3 ? (Math.sin(act) > 0 ? 1 : -1) * 0.5 * u : bodyG.rotation.y
        body.scale.y = 0.92 + Math.sin(t * 6) * 0.01
      },
    }
  },

  flowers(k, p, rnd) {
    const { g, lights } = b(k)
    // 星辰花(和她一起种下的那一盆):细茎顶上一簇簇小花
    blk(k, g, 0.14, 0.12, 0.14, p.color2 ?? '#d9cdb8', 0, 0, 0, { rough: 0.8 })
    const cols = [p.color ?? '#8f6cc9', '#b58fe0', '#6f8fd8', '#e3d6f5']
    for (let i = 0; i < 9; i++) {
      const a = rnd() * Math.PI * 2
      const r = rnd() * 0.04
      const h = 0.14 + rnd() * 0.12
      const stem = mesh(cylG(0.003, 0.003, h, 4), k.mat('#6b8a58'), Math.cos(a) * r, 0.12 + h / 2, Math.sin(a) * r, { shadow: false })
      stem.rotation.set((rnd() - 0.5) * 0.4, 0, (rnd() - 0.5) * 0.4)
      g.add(stem)
      for (let j = 0; j < 5; j++) {
        g.add(mesh(sphG(0.012, 6, 4), k.mat(cols[(i + j) % cols.length], { rough: 1 }), Math.cos(a) * r * 1.6 + (rnd() - 0.5) * 0.04, 0.12 + h + (rnd() - 0.5) * 0.03, Math.sin(a) * r * 1.6 + (rnd() - 0.5) * 0.04, { shadow: false }))
      }
    }
    return { group: g, lights }
  },

  radio(k, p) {
    const { g, lights } = b(k)
    // 老收音机(她送的礼物,能收到宇宙里脉冲星的信号)
    const c = p.color ?? '#8d5b3a'
    blk(k, g, 0.3, 0.18, 0.12, c, 0, 0, 0, { rough: 0.5 })
    blk(k, g, 0.14, 0.12, 0.005, '#d9c8a8', -0.06, 0.03, 0.062, { shadow: false })
    const dial = mesh(cylG(0.03, 0.03, 0.01, 16), k.mat('#f6e7b8', { emissive: '#ffcf7a', glow: k.night ? 1.2 : 0.1 }), 0.08, 0.09, 0.062, { shadow: false })
    dial.rotation.x = Math.PI / 2
    g.add(dial)
    const ant = mesh(cylG(0.003, 0.003, 0.3, 4), k.mat('#b8bcc4', { metal: 0.8, rough: 0.3 }), 0.1, 0.3, -0.03)
    ant.rotation.z = -0.5
    g.add(ant)
    return { group: g, lights }
  },

  box(k, p) {
    const { g, lights } = b(k)
    blk(k, g, 0.4 * p.scale, 0.3 * p.scale, 0.4 * p.scale, p.color ?? '#c9b08a', 0, 0, 0)
    return { group: g, lights }
  },
}

/** 书桌上的小物件(二手相机、笔墨、星球仪……)—— 挂在 desk 类型上,用 variant 选:"camera,brush,globe,books,cup"。 */
function deskItems(k: Kit, g: THREE.Group, items: string, rnd: () => number): void {
  const tz = -0.34
  const top = 0.66
  for (const it of items.split(',').map((s) => s.trim())) {
    if (it === 'camera') {
      blk(k, g, 0.13, 0.08, 0.06, '#2b2d33', 0.1, top, tz + 0.08, { rough: 0.4, metal: 0.3 })
      blk(k, g, 0.13, 0.015, 0.06, '#c9ccd2', 0.1, top + 0.08, tz + 0.08, { metal: 0.6, rough: 0.3 })
      const lens = mesh(cylG(0.03, 0.03, 0.05, 16), k.mat('#1a1b1f', { rough: 0.3, metal: 0.5 }), 0.1, top + 0.04, tz + 0.13)
      lens.rotation.x = Math.PI / 2
      g.add(lens)
    } else if (it === 'brush') {
      // 砚台 + 毛笔 + 一张写了字的宣纸
      blk(k, g, 0.12, 0.02, 0.08, '#2a2a2e', -0.1, top, tz + 0.05, { rough: 0.3 })
      const brush = mesh(cylG(0.006, 0.006, 0.2, 6), k.mat(WOOD_DARK), -0.15, top + 0.03, tz + 0.16)
      brush.rotation.z = Math.PI / 2
      brush.rotation.y = 0.4
      g.add(brush)
      const paper = k.tex(128, 96, (c, w, h) => {
        c.fillStyle = '#f5efe1'
        c.fillRect(0, 0, w, h)
        c.fillStyle = '#1d1a18'
        c.font = '56px "STKaiti", "Kaiti SC", "KaiTi", serif'
        c.textAlign = 'center'
        c.textBaseline = 'middle'
        c.fillText('星', w / 2, h / 2)
      })
      const pm = mesh(new THREE.PlaneGeometry(0.26, 0.19), k.mat('#ffffff', { map: paper, rough: 1 }), -0.18, top + 0.002, tz + 0.02, { shadow: false })
      pm.rotation.x = -Math.PI / 2
      pm.rotation.z = 0.12
      k.owned.push(pm.geometry)
      g.add(pm)
    } else if (it === 'globe') {
      blk(k, g, 0.08, 0.02, 0.08, '#c9a45c', 0.3, top, tz - 0.12, { metal: 0.6, rough: 0.3 })
      g.add(mesh(sphG(0.075, 18, 12), k.mat('#6d8fca', { rough: 0.5 }), 0.3, top + 0.11, tz - 0.12))
    } else if (it === 'books') {
      let y = top
      for (let i = 0; i < 3; i++) {
        const h = 0.035 + rnd() * 0.02
        const bk = blk(k, g, 0.2, h, 0.15, ['#3f5d8c', '#c7b28a', '#7a4e5c'][i], -0.35, y, tz + 0.1, { shadow: false })
        bk.rotation.y = (rnd() - 0.5) * 0.3
        y += h
      }
    } else if (it === 'cup') {
      g.add(mesh(cylG(0.035, 0.03, 0.08, 14), k.mat('#e7eef8', { rough: 0.4 }), 0.42, top + 0.04, tz + 0.15))
    }
  }
}

/** 造一个道具,摆到 scene 里写的位置。认不出的类型 → null(parseScene 已经滤过,这里只是兜底)。 */
export function buildProp(k: Kit, p: PropSpec, index: number): BuiltProp | null {
  return withKit(k, () => buildPropIn(k, p, index))
}
function buildPropIn(k: Kit, p: PropSpec, index: number): BuiltProp | null {
  const make = Object.hasOwn(BUILDERS, p.type) ? BUILDERS[p.type] : undefined
  if (!make) return null
  const rnd = seeded(hashStr(`${p.type}:${p.id ?? index}`))
  const built = make(k, p, rnd)
  if (p.type === 'desk' && p.variant) deskItems(k, built.group, p.variant, rnd)
  const g = built.group
  g.name = `prop:${p.id ?? p.type}`
  g.position.set(p.at[0], p.y, p.at[1])
  g.rotation.y = p.rot * DEG
  if (!['poster', 'photos', 'scroll', 'sword', 'clock', 'lights', 'plush'].includes(p.type)) g.scale.setScalar(p.scale)
  return built
}

/** 场景外的背景:夜里深蓝 + 星星,白天淡淡的晨光渐变。 */
export function backgroundTexture(k: Kit, night: boolean, sky: string): THREE.Texture {
  return k.tex(512, 512, (g, w, h) => {
    const grd = g.createRadialGradient(w * 0.5, h * 0.45, 20, w * 0.5, h * 0.5, w * 0.75)
    if (night) {
      grd.addColorStop(0, shade(sky, 1.9))
      grd.addColorStop(0.55, sky)
      grd.addColorStop(1, shade(sky, 0.45))
    } else {
      grd.addColorStop(0, '#fbf3e6')
      grd.addColorStop(0.6, '#e9eef6')
      grd.addColorStop(1, '#c9d6ea')
    }
    g.fillStyle = grd
    g.fillRect(0, 0, w, h)
    if (night) starField(g, w, h, seeded(21), 140, 1.4, 0.8)
  })
}
