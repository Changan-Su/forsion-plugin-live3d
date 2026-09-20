// live3d.json 的校验 / 序列化 / 缺省生成(纯函数,无 DOM / three)。
// profile 会被人手改、被 agent 写,所以错误一律是**双语、能照着改的**人话;不认识的顶层字段只警告不报错
// (新版插件写的字段在旧版里读得进来)。路径一律相对 profile 所在文件夹,绝对路径与 '..' 越界直接拒。

import type { Analysis, Framing, Msg, Phase, Profile, ProfilePose, ProfileTransform, ResolvedProfile, StateSpec } from './contract'
import {
  DEFAULT_POSE, FRAMINGS, LIVE2D_REFUSAL, MODEL_EXTS, MOTION_EXTS, baseName, extOf, isAgentSlug, isLive2DPath, isPhase, isSafeRel,
  joinRel, normRel, stripExt,
} from './contract'
import { guessUpAxis, suggestStates } from './heuristics'

export type ParseResult =
  | { ok: true; value: ResolvedProfile; warnings: Msg[] }
  | ({ ok: false } & Msg)

const KNOWN_TOP = new Set(['live3d', 'name', 'model', 'motions', 'agents', 'transform', 'framing', 'states', 'pose'])
const KNOWN_TRANSFORM = new Set(['scale', 'rotateY', 'offsetY', 'upAxis'])
const KNOWN_STATE = new Set(['clip', 'expression', 'weight', 'mouth', 'once'])
/** pose 的每个数:[下限, 上限]。超界一律拒 —— 手臂转 400° 只会让人以为模型坏了。 */
const POSE_RANGE: Record<keyof ProfilePose, [number, number]> = {
  armSpread: [0, 1], armForward: [0, 1], elbow: [0, 1], liveliness: [0, 2],
}

export const DEFAULT_TRANSFORM: ProfileTransform = { scale: 1, rotateY: 0, offsetY: 0 }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const fail = (zh: string, en: string): ParseResult => ({ ok: false, zh, en })

/** 路径字段的共同校验;返回错误或 null。`what` 是 {zh,en} 的字段称呼。 */
function checkPath(p: unknown, what: Msg, exts: readonly string[]): Msg | null {
  if (typeof p !== 'string' || !p.trim()) return { zh: `${what.zh}必须是非空的文件路径`, en: `${what.en} must be a non-empty file path` }
  if (!isSafeRel(p)) {
    return {
      zh: `${what.zh}「${p}」必须是相对 live3d.json 所在文件夹的路径(不能是绝对路径、网址,也不能用 .. 跳出文件夹)`,
      en: `${what.en} "${p}" must be relative to the folder that holds live3d.json (no absolute paths, URLs or ".." outside the folder)`,
    }
  }
  if (isLive2DPath(p)) return LIVE2D_REFUSAL
  const ext = extOf(p)
  if (!exts.includes(ext)) {
    const list = exts.map((e) => `.${e}`).join(' / ')
    return { zh: `${what.zh}「${p}」的格式不支持,只能是 ${list}`, en: `${what.en} "${p}" has an unsupported format; use ${list}` }
  }
  return null
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * 解析并校验 live3d.json。`dir` = 这份 profile 所在的库内文件夹(如 `Live3D/models/alice`)。
 * 成功:补齐缺省、解析出库内路径(modelPath / motionPaths);warnings 是不致命的提示(不认识的字段等)。
 */
export function parseProfile(text: string, dir: string): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    return fail(`live3d.json 不是合法的 JSON:${why}`, `live3d.json is not valid JSON: ${why}`)
  }
  if (!isObj(raw)) return fail('live3d.json 的最外层必须是一个对象 { … }', 'live3d.json must contain a JSON object { … } at the top level')

  const warnings: Msg[] = []
  if (raw.live3d !== 1) {
    return fail(
      `不认识的 profile 版本(live3d = ${JSON.stringify(raw.live3d)});本插件只读 "live3d": 1`,
      `Unsupported profile version (live3d = ${JSON.stringify(raw.live3d)}); this plugin reads "live3d": 1`,
    )
  }
  for (const k of Object.keys(raw)) {
    if (!KNOWN_TOP.has(k)) warnings.push({ zh: `忽略了不认识的字段「${k}」`, en: `Ignored unknown field "${k}"` })
  }

  // model
  if (raw.model === undefined) return fail('缺少 "model":要显示哪个模型文件?', 'Missing "model": which model file should be shown?')
  const modelErr = checkPath(raw.model, { zh: '"model" ', en: '"model"' }, MODEL_EXTS)
  if (modelErr) return { ok: false, ...modelErr }
  const model = normRel(raw.model as string)

  // name
  let name = stripExt(baseName(model))
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string') return fail('"name" 必须是文字', '"name" must be a string')
    if (raw.name.trim()) name = raw.name.trim()
  }

  // motions
  let motions: string[] = []
  if (raw.motions !== undefined) {
    if (!Array.isArray(raw.motions)) return fail('"motions" 必须是文件路径的数组,如 ["wave.vrma"]', '"motions" must be an array of file paths, e.g. ["wave.vrma"]')
    for (let i = 0; i < raw.motions.length; i++) {
      const err = checkPath(raw.motions[i], { zh: `"motions" 第 ${i + 1} 项`, en: `"motions" item ${i + 1}` }, MOTION_EXTS)
      if (err) return { ok: false, ...err }
    }
    motions = [...new Set((raw.motions as string[]).map(normRel))]
  }

  // agents(绑定)
  let agents: string[] = []
  if (raw.agents !== undefined && raw.agents !== null) {
    if (!Array.isArray(raw.agents)) return fail('"agents" 必须是 Agent slug 的数组,如 ["xyra"]', '"agents" must be an array of agent slugs, e.g. ["xyra"]')
    for (const a of raw.agents) {
      if (!isAgentSlug(a)) {
        return fail(
          `"agents" 里的 ${JSON.stringify(a)} 不是 Agent slug;slug 只能用小写字母、数字和连字符(如 "xyra")`,
          `${JSON.stringify(a)} in "agents" is not an agent slug; slugs use lower-case letters, digits and hyphens only (e.g. "xyra")`,
        )
      }
    }
    agents = [...new Set(raw.agents as string[])]
  }

  // transform
  const transform: ProfileTransform = { ...DEFAULT_TRANSFORM }
  if (raw.transform !== undefined) {
    const tr = raw.transform
    if (!isObj(tr)) return fail('"transform" 必须是对象,如 { "scale": 1, "rotateY": 0, "offsetY": 0 }', '"transform" must be an object, e.g. { "scale": 1, "rotateY": 0, "offsetY": 0 }')
    for (const k of Object.keys(tr)) {
      if (!KNOWN_TRANSFORM.has(k)) warnings.push({ zh: `忽略了 transform 里不认识的字段「${k}」`, en: `Ignored unknown field "${k}" in transform` })
    }
    if (tr.scale !== undefined) {
      if (!finite(tr.scale) || tr.scale <= 0 || tr.scale > 100) return fail('"transform.scale" 必须是大于 0、不超过 100 的数', '"transform.scale" must be a number above 0 and at most 100')
      transform.scale = tr.scale
    }
    if (tr.rotateY !== undefined) {
      if (!finite(tr.rotateY)) return fail('"transform.rotateY" 必须是数字(角度)', '"transform.rotateY" must be a number (degrees)')
      transform.rotateY = tr.rotateY
    }
    if (tr.offsetY !== undefined) {
      if (!finite(tr.offsetY) || Math.abs(tr.offsetY) > 10) return fail('"transform.offsetY" 必须是 -10 到 10 之间的数', '"transform.offsetY" must be a number between -10 and 10')
      transform.offsetY = tr.offsetY
    }
    if (tr.upAxis !== undefined) {
      if (tr.upAxis !== 'y' && tr.upAxis !== 'z') return fail('"transform.upAxis" 只能是 "y" 或 "z"', '"transform.upAxis" must be "y" or "z"')
      if (tr.upAxis === 'z') transform.upAxis = 'z'
    }
  }

  // framing
  let framing: Framing = 'bust'
  if (raw.framing !== undefined) {
    if (!(FRAMINGS as readonly unknown[]).includes(raw.framing)) {
      return fail('"framing" 只能是 "bust"(半身)、"full"(全身)或 "face"(脸部特写)', '"framing" must be "bust", "full" or "face"')
    }
    framing = raw.framing as Framing
  }

  // states
  const states: Partial<Record<Phase, StateSpec>> = {}
  if (raw.states !== undefined) {
    if (!isObj(raw.states)) return fail('"states" 必须是对象,键是阶段名(idle、thinking…)', '"states" must be an object keyed by phase (idle, thinking, …)')
    for (const [key, val] of Object.entries(raw.states)) {
      if (!isPhase(key)) {
        return fail(
          `"states" 里的「${key}」不是阶段名;可用:idle、thinking、speaking、tool、waiting、error、done`,
          `"${key}" in "states" is not a phase; use idle, thinking, speaking, tool, waiting, error or done`,
        )
      }
      if (val === null) continue
      if (!isObj(val)) return fail(`"states.${key}" 必须是对象`, `"states.${key}" must be an object`)
      const spec: StateSpec = {}
      for (const k of Object.keys(val)) {
        if (!KNOWN_STATE.has(k)) warnings.push({ zh: `忽略了 states.${key} 里不认识的字段「${k}」`, en: `Ignored unknown field "${k}" in states.${key}` })
      }
      if (val.clip !== undefined) {
        if (val.clip !== null && typeof val.clip !== 'string') return fail(`"states.${key}.clip" 必须是片段名或 null`, `"states.${key}.clip" must be a clip name or null`)
        spec.clip = val.clip === null ? null : (val.clip as string)
      }
      for (const f of ['expression', 'mouth'] as const) {
        if (val[f] === undefined) continue
        if (typeof val[f] !== 'string' || !(val[f] as string).trim()) return fail(`"states.${key}.${f}" 必须是非空文字`, `"states.${key}.${f}" must be a non-empty string`)
        spec[f] = (val[f] as string).trim()
      }
      if (val.weight !== undefined) {
        if (!finite(val.weight) || val.weight < 0 || val.weight > 1) {
          return fail(`"states.${key}.weight" 必须在 0 到 1 之间`, `"states.${key}.weight" must be between 0 and 1`)
        }
        spec.weight = val.weight
      }
      if (val.once !== undefined) {
        if (typeof val.once !== 'boolean') return fail(`"states.${key}.once" 必须是 true 或 false`, `"states.${key}.once" must be true or false`)
        spec.once = val.once
      }
      states[key] = spec
    }
  }

  // pose(程序化待机姿势的微调)
  const pose: ProfilePose = { ...DEFAULT_POSE }
  if (raw.pose !== undefined && raw.pose !== null) {
    const po = raw.pose
    if (!isObj(po)) return fail('"pose" 必须是对象,如 { "armSpread": 0.4 }', '"pose" must be an object, e.g. { "armSpread": 0.4 }')
    for (const k of Object.keys(po)) {
      if (!(k in POSE_RANGE)) warnings.push({ zh: `忽略了 pose 里不认识的字段「${k}」`, en: `Ignored unknown field "${k}" in pose` })
    }
    for (const k of Object.keys(POSE_RANGE) as Array<keyof ProfilePose>) {
      const v = po[k]
      if (v === undefined) continue
      const [lo, hi] = POSE_RANGE[k]
      if (!finite(v) || v < lo || v > hi) return fail(`"pose.${k}" 必须是 ${lo} 到 ${hi} 之间的数`, `"pose.${k}" must be a number between ${lo} and ${hi}`)
      pose[k] = v
    }
  }

  const d = normRel(dir)
  return {
    ok: true,
    warnings,
    value: {
      live3d: 1, name, model, motions, agents, transform, framing, states, pose,
      dir: d, modelPath: joinRel(d, model), motionPaths: motions.map((m) => joinRel(d, m)),
    },
  }
}

/** 只写 Profile 字段(剥掉 dir / modelPath / motionPaths),两格缩进 + 结尾换行。
 *  `agents` 与 `pose` **恒写出来**(哪怕是空 / 缺省):① 文件自己就把两个旋钮教给了看它的人和 agent;
 *  ② Desk 用这份序列化当「配置变没变」的键,少写一个字段 = 改了姿势却不重画。 */
export function serializeProfile(p: Profile | ResolvedProfile): string {
  const transform: ProfileTransform = { scale: p.transform.scale, rotateY: p.transform.rotateY, offsetY: p.transform.offsetY }
  if (p.transform.upAxis === 'z') transform.upAxis = 'z'
  const out: Profile = {
    live3d: 1,
    name: p.name,
    model: p.model,
    motions: [...p.motions],
    agents: [...p.agents],
    transform,
    framing: p.framing,
    states: p.states,
    pose: { ...p.pose },
  }
  return JSON.stringify(out, null, 2) + '\n'
}

/** 改一份已解析的 profile 的绑定(纯函数;写盘由调用方做)。slug 会去重、排序,非法 slug 直接丢掉。 */
export function withAgents<T extends Profile>(p: T, agents: readonly string[]): T {
  return { ...p, agents: [...new Set(agents.filter(isAgentSlug))].sort() }
}

/**
 * 导入时的缺省 profile。`fileName` = 模型文件相对 profile 文件夹的路径(通常就是文件名);
 * `analysis` 在手就按它给 states / 构图 / 竖轴建议;`motions` = 一并导入的动作文件(相对路径)。
 */
export function defaultProfileFor(fileName: string, analysis?: Analysis | null, motions: string[] = []): Profile {
  const model = normRel(fileName)
  const humanoid = !!analysis && (!!analysis.vrm || !!analysis.bones.head)
  const transform: ProfileTransform = { ...DEFAULT_TRANSFORM }
  if (analysis && analysis.format === 'obj' && guessUpAxis(analysis.size) === 'z') transform.upAxis = 'z'
  // 「高」按摆正之后的竖轴算(Z-up 的 OBJ 躺着时 Y 是厚度)。
  const [sx, sy, sz] = analysis ? analysis.size : [0, 0, 0]
  const tall = !!analysis && (transform.upAxis === 'z' ? sz > Math.max(sx, sy) * 1.2 : sy > Math.max(sx, sz) * 1.2)
  return {
    live3d: 1,
    name: analysis?.vrm?.title?.trim() || stripExt(baseName(model)),
    model,
    motions: motions.map(normRel),
    agents: [],
    transform,
    framing: humanoid || tall ? 'bust' : 'full',
    states: analysis ? suggestStates(analysis) : {},
    pose: { ...DEFAULT_POSE },
  }
}
