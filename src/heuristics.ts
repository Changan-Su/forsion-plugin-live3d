// 命名启发式(纯函数,无 three / DOM):片段名 → 阶段、表情挑选、morph 同义词、骨骼名 → 部位、骨架流派。
// 导入时 suggestStates() 用它们给出一份「开箱即用」的 states;agent 辅助导入可以在此基础上改。
// 各家命名的来源:Blender NLA(`Armature|Idle`)、Mixamo(`mixamo.com`、`mixamorig:Head`)、3ds Max(`Take 001`)、
// VRoid(`J_Bip_C_Head`、`Fcl_MTH_A`)、ARKit 52(`jawOpen`)、VRChat(`vrc.v_aa`)、MMD(`頭`、`あ`、`まばたき`)。
// ⚠️three 的加载器会用 PropertyBinding.sanitizeNodeName 去掉节点名里的 `[]./:` —— `mixamorig:Head` 进场景后是
// `mixamorigHead`,`UpperArm.L` 是 `UpperArmL`;下面的骨骼正则两种写法都认。

import type { Analysis, Phase, Profile, RigKind, StateSpec } from './contract'
import { PHASES, baseName, stripExt } from './contract'

// ── 片段名 ────────────────────────────────────────────────────────────────────
/** 没有语义的片段名段:导出工具塞进来的骨架名 / 图层名 / 默认 take 名。 */
const JUNK_SEGMENT = /^(.*armature(\.\d+)?|mixamo\.com|(base\s*)?layer\s*\d*|take\s*0*\d*|default\s*take|unreal\s*take|anim(ation)?\s*\d*|scene|root|clip\s*\d*|action\s*\d*)$/i

/** 去掉 `Armature|` 这类前缀段与 `|Layer0` 这类后缀段;全是无意义段 → null。 */
export function cleanClipName(raw: string | undefined | null): string | null {
  const segs = String(raw ?? '').split('|').map((s) => s.trim()).filter(Boolean)
  const good = segs.filter((s) => !JUNK_SEGMENT.test(s))
  return good.length ? good[good.length - 1] : null
}

/** 片段的显示 / 引用名:清洗后的片段名,无意义时退回来源文件名(不含扩展名)。 */
export function clipDisplayName(raw: string | undefined | null, sourcePath: string): string {
  return cleanClipName(raw) ?? (stripExt(baseName(sourcePath)) || 'clip')
}

/** 每个阶段的片段名规则:[正则, 分数],取分数最高的那个片段。 */
export const CLIP_RULES: Record<Phase, Array<[RegExp, number]>> = {
  idle: [[/^idle$/i, 10], [/idle/i, 8], [/breath/i, 6], [/rest|relax/i, 5], [/neutral|default/i, 4], [/stand/i, 3]],
  thinking: [[/think/i, 10], [/ponder|hmm|consider|thought/i, 8], [/confus|puzzl|scratch/i, 6], [/look[ _-]?around/i, 3]],
  speaking: [[/talk/i, 10], [/speak|chat|convers|explain/i, 8], [/say|gestur|argu/i, 5]],
  tool: [[/typ(e|ing)/i, 10], [/keyboard|comput|laptop/i, 9], [/work|writ|build|craft|hammer|fix|search/i, 6]],
  waiting: [[/wav(e|ing)/i, 10], [/greet|hello|beckon|^hi$/i, 8], [/ask|question|shrug/i, 6], [/point/i, 3]],
  error: [[/sad/i, 10], [/cry|fail|defeat|disappoint|upset|los[et]/i, 8], [/^no$|head[ _-]?shake|shake[ _-]?head/i, 7], [/angry|frustrat/i, 5], [/death|die|dying|fall/i, 3]],
  done: [[/cheer|victory|celebrat|clap|happy|joy/i, 10], [/thumbs?[ _-]?up|^yes$|agree|nod/i, 8], [/danc|samba/i, 6]],
}

/** 永远不该被挑中的片段(绑定姿势)。 */
const NEVER_CLIP = /t[ _-]?pose|a[ _-]?pose|bind[ _-]?pose/i

/** 给某阶段从片段名里挑一个;没有像样的 → undefined。 */
export function pickClip(phase: Phase, clipNames: readonly string[]): string | undefined {
  let best: string | undefined
  let bestScore = 0
  for (const name of clipNames) {
    if (!name || NEVER_CLIP.test(name)) continue
    for (const [re, score] of CLIP_RULES[phase]) {
      if (re.test(name) && score > bestScore) {
        best = name
        bestScore = score
      }
    }
  }
  return best
}

/** 片段缺省是否只播一遍:等待 / 完成是一次性的反应;出错里只有「摇头 / 倒下」这类动作是一次性的。 */
export function onceByDefault(phase: Phase, clipName: string): boolean {
  if (phase === 'waiting' || phase === 'done') return true
  if (phase === 'error') return /^no$|shake|death|die|dying|fall/i.test(clipName)
  return false
}

// ── 表情 ──────────────────────────────────────────────────────────────────────
/** 每个阶段想要的表情(按优先级)与权重;null = 这个阶段不加表情。名字用 VRM1 预设名。 */
export const PHASE_EXPRESSIONS: Record<Phase, { names: string[]; weight: number } | null> = {
  idle: { names: ['relaxed', 'neutral'], weight: 0.3 },
  thinking: { names: ['relaxed'], weight: 0.35 },
  speaking: null,
  tool: null,
  waiting: { names: ['surprised', 'happy'], weight: 0.5 },
  error: { names: ['sad'], weight: 0.7 },
  done: { names: ['happy'], weight: 0.8 },
}

/** 预设名的同义词(VRM0 旧名、VRoid 的 Fcl_* morph、MMD 日文名、常见英文说法)。全部按不分大小写比较。 */
export const EXPRESSION_SYNONYMS: Record<string, string[]> = {
  happy: ['joy', 'smile', 'fun', 'Fcl_ALL_Joy', '笑い', 'にっこり'],
  sad: ['sorrow', 'Fcl_ALL_Sorrow', '困る', '悲しい'],
  surprised: ['surprise', 'shock', 'Fcl_ALL_Surprised', 'びっくり', '驚き'],
  angry: ['anger', 'mad', 'Fcl_ALL_Angry', '怒り'],
  relaxed: ['fun', 'calm', 'Fcl_ALL_Fun'],
  neutral: ['Fcl_ALL_Neutral', 'default'],
  aa: ['a', 'Fcl_MTH_A', 'vrc.v_aa', 'jawOpen', 'あ'],
  blink: ['Fcl_EYE_Close', 'vrc.blink', 'まばたき'],
}

const lc = (s: string): string => s.toLowerCase()

/** 从可用名单里挑表情。**按 want 的优先级逐个找**,每个 want 依次试:① 精确 ② 不分大小写 ③ 同义词
 *  ④ 情绪词作为整词出现(`Fcl_ALL_Joy` 里的 joy)—— 都不中才看下一个 want(想要 surprised 时,自定义的
 *  "Surprised" 比预设 happy 更对)。 */
export function pickExpression(want: readonly string[], available: readonly string[]): string | undefined {
  if (!available.length) return undefined
  const byLower = new Map(available.map((a) => [lc(a), a] as const))
  const tokens = available.map((a) => [a, a.split(/[^a-z0-9]+/i).map(lc)] as const)
  for (const w of want) {
    if (available.includes(w)) return w
    const ci = byLower.get(lc(w))
    if (ci) return ci
    const syns = EXPRESSION_SYNONYMS[w] ?? []
    for (const syn of syns) {
      const hit = byLower.get(lc(syn))
      if (hit) return hit
    }
    if (w.length < 3) continue // aa / oh 这类短名做整词匹配会误中一片
    const words = [w, ...syns.filter((s) => /^[a-z]{3,}$/i.test(s))].map(lc)
    for (const [a, toks] of tokens) if (words.some((x) => toks.includes(x))) return a
  }
  return undefined
}

// ── morph 同义词(非 VRM 模型的口型 / 眨眼 / 微笑) ──────────────────────────────
export type MorphKind = 'mouth' | 'blink' | 'smile'

/** 按组排优先级;组内是一套(ARKit 的左右眼)—— 命中一组就返回这组里所有存在的名字。 */
export const MORPH_GROUPS: Record<MorphKind, string[][]> = {
  mouth: [['jawOpen'], ['vrc.v_aa'], ['v_aa'], ['Fcl_MTH_A'], ['mouthOpen', 'mouth_open', 'MouthOpen'], ['あ'], ['aa'], ['a']],
  blink: [
    ['eyeBlinkLeft', 'eyeBlinkRight'], ['eyeBlink_L', 'eyeBlink_R'], ['vrc.blink'], ['Fcl_EYE_Close'], ['blink'],
    ['まばたき'], ['eyes_closed', 'eyesClosed', 'eye_close', 'eyeClose'],
  ],
  smile: [
    ['mouthSmileLeft', 'mouthSmileRight'], ['mouthSmile_L', 'mouthSmile_R'], ['mouthSmile'], ['Fcl_MTH_Joy'], ['Fcl_ALL_Joy'],
    ['笑い'], ['smile'], ['happy'], ['joy'],
  ],
}

/** 在 morph 名单里找某类 morph(不分大小写),返回名单里的原名;没有 → []。 */
export function findMorphs(kind: MorphKind, names: readonly string[]): string[] {
  const byLower = new Map(names.map((n) => [lc(n), n] as const))
  for (const group of MORPH_GROUPS[kind]) {
    const hits = group.map((g) => byLower.get(lc(g))).filter((x): x is string => !!x)
    if (hits.length) return [...new Set(hits)]
  }
  return []
}

// ── 骨骼 ──────────────────────────────────────────────────────────────────────
export type RigRole =
  | 'hips' | 'spine' | 'chest' | 'neck' | 'head'
  | 'leftUpperArm' | 'rightUpperArm' | 'leftLowerArm' | 'rightLowerArm' | 'leftHand' | 'rightHand'

const MX = 'mixamorig\\d*[:_]?'
const L = '(?:[._ ]?l|[._ ]?left)'
const R = '(?:[._ ]?r|[._ ]?right)'
/** 部位 → 正则(按优先级)。Mixamo / VRoid / 3ds Max Biped / Blender(`.L` 被 sanitize 成 `L`)/ 通用 / MMD /
 *  Blender mmd_tools 导出的 MMD(`左腕` → `腕.L`,GLTFLoader 再 sanitize 成 `腕L`;09-19 用户那份 GLB 就是这样,
 *  认不出 → 手臂永远 T-pose)。 */
export const BONE_RULES: Record<RigRole, RegExp[]> = {
  hips: [new RegExp(`^${MX}Hips$`, 'i'), /^J_Bip_C_Hips$/i, /^(hips|pelvis|bip0?1[ _]?pelvis)$/i, /^センター$/, /hips$/i],
  spine: [new RegExp(`^${MX}Spine$`, 'i'), /^J_Bip_C_Spine$/i, /^(spine|abdomen|bip0?1[ _]?spine)$/i, /^上半身$/, /spine$/i],
  chest: [new RegExp(`^${MX}Spine[12]$`, 'i'), /^J_Bip_C_(Upper)?Chest$/i, /^(chest|upper_?chest|torso|spine[._]?0?[12]|bip0?1[ _]?spine[12])$/i, /^上半身2$/],
  neck: [new RegExp(`^${MX}Neck$`, 'i'), /^J_Bip_C_Neck$/i, /^(neck|bip0?1[ _]?neck)$/i, /^首$/, /(^|[^a-z])neck$/i],
  head: [new RegExp(`^${MX}Head$`, 'i'), /^J_Bip_C_Head$/i, /^(head|bip0?1[ _]?head)$/i, /^頭$/, /(^|[^a-z])head$/i],
  leftUpperArm: [new RegExp(`^${MX}LeftArm$`, 'i'), /^J_Bip_L_UpperArm$/i, new RegExp(`^(left[ _]?(upper[ _]?)?arm|upper[ _]?arm${L}|l[ _]?upper[ _]?arm|bip0?1[ _]?l[ _]?upperarm)$`, 'i'), /^左腕$/, /^腕\.?L$/],
  rightUpperArm: [new RegExp(`^${MX}RightArm$`, 'i'), /^J_Bip_R_UpperArm$/i, new RegExp(`^(right[ _]?(upper[ _]?)?arm|upper[ _]?arm${R}|r[ _]?upper[ _]?arm|bip0?1[ _]?r[ _]?upperarm)$`, 'i'), /^右腕$/, /^腕\.?R$/],
  leftLowerArm: [new RegExp(`^${MX}LeftForeArm$`, 'i'), /^J_Bip_L_LowerArm$/i, new RegExp(`^(left[ _]?(fore|lower)[ _]?arm|(fore|lower)[ _]?arm${L}|l[ _]?(fore|lower)[ _]?arm|bip0?1[ _]?l[ _]?forearm)$`, 'i'), /^左ひじ$/, /^ひじ\.?L$/],
  rightLowerArm: [new RegExp(`^${MX}RightForeArm$`, 'i'), /^J_Bip_R_LowerArm$/i, new RegExp(`^(right[ _]?(fore|lower)[ _]?arm|(fore|lower)[ _]?arm${R}|r[ _]?(fore|lower)[ _]?arm|bip0?1[ _]?r[ _]?forearm)$`, 'i'), /^右ひじ$/, /^ひじ\.?R$/],
  leftHand: [new RegExp(`^${MX}LeftHand$`, 'i'), /^J_Bip_L_Hand$/i, new RegExp(`^(left[ _]?hand|hand${L}|l[ _]?hand|bip0?1[ _]?l[ _]?hand)$`, 'i'), /^左手首$/, /^手首\.?L$/],
  rightHand: [new RegExp(`^${MX}RightHand$`, 'i'), /^J_Bip_R_Hand$/i, new RegExp(`^(right[ _]?hand|hand${R}|r[ _]?hand|bip0?1[ _]?r[ _]?hand)$`, 'i'), /^右手首$/, /^手首\.?R$/],
}

/** 在骨骼名单里找各部位(每个部位取优先级最高、名单里最靠前的那根)。 */
export function findRigBones(boneNames: readonly string[]): Partial<Record<RigRole, string>> {
  const out: Partial<Record<RigRole, string>> = {}
  for (const role of Object.keys(BONE_RULES) as RigRole[]) {
    for (const re of BONE_RULES[role]) {
      const hit = boneNames.find((n) => re.test(n))
      if (hit) {
        out[role] = hit
        break
      }
    }
  }
  return out
}

/** 骨架流派(仅用于展示与 agent 判断能否套 Mixamo 动作)。 */
export function guessRig(boneNames: readonly string[], isVrm = false): RigKind {
  if (isVrm) return 'vrm'
  if (boneNames.some((n) => /^mixamorig/i.test(n))) return 'mixamo'
  if (boneNames.some((n) => /^J_Bip_/i.test(n))) return 'vroid'
  if (boneNames.some((n) => /^(頭|首|上半身2?|センター|左腕|右腕)$/.test(n))) return 'mmd'
  return 'unknown'
}

/** 包围盒猜「上」轴:Z 明显是最长的一维(比 Y、X 都长出一截)→ 躺着的 Z-up 模型。扁平的盘子不算。 */
export function guessUpAxis(size: readonly [number, number, number]): 'y' | 'z' {
  const [x, y, z] = size
  return z > y * 1.3 && z > x * 1.2 ? 'z' : 'y'
}

// ── states 建议 ───────────────────────────────────────────────────────────────
/** 按片段名 / 表情名给出一份 states(只写有把握的字段;没写的由 reactions.planFor 走缺省)。 */
export function suggestStates(a: Pick<Analysis, 'clips' | 'morphs' | 'vrm'>): Profile['states'] {
  const clipNames = a.clips.map((c) => c.name)
  const exprs = a.vrm ? a.vrm.expressions : a.morphs
  const out: Profile['states'] = {}
  for (const phase of PHASES) {
    const spec: StateSpec = {}
    const clip = pickClip(phase, clipNames)
    if (clip) {
      spec.clip = clip
      if (onceByDefault(phase, clip)) spec.once = true
    }
    const ex = PHASE_EXPRESSIONS[phase]
    if (ex) {
      const name = pickExpression(ex.names, exprs)
      if (name) {
        spec.expression = name
        spec.weight = ex.weight
      }
    }
    if (phase === 'speaking') {
      const mouth = a.vrm ? pickExpression(['aa'], exprs) : findMorphs('mouth', a.morphs)[0]
      if (mouth) spec.mouth = mouth
    }
    if (Object.keys(spec).length) out[phase] = spec
  }
  return out
}
