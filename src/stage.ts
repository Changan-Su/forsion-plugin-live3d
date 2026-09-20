// Live3D 舞台:一个 WebGL 渲染器 + 一个形象(导入的模型,或缺省小球),跟着 agent 状态做反应。
//
// 用法(P2 的 index.ts):
//   const stage = createStage({ surface: 'card', interactive: false, assetUrl })
//   stage.attach(el)                          // el = 宿主给的容器(已撑满、position:relative)
//   await stage.setProfile(resolved | null)   // null = 缺省小球
//   host.onStatus((s) => stage.setStatus(s)); stage.setStatusSource(() => host.status())
//   … stage.dispose()
// 一个 stage 可以在卡片 / 侧板之间搬家:detach() 后 attach(另一个 el, { surface: 'panel' }),
// 模型与 GL 上下文都不重建(Chromium 同时最多 ~16 个上下文,能复用就复用)。
//
// 几条会静默出错的约束(desk.md §d、formats.md §5/§6):
//  - 卡片正文有 CSS zoom:0.75。画布 CSS 一律 100%/100%,绘图缓冲 = getBoundingClientRect(视觉像素,已含 zoom)
//    × pixelRatio(min(dpr,1.5));setSize 的 updateStyle 必须是 false,否则 three 会把 style 写成局部像素、只填 3/4。
//    ⚠️setSize 内部已经乘 pixelRatio —— 传 rect 尺寸即可,别再自己乘 dpr(否则缓冲是 dpr² 倍)。
//  - 卡片 pointer-events:none —— 视线跟指针用 window 级 pointermove,经画布 rect 换算,和卡片收不收事件无关。
//  - 看不见就别画:尺寸为 0 / IntersectionObserver 不相交 / document.hidden / 上下文丢失 → 停 rAF;卡片封顶 30fps。
//    dt 只钳长间隔(MAX_DT = 0.1s,更长的卡顿按「恢复」处理:dt=0 + 重置 VRM 弹簧骨,否则头发炸开)——
//    ⚠️别再钳到 1/30:卡片封顶后 50/75/100Hz 屏的帧距是 40ms,钳成 33ms 动画就慢放 17%。弹簧骨按 ≤1/30 分步。
//  - 每帧骨骼顺序:**基准姿势还原**(不是静止姿势!)→ mixer.update → 记下 mixer 的输出当新基准 → 程序化骨骼 / 表情 → vrm.update。
//    ⚠️别改回「每帧复位到静止姿势」:three 的 PropertyMixer 只在混合值**变了**才写骨骼,值不变的帧(常量轨 / 单帧
//    .vrma / 关键帧停顿 / 恢复后 dt=0 的第一帧)骨骼就停在静止姿势 —— T-pose 闪一帧或整段 T-pose。

import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm'
import type { AgentStatusLike, Analysis, Framing, Msg, Phase, ResolvedProfile } from './contract'
import { DEFAULT_POSE, isPhase } from './contract'
import { analyze, measure } from './analysis'
import { findMorphs, findRigBones, type RigRole } from './heuristics'
import { loadModel, toMsg, type LoadErrorCode, type LoadedModel, type LoadModelOptions } from './loaders'
import { createMouthEnvelope, mouthFlap, planFor, PROC, type Caps, type ProcPlan, type ReactionPlan } from './reactions'
import { createOrb, readAccent, type Orb } from './orb'

// ── 公共类型 ──────────────────────────────────────────────────────────────────
export type StageSurface = 'card' | 'panel' | 'studio'

export interface StageOptions {
  surface: StageSurface
  /** 面板 / 工作室:拖拽绕 Y 转、滚轮缩放、双击复位。卡片没有交互。 */
  interactive: boolean
  /** 库内相对路径 → URL(ctx.app.assetUrl,缺省 amadeus-asset://v/…)。 */
  assetUrl: (rel: string) => string
  /** 可选:换掉读字节的方式(比如 ctx.app.readBytes)。 */
  readBytes?: LoadModelOptions['readBytes']
  /** 小球颜色(CSS 颜色);缺省读宿主 --accent。 */
  accent?: string
}

export type SetProfileResult =
  | { ok: true; analysis: Analysis | null }
  | ({ ok: false; code: LoadErrorCode | 'superseded' | 'disposed' } & Msg)

export interface Stage {
  /** 把画布挂进 el(会先从旧容器摘下)。o 可顺便切换卡片 / 侧板形态。 */
  attach(el: HTMLElement, o?: { surface?: StageSurface; interactive?: boolean }): void
  /** 摘下画布、停渲染;模型与 GL 上下文保留,可再 attach。 */
  detach(): void
  /** 换形象。null = 缺省小球。同一模型 + 同一组动作只重套 states / transform / framing,不重载。
   *  加载失败 → 显示小球并返回 {ok:false};被更新的调用取代 → {ok:false, code:'superseded'}(调用方忽略即可)。 */
  setProfile(p: ResolvedProfile | null): Promise<SetProfileResult>
  /** 推一份状态(宿主 onStatus 回调里调)。只在 phase 变化时换反应。 */
  setStatus(s: AgentStatusLike): void
  /** 说话期间逐帧拉取 textChars 做口型(宿主 host.status)。null = 取消,口型退回合成的一张一合。 */
  setStatusSource(fn: (() => AgentStatusLike) | null): void
  /** 工作室「试一下」:强制显示某阶段(null = 回到真实状态)。 */
  previewPhase(phase: Phase | null): void
  /** 正面 512×512 PNG(preview.png);没有上下文时 null。 */
  snapshot(): Promise<Blob | null>
  /** 当前模型的体检结果;小球 / 未加载时 null。 */
  currentAnalysis(): Analysis | null
  dispose(): void
}

// ── 形象接口(小球与模型共用;orb.ts 实现一份) ─────────────────────────────────
/** 构图锚点:形象在「舞台根」坐标系里的包围盒与头部位置(归一化、profile 变换之后)。 */
export interface Anchors {
  box: THREE.Box3
  head?: THREE.Vector3
  /** 像人(有头骨 / 瘦高):bust / face 构图才有意义。 */
  humanoid: boolean
}

/** 每帧喂给形象的输入(stage 算好,形象只管表现)。角度都在形象自己的朝向系里(+Z 朝镜头)。 */
export interface FrameInput {
  t: number
  dt: number
  /** 视线(弧度):yaw 正 = 看向观众右手边,pitch 正 = 往上看。已钳制、已平滑。 */
  look: { yaw: number; pitch: number }
  /** 这一帧的张嘴量 0..1。 */
  mouth: number
  /** 平滑后的程序化参数。 */
  proc: ProcPlan
  /** prefers-reduced-motion。 */
  reduced: boolean
}

export interface Avatar {
  root: THREE.Object3D
  anchors: Anchors
  caps: Caps
  applyPlan(plan: ReactionPlan): void
  update(f: FrameInput): void
  /** 恢复渲染后的第一帧(弹簧骨复位等)。 */
  onResume?(): void
  /** profile 的 states 变了(同一模型、同一摆放):一次性片段播完回哪个 idle 片段要跟着变。 */
  setStates?(states: ResolvedProfile['states']): void
  /** profile 的 pose 变了:就地换掉待机姿势的几个数,**不重载模型**(25MB 的 PMX 重载要好几秒,
   *  而调姿势天生是「改一个数看一眼」的来回)。 */
  setPose?(pose: ResolvedProfile['pose']): void
  dispose(): void
}

// ── 小工具 ────────────────────────────────────────────────────────────────────
const DEG = Math.PI / 180
const TARGET_HEIGHT = 1.6
/** 单帧 dt 上限:低帧率(10fps)也按真实时间走。 */
const MAX_DT = 0.1
/** 超过这么久没出帧(卡顿、被节流)按「恢复」处理:dt=0,弹簧骨复位。 */
const RESUME_GAP = 0.5
/** 弹簧骨单步上限:dt 大于它就分几步推,免得头发 / 裙子一步冲过头。 */
const SPRING_STEP = 1 / 30

/** 这一帧该推进多少秒(纯函数,单测钉住)。resume = 按「恢复」处理(dt=0 + 弹簧骨复位)。 */
export function frameDelta(raw: number): { dt: number; resume: boolean } {
  if (!(raw >= 0)) return { dt: 0, resume: true }
  if (raw > RESUME_GAP) return { dt: 0, resume: true }
  return { dt: Math.min(raw, MAX_DT), resume: false }
}
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)
const damp = (cur: number, target: number, rate: number, dt: number): number => cur + (target - cur) * (1 - Math.exp(-rate * dt))
const _q = new THREE.Quaternion()
const _q2 = new THREE.Quaternion()
const _qp = new THREE.Quaternion()
const _e = new THREE.Euler()
const _v = new THREE.Vector3()
const _v2 = new THREE.Vector3()

/** 在「朝向系」F 里定义的旋转 dLocal,作用到骨骼上(绕骨骼自身支点):L' = P⁻¹·(F·d·F⁻¹)·P·L。
 *  和骨骼本地轴怎么摆无关 —— Mixamo / VRoid / VRM0 / VRM1 的骨骼都能用同一套角度。 */
function rotateInFacing(bone: THREE.Object3D, facing: THREE.Quaternion, dLocal: THREE.Quaternion): void {
  const parent = bone.parent
  if (parent) parent.getWorldQuaternion(_qp)
  else _qp.identity()
  _q.copy(facing).multiply(dLocal).multiply(_q2.copy(facing).invert()) // 世界系的 D
  const pInv = _q2.copy(_qp).invert()
  bone.quaternion.premultiply(_qp).premultiply(_q).premultiply(pInv)
}

const eulerQ = (x: number, y: number, z: number): THREE.Quaternion => new THREE.Quaternion().setFromEuler(_e.set(x, y, z, 'YXZ'))

// ── 模型形象 ──────────────────────────────────────────────────────────────────
interface ModelAvatarOptions {
  loaded: LoadedModel
  profile: ResolvedProfile
}

/** 骨骼集合:VRM 用归一化骨骼,其它按名字启发式。 */
type BoneSet = Partial<Record<RigRole, THREE.Object3D>>

const VRM_ROLE: Record<RigRole, VRMHumanBoneName> = {
  hips: 'hips', spine: 'spine', chest: 'chest', neck: 'neck', head: 'head',
  leftUpperArm: 'leftUpperArm', rightUpperArm: 'rightUpperArm', leftLowerArm: 'leftLowerArm', rightLowerArm: 'rightLowerArm',
  leftHand: 'leftHand', rightHand: 'rightHand',
}

function createModelAvatar({ loaded, profile }: ModelAvatarOptions): Avatar {
  const vrm: VRM | undefined = loaded.vrm
  const model = loaded.root

  // 层级:pivot(整体程序化)→ xf(profile 变换)→ norm(归一化)→ turn(自动转身)→ upfix(Z-up 纠正)→ 模型
  const pivot = new THREE.Group()
  pivot.name = 'live3d-pivot'
  const xf = new THREE.Group()
  const norm = new THREE.Group()
  const turn = new THREE.Group()
  const upfix = new THREE.Group()
  pivot.add(xf)
  xf.add(norm)
  norm.add(turn)
  turn.add(upfix)
  upfix.add(model)
  if (profile.transform.upAxis === 'z') upfix.rotation.x = -Math.PI / 2

  // 骨骼
  const bones: BoneSet = {}
  if (vrm?.humanoid) {
    for (const role of Object.keys(VRM_ROLE) as RigRole[]) {
      const n = vrm.humanoid.getNormalizedBoneNode(VRM_ROLE[role])
      if (n) bones[role] = n
    }
    if (!bones.chest) {
      const up = vrm.humanoid.getNormalizedBoneNode('upperChest')
      if (up) bones.chest = up
    }
  } else {
    const found = findRigBones([...loaded.bones.keys()])
    for (const role of Object.keys(found) as RigRole[]) {
      const b = loaded.bones.get(found[role]!)
      if (b) bones[role] = b
    }
  }
  // 自动转身:glTF 约定正面 = +Z,但不少模型(比如 three.js 的 Soldier.glb)是背对 +Z 导出的。有左右臂骨时
  // 按「左臂在 +X」判断(面朝 +Z 的角色左手在观众右边);左臂跑到 -X = 背对镜头 → 转 180°。VRM 已由 rotateVRM0 处理。
  if (!vrm && bones.leftUpperArm && bones.rightUpperArm) {
    turn.updateMatrixWorld(true)
    const lx = bones.leftUpperArm.getWorldPosition(new THREE.Vector3()).x
    const rx = bones.rightUpperArm.getWorldPosition(new THREE.Vector3()).x
    if (lx < rx) turn.rotation.y = Math.PI
  }
  const procBones = [...new Set(Object.values(bones))].filter((b): b is THREE.Object3D => !!b)
  const rest = new Map(procBones.map((b) => [b, b.quaternion.clone()] as const))
  const hasHead = !!bones.head

  // 片段 & mixer
  const mixer = new THREE.AnimationMixer(model)
  const clipByName = new Map(loaded.clips.map((c) => [c.name, c] as const))
  const clipNodes = new Map<THREE.AnimationClip, Set<string>>()
  for (const c of loaded.clips) {
    const s = new Set<string>()
    for (const tr of c.tracks) {
      try {
        s.add(THREE.PropertyBinding.parseTrackName(tr.name).nodeName)
      } catch {
        /* 忽略 */
      }
    }
    clipNodes.set(c, s)
  }

  // 表情 / morph
  const exprNames = vrm ? vrm.expressionManager?.expressions.map((e) => e.expressionName) ?? [] : loaded.morphNames
  const mouthMorph = vrm ? undefined : findMorphs('mouth', loaded.morphNames)[0]
  const blinkNames = vrm ? (vrm.expressionManager?.getExpression('blink') ? ['blink'] : []) : findMorphs('blink', loaded.morphNames)
  const caps: Caps = { clips: loaded.clips.map((c) => c.name), expressions: exprNames, vrm: !!vrm, mouthMorph }
  const morphSlots = new Map<string, Array<{ mesh: THREE.Mesh; i: number }>>()
  for (const mesh of loaded.morphMeshes) {
    for (const [name, i] of Object.entries(mesh.morphTargetDictionary ?? {})) {
      const list = morphSlots.get(name) ?? []
      list.push({ mesh, i })
      morphSlots.set(name, list)
    }
  }
  const setWeight = (name: string, w: number): void => {
    if (vrm) vrm.expressionManager?.setValue(name, w)
    else for (const { mesh, i } of morphSlots.get(name) ?? []) if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[i] = w
  }

  let states = profile.states
  // `?? DEFAULT_POSE`:类型上 pose 是必填,但手搭 profile 的台架(render-smoke-rig / shell-smoke)与旧宿主留下的
  // 内存对象可能没有它 —— 少一个字段不该让整个形象崩掉。
  let pose = profile.pose ?? DEFAULT_POSE

  // ── 摆姿势量尺寸:idle 片段第 0 帧(没有就绑定姿势)→ 包围盒 → 归一化 ──
  const idleName = planFor('idle', states, caps).clip?.name
  const idleClip = idleName ? clipByName.get(idleName) : undefined
  if (idleClip) {
    mixer.clipAction(idleClip).play()
    mixer.update(0)
  }
  vrm?.update(0)
  turn.updateMatrixWorld(true)
  const box = measure(turn)
  mixer.stopAllAction()
  mixer.uncacheRoot(model)
  for (const [b, q] of rest) b.quaternion.copy(q)
  if (box.isEmpty()) box.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5))
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const s = TARGET_HEIGHT / Math.max(size.y, 0.6 * Math.max(size.x, size.z), 1e-6)
  norm.scale.setScalar(s)
  norm.position.set(-center.x * s, -box.min.y * s, -center.z * s)
  xf.scale.setScalar(profile.transform.scale)
  xf.rotation.y = profile.transform.rotateY * DEG
  xf.position.y = profile.transform.offsetY
  pivot.updateMatrixWorld(true)

  const nbox = box.clone().applyMatrix4(norm.matrix).applyMatrix4(xf.matrix)
  let head: THREE.Vector3 | undefined
  if (bones.head) {
    if (idleClip) {
      mixer.clipAction(idleClip).play()
      mixer.update(0)
      vrm?.update(0)
    }
    pivot.updateMatrixWorld(true)
    head = bones.head.getWorldPosition(new THREE.Vector3())
    mixer.stopAllAction()
    for (const [b, q] of rest) b.quaternion.copy(q)
  }
  const nsize = nbox.getSize(new THREE.Vector3())
  const anchors: Anchors = { box: nbox, head, humanoid: hasHead || nsize.y > 1.2 * Math.max(nsize.x, nsize.z) }
  // 每帧的「基准姿势」:起初 = 静止姿势,之后 = 上一帧 mixer 的输出(见顶注:mixer 只在值变了才写骨骼)。
  const base = new Map([...rest].map(([b, q]) => [b, q.clone()] as const))

  // ── 运行时状态 ──
  let plan: ReactionPlan = planFor('idle', states, caps, null)
  let pendingClip: ReactionPlan['clip'] | null | undefined = plan.clip ?? null // undefined = 没有待处理
  let current: THREE.AnimationAction | null = null
  let currentOnce = false
  let first = true
  const exprCur = new Map<string, number>()
  /** 口型上一次驱动的通道:说完话 / 换了口型通道后要把它收回 0(非 VRM 的 jawOpen、VRM 的自定义 mouth 没人替它归零)。 */
  let lastMouth: string | undefined
  let lastMouthW = 0
  let nextBlink = 1.2
  let blinkStart = -1
  let saccade = { yaw: 0, pitch: 0, next: 0 }
  const lookTarget = new THREE.Object3D()
  pivot.add(lookTarget)
  if (vrm?.lookAt) vrm.lookAt.target = lookTarget
  const facing = new THREE.Quaternion()

  const onFinished = (e: { action: THREE.AnimationAction }): void => {
    if (e.action !== current || !currentOnce) return
    const back = planFor('idle', states, caps, null).clip
    pendingClip = back ?? null
  }
  mixer.addEventListener('finished', onFinished as never)

  const startClip = (req: ReactionPlan['clip'] | null): void => {
    if (!req) {
      current?.fadeOut(0.35)
      current = null
      currentOnce = false
      return
    }
    const clip = clipByName.get(req.name)
    if (!clip) return
    const action = mixer.clipAction(clip)
    if (action === current && !req.restart && action.isRunning()) return
    action.reset()
    action.setLoop(req.once ? THREE.LoopOnce : THREE.LoopRepeat, req.once ? 1 : Infinity)
    action.clampWhenFinished = req.once
    action.enabled = true
    action.setEffectiveTimeScale(1)
    action.setEffectiveWeight(1)
    if (first || action === current) action.play() // 首个片段直接满权重(不从 T-pose 淡入);同一片段重播不闪
    else {
      action.fadeIn(0.35).play()
      current?.fadeOut(0.35)
    }
    first = false
    current = action
    currentOnce = req.once
  }

  /** 正在控制某根骨骼的片段总权重(0..1),用来让程序化手臂姿势给片段让位。
   *  算「在 mixer 里、启用着」的动作,不是 isRunning():一次性片段播完停在末帧(clampWhenFinished → paused)时仍然
   *  压着骨骼,淡出的 0.35s 里权重逐帧降 —— 只数 running 的话手臂会在播完那一帧一下子掉下来。 */
  const clipWeightOn = (bone: THREE.Object3D | undefined): number => {
    if (!bone) return 0
    let w = 0
    for (const [clip, nodes] of clipNodes) {
      if (!nodes.has(bone.name)) continue
      const a = mixer.existingAction(clip)
      if (a && a.enabled && a.isScheduled()) w += a.getEffectiveWeight()
    }
    return clamp(w, 0, 1)
  }

  const armDir = new THREE.Vector3()
  const _side = new THREE.Vector3(1, 0, 0)
  /** 手肘最多弯多少(pose.elbow = 1 时)。再大手就戳到肚子上了。 */
  const MAX_ELBOW = 75 * DEG
  /**
   * 手臂放下(在朝向系里算方向,VRM0 的符号翻转隐含在其中)。T-pose / A-pose 都收敛到同一个垂手姿势。
   * 三个 profile 旋钮:armSpread(离身侧多远)、armForward(往前摆多少)、elbow(手肘弯多少,**相对上臂**算,
   * 所以调前摆不会连带把手肘掰直)。
   * `drift` 是这一帧的缓慢漂移:没有它,手臂每帧都被解到同一个方向上,只有躯干在呼吸 —— 看起来就是个挂在
   * 衣架上的人偶,正是用户说的「默认动作很怪」(2026-09-20)。两侧用不同周期,永远不同步。
   */
  const relaxArm = (
    upper: THREE.Object3D | undefined, lower: THREE.Object3D | undefined, hand: THREE.Object3D | undefined,
    side: 1 | -1, w: number, drift: { spread: number; forward: number },
  ): void => {
    if (!upper || !lower || w <= 0.001) return
    const p0 = upper.getWorldPosition(_v)
    const p1 = lower.getWorldPosition(_v2)
    armDir.subVectors(p1, p0)
    if (armDir.lengthSq() < 1e-10) return
    armDir.normalize()
    const spread = clamp(pose.armSpread + drift.spread, 0, 1.2)
    const fwd = clamp(pose.armForward + drift.forward, -0.2, 1.2)
    const upLocal = new THREE.Vector3(side * spread, -1, fwd).normalize()
    const target = upLocal.clone().applyQuaternion(facing)
    const d = new THREE.Quaternion().setFromUnitVectors(armDir, target)
    const dLocal = facing.clone().invert().multiply(d).multiply(facing) // 世界 → 朝向系
    rotateInFacing(upper, facing, new THREE.Quaternion().slerp(dLocal, w))
    if (hand) {
      const q0 = lower.getWorldPosition(new THREE.Vector3())
      const q1 = hand.getWorldPosition(new THREE.Vector3())
      const fore = q1.sub(q0)
      if (fore.lengthSq() > 1e-10) {
        fore.normalize()
        // 前臂 = 上臂方向绕左右轴往镜头方向转 elbow(绕 +X 取负角 = 往 +Z 转)。
        const t2 = upLocal.clone().applyAxisAngle(_side, -pose.elbow * MAX_ELBOW).normalize().applyQuaternion(facing)
        const d2 = new THREE.Quaternion().setFromUnitVectors(fore, t2)
        const d2Local = facing.clone().invert().multiply(d2).multiply(facing)
        rotateInFacing(lower, facing, new THREE.Quaternion().slerp(d2Local, w * 0.9))
      }
    }
  }

  /** 这一帧某只手臂的漂移量。周期取互质的秒数,左右再错开相位。amp = liveliness × 减弱动效系数。 */
  const armDrift = (t: number, side: 1 | -1, amp: number): { spread: number; forward: number } => {
    if (amp <= 0) return { spread: 0, forward: 0 }
    const L = side > 0
    return {
      spread: Math.sin((t * 2 * Math.PI) / (L ? 7.3 : 9.1) + (L ? 0 : 1.7)) * 0.05 * amp,
      forward: Math.sin((t * 2 * Math.PI) / (L ? 11.4 : 8.6) + (L ? 2.1 : 0.4)) * 0.06 * amp,
    }
  }

  return {
    root: pivot,
    anchors,
    caps,
    applyPlan(p: ReactionPlan) {
      const prevClip = plan.clip
      plan = p
      const same = prevClip && p.clip && prevClip.name === p.clip.name && !p.clip.restart
      if (!same || !current) pendingClip = p.clip ?? null
    },
    onResume() {
      vrm?.springBoneManager?.reset()
    },
    setStates(st) {
      states = st
    },
    setPose(p) {
      pose = p ?? DEFAULT_POSE
    },
    update(f: FrameInput) {
      const { t, dt, proc } = f
      const k = (f.reduced ? 0.35 : 1) * pose.liveliness

      // ① 还原基准姿势(撤掉上一帧叠的程序化旋转)→ 片段切换 → mixer → 记下 mixer 的输出当新基准。
      //    mixer 这一帧没写的骨骼(值没变)保持上一帧的片段姿势;没有片段绑定的骨骼基准一直是静止姿势;
      //    片段淡出时 mixer 混回它存的「原始状态」,基准跟着回去。程序化旋转在记录之后才叠,不会累积。
      for (const [b, q] of base) b.quaternion.copy(q)
      if (pendingClip !== undefined) {
        startClip(pendingClip)
        pendingClip = undefined
      }
      mixer.update(dt)
      for (const [b, q] of base) q.copy(b.quaternion)
      pivot.updateMatrixWorld(true)
      xf.getWorldQuaternion(facing)

      // ② 程序化:手臂 → 躯干 → 头
      relaxArm(bones.leftUpperArm, bones.leftLowerArm, bones.leftHand, 1, 1 - clipWeightOn(bones.leftUpperArm), armDrift(t, 1, k))
      relaxArm(bones.rightUpperArm, bones.rightLowerArm, bones.rightHand, -1, 1 - clipWeightOn(bones.rightUpperArm), armDrift(t, -1, k))
      const breath = Math.sin(t * Math.PI * 2 / 4.2)
      const sway = Math.sin(t * Math.PI * 2 / 6.3) * 0.02 * proc.sway * k
      const lean = 0.12 * proc.droop
      if (bones.spine) rotateInFacing(bones.spine, facing, eulerQ(lean * 0.5 + breath * 0.012 * k, 0, sway))
      if (bones.chest) rotateInFacing(bones.chest, facing, eulerQ(lean * 0.5 + breath * 0.018 * k, f.look.yaw * 0.08, sway * 0.5))
      const nod = Math.sin(t * Math.PI * 2 * 1.7) * 0.07 * proc.nod * k
      const droopPitch = 0.3 * proc.droop
      const yaw = f.look.yaw
      const pitch = f.look.pitch
      if (bones.neck) rotateInFacing(bones.neck, facing, eulerQ(-pitch * 0.35 + droopPitch * 0.4 + nod * 0.4, yaw * 0.35, proc.headTilt * 0.3))
      if (bones.head) rotateInFacing(bones.head, facing, eulerQ(-pitch * 0.5 + droopPitch * 0.6 + nod * 0.6, yaw * 0.55, proc.headTilt * 0.7))

      // 没有头骨的模型:整个转向指针 + 呼吸缩放 + 轻晃
      const hop = Math.abs(Math.sin(t * Math.PI * 2.2)) * 0.06 * proc.bounce * k
      const bob = Math.sin(t * Math.PI * 2 * 3.1) * 0.008 * proc.bob * k
      pivot.position.y = hop + bob
      if (!hasHead) {
        pivot.rotation.set(-pitch * 0.2 + 0.08 * proc.droop, clamp(yaw * 0.45, -15 * DEG, 15 * DEG), sway * 1.2 + proc.headTilt * 0.25)
        pivot.scale.set(1, 1 + breath * 0.01 * k, 1)
      }

      // ③ 视线目标(VRM 眼睛):头的位置沿视线方向 1m,叠一点扫视
      if (t > saccade.next) {
        saccade = { yaw: (Math.random() - 0.5) * 0.08, pitch: (Math.random() - 0.5) * 0.05, next: t + 0.7 + Math.random() * 2 }
      }
      if (vrm?.lookAt && bones.head) {
        pivot.updateMatrixWorld(true)
        const hp = bones.head.getWorldPosition(new THREE.Vector3())
        const y = yaw + saccade.yaw
        const p = pitch + saccade.pitch
        const dir = new THREE.Vector3(Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)).applyQuaternion(facing)
        lookTarget.parent?.worldToLocal(lookTarget.position.copy(hp).addScaledVector(dir, 1))
      }

      // ④ 表情:目标权重平滑;眨眼;口型
      const targets = plan.expressions
      for (const name of new Set([...exprCur.keys(), ...Object.keys(targets)])) {
        const v = damp(exprCur.get(name) ?? 0, targets[name] ?? 0, 6, dt)
        exprCur.set(name, v)
        setWeight(name, v)
        if (v < 0.001 && !(name in targets)) exprCur.delete(name)
      }
      if (t >= nextBlink && blinkStart < 0) blinkStart = t
      let blink = 0
      if (blinkStart >= 0) {
        const bt = (t - blinkStart) / (plan.phase === 'thinking' ? 0.24 : 0.13)
        if (bt >= 1) {
          blinkStart = -1
          nextBlink = t + 2 + Math.random() * 4
        } else blink = Math.sin(bt * Math.PI)
      }
      for (const b of blinkNames) if (!(b in targets)) setWeight(b, blink)
      // 口型:不说话了 / 换了通道 → 上一次驱动的通道平滑收回 0(它若同时是表情目标,交给上面的表情循环)
      if (lastMouth && lastMouth !== plan.mouth) {
        if (!(lastMouth in targets)) {
          lastMouthW = damp(lastMouthW, 0, 14, dt)
          setWeight(lastMouth, lastMouthW)
          if (lastMouthW < 0.001) {
            setWeight(lastMouth, 0)
            lastMouth = undefined
          }
        } else lastMouth = undefined
      }
      if (plan.mouth) {
        setWeight(plan.mouth, f.mouth)
        lastMouth = plan.mouth
        lastMouthW = f.mouth
      } else if (vrm) setWeight('aa', 0)

      // ⑤ VRM:归一化骨骼 → 原始骨骼、看向、表情、弹簧骨(dt 大就分步,弹簧骨一步不超过 SPRING_STEP)
      if (vrm) {
        const n = Math.max(1, Math.ceil(dt / SPRING_STEP - 1e-6))
        for (let i = 0; i < n; i++) vrm.update(dt / n)
      }
      loaded.tick?.(dt)
    },
    dispose() {
      mixer.removeEventListener('finished', onFinished as never)
      mixer.stopAllAction()
      mixer.uncacheRoot(model)
      pivot.removeFromParent()
      upfix.remove(model)
      turn.clear()
      loaded.dispose()
    },
  }
}

// ── 构图 ──────────────────────────────────────────────────────────────────────
function frameCamera(camera: THREE.PerspectiveCamera, a: Anchors, framing: Framing, zoom: number): void {
  const box = a.box
  const H = Math.max(1e-3, box.max.y - box.min.y)
  const W = Math.max(box.max.x - box.min.x, 1e-3)
  const cx = (box.min.x + box.max.x) / 2
  const cz = (box.min.z + box.max.z) / 2
  const top = box.max.y
  const headY = a.head ? Math.min(a.head.y, top) : a.humanoid ? top - 0.12 * H : null
  // 头的尺度 = 头骨关节到头顶的距离(真人 ≈ 0.12H;Q 版 / 机器人大头能到 0.35H)。构图按它算,而不是按身高比例 ——
  // 否则大头模型的半身像只拍到下巴。
  const hs = headY === null ? 0 : Math.max(top - headY, 0.06 * H)
  let lo: number
  let hi: number
  let needW: number
  const mode = headY === null ? 'full' : framing
  if (mode === 'bust' && headY !== null) {
    hi = top + 0.3 * hs
    lo = headY - 2.6 * hs
    needW = Math.min(W, 2.4 * hs) // 肩宽 ≈ 2.2 个头(绑定姿势的 T 字臂展不算)
  } else if (mode === 'face' && headY !== null) {
    hi = top + 0.22 * hs
    lo = headY - 0.7 * hs
    needW = 1.9 * hs
  } else {
    hi = top
    lo = box.min.y
    needW = a.humanoid ? Math.min(W, 0.6 * H) : W
  }
  // 拍到的范围不超过全身;全身时上下各留 5%。
  if (hi - lo >= H) {
    hi = top
    lo = box.min.y
  }
  const full = hi === top && lo === box.min.y
  let V = (hi - lo) * (full ? 1.1 : 1)
  needW *= 1.1
  V = Math.max(V, needW / Math.max(camera.aspect, 0.2)) / zoom
  // 全身居中;半身 / 特写钉住头顶(宽度不够而拉远时往下多拍,不在头顶上方留一大片空)
  const centerY = full ? (hi + lo) / 2 : hi - V / 2
  const d = V / 2 / Math.tan((camera.fov * DEG) / 2)
  camera.position.set(cx, centerY, box.max.z + d)
  camera.lookAt(cx, centerY, cz)
  camera.near = Math.max(0.01, d / 50)
  camera.far = d * 50 + (box.max.z - box.min.z)
  camera.updateProjectionMatrix()
}

// ── 舞台 ──────────────────────────────────────────────────────────────────────
export function createStage(opts: StageOptions): Stage {
  let surface: StageSurface = opts.surface
  let interactive = opts.interactive

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' })
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.5))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.setClearColor(0x000000, 0)
  const canvas = renderer.domElement
  canvas.className = 'live3d-canvas'
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;outline:none;'

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100)
  const pmrem = new THREE.PMREMGenerator(renderer)
  let envRT = pmrem.fromScene(new RoomEnvironment(), 0.04)
  scene.environment = envRT.texture
  scene.environmentIntensity = 0.55
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.1)
  const key = new THREE.DirectionalLight(0xffffff, 2.2)
  key.position.set(1.2, 2.2, 2.4)
  const fill = new THREE.DirectionalLight(0xffffff, 0.6)
  fill.position.set(-2, 1, 1)
  scene.add(hemi, key, fill)

  const stageRoot = new THREE.Group() // 用户拖拽转向作用在它上
  scene.add(stageRoot)

  let avatar: Avatar = createOrb(opts.accent ?? readAccent())
  let isOrb = true
  // 小球颜色跟宿主强调色走:--accent 随配色(data-skin)/ 明暗 / 自定义色(:root 内联 style)变。Desk 舞台一活就是
  // 一整程,只在创建时读一次的话换了配色小球还是旧颜色 —— 挂上时重读一次,挂着期间盯 <html> 的这几个属性。
  let accentNow = opts.accent ?? readAccent()
  const syncAccent = (): void => {
    if (opts.accent !== undefined || !isOrb || disposed) return
    const a = readAccent()
    if (a === accentNow) return
    accentNow = a
    ;(avatar as Orb).setAccent?.(a)
  }
  let accentQueued = false
  const accentMo =
    opts.accent === undefined && typeof MutationObserver === 'function'
      ? new MutationObserver(() => {
          // 宿主换配色是一串属性 / 内联变量一起写:攒到微任务里读一次
          if (accentQueued) return
          accentQueued = true
          queueMicrotask(() => {
            accentQueued = false
            syncAccent()
          })
        })
      : null
  stageRoot.add(avatar.root)
  let profile: ResolvedProfile | null = null
  let loadedKey = ''
  let analysis: Analysis | null = null
  let gen = 0
  let disposed = false

  // 状态
  let status: AgentStatusLike = { phase: 'idle', sessionId: null, textChars: 0 }
  let source: (() => AgentStatusLike) | null = null
  let preview: Phase | null = null
  let phase: Phase = 'idle'
  let plan: ReactionPlan = planFor('idle', undefined, avatar.caps, null)
  const env = createMouthEnvelope()
  const proc: ProcPlan = { ...PROC.idle }
  const look = { yaw: 0, pitch: 0 }
  const reducedMq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null

  const framing = (): Framing => (isOrb ? 'full' : profile?.framing ?? 'bust')
  const applyPhase = (next: Phase, force = false): void => {
    if (next === phase && !force) return
    const prev = phase
    phase = next
    plan = planFor(next, isOrb ? undefined : profile?.states, avatar.caps, prev)
    avatar.applyPlan(plan)
    if (next !== 'speaking') env.reset()
  }

  // 交互 / 指针
  let pointer: { x: number; y: number; t: number } | null = null
  let userYaw = 0
  let userYawTarget = 0
  let zoom = 1
  let zoomTarget = 1
  let drag: { id: number; x: number } | null = null

  // 尺寸 / 可见性 / 循环
  let host: HTMLElement | null = null
  let ro: ResizeObserver | null = null
  let io: IntersectionObserver | null = null
  let visible = true
  let sized = false
  let needResize = true
  let contextLost = false
  let raf = 0
  let lastFrame = 0
  let resumed = true
  const timer = new THREE.Timer()
  timer.connect(document)

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
    renderer.setSize(w, h, false) // 视觉像素;内部乘 pixelRatio;不写 style
    camera.aspect = w / h
    frameCamera(camera, avatar.anchors, framing(), zoom)
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

  const headScreenPos = (rect: DOMRect): { x: number; y: number } => {
    const a = avatar.anchors
    const hp = (a.head ? a.head.clone() : new THREE.Vector3((a.box.min.x + a.box.max.x) / 2, a.box.max.y - 0.1 * (a.box.max.y - a.box.min.y), 0))
    stageRoot.localToWorld(hp)
    hp.project(camera)
    return { x: rect.left + ((hp.x + 1) / 2) * rect.width, y: rect.top + ((1 - hp.y) / 2) * rect.height }
  }

  const lookTarget = (t: number): { yaw: number; pitch: number } => {
    switch (proc.look) {
      case 'up':
        return { yaw: -0.32, pitch: 0.3 }
      case 'down':
        return { yaw: 0.05, pitch: -0.4 }
      case 'camera':
        return { yaw: -userYaw * 0.5, pitch: 0 }
      default: {
        if (!pointer || t - pointer.t > 6 || !host) return { yaw: -userYaw * 0.5, pitch: 0 }
        const rect = canvas.getBoundingClientRect()
        const hs = headScreenPos(rect)
        const D = 700 // 「观众离屏幕」的等效像素距离:指针离头 300px ≈ 转 23°
        const yaw = clamp(Math.atan2(pointer.x - hs.x, D), -35 * DEG, 35 * DEG) - userYaw
        const pitch = clamp(Math.atan2(hs.y - pointer.y, D), -20 * DEG, 20 * DEG)
        return { yaw: clamp(yaw, -35 * DEG, 35 * DEG), pitch }
      }
    }
  }

  function render(): void {
    renderer.render(scene, camera)
  }

  function frame(ts: number): void {
    raf = requestAnimationFrame(frame)
    if (surface === 'card' && ts - lastFrame < 1000 / 30 - 2) return
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
    const reduced = !!reducedMq?.matches

    // 状态 → 口型
    let mouth = 0
    if (phase === 'speaking') {
      if (source && preview === null) {
        let s: AgentStatusLike | null = null
        try {
          s = source()
        } catch {
          s = null
        }
        if (s) env.sample(s.textChars, t, s.messageId)
        else env.decay(t)
      } else {
        env.sample(Math.floor(t * 30), t, 'synthetic') // 没有拉取源(预览 / 老宿主):匀速「出字」
      }
      mouth = mouthFlap(env.value, t)
    } else env.decay(t)

    // 程序化参数平滑
    const pt = PROC[phase]
    for (const key of ['headTilt', 'nod', 'bob', 'droop', 'bounce', 'sway'] as const) proc[key] = damp(proc[key], pt[key], 5, dt)
    proc.look = pt.look
    const lt = lookTarget(t)
    look.yaw = damp(look.yaw, lt.yaw, 7, dt)
    look.pitch = damp(look.pitch, lt.pitch, 7, dt)

    // 用户视角
    userYaw = damp(userYaw, userYawTarget, 10, dt)
    const z0 = zoom
    zoom = damp(zoom, zoomTarget, 10, dt)
    stageRoot.rotation.y = userYaw
    if (Math.abs(zoom - z0) > 1e-4) frameCamera(camera, avatar.anchors, framing(), zoom)

    avatar.update({ t, dt, look, mouth, proc, reduced })
    render()
  }

  // ── 监听 ──
  const onPointerMove = (e: PointerEvent): void => {
    pointer = { x: e.clientX, y: e.clientY, t: timer.getElapsed() }
    if (drag && e.pointerId === drag.id) {
      userYawTarget += (e.clientX - drag.x) * 0.012
      drag.x = e.clientX
    }
  }
  const onWinResize = (): void => {
    needResize = true
    if (!raf) {
      applySize()
      updateLoop()
    }
  }
  const onVisibility = (): void => updateLoop()
  const onDown = (e: PointerEvent): void => {
    if (!interactive || e.button !== 0) return
    drag = { id: e.pointerId, x: e.clientX }
    try {
      canvas.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    canvas.style.cursor = 'grabbing'
  }
  const onUp = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return
    drag = null
    canvas.style.cursor = interactive ? 'grab' : ''
  }
  const onWheel = (e: WheelEvent): void => {
    if (!interactive) return
    e.preventDefault()
    zoomTarget = clamp(zoomTarget * Math.exp(-e.deltaY * 0.0015), 0.7, 2.4)
  }
  const onDbl = (): void => {
    if (!interactive) return
    userYawTarget = 0
    zoomTarget = 1
  }
  const onLost = (e: Event): void => {
    e.preventDefault()
    contextLost = true
    updateLoop()
  }
  const onRestored = (): void => {
    contextLost = false
    envRT.dispose()
    envRT = pmrem.fromScene(new RoomEnvironment(), 0.04) // PMREM 的渲染目标内容随上下文丢了,重烘
    scene.environment = envRT.texture
    needResize = true
    updateLoop()
  }
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointercancel', onUp)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('dblclick', onDbl)
  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)

  const applyInteractive = (): void => {
    canvas.style.cursor = interactive ? 'grab' : ''
    canvas.style.touchAction = interactive ? 'none' : ''
    canvas.style.pointerEvents = interactive ? 'auto' : 'none'
  }
  applyInteractive()

  const swapAvatar = (next: Avatar, orb: boolean): void => {
    const old = avatar
    avatar = next
    isOrb = orb
    stageRoot.add(next.root)
    old.dispose()
    applyPhase(preview ?? status.phase, true)
    needResize = true
    frameCamera(camera, avatar.anchors, framing(), zoom)
    resumed = true
  }

  const stage: Stage = {
    attach(el, o) {
      if (disposed) return
      if (host && host !== el) stage.detach()
      if (o?.surface) surface = o.surface
      if (o?.interactive !== undefined) interactive = o.interactive
      else if (o?.surface) interactive = o.surface !== 'card'
      applyInteractive()
      if (host === el) return
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
        visible = entries.some((e) => e.isIntersecting)
        updateLoop()
      })
      io.observe(el)
      window.addEventListener('pointermove', onPointerMove, { passive: true })
      window.addEventListener('resize', onWinResize)
      document.addEventListener('visibilitychange', onVisibility)
      syncAccent()
      accentMo?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-skin', 'data-mode', 'data-theme', 'class', 'style'] })
      applySize()
      updateLoop()
    },
    detach() {
      if (!host) return
      ro?.disconnect()
      io?.disconnect()
      ro = io = null
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('resize', onWinResize)
      document.removeEventListener('visibilitychange', onVisibility)
      accentMo?.disconnect()
      canvas.remove()
      host = null
      drag = null
      updateLoop()
    },
    async setProfile(p) {
      const my = ++gen
      if (disposed) return { ok: false, code: 'disposed', zh: '舞台已销毁', en: 'The stage has been disposed' }
      if (!p) {
        profile = null
        loadedKey = ''
        analysis = null
        if (!isOrb) swapAvatar(createOrb((accentNow = opts.accent ?? readAccent())), true)
        return { ok: true, analysis: null }
      }
      const key = JSON.stringify([p.modelPath, p.motionPaths])
      if (!isOrb && key === loadedKey && profile) {
        // 同一模型、transform 没变:只换 states / pose / framing,不重载。transform 变了就整份重载(摆放与构图锚点
        // 都依赖它;重载只多一次解析,字节多半还在缓存里)。
        if (sameShape(profile, p)) {
          profile = p
          avatar.setStates?.(p.states)
          avatar.setPose?.(p.pose)
          applyPhase(preview ?? status.phase, true)
          needResize = true
          return { ok: true, analysis }
        }
      }
      let loaded: LoadedModel
      try {
        loaded = await loadModel({ path: p.modelPath, motionPaths: p.motionPaths, assetUrl: opts.assetUrl, readBytes: opts.readBytes })
      } catch (e) {
        if (my !== gen || disposed) return superseded(disposed)
        const m = toMsg(e)
        profile = null
        loadedKey = ''
        analysis = null
        if (!isOrb) swapAvatar(createOrb((accentNow = opts.accent ?? readAccent())), true)
        return { ok: false, code: m.code, zh: m.zh, en: m.en }
      }
      if (my !== gen || disposed) {
        loaded.dispose()
        return superseded(disposed)
      }
      try {
        const a = analyze(loaded, relToProfile(p))
        const next = createModelAvatar({ loaded, profile: p })
        profile = p
        loadedKey = key
        analysis = a
        swapAvatar(next, false)
        return { ok: true, analysis: a }
      } catch (e) {
        loaded.dispose()
        const m = toMsg(e)
        return { ok: false, code: m.code, zh: m.zh, en: m.en }
      }
    },
    setStatus(s) {
      // 宿主将来多出的阶段名按 idle 处理(不认识 ≠ 崩)
      status = isPhase(s?.phase) ? s : { ...s, phase: 'idle' }
      if (preview === null) applyPhase(status.phase)
    },
    setStatusSource(fn) {
      source = fn
    },
    previewPhase(ph) {
      preview = ph && isPhase(ph) ? ph : null
      applyPhase(ph ?? status.phase, true)
    },
    async snapshot() {
      if (disposed || contextLost) return null
      const pr = renderer.getPixelRatio()
      const size = renderer.getSize(new THREE.Vector2())
      const aspect = camera.aspect
      const yaw = stageRoot.rotation.y
      renderer.setPixelRatio(1)
      renderer.setSize(512, 512, false)
      camera.aspect = 1
      stageRoot.rotation.y = 0
      frameCamera(camera, avatar.anchors, framing(), 1)
      render()
      const blob = new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), 'image/png')) // 同一任务里读缓冲
      renderer.setPixelRatio(pr)
      renderer.setSize(size.x, size.y, false)
      camera.aspect = aspect
      stageRoot.rotation.y = yaw
      frameCamera(camera, avatar.anchors, framing(), zoom)
      if (!raf && sized) render()
      return blob
    },
    currentAnalysis: () => analysis,
    dispose() {
      if (disposed) return
      disposed = true
      gen++
      stage.detach()
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('dblclick', onDbl)
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      timer.dispose()
      avatar.dispose()
      envRT.dispose()
      pmrem.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
    },
  }
  return stage

  function superseded(isDisposed: boolean): SetProfileResult {
    return isDisposed
      ? { ok: false, code: 'disposed', zh: '舞台已销毁', en: 'The stage has been disposed' }
      : { ok: false, code: 'superseded', zh: '已被新的加载取代', en: 'Superseded by a newer load' }
  }
}

/** transform / framing 没变 → 同一个外壳可以继续用(只换 states)。 */
function sameShape(a: ResolvedProfile, b: ResolvedProfile): boolean {
  return (
    a.transform.scale === b.transform.scale && a.transform.rotateY === b.transform.rotateY && a.transform.offsetY === b.transform.offsetY &&
    (a.transform.upAxis ?? 'y') === (b.transform.upAxis ?? 'y')
  )
}

/** 模型相对 profile 文件夹的路径(analysis.file)。 */
function relToProfile(p: ResolvedProfile): string {
  return p.model
}

// 供 orb 之外的调试 / 冒烟用:当前舞台的 three 对象不对外暴露(Stage 接口里没有),这里不导出。
export type { Orb }
