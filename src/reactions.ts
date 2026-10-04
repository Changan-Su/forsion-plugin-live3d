// 阶段 → 反应计划(纯函数)+ 口型(出字包络 / 语音通话的真实电平)。stage 与 orb 都只吃这里的输出,不自己判断「思考时该干嘛」。
//
// 计划由三层拼成:① profile 里这个阶段的 StateSpec ② 缺省表(PHASE_EXPRESSIONS / 下面的 PROC)
// ③ 模型能力(有没有这个片段 / 表情 / 口型 morph)。没有能力的项直接丢掉,不留「想播但播不了」的名字。

import type { AgentStatusLike, Phase, Profile, StateSpec } from './contract'
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

// ── 真实语音口型(语音通话)────────────────────────────────────────────────────
/** 低于这个电平不张嘴(编码底噪 / 气声)。 */
export const SPEECH_FLOOR = 0.04
/** 自动增益的下限:最近的峰值再小,也按「峰值 = FLOOR + 这么多」算 —— 免得把一段几乎没声的气声放大成满嘴。
 *  校准旋钮:嫌轻声的音色嘴张不开就调小,嫌底噪也在动嘴就调大。 */
export const SPEECH_MIN_SPAN = 0.2
/** 峰值的回落时间常数(秒):换了更轻的音色 / 调小了音量,几秒后嘴重新张得开。 */
export const SPEECH_PEAK_TAU = 4

/** 峰值跟踪:立刻跟上更响的,按 SPEECH_PEAK_TAU 慢慢回落。 */
export const speechPeak = (peak: number, level: number, dt: number): number =>
  Math.max(level, peak * Math.exp(-Math.max(0, dt) / SPEECH_PEAK_TAU))

/**
 * 宿主 speechLevel(模型输出的真实电平,0..1,~20Hz 更新)→ 张嘴量。这是真声音:音节的起伏已经在信号里,
 * 所以只做门限 + 按近期峰值归一 + 一阶平滑(上升 τ≈40ms 跟得上爆破音,回落 τ≈90ms 让音节之间合一下而不抖),
 * 不叠 mouthFlap 的正弦。归一是因为绝对响度靠不住:音色之间差得多,写死增益不是张不开就是总张满。
 * ponytail: 只有「开合」一个通道(VRM 'aa' / 口型 morph);要 あいうえお 五个口型得宿主再给频谱。
 */
export function speechMouth(prev: number, level: number, peak: number, dt: number): number {
  const target = clamp01((level - SPEECH_FLOOR) / Math.max(peak - SPEECH_FLOOR, SPEECH_MIN_SPAN))
  const tau = target > prev ? 0.04 : 0.09
  return clamp01(prev + (target - prev) * (1 - Math.exp(-Math.max(0, dt) / tau)))
}

/**
 * 一帧的张嘴量(两个舞台共用):状态里有 speechLevel(会话在语音通话)→ 跟真实电平;否则跟出字速度(包络 + 开合)。
 * 通话里代办 run 在聊天区出字时 speechLevel = 0 —— 没有声音,嘴不动。
 * @param s 本帧拉到的状态;undefined = 没有拉取源(预览 / 老宿主)→ 匀速「出字」;null = 拉取失败 → 只衰减。
 */
export interface MouthDriver {
  step(speaking: boolean, s: AgentStatusLike | null | undefined, t: number, dt: number): number
  reset(): void
}

export function createMouthDriver(): MouthDriver {
  const env = createMouthEnvelope()
  let voiced = 0
  let byVoice = false
  let peak = 0 // 跨句保留(同一通电话的响度不会一句一变),只随时间回落
  let peakAt = 0
  return {
    step(speaking, s, t, dt) {
      if (!speaking) {
        env.decay(t)
        voiced = 0
        return 0
      }
      if (typeof s?.speechLevel === 'number') {
        byVoice = true
        // 峰值按真实流逝的时间回落(不是按说话的帧数):上一通的大嗓门不许压住一分钟后这通轻声的口型。
        peak = speechPeak(peak, s.speechLevel, t - peakAt)
        peakAt = t
        voiced = speechMouth(voiced, s.speechLevel, peak, dt)
        return voiced
      }
      // 挂断后切回出字口型:基线重来 —— 通话期间聊天区攒下的字不算「刚出的」(否则嘴会弹开一下)。
      if (byVoice) {
        byVoice = false
        env.reset()
      }
      voiced = 0
      if (s === undefined) env.sample(Math.floor(t * 30), t, 'synthetic')
      else if (s) env.sample(s.textChars, t, s.messageId)
      else env.decay(t)
      return mouthFlap(env.value, t)
    },
    reset() {
      env.reset()
      voiced = 0
      byVoice = false
    },
  }
}
