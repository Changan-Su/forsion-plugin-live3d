// 角色在房间里的「日常」:走过去 → 转身 → 坐下 / 躺下 → 做这件事 → 起身 → 按权重抽下一件。纯逻辑(无 three / DOM),
// 每帧 update(dt) 出一份 BrainFrame(站在哪、朝哪、走路权重、坐 / 躺到几成、当前姿势),由 animator 变成骨骼。
//
// Agent 阶段插队:thinking / tool / speaking / waiting / error / done 各映射一个活动(scene.agent);阶段变了就打断当前
// 活动过去做那件事,阶段回 idle 后接着过日子。**同一个地方换姿势不重走**(思考 ↔ 调工具都在书桌,只换手上的动作),
// 否则 agent 一秒切三次阶段,角色就在屋里来回跑。
//
// 「here」活动(说话、叹气、被戳醒)原地做:不挪位置、不换站法 —— 躺着被叫醒就躺着皱眉,坐着说话就转头看镜头。

import type { Phase } from '../contract'
import type { ActivitySpec, EmoteName, PoseName, ResolvedScene, Stance } from './scene'
import { AGENT_ACTIVITIES, PROP_INFO, activityById, stanceOf } from './scene'
import { findPath, isFree, nearestFree, type NavGrid, type Pt } from './nav'

export interface Place {
  /** 形象根(双脚 / 坐下时的臀部 / 躺下时身体中点)落在哪。 */
  x: number
  z: number
  /** 朝向(弧度,0 = +Z)。躺姿 = 从脚指向头的方向(身体偏航 = face + π,见 bodyYaw)。 */
  face: number
  /** 座面 / 床面高度。 */
  y: number
  /** 先走到这里,再「进入」锚点(坐下 / 躺下)。 */
  approach: Pt
  /** 看向哪(窗外、望远镜目镜……);省略 = 看镜头 / 随意。 */
  look?: [number, number, number]
  /** 同一个锚点的身份(换姿势不重走的判据)。 */
  key: string
}

export type BrainMode = 'exit' | 'walk' | 'turn' | 'enter' | 'do'

export interface BrainFrame {
  x: number
  z: number
  yaw: number
  /** 走路循环的权重 0..1 与当前速度(米 / 秒)。 */
  walk: number
  speed: number
  stance: Stance
  /** 进入站法的程度 0..1(坐下 / 躺下到几成)。 */
  settle: number
  seatY: number
  pose: PoseName
  /** 这个姿势做了多久(秒)。 */
  poseT: number
  activity: ActivitySpec | null
  emote: EmoteName | null
  look: [number, number, number] | null
  mode: BrainMode
}

export interface BrainDeps {
  scene: ResolvedScene
  grid: NavGrid
  /** 镜头在地板上的投影(「front」站位 / 转向观众用)。 */
  camera(): Pt
  night(): boolean
  rng?: () => number
}

export interface Brain {
  update(dt: number): BrainFrame
  frame(): BrainFrame
  /** Agent 阶段变了。 */
  setPhase(phase: Phase): void
  /** 用户点了角色一下。 */
  poke(): void
  /** 直接指定下一件事(工作室「试一下」/ 台架)。null = 回到随机日常。 */
  force(activityId: string | null): void
  /** 当前正在做的活动 id(台架读)。 */
  current(): string | null
}

const WALK_SPEED = 0.55
const TURN_RATE = 5.5
const ENTER_TIME: Record<Stance, number> = { stand: 0.35, sit: 0.75, lie: 1.25 }
const EXIT_TIME: Record<Stance, number> = { stand: 0.2, sit: 0.6, lie: 1.1 }
/** 睡着一类的姿势:被戳 = 叫醒(皱眉 + 气),而不是打招呼。 */
const ASLEEP: ReadonlySet<PoseName> = new Set<PoseName>(['sleep', 'sit-doze', 'desk-sleep', 'nod-off', 'sunbathe'])
/** 冲着你做的姿势:站着整个人转过来,坐着在椅子上转过来一半(躺着不转)。 */
const TO_CAMERA: ReadonlySet<PoseName> = new Set<PoseName>(['talk', 'wave', 'cheer'])

/** 内置的「被戳」反应(不参与抽签;场景里同名活动优先)。 */
const POKE_ACTIVITIES: ActivitySpec[] = [
  { id: '@poke', at: 'here', pose: 'wave', time: [2.2, 2.8], weight: 0, emote: 'heart', chained: true },
  { id: '@woken', at: 'here', pose: 'sigh', time: [2.2, 2.8], weight: 0, emote: 'anger', chained: true, then: '@yawn' },
  { id: '@yawn', at: 'here', pose: 'yawn', time: [2.4, 3], weight: 0, chained: true },
]

/** 在这个锚点上身体该转到的偏航。躺下时身体绕 X 往后倒 90°:头(局部 +Y)落到局部 -Z,所以「头朝 face」= 偏航 face + π。 */
export const bodyYaw = (face: number, stance: Stance): number => (stance === 'lie' ? face + Math.PI : face)

const wrapAngle = (a: number): number => {
  let x = (a + Math.PI) % (2 * Math.PI)
  if (x < 0) x += 2 * Math.PI
  return x - Math.PI
}
const DEG = Math.PI / 180

/** 道具局部点 → 世界(与 three 的 rotation.y 同号)。 */
export function propToWorld(prop: { at: [number, number]; rot: number; scale: number }, lx: number, lz: number): Pt {
  const r = prop.rot * DEG
  const c = Math.cos(r)
  const s = Math.sin(r)
  const x = lx * prop.scale
  const z = lz * prop.scale
  return [prop.at[0] + x * c + z * s, prop.at[1] - x * s + z * c]
}

export function createBrain(deps: BrainDeps): Brain {
  const { scene, grid } = deps
  const rng = deps.rng ?? Math.random
  const W = scene.room.width
  const D = scene.room.depth

  const lookup = (id: string | undefined): ActivitySpec | null =>
    activityById(scene, id) ?? (id ? POKE_ACTIVITIES.find((a) => a.id === id) ?? null : null)

  /** 活动的「在哪」→ 具体站位;道具不存在 → null(这个活动在本场景里做不了)。 */
  function resolve(at: string, from: BrainFrame): Place | null {
    if (at === 'here') return { x: from.x, z: from.z, face: from.yaw, y: from.seatY, approach: [from.x, from.z], key: cur?.place.key ?? 'here' }
    if (at === 'front') {
      const [cx, cz] = deps.camera()
      const p = nearestFree(grid, [W * 0.18, D * 0.18]) ?? [0, 0]
      return { x: p[0], z: p[1], face: Math.atan2(cx - p[0], cz - p[1]), y: 0, approach: p, key: 'front' }
    }
    if (at === 'center') {
      // 在屋子中间一块随便挑个空地站着(每次不同,看起来像在踱步)
      for (let k = 0; k < 12; k++) {
        const p: Pt = [(rng() - 0.5) * W * 0.6, (rng() - 0.5) * D * 0.6]
        if (isFree(grid, p)) {
          const [cx, cz] = deps.camera()
          return { x: p[0], z: p[1], face: Math.atan2(cx - p[0], cz - p[1]) + (rng() - 0.5) * 1.2, y: 0, approach: p, key: `center:${k}` }
        }
      }
      const p = nearestFree(grid, [0, 0]) ?? [0, 0]
      return { x: p[0], z: p[1], face: 0, y: 0, approach: p, key: 'center' }
    }
    if (at === 'window' || at.startsWith('window.')) {
      const i = at === 'window' ? 0 : Number(at.slice(7))
      const w = scene.room.windows[i]
      if (!w) return null
      // 左墙窗:墙在 x = -W/2,沿 +Z;右墙窗:墙在 z = -D/2,沿 +X
      const along = w.wall === 'left' ? -D / 2 + w.at * D : -W / 2 + w.at * W
      const wx = w.wall === 'left' ? -W / 2 : along
      const wz = w.wall === 'left' ? along : -D / 2
      const nxv = w.wall === 'left' ? 1 : 0
      const nzv = w.wall === 'left' ? 0 : 1
      const stand = nearestFree(grid, [wx + nxv * 0.55, wz + nzv * 0.55]) ?? [0, 0]
      return {
        x: stand[0], z: stand[1], face: Math.atan2(-nxv, -nzv), y: 0, approach: stand, key: `window:${i}`,
        look: [wx - nxv * 2, w.sill + w.height * 0.9 + 1.2, wz - nzv * 2],
      }
    }
    const [pid, aname] = at.split('.', 2)
    const prop = scene.props.find((p) => p.id === pid)
    if (!prop) return null
    const info = PROP_INFO[prop.type] // 类型在 parseScene 里用 hasOwn 核过
    const key = aname ?? info?.main ?? ''
    // 锚点名来自用户写的 at("bed.__proto__"),同样只认自有键
    const a = info && Object.hasOwn(info.anchors, key) ? info.anchors[key] : aname ? null : Object.values(info?.anchors ?? {})[0]
    if (!a) return null
    let [x, z] = propToWorld(prop, a.x, a.z)
    // 站着的锚点(没有座面高度)被别的家具占住了 → 挪到最近的空地(看墙上的剑,剑下面偏偏摆着钢琴)
    if (a.y === undefined && !isFree(grid, [x, z])) [x, z] = nearestFree(grid, [x, z]) ?? [x, z]
    const ap = a.approach ? propToWorld(prop, a.approach[0], a.approach[1]) : propToWorld(prop, a.x + Math.sin(a.face * DEG) * 0.45, a.z + Math.cos(a.face * DEG) * 0.45)
    const approach = nearestFree(grid, ap) ?? ap
    const face = (a.face + prop.rot) * DEG
    const look: [number, number, number] | undefined =
      prop.type === 'telescope' ? [x + Math.sin(face) * 3, 3.2, z + Math.cos(face) * 3] : undefined
    return { x, z, face, y: (a.y ?? 0) * prop.scale + (prop.type === 'rug' ? 0 : 0), approach, look, key: `${pid}.${aname ?? info.main ?? ''}` }
  }

  // ── 状态 ───────────────────────────────────────────────────────────────────
  const start = nearestFree(grid, [W * 0.1, D * 0.1]) ?? [0, 0]
  const fr: BrainFrame = {
    x: start[0], z: start[1], yaw: Math.PI / 4, walk: 0, speed: 0, stance: 'stand', settle: 0, seatY: 0,
    pose: 'stand', poseT: 0, activity: null, emote: null, look: null, mode: 'do',
  }
  let cur: { act: ActivitySpec; place: Place } | null = null
  let next: { act: ActivitySpec; place: Place } | null = null
  let path: Pt[] = []
  let modeT = 0
  let doUntil = 2 // 开场先站两秒,别一出来就跑
  let lastId: string | null = null
  let phase: Phase = 'idle'
  /** 此刻被 agent 阶段钉住的活动(阶段没变就一直做)。 */
  let pinned: string | null = null
  let forced: string | null = null
  /** 坐下 / 起身过渡中途来的活动:过渡做完再处理(半坐半站时换动作会穿帮)。 */
  let queued: ActivitySpec | null = null
  /** 阶段已回 idle、但还在路上 / 正坐下的那个 agent 活动:到了也只做一下就走(别按整段时长做完)。 */
  let stale: string | null = null
  /** 进入 / 起身过渡的起止点。 */
  let from = { x: 0, z: 0, yaw: 0, y: 0 }

  const inWindow = (a: ActivitySpec): boolean => !a.when || (a.when === 'night') === deps.night()

  function pickRandom(): ActivitySpec | null {
    const pool = scene.activities.filter((a) => !a.chained && a.weight > 0 && inWindow(a) && a.id !== lastId && resolve(a.at, fr))
    const all = pool.length ? pool : scene.activities.filter((a) => !a.chained && a.weight > 0 && inWindow(a) && resolve(a.at, fr))
    let sum = 0
    for (const a of all) sum += a.weight
    let r = rng() * sum
    for (const a of all) {
      r -= a.weight
      if (r <= 0) return a
    }
    return all[all.length - 1] ?? null
  }

  /** 安排去做 act。同一锚点、同一站法 → 原地换姿势。 */
  function goTo(act: ActivitySpec): void {
    if (fr.mode === 'exit' || fr.mode === 'enter') {
      queued = act
      return
    }
    if (act.at === 'here' && !cur) {
      // 走在路上被叫住:原地站定做
      path = []
      next = null
      fr.stance = 'stand'
      fr.settle = 0
      return begin({ act, place: resolve('here', fr)! })
    }
    const place = resolve(act.at, fr)
    if (!place) {
      // 这个场景里没有这个地方(没有书桌却要去书桌工作)→ 原地做
      const here = resolve('here', fr)!
      return begin({ act: { ...act, at: 'here' }, place: here })
    }
    const stance = act.at === 'here' ? fr.stance : stanceOf(act.pose)
    if (cur && (act.at === 'here' || (place.key === cur.place.key && stance === fr.stance && fr.mode === 'do'))) {
      // 原地换动作:不起身、不走路
      cur = { act, place: act.at === 'here' ? cur.place : place }
      fr.activity = act
      fr.pose = act.pose
      fr.poseT = 0
      fr.emote = act.emote ?? null
      fr.look = cur.place.look ?? null
      fr.mode = 'do'
      doUntil = duration(act)
      lastId = act.id
      return
    }
    next = { act, place }
    if (fr.stance !== 'stand' && fr.settle > 0) {
      // 先起身:从锚点退回它的 approach
      fr.mode = 'exit'
      modeT = 0
      from = { x: fr.x, z: fr.z, yaw: fr.yaw, y: fr.seatY }
      fr.emote = null
      return
    }
    planWalk()
  }

  function planWalk(): void {
    if (!next) return
    cur = null // 迈步即结束旧活动:路上被叫住做「here」要按当前位置来,别挂在旧锚点上
    const p = findPath(grid, [fr.x, fr.z], next.place.approach) ?? [[fr.x, fr.z], next.place.approach]
    path = p.slice(1)
    fr.mode = 'walk'
    fr.pose = 'stand'
    fr.stance = 'stand'
    fr.settle = 0
    fr.emote = null
    fr.look = null
    fr.activity = next.act
  }

  function begin(n: { act: ActivitySpec; place: Place }): void {
    cur = n
    next = null
    lastId = n.act.id
    fr.activity = n.act
    fr.pose = n.act.pose
    fr.poseT = 0
    fr.stance = n.act.at === 'here' ? fr.stance : stanceOf(n.act.pose)
    fr.emote = n.act.emote ?? null
    fr.look = n.place.look ?? null
    fr.mode = 'do'
    doUntil = duration(n.act)
    if (stale && n.act.id === stale) {
      stale = null
      doUntil = Math.min(doUntil, 1.2)
    }
    flushQueued()
  }

  function flushQueued(): void {
    const q = queued
    if (!q) return
    queued = null
    goTo(q)
  }

  const duration = (a: ActivitySpec): number => a.time[0] + (a.time[1] - a.time[0]) * rng()

  function finishActivity(): void {
    const act = cur?.act
    if (pinned && act?.id === pinned) {
      doUntil = 0.5 // 阶段还没变:接着做(每半秒复查一次)
      return
    }
    // 优先级:then 链 > 仍钉着的 agent 活动(被戳一下、叹口气之后回去接着干)> 指定 > 随机日常。
    // then 链优先于「指定」:指定去睡觉,也该睡醒伸完懒腰再回去睡(被吵醒 → 打哈欠同理)
    const chained = lookup(act?.then)
    const back = pinned ? lookup(pinned) : null
    const f = forced ? lookup(forced) : null
    const n = chained ?? back ?? f ?? pickRandom()
    if (n) goTo(n)
    else doUntil = 3
  }

  const ease = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))

  function update(dt: number): BrainFrame {
    fr.poseT += dt
    switch (fr.mode) {
      case 'do': {
        doUntil -= dt
        if (cur) {
          // 身体朝向:锚点的朝向;冲着你做的姿势转向镜头(坐着转一半)
          const base = bodyYaw(cur.place.face, fr.stance)
          let want = base
          if (TO_CAMERA.has(fr.pose) && fr.stance !== 'lie') {
            const [cx, cz] = deps.camera()
            want = base + wrapAngle(Math.atan2(cx - fr.x, cz - fr.z) - base) * (fr.stance === 'stand' ? 1 : 0.55)
          }
          fr.yaw += wrapAngle(want - fr.yaw) * (1 - Math.exp(-4 * dt))
        }
        if (doUntil <= 0) finishActivity()
        break
      }
      case 'exit': {
        const T = EXIT_TIME[fr.stance]
        modeT += dt
        const k = ease(modeT / T)
        const back = cur?.place.approach ?? [from.x, from.z]
        fr.settle = 1 - k
        fr.x = from.x + (back[0] - from.x) * k
        fr.z = from.z + (back[1] - from.z) * k
        fr.seatY = from.y
        if (modeT >= T) {
          fr.settle = 0
          fr.stance = 'stand'
          fr.seatY = 0
          cur = null
          if (next) planWalk()
          else {
            // 起身途中目标被撤掉了(阶段回 idle):站定,下一帧重新挑事做 —— 别卡在 exit 里
            fr.mode = 'do'
            doUntil = 0
          }
          flushQueued()
        }
        break
      }
      case 'walk': {
        const target = path[0]
        if (!target) {
          fr.mode = 'turn'
          modeT = 0
          break
        }
        const dx = target[0] - fr.x
        const dz = target[1] - fr.z
        const dist = Math.hypot(dx, dz)
        const want = Math.atan2(dx, dz)
        const dy = wrapAngle(want - fr.yaw)
        fr.yaw += Math.sign(dy) * Math.min(Math.abs(dy), TURN_RATE * dt)
        // 转身转到大致对准才迈步(原地转大弯时不滑步)
        const align = Math.max(0, Math.cos(dy))
        const step = WALK_SPEED * dt * align * align
        fr.walk = Math.min(1, fr.walk + dt * 5)
        fr.speed = WALK_SPEED * align
        if (dist <= step || dist < 0.02) {
          fr.x = target[0]
          fr.z = target[1]
          path.shift()
        } else {
          fr.x += (dx / dist) * step
          fr.z += (dz / dist) * step
        }
        break
      }
      case 'turn': {
        fr.walk = Math.max(0, fr.walk - dt * 4)
        fr.speed = 0
        const n = next
        if (!n) {
          fr.mode = 'do'
          break
        }
        const stance = stanceOf(n.act.pose)
        // 坐:背对座位转身(转到坐下后面朝的方向);躺:转到躺平后的偏航,然后往后倒上床
        const want = bodyYaw(n.place.face, stance)
        const dy = wrapAngle(want - fr.yaw)
        fr.yaw += Math.sign(dy) * Math.min(Math.abs(dy), TURN_RATE * 0.8 * dt)
        if (Math.abs(dy) < 0.05 && fr.walk <= 0.05) {
          fr.walk = 0
          fr.mode = 'enter'
          modeT = 0
          from = { x: fr.x, z: fr.z, yaw: fr.yaw, y: 0 }
          fr.stance = stance
          fr.pose = n.act.pose
          fr.poseT = 0
          fr.seatY = n.place.y
        }
        break
      }
      case 'enter': {
        const n = next
        if (!n) {
          fr.mode = 'do'
          break
        }
        const T = ENTER_TIME[fr.stance]
        modeT += dt
        const k = ease(modeT / T)
        fr.settle = fr.stance === 'stand' ? 0 : k
        fr.x = from.x + (n.place.x - from.x) * k
        fr.z = from.z + (n.place.z - from.z) * k
        fr.yaw = from.yaw + wrapAngle(bodyYaw(n.place.face, fr.stance) - from.yaw) * k
        if (modeT >= T) {
          fr.settle = fr.stance === 'stand' ? 0 : 1
          begin(n)
        }
        break
      }
    }
    if (fr.mode !== 'walk') {
      fr.walk = Math.max(0, fr.walk - dt * 4)
      if (fr.mode !== 'turn') fr.speed = 0
    }
    return fr
  }

  return {
    update,
    frame: () => fr,
    setPhase(p) {
      if (p === phase) return
      phase = p
      const id = p === 'idle' ? null : scene.agent[p] ?? null
      const act = lookup(id ?? undefined)
      if (!act) {
        // 回到 idle(或这个阶段没配活动):放开钉子。正在做的 agent 活动做完这一轮就回日常;
        // 还在路上的直接改去过日子;排着队的撤掉;正坐下的坐好了只停一下。
        const was = pinned
        pinned = null
        if (!was) return
        if (cur?.act.id === was && fr.mode === 'do') doUntil = Math.min(doUntil, 1.2)
        if (queued?.id === was) queued = null
        if (next?.act.id === was) {
          if (fr.mode === 'walk' || fr.mode === 'turn') {
            next = null
            path = []
            const n = pickRandom()
            if (n) goTo(n)
            else fr.mode = 'do'
          } else if (fr.mode === 'exit') next = null // 起身完自己重新挑(见 exit 分支)
          else stale = was // 正在坐下:坐好了只停一下
        }
        return
      }
      // done / error 是一次性的反应,不钉
      pinned = p === 'done' || p === 'error' ? null : act.id
      goTo(act)
    },
    poke() {
      const asleep = fr.mode === 'do' && ASLEEP.has(fr.pose)
      const act = lookup(asleep ? '@woken' : '@poke')
      if (act) goTo(act)
    },
    force(id) {
      forced = id
      const act = lookup(id ?? undefined)
      if (act) goTo(act)
    },
    current: () => (fr.mode === 'do' ? cur?.act.id ?? null : null),
  }
}

/** 所有内置活动(台架 / 文档用)。 */
export const BUILTIN_ACTIVITY_IDS = [...AGENT_ACTIVITIES, ...POKE_ACTIVITIES].map((a) => a.id)
