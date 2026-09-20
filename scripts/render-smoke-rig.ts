// render-smoke.mjs 的「合成模型」段(打进冒烟包,页面里跑)。数值口径的回归:骨骼姿势 / 口型 / 帧间隔 / 小球颜色 /
// FBX 内嵌贴图的 blob: / 模型里的联网引用 / 只在 extensionsUsed 里的 Draco。
//
// 被测代码(createStage / loadModel / registerModelKind)由入口**注入**,不在这里 import —— 这样
// `LIVE3D_SRC_ROOT=<旧源码> node scripts/render-smoke.mjs --only rig` 用同一份台架测旧代码,新加的断言必须在旧代码上红
// (负对照)。three 从插件的 node_modules 来,和被测代码是同一个实例(Scene.prototype 钩子才挂得上)。
import * as THREE from 'three'

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

export interface RigDeps {
  createStage: Any
  loadModel: Any
  registerModelKind: Any
  assetUrl: (rel: string) => string
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const Zq = (deg: number): number[] => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (deg * Math.PI) / 180).toArray()

interface RigCfg {
  clips: () => THREE.AnimationClip[]
  vrm?: Any
}
let cfg: RigCfg = { clips: () => [] }
/** 最近一次加载出来的合成模型的零件(量角度 / 读 morph / 读位移)。 */
const parts: {
  la?: THREE.Object3D; lf?: THREE.Object3D; lh?: THREE.Object3D
  ra?: THREE.Object3D; rf?: THREE.Object3D
  mesh?: THREE.Mesh; mover?: THREE.Object3D
} = {}
/** 合成模型被真正解析了几次 —— 「只改 pose 不重载模型」这条断言靠它(重载 = 这个数 +1)。 */
let loadCount = 0

function buildRig(path: string): Any {
  const B = (n: string, x: number, y: number, z: number): THREE.Bone => {
    const b = new THREE.Bone()
    b.name = n
    b.position.set(x, y, z)
    return b
  }
  const hips = B('Hips', 0, 1, 0), spine = B('Spine', 0, 0.2, 0), head = B('Head', 0, 0.5, 0)
  const la = B('LeftArm', 0.2, 0.2, 0), lf = B('LeftForeArm', 0.3, 0, 0), lh = B('LeftHand', 0.25, 0, 0)
  const ra = B('RightArm', -0.2, 0.2, 0), rf = B('RightForeArm', -0.3, 0, 0), rh = B('RightHand', -0.25, 0, 0)
  hips.add(spine)
  spine.add(head, la, ra)
  la.add(lf)
  lf.add(lh)
  ra.add(rf)
  rf.add(rh)
  // 身体:一块带 jawOpen morph 的盒子(非 VRM 的口型通道)
  const g = new THREE.BoxGeometry(0.4, 1.7, 0.3)
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  const open = pos.clone()
  for (let i = 0; i < open.count; i++) if (open.getY(i) < 0) open.setY(i, open.getY(i) - 0.3)
  g.morphAttributes.position = [open]
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x8899aa }))
  mesh.name = 'Body'
  mesh.position.y = 0.85
  mesh.updateMorphTargets()
  mesh.morphTargetDictionary = { jawOpen: 0 }
  mesh.morphTargetInfluences = [0]
  const mover = new THREE.Object3D()
  mover.name = 'Mover'
  const root = new THREE.Group()
  root.add(hips, mesh, mover)
  const bones = new Map<string, THREE.Bone>()
  root.traverse((x) => {
    if ((x as THREE.Bone).isBone) bones.set(x.name, x as THREE.Bone)
  })
  Object.assign(parts, { la, lf, lh, ra, rf, mesh, mover })
  loadCount++
  const clips = cfg.clips()
  return {
    kind: 'rig', format: cfg.vrm ? 'vrm' : 'glb', path, root, vrm: cfg.vrm, clips,
    clipSources: Object.fromEntries(clips.map((c) => [c.name, path])),
    morphMeshes: cfg.vrm ? [] : [mesh], morphNames: cfg.vrm ? [] : ['jawOpen'], bones, warnings: [], dispose() {},
  }
}

/** 上臂与水平面的夹角(度):T-pose ≈ 0~1,片段举到 80,程序化垂手 ≈ -72。 */
function armAngle(): number {
  const a = parts.la!.getWorldPosition(new THREE.Vector3())
  const b = parts.lf!.getWorldPosition(new THREE.Vector3())
  const d = b.sub(a).normalize()
  return Math.round((Math.asin(Math.max(-1, Math.min(1, d.y))) * 180) / Math.PI)
}

const profileFor = (states: Record<string, unknown>, extra: Record<string, unknown> = {}): Any => ({
  live3d: 1, name: 'rig', model: 'RIG_x.glb', motions: [], agents: [], transform: { scale: 1, rotateY: 0, offsetY: 0 }, framing: 'full',
  states, dir: 'Live3D/models/rt', modelPath: 'Live3D/models/rt/RIG_x.glb', motionPaths: [], ...extra,
})

/** 某根骨骼指向它子骨骼的方向(世界系)。 */
function dirOf(a: THREE.Object3D, b: THREE.Object3D): THREE.Vector3 {
  return b.getWorldPosition(new THREE.Vector3()).sub(a.getWorldPosition(new THREE.Vector3())).normalize()
}
const deg = (rad: number): number => (rad * 180) / Math.PI
/** 待机姿势的四个观测量(度 / 归一化单位)。 */
function poseProbe(): { lArm: number; rArm: number; elbow: number; handX: number } {
  const l = dirOf(parts.la!, parts.lf!)
  const r = dirOf(parts.ra!, parts.rf!)
  const fore = dirOf(parts.lf!, parts.lh!)
  return {
    lArm: +deg(Math.asin(Math.max(-1, Math.min(1, l.y)))).toFixed(2),
    rArm: +deg(Math.asin(Math.max(-1, Math.min(1, r.y)))).toFixed(2),
    elbow: +deg(Math.acos(Math.max(-1, Math.min(1, l.dot(fore))))).toFixed(2),
    handX: +parts.lh!.getWorldPosition(new THREE.Vector3()).x.toFixed(4),
  }
}

export function createRigHarness(deps: RigDeps): Record<string, (...a: Any[]) => Promise<Any>> {
  deps.registerModelKind({ kind: 'rig', accepts: (p: string) => p.includes('/RIG_'), load: async (o: Any) => buildRig(o.path) })

  /** 每个渲染出来的帧记一次(Scene.onBeforeRender = 这一帧真画出去的姿势)。 */
  async function record<T>(fn: (log: Array<[number, number]>) => Promise<T>): Promise<T> {
    const log: Array<[number, number]> = []
    const t0 = performance.now()
    const prev = THREE.Scene.prototype.onBeforeRender
    THREE.Scene.prototype.onBeforeRender = function (this: THREE.Scene) {
      if (parts.la && this.getObjectByName('live3d-pivot')) log.push([Math.round(performance.now() - t0), armAngle()])
    }
    try {
      return await fn(log)
    } finally {
      THREE.Scene.prototype.onBeforeRender = prev
    }
  }

  async function withStage<T>(el: HTMLElement, surface: string, c: RigCfg, states: Record<string, unknown>, fn: (st: Any) => Promise<T>): Promise<T> {
    cfg = c
    const st = deps.createStage({ surface, interactive: false, assetUrl: deps.assetUrl })
    st.attach(el)
    try {
      const r = await st.setProfile(profileFor(states))
      if (!r.ok) throw new Error('rig load failed: ' + JSON.stringify(r))
      return await fn(st)
    } finally {
      st.dispose()
    }
  }

  const panel = (): HTMLElement => document.getElementById('panel')!
  const idleArm = (keys: number[], times: number[], dur: number): THREE.AnimationClip =>
    new THREE.AnimationClip('Idle', dur, [new THREE.QuaternionKeyframeTrack('LeftArm.quaternion', times, keys.flatMap(Zq))])

  return {
    /** 片段把手臂举在常量 80°(单帧姿势 / 常量轨 / 关键帧停顿)—— 每一帧都该是 80,不是静止姿势。 */
    async pose(kind: 'constant' | 'singlekey' | 'hold') {
      const clip =
        kind === 'constant' ? idleArm([80, 80], [0, 1], 1) : kind === 'singlekey' ? idleArm([80], [0], 1) : idleArm([40, 80, 80, 40], [0, 0.4, 0.8, 1.2], 1.2)
      return withStage(panel(), 'panel', { clips: () => [clip] }, { idle: { clip: 'Idle' } }, async () => {
        await sleep(600)
        return record(async (log) => {
          await sleep(1300)
          const a = log.map(([, x]) => x)
          return { frames: a.length, min: Math.min(...a), max: Math.max(...a) }
        })
      })
    },
    /**
     * 待机姿势(没有任何片段的模型 —— MMD / VRoid 的常态)。采一段时间的四个观测量,再就地换一次 pose:
     *  - 手臂不许被钉死:整段里上臂仰角要有可见变化,左右两侧还不能同相(2026-09-20 之前正是这样,像挂在衣架上);
     *  - liveliness:0 = 完全不动(上面那条的负对照,顺便钉住「0 不能被当成缺失而补成 1」);
     *  - armSpread 调大 → 手离身体中线更远;elbow 调大 → 上臂与前臂夹角更大;
     *  - 只改 pose 的那次 setProfile **不许重载模型**(loadCount 不变)。
     */
    async idlePose() {
      const sample = async (ms: number): Promise<Array<ReturnType<typeof poseProbe>>> => {
        const out: Array<ReturnType<typeof poseProbe>> = []
        const t0 = performance.now()
        while (performance.now() - t0 < ms) {
          await sleep(60)
          out.push(poseProbe())
        }
        return out
      }
      const spread = (xs: number[]): number => +(Math.max(...xs) - Math.min(...xs)).toFixed(3)
      /** 皮尔逊相关。**这条才是「手臂有没有自己的动作」的判据**:只有躯干在动时,躯干那点侧倾把一侧抬起、
       *  另一侧压下,两条序列是完美反相(r ≈ -1);两臂各有各的漂移周期之后 |r| 会明显离开 1。
       *  单看「动没动」不行 —— 躯干呼吸本来就会把手臂带起来一点。 */
      const corr = (a: number[], b: number[]): number => {
        const n = Math.min(a.length, b.length)
        const ma = a.slice(0, n).reduce((x, y) => x + y, 0) / n
        const mb = b.slice(0, n).reduce((x, y) => x + y, 0) / n
        let sab = 0, saa = 0, sbb = 0
        for (let i = 0; i < n; i++) {
          const da = a[i] - ma, db = b[i] - mb
          sab += da * db; saa += da * da; sbb += db * db
        }
        return saa > 1e-12 && sbb > 1e-12 ? +(sab / Math.sqrt(saa * sbb)).toFixed(3) : 1
      }
      loadCount = 0
      return withStage(panel(), 'panel', { clips: () => [] }, {}, async (st) => {
        await sleep(400)
        const loadsAfterFirst = loadCount
        const def = await sample(2400)
        // 同一帧左右不同相:取整段里两侧仰角之差的最大绝对值
        const lockstep = corr(def.map((p) => p.lArm), def.map((p) => p.rArm))
        const base = def[def.length - 1]

        const apply = async (pose: Record<string, number>): Promise<ReturnType<typeof poseProbe>> => {
          const r = await st.setProfile(profileFor({}, { pose }))
          if (!r.ok) throw new Error('setProfile failed: ' + JSON.stringify(r))
          await sleep(500)
          return poseProbe()
        }
        const still = await apply({ armSpread: 0.36, armForward: 0.2, elbow: 0.26, liveliness: 0 })
        const stillSamples = await sample(1500)
        const wide = await apply({ armSpread: 0.9, armForward: 0.2, elbow: 0.26, liveliness: 0 })
        const bent = await apply({ armSpread: 0.36, armForward: 0.2, elbow: 0.9, liveliness: 0 })
        return {
          loads: loadCount,
          loadsAfterFirst,
          moveL: spread(def.map((p) => p.lArm)),
          moveR: spread(def.map((p) => p.rArm)),
          lockstep,
          baseElbow: base.elbow,
          stillMove: spread(stillSamples.map((p) => p.lArm)),
          stillHandX: still.handX,
          wideHandX: wide.handX,
          bentElbow: bent.elbow,
        }
      })
    },
    /** 摘下再挂上(卡片 ↔ 侧板搬家、窗口恢复):恢复后第一帧 dt=0,不许闪静止姿势。 */
    async resume() {
      const clip = idleArm([40, 80, 40], [0, 1, 2], 2)
      return withStage(panel(), 'panel', { clips: () => [clip] }, { idle: { clip: 'Idle' } }, async (st) => {
        await sleep(600)
        const out: number[][] = []
        for (let k = 0; k < 3; k++) {
          st.detach()
          await sleep(250)
          out.push(
            await record(async (log) => {
              st.attach(panel())
              await sleep(150)
              return log.slice(0, 5).map(([, x]) => x)
            }),
          )
        }
        return out
      })
    },
    /** done 播一次举手(clampWhenFinished 停在末帧)→ 播完淡回 idle:手臂要平滑放下,不许一帧掉下去。 */
    async onceFinish() {
      const idle = new THREE.AnimationClip('Idle', 2, [new THREE.QuaternionKeyframeTrack('Spine.quaternion', [0, 1, 2], [...Zq(0), ...Zq(2), ...Zq(0)])])
      const wave = new THREE.AnimationClip('Wave', 0.5, [new THREE.QuaternionKeyframeTrack('LeftArm.quaternion', [0, 0.25, 0.5], [...Zq(60), ...Zq(80), ...Zq(80)])])
      return withStage(panel(), 'panel', { clips: () => [idle, wave] }, { idle: { clip: 'Idle' }, done: { clip: 'Wave', once: true } }, async (st) => {
        st.setStatus({ phase: 'idle', sessionId: 's', textChars: 0 })
        await sleep(500)
        return record(async (log) => {
          st.setStatus({ phase: 'done', sessionId: 's', textChars: 0 })
          await sleep(1600)
          const a = log.map(([, x]) => x)
          let maxStep = 0
          for (let i = 1; i < a.length; i++) maxStep = Math.max(maxStep, Math.abs(a[i] - a[i - 1]))
          return { frames: a.length, maxStep, peak: Math.max(...a), end: a[a.length - 1] }
        })
      })
    },
    /** 说话 → done / idle:口型通道(非 VRM 的 jawOpen;VRM 的自定义 mouth 'oh')必须收回 0。 */
    async mouth(kind: 'morph' | 'vrm-oh') {
      const vals = new Map<string, number>()
      const names = ['aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'happy', 'relaxed', 'surprised']
      const vrm =
        kind === 'vrm-oh'
          ? {
              expressionManager: {
                expressions: names.map((n) => ({ expressionName: n })),
                getExpression: (n: string) => (names.includes(n) ? { expressionName: n } : null),
                setValue: (n: string, w: number) => void vals.set(n, w),
              },
              update() {},
            }
          : undefined
      const read = (): number => (kind === 'vrm-oh' ? vals.get('oh') ?? 0 : parts.mesh!.morphTargetInfluences![0])
      const states = kind === 'vrm-oh' ? { speaking: { mouth: 'oh' } } : {}
      return withStage(panel(), 'panel', { clips: () => [], vrm }, states, async (st) => {
        let chars = 0
        const t0 = performance.now()
        st.setStatusSource(() => ({ phase: 'speaking', sessionId: 's', messageId: 'm1', textChars: (chars = Math.floor((performance.now() - t0) / 10)) }))
        st.setStatus({ phase: 'speaking', sessionId: 's', messageId: 'm1', textChars: 0 })
        let peak = 0
        for (let i = 0; i < 16; i++) {
          await sleep(50)
          peak = Math.max(peak, read())
        }
        st.setStatusSource(null)
        st.setStatus({ phase: 'done', sessionId: 's', textChars: chars })
        await sleep(1200)
        const afterDone = read()
        st.setStatus({ phase: 'idle', sessionId: 's', textChars: chars })
        await sleep(600)
        return { peak: +peak.toFixed(3), afterDone: +afterDone.toFixed(3), afterIdle: +read().toFixed(3) }
      })
    },
    /** 卡片封顶 30fps + 75Hz 屏(帧距 40ms):片段要按真实时间走(旧的 1/30 钳制 → 0.83 倍慢放)。 */
    async slowmo(hz = 75) {
      const clip = new THREE.AnimationClip('Idle', 100, [new THREE.NumberKeyframeTrack('Mover.position[x]', [0, 100], [0, 100])])
      const raf = window.requestAnimationFrame
      const caf = window.cancelAnimationFrame
      window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 1000 / hz)) as never
      window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as never
      try {
        return await withStage(document.getElementById('card-body')!, 'card', { clips: () => [clip] }, { idle: { clip: 'Idle' } }, async () => {
          await sleep(400)
          const x0 = parts.mover!.position.x
          const w0 = performance.now()
          await sleep(2500)
          return +((parts.mover!.position.x - x0) / ((performance.now() - w0) / 1000)).toFixed(3)
        })
      } finally {
        window.requestAnimationFrame = raf
        window.cancelAnimationFrame = caf
      }
    },
    /** 小球颜色:挂上前把 --accent 改掉 → 挂上时要重读;挂着时换配色(data-skin + 内联 --accent)→ 要跟着变。
     *  分三步由 node 侧截图:start(绿,未挂)→ attach(改红后挂上)→ skin(改蓝 + data-skin)。 */
    async orb(step: 'start' | 'attach' | 'skin' | 'end') {
      const root = document.documentElement
      const w = window as Any
      if (step === 'start') {
        root.style.setProperty('--accent', '#22b04a')
        w.__orbStage = deps.createStage({ surface: 'panel', interactive: false, assetUrl: deps.assetUrl })
        await w.__orbStage.setProfile(null)
        root.style.setProperty('--accent', '#e0301e') // 改在挂上之前:没挂着,观察器也没开
        return true
      }
      if (step === 'attach') {
        w.__orbStage.attach(panel())
        await sleep(500)
        return true
      }
      if (step === 'skin') {
        root.setAttribute('data-skin', 'smoke-teal')
        root.style.setProperty('--accent', '#1e5ae0')
        await sleep(500)
        return true
      }
      w.__orbStage?.dispose()
      w.__orbStage = null
      root.removeAttribute('data-skin')
      root.style.removeProperty('--accent')
      return true
    },
    /** FBX 内嵌贴图:FBXLoader 建的 blob: 要在贴图落地后撤销(不撤 = 每次重载都钉一份字节在内存里),且撤销不伤贴图。 */
    async fbxBlobs(path: string) {
      const live = new Set<string>()
      let created = 0
      let revoked = 0
      const oc = URL.createObjectURL.bind(URL)
      const orv = URL.revokeObjectURL.bind(URL)
      URL.createObjectURL = (b: Blob | MediaSource) => {
        const u = oc(b)
        created++
        live.add(u)
        return u
      }
      URL.revokeObjectURL = (u: string) => {
        revoked++
        live.delete(u)
        orv(u)
      }
      try {
        let last: Any = null
        for (let k = 0; k < 3; k++) {
          const m = await deps.loadModel({ path, assetUrl: deps.assetUrl })
          if (last) last.dispose()
          last = m
        }
        // 最后一份:贴图在 blob 撤销之后还画得出来(红)
        let map: THREE.Texture | null = null
        last.root.traverse((o: Any) => {
          if (o.isMesh && o.material?.map) map = o.material.map
        })
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 16
        const r = new THREE.WebGLRenderer({ canvas, preserveDrawingBuffer: true })
        const scene = new THREE.Scene()
        scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map })))
        const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
        cam.position.z = 1
        r.render(scene, cam)
        const px = new Uint8Array(4)
        const gl = r.getContext()
        gl.readPixels(8, 8, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
        r.dispose()
        r.forceContextLoss()
        const nw = (map as Any)?.image?.naturalWidth ?? null
        last.dispose()
        return { created, revoked, live: live.size, naturalWidth: nw, pixel: [...px] }
      } finally {
        URL.createObjectURL = oc
        URL.revokeObjectURL = orv
      }
    },
    /** 读一个模型:返回 'loaded:<警告>' 或 '<错误码>|zh|en|<en 原文>'。 */
    async loadResult(path: string) {
      try {
        const m = await deps.loadModel({ path, assetUrl: deps.assetUrl })
        const w = m.warnings.join(' | ')
        m.dispose()
        return 'loaded:' + w
      } catch (e: Any) {
        return `${e.code}|${e.zh ? 'zh' : ''}|${e.en ? 'en' : ''}|${e.en ?? e.message}`
      }
    },
  }
}
