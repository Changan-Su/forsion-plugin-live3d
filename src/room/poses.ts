// 姿势库 + 动画合成(纯数学,无 three):BrainFrame → 形象根的摆放(位置 / 偏航 / 仰倒)+ BodyFrame(四肢方向、
// 脊柱角度、闭眼、情绪)。形象那一侧(stage.ts 的 createModelAvatar)只管把这些数套到骨骼上。
//
// 朝向系约定(与 stage.ts 同):+Z = 角色正前方、+X = 角色**左**手边、+Y = 头顶方向。躺下时整个朝向系跟着身体倒下,
// 所以「躺姿里手举到头边」仍写成 +Y。手臂写成左臂的方向,右臂自动镜像(x 取反)。
// 角度:脊柱 / 头的 x 正 = 往前弯(低头),y 正 = 往角色左边转,z = 侧歪。腿的大腿 x 负 = 往前抬,膝盖正 = 往后弯。

import type { BodyFrame, LegPose, LimbAim } from '../stage'
import type { BrainFrame } from './brain'
import type { EmoteName, PoseName, Stance } from './scene'

type V3 = readonly [number, number, number]
export type Mood = 'happy' | 'smile' | 'sleepy' | 'yawn' | 'grumpy' | 'sad' | 'surprised' | 'serene'
export type Held = 'book' | 'plush' | null
export type LookMode = 'camera' | 'up' | 'down' | 'target' | 'forward' | 'free'

/** 一个姿势在某一刻的样子。手臂 = [上臂方向, 前臂方向](左臂写法);省略 = 放松垂手。 */
export interface PoseOut {
  armL?: [V3, V3]
  armR?: [V3, V3]
  /** 两腿各自的覆盖(省略 = 按站法:站直 / 坐 / 躺)。 */
  legL?: LegPose
  legR?: LegPose
  spine?: V3
  chest?: V3
  neck?: V3
  head?: V3
  eyes?: number
  mood?: Partial<Record<Mood, number>>
  look?: LookMode
  held?: Held
  /** 额外离地(米 / 身高):欢呼时蹦一下。 */
  hop?: number
  /** 待机呼吸倍率(睡觉时关掉 Desk 那层,由这里自己做深呼吸)。 */
  idle?: number
}

const mirror = (v: V3): V3 => [-v[0], v[1], v[2]]
const S = Math.sin
const smooth01 = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x))

// ── 腿:三种站法的基础腿型 ────────────────────────────────────────────────────
const leg = (tx: number, ty: number, tz: number, knee: number, foot = 0, w = 1): LegPose => ({ thigh: [tx, ty, tz], knee, foot, w })
/** 坐:大腿抬平、小腿垂下,两脚微微晃(Q 版腿短,坐在椅子上脚是悬空的)。 */
function sitLegs(t: number, side: 1 | -1): LegPose {
  return leg(-1.42, 0, side * 0.1, 1.28 + 0.14 * S(t * 1.7 + (side > 0 ? 0 : 2.1)), -0.15)
}
function lieLegs(t: number, side: 1 | -1, frog = 0): LegPose {
  return leg(-0.12 - frog * 0.45, 0, side * (0.08 + frog * 0.38), 0.18 + frog * 0.75 + 0.03 * S(t * 0.4 + side), 0.2)
}

// ── 姿势表 ───────────────────────────────────────────────────────────────────
type PoseFn = (t: number) => PoseOut

const HANDS_BEHIND: [V3, V3] = [[0.22, -0.78, -0.55], [-0.75, 0.05, -0.45]]
const LAP: [V3, V3] = [[0.14, -0.82, 0.45], [-0.12, -0.25, 1]]

export const POSE_TABLE: Record<PoseName, PoseFn> = {
  stand: (t) => ({ look: 'free', head: [0, 0, 0.03 * S(t * 0.3)] }),
  // 望向窗外 / 星空:抬头,手背在身后
  gaze: (t) => ({ armL: HANDS_BEHIND, armR: HANDS_BEHIND, head: [-0.12, 0.05 * S(t * 0.25), 0.06], chest: [-0.05, 0, 0], look: 'target' }),
  // 望远镜:弯腰凑近目镜,两手扶镜筒;偶尔微调
  telescope: (t) => ({
    armL: [[0.35, -0.2, 0.9], [-0.35, 0.3, 0.88]],
    armR: [[0.3, -0.3, 0.9], [-0.25, 0.2, 0.95]],
    spine: [0.22, 0, 0], chest: [0.12, 0.03 * S(t * 0.2), 0], head: [-0.05, 0, 0], look: 'forward',
  }),
  // 书架前挑书:右手够上层,头慢慢扫过书脊
  browse: (t) => ({
    armR: [[0.25, 0.55, 0.75], [0.05, 0.92, 0.35]],
    head: [-0.18, 0.28 * S(t * 0.45), 0], look: 'forward',
  }),
  // 看墙上的照片 / 海报 / 剑:手背后,歪头端详
  view: (t) => ({ armL: HANDS_BEHIND, armR: HANDS_BEHIND, head: [-0.06, 0.12 * S(t * 0.2), 0.16], chest: [0.04, 0, 0], look: 'forward' }),
  // 看花 / 给植物浇水:弯腰、伸手
  water: (t) => ({
    armR: [[0.1, -0.45, 0.88], [0.1, -0.55, 0.82]],
    spine: [0.28, 0, 0], chest: [0.12, 0, 0], head: [0.2, 0.1 * S(t * 0.5), 0.1], look: 'down', mood: { smile: 0.5 },
  }),
  // 伸懒腰:两手举过头顶,后仰,闭眼张嘴
  stretch: (t) => {
    const k = smooth01(Math.min(1, t / 0.8)) * (1 - smooth01((t - 2.2) / 0.8))
    return {
      armL: [[0.18, 1, 0.08], [0.05, 1, 0.05]], armR: [[0.18, 1, 0.08], [0.05, 1, 0.05]],
      spine: [-0.14 * k, 0, 0], chest: [-0.1 * k, 0, 0], head: [-0.15 * k, 0, 0], eyes: 0.85 * k, mood: { yawn: k }, look: 'forward',
    }
  },
  // 打哈欠:右手捂嘴,眯眼
  yawn: (t) => {
    const k = smooth01(Math.min(1, t / 0.6)) * (1 - smooth01((t - 2) / 0.7))
    return { armR: [[0.18, -0.25, 0.95], [-0.35, 0.88, 0.3]], head: [-0.1 * k, 0, 0.08], eyes: 0.7 * k, mood: { yawn: k, sleepy: 0.5 }, look: 'forward' }
  },
  // 站着打瞌睡:头一点一点往下掉,掉到底猛地一抬(然后再慢慢掉)
  'nod-off': (t) => {
    const cyc = (t % 5.5) / 5.5
    const drop = cyc < 0.85 ? smooth01(cyc / 0.85) : 1 - smooth01((cyc - 0.85) / 0.05)
    return { head: [0.45 * drop, 0, 0.1 * drop], neck: [0.15 * drop, 0, 0], spine: [0.05 * drop, 0, 0], eyes: 0.4 + 0.6 * drop, mood: { sleepy: 0.8 }, idle: 0.3, look: 'down' }
  },
  // 招手(对镜头)
  wave: (t) => ({ armL: [[0.7, 0.5, 0.35], [0.12 + 0.35 * S(t * 9), 1, 0.12]], head: [0, 0, 0.12], mood: { happy: 0.8 }, look: 'camera' }),
  // 说话:看镜头,手在身前比划
  talk: (t) => ({
    armL: [[0.28, -0.7, 0.55], [-0.15 + 0.12 * S(t * 2.3), 0.15 + 0.1 * S(t * 3.1), 1]],
    armR: [[0.25, -0.75, 0.5], [-0.1 + 0.08 * S(t * 1.9 + 1), 0.05, 1]],
    head: [0, 0, 0.05 * S(t * 0.8)], mood: { smile: 0.4 }, look: 'camera',
  }),
  // 欢呼:双手 V 字举高、蹦一下
  cheer: (t) => ({
    armL: [[0.65, 0.75, 0.2], [0.35, 1, 0.05]], armR: [[0.65, 0.75, 0.2], [0.35, 1, 0.05]],
    hop: Math.max(0, S(t * 7)) * 0.06 * (t < 1.4 ? 1 : 0), mood: { happy: 1 }, eyes: 0.4, look: 'camera',
  }),
  // 叹气 / 垂头(出错、被吵醒时的不爽)
  sigh: () => ({ spine: [0.2, 0, 0], head: [0.32, 0, -0.08], mood: { grumpy: 0.6 }, look: 'down' }),
  // 蹲下看低处
  crouch: (t) => ({
    legL: leg(-1.35, 0, 0.2, 2.2, -0.6), legR: leg(-1.35, 0, -0.2, 2.2, -0.6),
    armR: [[0.1, -0.5, 0.85], [0.1, -0.3, 0.95]], spine: [0.3, 0, 0], head: [0.25, 0.1 * S(t), 0.1], look: 'down',
  }),

  // ── 坐 ──
  sit: (t) => ({ armL: LAP, armR: LAP, head: [0.05, 0.1 * S(t * 0.3), 0], look: 'free' }),
  // 坐着看书:两手捧书在胸前,低头;隔一阵翻一页(右手一挥)
  'sit-read': (t) => {
    const flip = t % 9 > 8.3 ? S(((t % 9) - 8.3) / 0.7 * Math.PI) : 0
    return {
      armL: [[0.3, -0.6, 0.72], [-0.45, 0.25, 0.86]],
      armR: [[0.3, -0.6, 0.72], [-0.45 + 0.5 * flip, 0.25 + 0.2 * flip, 0.86]],
      head: [0.3, 0.06 * S(t * 0.4), 0.05], look: 'down', held: 'book',
    }
  },
  // 坐在书桌前干活(打字 / 写字):两手在桌面,轻微敲击
  'sit-work': (t) => ({
    armL: [[0.3, -0.35, 0.9], [-0.18 + 0.04 * S(t * 11), -0.1, 1]],
    armR: [[0.3, -0.35, 0.9], [-0.18 + 0.04 * S(t * 13 + 1), -0.1, 1]],
    spine: [0.08, 0, 0], head: [0.22, 0.08 * S(t * 0.6), 0], look: 'down',
  }),
  // 托腮想事情
  'sit-think': (t) => ({
    armR: [[0.22, -0.3, 0.92], [-0.28, 0.93, 0.2]],
    armL: [[0.3, -0.45, 0.85], [-0.55, -0.1, 0.83]],
    head: [-0.1, -0.12, 0.2 + 0.04 * S(t * 0.7)], look: 'up', mood: { sleepy: 0.2 },
  }),
  // 坐着打盹:头往前一点一点
  'sit-doze': (t) => {
    const nod = 0.35 + 0.12 * S(t * 0.9)
    return { armL: LAP, armR: LAP, head: [nod, 0, 0.12], neck: [0.12, 0, 0], eyes: 1, mood: { sleepy: 0.5 }, idle: 0.2, look: 'down' }
  },
  // 趴在桌上睡:两臂叠在桌面,脸侧枕着
  'desk-sleep': (t) => ({
    armL: [[0.35, -0.15, 0.92], [-0.95, 0.05, 0.3]],
    armR: [[0.35, -0.12, 0.92], [-0.95, 0.12, 0.25]],
    spine: [0.42 + 0.015 * S(t * 1.1), 0, 0], chest: [0.28, 0, 0], neck: [0.1, 0, 0], head: [0.2, 0.45, 0.35], eyes: 1, mood: { serene: 0.3 }, idle: 0, look: 'down',
  }),
  // 弹钢琴:两手在琴键上左右移动,头随旋律轻摆
  piano: (t) => ({
    armL: [[0.28, -0.45, 0.85], [-0.12 + 0.22 * S(t * 1.3), -0.2, 1]],
    armR: [[0.28, -0.45, 0.85], [-0.12 - 0.2 * S(t * 1.1 + 0.8), -0.2, 1]],
    spine: [0.05, 0, 0.04 * S(t * 1.6)], head: [0.15, 0.08 * S(t * 0.8), 0.08 * S(t * 1.6)], eyes: 0.5, mood: { serene: 0.6 }, look: 'down',
  }),
  // 抱着玩偶坐在床边
  hug: (t) => ({
    armL: [[0.3, -0.35, 0.88], [-0.92, 0.1, 0.35]], armR: [[0.3, -0.3, 0.88], [-0.92, 0.15, 0.3]],
    head: [0.15, 0, 0.22 + 0.05 * S(t * 0.5)], mood: { serene: 0.6 }, eyes: 0.35, look: 'down', held: 'plush',
  }),

  // ── 躺(朝向系跟着身体倒下:+Y 指向头,+Z 指向天花板) ──
  lie: (t) => ({
    armL: [[0.8, 0.5, 0.15], [0.2, 0.95, 0.2]], armR: [[0.8, 0.5, 0.15], [0.2, 0.95, 0.2]],
    head: [-0.3, 0.3 * S(t * 0.15), 0], look: 'forward',
  }),
  // 睡觉:翻着肚皮的大猫 —— 两手弯着举在头两边,腿微微外撇,胸口起伏
  sleep: (t) => ({
    armL: [[0.78, 0.58, 0.18], [0.12, 0.96, 0.22]], armR: [[0.74, 0.62, 0.2], [0.18, 0.95, 0.25]],
    legL: lieLegs(t, 1, 1), legR: lieLegs(t, -1, 1),
    chest: [-0.04 * S(t * 1.2), 0, 0], head: [-0.32, 0.45, 0.12], eyes: 1, mood: { serene: 0.25 }, idle: 0, look: 'forward',
  }),
  // 晒太阳:摊开四肢,闭眼微笑
  sunbathe: (t) => ({
    armL: [[1, 0.12, 0.08], [0.9, 0.35, 0.12]], armR: [[1, 0.12, 0.08], [0.9, 0.35, 0.12]],
    legL: lieLegs(t, 1, 0.4), legR: lieLegs(t, -1, 0.4),
    chest: [-0.03 * S(t * 1.1), 0, 0], head: [-0.3, 0.2, 0], eyes: 1, mood: { serene: 0.8, smile: 0.4 }, idle: 0, look: 'forward',
  }),
}

// ── 走路 ─────────────────────────────────────────────────────────────────────
/** 走路循环的一帧(φ 是步态相位)。Q 版腿短:大腿摆幅不小,身体左右摇(小企鹅步)。 */
function walkLayer(phi: number): PoseOut {
  const s = S(phi)
  const c = Math.cos(phi)
  return {
    legL: leg(-0.55 * s, 0, 0.04, 0.85 * Math.max(0, c), -0.2 * Math.max(0, c)),
    legR: leg(0.55 * s, 0, -0.04, 0.85 * Math.max(0, -c), -0.2 * Math.max(0, -c)),
    armL: [[0.16, -0.95, -0.4 * s], [0.08, -0.85, 0.3 - 0.35 * s]],
    armR: [[0.16, -0.95, 0.4 * s], [0.08, -0.85, 0.3 + 0.35 * s]],
    spine: [0.06, 0.05 * s, 0.07 * s],
    head: [0, -0.04 * s, -0.05 * s],
  }
}

// ── 混合 ─────────────────────────────────────────────────────────────────────
const lerp = (a: number, b: number, k: number): number => a + (b - a) * k
const lerp3 = (a: V3 | undefined, b: V3 | undefined, k: number): V3 | undefined => {
  if (!a && !b) return undefined
  const x = a ?? [0, 0, 0]
  const y = b ?? [0, 0, 0]
  return [lerp(x[0], y[0], k), lerp(x[1], y[1], k), lerp(x[2], y[2], k)]
}
const nlerp3 = (a: V3, b: V3, k: number): V3 => {
  const v: [number, number, number] = [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)]
  const n = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / n, v[1] / n, v[2] / n]
}

type Arm = { u: V3; l: V3; w: number } | undefined
const armOf = (a: [V3, V3] | undefined, mirrorIt: boolean): Arm =>
  a ? { u: mirrorIt ? mirror(a[0]) : a[0], l: mirrorIt ? mirror(a[1]) : a[1], w: 1 } : undefined
function mixArm(a: Arm, b: Arm, k: number): Arm {
  if (!a && !b) return undefined
  if (!a) return { ...b!, w: b!.w * k }
  if (!b) return { ...a, w: a.w * (1 - k) }
  return { u: nlerp3(a.u, b.u, k), l: nlerp3(a.l, b.l, k), w: lerp(a.w, b.w, k) }
}
function mixLeg(a: LegPose | undefined, b: LegPose | undefined, k: number): LegPose | undefined {
  if (!a && !b) return undefined
  const x = a ?? { ...b!, w: 0 }
  const y = b ?? { ...a!, w: 0 }
  return {
    thigh: [lerp(x.thigh[0], y.thigh[0], k), lerp(x.thigh[1], y.thigh[1], k), lerp(x.thigh[2], y.thigh[2], k)],
    knee: lerp(x.knee, y.knee, k), foot: lerp(x.foot, y.foot, k), w: lerp(x.w, y.w, k),
  }
}

/** 合成用的中间态(手臂已镜像成左右各自的方向)。 */
export interface Mix {
  armL: Arm
  armR: Arm
  legL?: LegPose
  legR?: LegPose
  spine?: V3
  chest?: V3
  neck?: V3
  head?: V3
  eyes: number
  mood: Partial<Record<Mood, number>>
  idle: number
  hop: number
}

function toMix(p: PoseOut, stance: Stance, settle: number, t: number): Mix {
  // 站法决定缺省腿型;姿势自己给了腿就用姿势的
  const sitL = stance === 'sit' ? mixLeg(undefined, sitLegs(t, 1), settle) : stance === 'lie' ? mixLeg(undefined, lieLegs(t, 1), settle) : undefined
  const sitR = stance === 'sit' ? mixLeg(undefined, sitLegs(t, -1), settle) : stance === 'lie' ? mixLeg(undefined, lieLegs(t, -1), settle) : undefined
  return {
    armL: armOf(p.armL, false),
    armR: armOf(p.armR, true),
    legL: p.legL ? mixLeg(sitL, p.legL, stance === 'stand' ? 1 : settle) : sitL,
    legR: p.legR ? mixLeg(sitR, p.legR, stance === 'stand' ? 1 : settle) : sitR,
    spine: p.spine, chest: p.chest, neck: p.neck, head: p.head,
    eyes: p.eyes ?? 0, mood: p.mood ?? {}, idle: p.idle ?? 1, hop: p.hop ?? 0,
  }
}

function mixMix(a: Mix, b: Mix, k: number): Mix {
  const mood: Partial<Record<Mood, number>> = {}
  for (const m of new Set([...Object.keys(a.mood), ...Object.keys(b.mood)]) as Set<Mood>) mood[m] = lerp(a.mood[m] ?? 0, b.mood[m] ?? 0, k)
  return {
    armL: mixArm(a.armL, b.armL, k), armR: mixArm(a.armR, b.armR, k),
    legL: mixLeg(a.legL, b.legL, k), legR: mixLeg(a.legR, b.legR, k),
    spine: lerp3(a.spine, b.spine, k), chest: lerp3(a.chest, b.chest, k), neck: lerp3(a.neck, b.neck, k), head: lerp3(a.head, b.head, k),
    eyes: lerp(a.eyes, b.eyes, k), mood, idle: lerp(a.idle, b.idle, k), hop: lerp(a.hop, b.hop, k),
  }
}

const cloneMix = (m: Mix): Mix => JSON.parse(JSON.stringify(m)) as Mix

// ── 动画器 ───────────────────────────────────────────────────────────────────
/** 形象的量尺(房间坐标,米):身高、髋关节离脚底多高、背面离根多远(躺下时垫高用)。 */
export interface BodyMetrics {
  height: number
  hipY: number
  back: number
}

export interface Animated {
  /** 形象根(脚底)的位置与朝向。pitch = 往后仰倒的角度(躺下 -π/2)。 */
  root: { x: number; y: number; z: number; yaw: number; pitch: number }
  body: BodyFrame
  /** 情绪 → 权重(由 roomStage 解析成模型里的表情名)。 */
  mood: Partial<Record<Mood, number>>
  look: LookMode
  held: Held
  emote: EmoteName | null
}

export interface Animator {
  step(fr: BrainFrame, dt: number, t: number): Animated
}

const CROSSFADE = 0.45

export function createAnimator(m: BodyMetrics): Animator {
  let phi = 0
  let lastKey = ''
  let from: Mix | null = null
  let fade = 1
  let last: Mix | null = null

  return {
    step(fr, dt, t) {
      // 步态相位跟着走过的距离走(Q 版一步 ≈ 0.28 × 身高)
      phi += (fr.speed * dt) / Math.max(0.1, m.height * 0.28) * Math.PI
      const key = `${fr.pose}|${fr.stance}`
      if (key !== lastKey) {
        // 换姿势:从上一帧的样子交叉淡入新姿势(新姿势自己的动态部分照常跑)
        if (last) from = cloneMix(last)
        fade = 0
        lastKey = key
      }
      fade = Math.min(1, fade + dt / CROSSFADE)
      const out = POSE_TABLE[fr.pose]?.(fr.poseT) ?? {}
      let mix = toMix(out, fr.stance, fr.settle, t)
      if (from && fade < 1) mix = mixMix(from, mix, smooth01(fade))
      if (fr.walk > 0.001) mix = mixMix(mix, toMix(walkLayer(phi), 'stand', 0, t), fr.walk)
      last = mix

      // ── 根:站 / 坐 / 躺 ──
      const s = fr.settle
      let y = 0
      let pitch = 0
      let x = fr.x
      let z = fr.z
      if (fr.stance === 'sit') {
        // 髋关节落在座面上(Q 版腿短:座面比髋高 → 整个人被抬上去,脚悬空)
        y = s * Math.max(0, fr.seatY - m.hipY + 0.015)
      } else if (fr.stance === 'lie') {
        pitch = -Math.PI / 2 * s
        // 仰倒时绕脚底转:抬高到床面 + 后脑勺厚度;根(脚)从身体中点往脚那头退半个身长
        y = s * (fr.seatY + m.back)
        const headDir = fr.yaw + Math.PI // 躺平后头朝 yaw + π
        x -= Math.sin(headDir) * m.height * 0.5 * s
        z -= Math.cos(headDir) * m.height * 0.5 * s
        // 往后倒的途中抬一下(像坐到床沿再躺下),别让脚在床沿里穿
        y += Math.sin(s * Math.PI) * 0.12 * m.height
      }
      y += mix.hop * m.height + (fr.walk > 0 ? Math.abs(S(phi)) * 0.018 * m.height * fr.walk : 0)

      const aim = (a: Arm): LimbAim | undefined => (a && a.w > 0.001 ? { upper: a.u, lower: a.l, w: a.w } : undefined)
      const body: BodyFrame = {
        armL: aim(mix.armL), armR: aim(mix.armR), legL: mix.legL, legR: mix.legR,
        spine: mix.spine, chest: mix.chest, neck: mix.neck, head: mix.head,
        eyes: mix.eyes, idle: mix.idle,
      }
      return {
        root: { x, y, z, yaw: fr.yaw, pitch },
        body,
        mood: mix.mood,
        look: fr.mode === 'walk' ? 'forward' : out.look ?? 'free',
        held: fr.mode === 'do' || fr.mode === 'enter' ? out.held ?? null : null,
        emote: fr.mode === 'do' ? fr.emote : null,
      }
    },
  }
}
