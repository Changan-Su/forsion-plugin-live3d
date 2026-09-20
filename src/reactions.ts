// 阶段 → 反应计划(纯函数)+ 口型包络。stage 与 orb 都只吃这里的输出,不自己判断「思考时该干嘛」。
//
// 计划由三层拼成:① profile 里这个阶段的 StateSpec ② 缺省表(PHASE_EXPRESSIONS / 下面的 PROC)
// ③ 模型能力(有没有这个片段 / 表情 / 口型 morph)。没有能力的项直接丢掉,不留「想播但播不了」的名字。

import type { Phase, Profile, StateSpec } from './contract'
import { PHASE_EXPRESSIONS, pickExpression } from './heuristics'

/** 模型能提供什么(stage 按加载结果填)。 */
export interface Caps {
  /** 能播的片段名(已清洗,见 ClipInfo.name)。 */
  clips: readonly string[]
  /** 可用的表情名:VRM 的 expressionManager 名单,非 VRM 就是 morph 名单。 */
  expressions: readonly string[]
  /** 是 VRM(口型缺省 'aa',看向交给 vrm.lookAt)。 */
  vrm?: boolean
  /** 非 VRM 时的口型 morph(heuristics.findMorphs('mouth') 的第一个)。 */
  mouthMorph?: string
}

/** 程序化动作参数。幅度 0..1 是「相对强度」,由 stage / orb 换算成具体角度。 */
export interface ProcPlan {
  /** 视线:跟指针 / 往上(想事情)/ 往下(干活)/ 看镜头。 */
  look: 'pointer' | 'up' | 'down' | 'camera'
  /** 歪头(弧度,正 = 头往模型右肩歪)。 */
  headTilt: number
  /** 点头幅度(说话时的节奏点头)。 */
  nod: number
  /** 上下起伏(说话时的轻微颠动)。 */
  bob: number
  /** 垂头丧气。 */
  droop: number
  /** 蹦跳(等人 / 完成)。 */
  bounce: number
  /** 呼吸以外的左右轻晃。 */
  sway: number
}

export interface ReactionPlan {
  phase: Phase
  /** 要播的片段;undefined = 不播片段(只有程序化动作)。restart = 阶段真的变了,一次性片段要从头播。 */
  clip?: { name: string; once: boolean; restart: boolean }
  /** 表情目标权重(未列出的表情回 0)。 */
  expressions: Record<string, number>
  /** 说话时驱动口型的表情 / morph;非 speaking 阶段 undefined。 */
  mouth?: string
  proc: ProcPlan
}

/** 各阶段的程序化缺省(对照 formats.md §5 的反应表)。 */
export const PROC: Record<Phase, ProcPlan> = {
  idle: { look: 'pointer', headTilt: 0, nod: 0, bob: 0, droop: 0, bounce: 0, sway: 1 },
  thinking: { look: 'up', headTilt: 0.15, nod: 0, bob: 0, droop: 0, bounce: 0, sway: 0.5 },
  speaking: { look: 'camera', headTilt: 0.04, nod: 0.6, bob: 0.4, droop: 0, bounce: 0, sway: 0.6 },
  tool: { look: 'down', headTilt: -0.05, nod: 0.15, bob: 0, droop: 0, bounce: 0, sway: 0.3 },
  waiting: { look: 'camera', headTilt: 0.08, nod: 0, bob: 0, droop: 0, bounce: 1, sway: 0.4 },
  error: { look: 'down', headTilt: -0.1, nod: 0, bob: 0, droop: 1, bounce: 0, sway: 0.2 },
  done: { look: 'camera', headTilt: 0.1, nod: 0.3, bob: 0, droop: 0, bounce: 0.6, sway: 0.6 },
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

/**
 * 某阶段的反应计划。
 * - 片段:spec.clip 为字符串且模型有 → 用它;spec.clip === null → 明确不播;省略 / 模型没有 → 沿用 idle 的片段
 *   (循环播,让模型别僵在绑定姿势);idle 也没有 → 不播。
 * - 表情:spec.expression(模型有才用)否则缺省表挑一个;weight 缺省按缺省表。
 * - 口型:仅 speaking;spec.mouth > VRM 'aa' > 非 VRM 的口型 morph。
 */
export function planFor(phase: Phase, states: Profile['states'] | undefined, caps: Caps, prevPhase?: Phase | null): ReactionPlan {
  const st = states ?? {}
  const spec: StateSpec = st[phase] ?? {}
  const has = (n: string | null | undefined): n is string => !!n && caps.clips.includes(n)

  let clip: ReactionPlan['clip']
  const restart = prevPhase !== phase
  if (spec.clip === null) clip = undefined
  else if (has(spec.clip)) clip = { name: spec.clip, once: !!spec.once, restart }
  else {
    const idleClip = st.idle?.clip
    if (has(idleClip)) clip = { name: idleClip, once: false, restart: false }
  }

  const expressions: Record<string, number> = {}
  const def = PHASE_EXPRESSIONS[phase]
  if (spec.expression) {
    const name = pickExpression([spec.expression], caps.expressions)
    if (name) expressions[name] = clamp01(spec.weight ?? def?.weight ?? 0.7)
  } else if (def) {
    const name = pickExpression(def.names, caps.expressions)
    if (name) expressions[name] = clamp01(spec.weight ?? def.weight)
  }

  let mouth: string | undefined
  if (phase === 'speaking') {
    // 非 VRM 的 caps.expressions 就是 morph 名单,所以 spec.mouth 写 morph 名也在这一步命中。
    if (spec.mouth) mouth = pickExpression([spec.mouth], caps.expressions)
    if (!mouth) mouth = caps.vrm ? pickExpression(['aa'], caps.expressions) : caps.mouthMorph
  }

  return { phase, clip, expressions, mouth, proc: { ...PROC[phase] } }
}

// ── 口型包络 ──────────────────────────────────────────────────────────────────
/**
 * 把「流式正文的累计字符数」变成 0..1 的张嘴量。SSE 增量是一阵一阵来的,所以这不是语音,而是「活跃度」包络:
 *  - 有新字 → 目标 = 0.35 + 0.65·min(1, 速率/40 字每秒);没新字但距上次长字 < 120ms → 保持目标;否则 0
 *  - 一阶平滑:上升 τ≈80ms,回落 τ≈150ms
 *  - messageId 变了(换了一条气泡)→ 基线重置、包络归零;字数变少(done 改写正文)→ 按 0 增量处理
 * 时间单位:秒。
 */
export interface MouthEnvelope {
  /** 喂一次采样,返回当前张嘴量。 */
  sample(textChars: number, t: number, messageId?: string): number
  /** 不喂新字、只让包络按时间衰减(非 speaking 阶段每帧调)。 */
  decay(t: number): number
  reset(): void
  readonly value: number
}

export function createMouthEnvelope(opts: { attack?: number; release?: number; hold?: number; fullRate?: number } = {}): MouthEnvelope {
  const attack = opts.attack ?? 0.08
  const release = opts.release ?? 0.15
  const hold = opts.hold ?? 0.12
  const fullRate = opts.fullRate ?? 40
  let baseChars: number | null = null
  let msg: string | undefined
  let lastT: number | null = null
  let lastGrowT = -Infinity
  let target = 0
  let env = 0

  const step = (t: number): number => {
    if (lastT === null) {
      lastT = t
      return env
    }
    const dt = Math.max(0, t - lastT)
    lastT = t
    if (t - lastGrowT > hold) target = 0
    const tau = target > env ? attack : release
    env += (target - env) * (1 - Math.exp(-dt / tau))
    env = clamp01(env)
    return env
  }

  return {
    sample(textChars, t, messageId) {
      if (messageId !== msg || baseChars === null) {
        msg = messageId
        baseChars = textChars
        lastGrowT = -Infinity
        target = 0
        env = 0
        lastT = t
        return 0
      }
      const prevT = lastT ?? t
      const delta = textChars - baseChars
      baseChars = textChars // 变少也跟着走(改写后的新基线),但不产生负增量
      if (delta > 0) {
        const dt = Math.max(1 / 120, t - prevT)
        target = 0.35 + 0.65 * Math.min(1, delta / dt / fullRate)
        lastGrowT = t
      }
      return step(t)
    },
    decay(t) {
      lastGrowT = -Infinity
      return step(t)
    },
    reset() {
      baseChars = null
      msg = undefined
      lastT = null
      lastGrowT = -Infinity
      target = 0
      env = 0
    },
    get value() {
      return env
    },
  }
}

/** 包络 → 一帧的实际张嘴量:叠一个 ~5Hz 的开合,让嘴「一张一合」而不是张着不动。t 秒。 */
export function mouthFlap(envelope: number, t: number): number {
  if (envelope <= 0.001) return 0
  const syll = Math.abs(Math.sin(t * Math.PI * 5.2)) * 0.75 + Math.abs(Math.sin(t * Math.PI * 2.3 + 1.1)) * 0.25
  return clamp01(envelope * (0.25 + 0.75 * syll))
}
