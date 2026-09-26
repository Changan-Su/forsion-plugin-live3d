// 模型 / 动作加载(three.js r186 + @pixiv/three-vrm 3.5.5)。只管「把字节变成可渲染的 Object3D + 片段」,
// 不管摆放、构图与反应(那是 stage 的事)。
//
// 三处宿主约束,每一处都会**静默**出事(formats.md §1、seams.md §B):
//  ① CSP connect-src 没有 blob: / data:(老宿主)→ GLTFLoader 在 Chromium 上用 ImageBitmapLoader(fetch(blob:))
//    解内嵌贴图,被拦后吞掉错误 → 模型白模。解法:注册一个插件把 parser.textureLoader 换成 TextureLoader
//    (走 <img>,img-src 放行 blob:/data:)。新宿主放行了也照挂(无害)。
//  ② amadeus-asset://v/<整段 encodeURIComponent> 的 URL 里 '/' 被编码 → 三方加载器按 base 拼相对路径会拼出 404。
//    解法:字节自己 fetch,parse(buf, '') 不给 base;外部引用(.gltf 的 .bin/贴图、FBX 贴图、OBJ 的 .mtl/贴图)
//    全部经 LoadingManager.setURLModifier 按「模型所在文件夹」重新解析成 assetUrl。只有 blob: / data: /
//    amadeus-asset: 原样放行;模型里写死的 http(s):// 等联网引用一律拒绝并记警告(插件按设计离线:下载来的模型
//    不许每次显示都往外发请求),file:// 与绝对路径一样只取文件名、在模型文件夹里找。
//  ③ three r186 的 DRACOLoader / KTX2Loader 模块顶层 new URL(…, import.meta.url),IIFE 里装载即抛 —— 不 import 它们;
//    Draco 压缩的模型走 agent 辅助导入(转成 meshopt 再导);KTX2 贴图这里解不回来,只能请用户从原软件重新导出。
//    meshopt 解码器自带内联 wasm,CSP 下可用。
//
// 扩展点:ModelKindHandler。v1 只有 three 这一种(glTF/VRM/FBX/OBJ/PMX);将来的 Live2D 渲染器可以把自己的画布
// 当 CanvasTexture 贴在一块平面上交出来(LoadedModel.root = 那块平面,tick 里推进它自己的时间),stage 无需改动。

import * as THREE from 'three'
import { GLTFLoader, type GLTF, type GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { MMDLoader } from '@moeru/three-mmd'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'
import { VRMAnimationLoaderPlugin, VRMLookAtQuaternionProxy, createVRMAnimationClip, type VRMAnimation } from '@pixiv/three-vrm-animation'
import type { ModelFormat, Msg } from './contract'
import { LIVE2D_REFUSAL, baseName, detectFormat, dirOf, extOf, isLive2DPath, joinRel, MOTION_EXTS } from './contract'
import { clipDisplayName, findRigBones } from './heuristics'
import { collectTextures } from './analysis'

// ── 错误 ──────────────────────────────────────────────────────────────────────
export type LoadErrorCode = 'live2d' | 'unsupported' | 'not-found' | 'fetch-failed' | 'parse-failed' | 'empty'

/** 加载失败。zh / en 是给用户看的一句话;message = en(便于日志)。 */
export class LoadError extends Error implements Msg {
  readonly code: LoadErrorCode
  readonly zh: string
  readonly en: string
  constructor(code: LoadErrorCode, msg: Msg, cause?: unknown) {
    super(msg.en)
    this.name = 'LoadError'
    this.code = code
    this.zh = msg.zh
    this.en = msg.en
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause
  }
}

/** 任意异常 → 双语消息(非 LoadError 的按解析失败处理)。 */
export function toMsg(e: unknown): Msg & { code: LoadErrorCode } {
  if (e instanceof LoadError) return { code: e.code, zh: e.zh, en: e.en }
  const why = e instanceof Error ? e.message : String(e)
  return { code: 'parse-failed', zh: `模型解析失败:${why}`, en: `Could not parse the model: ${why}` }
}

// ── 类型 ──────────────────────────────────────────────────────────────────────
export interface LoadModelOptions {
  /** 模型文件的库内相对路径。 */
  path: string
  /** 库内相对路径 → 可 fetch / 可作 <img src> 的 URL(ctx.app.assetUrl 或 amadeus-asset://v/…)。 */
  assetUrl: (rel: string) => string
  /** 动作文件(.vrma / .fbx / .glb / .gltf)的库内相对路径。 */
  motionPaths?: readonly string[]
  /** 自定义读字节(比如 ctx.app.readBytes);返回 null = 文件不存在。缺省 = fetch(assetUrl(rel))。 */
  readBytes?: (rel: string) => Promise<ArrayBuffer | Uint8Array | null>
  /** CSP 贴图兜底(见顶注 ①)。缺省 true;只有渲染冒烟的负对照会关掉它。 */
  textureHook?: boolean
}

export interface LoadedModel {
  /** 由哪个 ModelKindHandler 加载('three')。 */
  kind: string
  format: ModelFormat
  path: string
  /** 放进场景的根(VRM = vrm.scene)。尚未归一化 / 摆放。 */
  root: THREE.Object3D
  vrm?: VRM
  /** 片段(名字已清洗且唯一,见 heuristics.clipDisplayName);mixer 的根 = root。 */
  clips: THREE.AnimationClip[]
  /** 片段名 → 来源文件(库内相对)。 */
  clipSources: Record<string, string>
  /** 带 morph 的网格与去重后的 morph 名。 */
  morphMeshes: THREE.Mesh[]
  morphNames: string[]
  /** 骨骼名 → 骨骼(只收 isBone 的节点;网格和骨骼同名时不会串)。 */
  bones: Map<string, THREE.Bone>
  /** 给 agent 看的英文诊断(贴图没加载上、动作套不上……)。 */
  warnings: string[]
  /** 非 three 的渲染器(未来的 Live2D 等)每帧推进自己;three 模型没有。 */
  tick?(dt: number): void
  /** 骨骼摆完(片段 + 程序化)之后、渲染之前调一次:骨架自带的约束在这里跟上。现在只有 MMD 的付与(append):
   *  MMD 的腿网格蒙在 `足D / ひざD / 足首D` 上,它们靠付与复制 `足 / ひざ / 足首` 的旋转 —— 不解算,转腿骨网格纹丝不动。 */
  afterPose?(): void
  dispose(): void
}

/** 扩展点:一种模型的加载器。accepts 按路径(扩展名)认领;后注册的优先。 */
export interface ModelKindHandler {
  kind: string
  accepts(path: string): boolean
  load(opts: LoadModelOptions): Promise<LoadedModel>
}

// ── 读字节 ────────────────────────────────────────────────────────────────────
const notFound = (rel: string): LoadError =>
  new LoadError('not-found', { zh: `找不到文件「${rel}」(被移走或改名了?)`, en: `File not found: "${rel}" (moved or renamed?)` })

async function fetchBytes(rel: string, opts: LoadModelOptions): Promise<ArrayBuffer> {
  if (opts.readBytes) {
    const b = await opts.readBytes(rel)
    if (!b) throw notFound(rel)
    return b instanceof Uint8Array ? (b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer) : b
  }
  let res: Response
  try {
    res = await fetch(opts.assetUrl(rel))
  } catch (e) {
    throw new LoadError(
      'fetch-failed',
      {
        zh: `读不到「${rel}」:没有打开笔记库,或宿主版本过旧(CSP 未放行 amadeus-asset:)`,
        en: `Could not read "${rel}": no vault is open, or the app is too old (its CSP does not allow amadeus-asset:)`,
      },
      e,
    )
  }
  if (res.status === 404) throw notFound(rel)
  if (!res.ok) throw new LoadError('fetch-failed', { zh: `读不到「${rel}」(HTTP ${res.status})`, en: `Could not read "${rel}" (HTTP ${res.status})` })
  return res.arrayBuffer()
}

// ── LoadingManager:相对引用重解析 + 失败记账 ─────────────────────────────────────
const PASS_THROUGH = /^(blob:|data:|amadeus-asset:)/i
/** 带协议头的 URI(两个字符以上的 scheme —— 'C:' 这种盘符不算)。 */
const SCHEME = /^[a-z][a-z0-9+.-]+:/i
/** 被拒的贴图引用换成这张 1×1 白图(中性占位:材质按本色显示;不联网、不撞 CSP —— img-src 放行 data:,也不会让
 *  GLTFLoader 打「Couldn't load texture」)。buffer 被拒在 parseGltf 里提前报错,不会拿它当数据。 */
const REFUSED_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAsTj2FAAAAABJRU5ErkJggg=='

export type ModelRefRoute = { pass: string } | { rel: string } | { refuse: string }

/** 模型里的一条引用怎么处理(纯函数,单测钉住):pass = 原样交给加载器;rel = 模型文件夹里的库内路径;
 *  refuse = 联网 / 未知协议,拒绝(插件离线,见顶注 ②)。 */
export function routeModelRef(ref: string, modelDir: string): ModelRefRoute {
  const u = String(ref ?? '').trim()
  if (PASS_THROUGH.test(u)) return { pass: u }
  if (/^file:/i.test(u)) return { rel: resolveModelRef(baseName(u.replace(/^file:\/*/i, '/')), modelDir) }
  if (SCHEME.test(u)) return { refuse: u }
  return { rel: resolveModelRef(u, modelDir) }
}

/** 模型里的相对引用(glTF uri、FBX RelativeFilename、MTL map_Kd)→ 库内路径。
 *  反斜杠归一;绝对路径 / 越界的 '..'(FBX 常带作者机器上的路径)只取文件名,在模型文件夹里找同名文件。 */
export function resolveModelRef(ref: string, modelDir: string): string {
  let r = ref.replace(/\\/g, '/')
  try {
    r = decodeURI(r)
  } catch {
    /* 非法转义就按原样 */
  }
  if (/^[a-z]:\//i.test(r) || r.startsWith('/') || r.split('/').includes('..')) r = baseName(r)
  return joinRel(modelDir, r)
}

interface TrackedManager {
  manager: THREE.LoadingManager
  failed: string[]
  /** 被拒的联网引用(原文)。 */
  refused: string[]
  idle(timeoutMs?: number): Promise<void>
}

/** manager → 它拒掉的引用(parseGltf 只拿得到 manager)。 */
const refusedOf = new WeakMap<THREE.LoadingManager, string[]>()

function trackedManager(modelDir: string, assetUrl: (rel: string) => string): TrackedManager {
  const manager = new THREE.LoadingManager()
  const failed: string[] = []
  const refused: string[] = []
  refusedOf.set(manager, refused)
  let pending = 0
  let waiters: Array<() => void> = []
  // FBXLoader.parseImage 给内嵌贴图建的 blob: 从不 revoke(GLTFLoader 自己会);全部 <img> 落地(pending 归零)后统一撤销。
  // <img> 此时已解码完,撤销不影响贴图;同一 blob 被多张贴图共用也等它们都落地。
  const blobs = new Set<string>()
  const flush = (): void => {
    for (const u of blobs) URL.revokeObjectURL(u)
    blobs.clear()
    const w = waiters
    waiters = []
    w.forEach((f) => f())
  }
  const start = manager.itemStart.bind(manager)
  const end = manager.itemEnd.bind(manager)
  const err = manager.itemError.bind(manager)
  manager.itemStart = (u: string) => {
    pending++
    start(u)
  }
  manager.itemEnd = (u: string) => {
    pending = Math.max(0, pending - 1)
    end(u)
    if (!pending) flush()
  }
  manager.itemError = (u: string) => {
    failed.push(u)
    err(u)
  }
  manager.setURLModifier((u) => {
    const r = routeModelRef(u, modelDir)
    if ('pass' in r) {
      if (/^blob:/i.test(r.pass)) blobs.add(r.pass)
      return r.pass
    }
    if ('refuse' in r) {
      if (!refused.includes(r.refuse)) refused.push(r.refuse)
      return REFUSED_URL
    }
    return assetUrl(r.rel)
  })
  return {
    manager,
    failed,
    refused,
    idle: (timeoutMs = 20000) =>
      pending
        ? new Promise<void>((res) => {
            const timer = setTimeout(res, timeoutMs)
            waiters.push(() => {
              clearTimeout(timer)
              res()
            })
          })
        : Promise.resolve(),
  }
}

function describeFailures(failed: readonly string[], refused: readonly string[] = []): string[] {
  const out: string[] = []
  for (const u of refused) out.push(`Refused a reference to a file outside the model folder: ${u} (Live3D works offline; put the file in the model folder and reference it by a relative path).`)
  failed = failed.filter((u) => u !== REFUSED_URL)
  const embedded = failed.filter((u) => /^(blob:|data:)/i.test(u)).length
  if (embedded) out.push(`${embedded} embedded texture(s) failed to load (the host CSP may block fetch of blob:/data: URLs).`)
  for (const u of failed) {
    if (/^(blob:|data:)/i.test(u)) continue
    let shown = u
    try {
      shown = decodeURIComponent(u.replace(/^[a-z-]+:\/\/[^/]*\//i, ''))
    } catch {
      /* keep raw */
    }
    out.push(`Could not load referenced file: ${shown}`)
  }
  return out
}

// ── glTF / VRM ───────────────────────────────────────────────────────────────
function gltfLoader(manager: THREE.LoadingManager, o: { vrm?: boolean; vrma?: boolean; textureHook?: boolean }): GLTFLoader {
  const loader = new GLTFLoader(manager)
  if (o.textureHook !== false) {
    // 插件回调在 parser 构造之后执行、loadTexture 惰性读 this.textureLoader —— 在这里换掉即可(formats.md §1.1)。
    loader.register((p: GLTFParser) => {
      ;(p as unknown as { textureLoader: THREE.Loader }).textureLoader = new THREE.TextureLoader(p.options.manager)
      return { name: 'forsion_csp_texture_fallback' }
    })
  }
  if (o.vrm) loader.register((p) => new VRMLoaderPlugin(p))
  if (o.vrma) loader.register((p) => new VRMAnimationLoaderPlugin(p))
  loader.setMeshoptDecoder(MeshoptDecoder)
  return loader
}

const REQUIRED_UNSUPPORTED: Record<string, Msg> = {
  KHR_draco_mesh_compression: {
    zh: '模型用了 Draco 网格压缩,插件不能直接读。请用「让 Agent 协助导入」先解压(或用 gltf-transform 转成 meshopt)。',
    en: 'This model uses Draco mesh compression, which the plugin cannot read directly. Use Agent-assisted import to decompress it first (or convert it to meshopt with gltf-transform).',
  },
  KHR_texture_basisu: {
    zh: '模型用了 KTX2 / Basis 压缩贴图,插件读不了,这里也没法可靠地把它解回普通图片。请在原来的软件里重新导出,贴图选 PNG / JPEG / WebP。',
    en: 'This model uses KTX2 / Basis compressed textures. The plugin cannot read them, and they cannot be reliably converted back to ordinary images here. Re-export the model from the original app with PNG / JPEG / WebP textures.',
  },
}

/** 模型的 buffer 放在网上:插件离线,不去下载。 */
const remoteBufferError = (uris: readonly string[]): LoadError =>
  new LoadError('unsupported', {
    zh: `模型的数据文件在网上(${uris.join(', ')}),Live3D 不联网下载。请把这些文件下载进模型文件夹,并在 .gltf 里改成相对路径。`,
    en: `The model's data files are on the internet (${uris.join(', ')}). Live3D does not download anything; download them into the model folder and change the .gltf to use relative paths.`,
  })

/** glTF JSON 头(GLB 读 JSON 块,.gltf 直接解析);读不出来 null。 */
function gltfJsonHead(buf: ArrayBuffer): { extensionsRequired?: unknown; extensionsUsed?: unknown; buffers?: unknown } | null {
  try {
    const u8 = new Uint8Array(buf)
    let json: string
    if (u8.length >= 20 && u8[0] === 0x67 && u8[1] === 0x6c && u8[2] === 0x54 && u8[3] === 0x46) {
      const dv = new DataView(buf)
      const len = dv.getUint32(12, true)
      json = new TextDecoder().decode(u8.subarray(20, 20 + len))
    } else {
      json = new TextDecoder().decode(u8)
    }
    const v = JSON.parse(json) as unknown
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** 只看 glTF JSON 头的 extensionsRequired。读不出来就返回 []。 */
export function gltfRequiredExtensions(buf: ArrayBuffer): string[] {
  return strList(gltfJsonHead(buf)?.extensionsRequired)
}

/** 会让加载失败、要提前拒掉的扩展:extensionsRequired 里我们不支持的,加上 extensionsUsed 里的 Draco ——
 *  GLTFLoader 只要在 extensionsUsed 里看到 Draco 就构造扩展、没有 DRACOLoader 当场抛(英文原文、不双语);
 *  KTX2 只在 Used 里时会回落到普通贴图,不拦。 */
export function gltfBlockingExtensions(buf: ArrayBuffer): string[] {
  const head = gltfJsonHead(buf)
  const out = strList(head?.extensionsRequired).filter((e) => e in REQUIRED_UNSUPPORTED)
  if (strList(head?.extensionsUsed).includes('KHR_draco_mesh_compression') && !out.includes('KHR_draco_mesh_compression')) out.push('KHR_draco_mesh_compression')
  return out
}

/**
 * glTF-Embedded(`buffers[].uri = data:…base64`)→ 内存里转成 GLB。GLTFLoader 用 FileLoader(fetch)读 buffer,
 * 老宿主 CSP 的 connect-src 不放行 data:,整份模型直接读不出来;转成 GLB 后 buffer 走 BIN 块,不再 fetch。
 * 只在**所有** buffer 都是 data: 时转(混着外部 .bin 的少见情况保持原样,走 URL 重解析那条路)。
 * 贴图若也是 data: URI,由上面的 TextureLoader 兜底走 <img>(img-src 放行 data:)。
 */
export function embeddedGltfToGlb(buf: ArrayBuffer): ArrayBuffer {
  const u8 = new Uint8Array(buf)
  if (u8.length >= 4 && u8[0] === 0x67 && u8[1] === 0x6c && u8[2] === 0x54 && u8[3] === 0x46) return buf // 已是 GLB
  let json: { buffers?: Array<{ uri?: string; byteLength?: number }>; bufferViews?: Array<{ buffer: number; byteOffset?: number }> }
  try {
    json = JSON.parse(new TextDecoder().decode(u8))
  } catch {
    return buf
  }
  const buffers = json.buffers ?? []
  if (!buffers.length || !buffers.every((b) => typeof b.uri === 'string' && /^data:[^,]*;base64,/i.test(b.uri))) return buf
  const parts = buffers.map((b) => {
    const bin = atob(b.uri!.slice(b.uri!.indexOf(',') + 1))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  })
  const offsets: number[] = []
  let total = 0
  for (const p of parts) {
    offsets.push(total)
    total += (p.length + 3) & ~3 // bufferView 对齐到 4 字节
  }
  const bin = new Uint8Array(total)
  parts.forEach((p, i) => bin.set(p, offsets[i]))
  for (const v of json.bufferViews ?? []) {
    v.byteOffset = (v.byteOffset ?? 0) + offsets[v.buffer]
    v.buffer = 0
  }
  json.buffers = [{ byteLength: total }]
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const pad = (4 - (jsonBytes.length % 4)) % 4
  if (pad) {
    const padded = new Uint8Array(jsonBytes.length + pad).fill(0x20)
    padded.set(jsonBytes)
    jsonBytes = padded
  }
  const glb = new Uint8Array(12 + 8 + jsonBytes.length + 8 + bin.length)
  const dv = new DataView(glb.buffer)
  dv.setUint32(0, 0x46546c67, true) // 'glTF'
  dv.setUint32(4, 2, true)
  dv.setUint32(8, glb.length, true)
  dv.setUint32(12, jsonBytes.length, true)
  dv.setUint32(16, 0x4e4f534a, true) // 'JSON'
  glb.set(jsonBytes, 20)
  const b0 = 20 + jsonBytes.length
  dv.setUint32(b0, bin.length, true)
  dv.setUint32(b0 + 4, 0x004e4942, true) // 'BIN\0'
  glb.set(bin, b0 + 8)
  return glb.buffer
}

async function parseGltf(raw: ArrayBuffer, manager: THREE.LoadingManager, o: { vrm?: boolean; vrma?: boolean; textureHook?: boolean }): Promise<GLTF> {
  const buf = embeddedGltfToGlb(raw)
  const blocking = gltfBlockingExtensions(buf)[0]
  if (blocking) throw new LoadError('unsupported', REQUIRED_UNSUPPORTED[blocking])
  // buffer 在网上:别让加载器拿着占位 URL 去读(读出来是空 / 被 CSP 拦,报一句看不懂的解析错)
  const remote = ((gltfJsonHead(buf)?.buffers as Array<{ uri?: unknown }> | undefined) ?? [])
    .map((b) => (b && typeof b.uri === 'string' ? routeModelRef(b.uri, '') : null))
    .flatMap((r) => (r && 'refuse' in r ? [r.refuse] : []))
  if (remote.length) throw remoteBufferError(remote)
  try {
    return await gltfLoader(manager, o).parseAsync(buf, '')
  } catch (e) {
    throw new LoadError('parse-failed', toParseMsg(e), e)
  }
}

const toParseMsg = (e: unknown): Msg => {
  const why = e instanceof Error ? e.message : String(e)
  return { zh: `模型解析失败:${why}`, en: `Could not parse the model: ${why}` }
}

// ── 片段:命名清洗 / 套到目标上 / 原地化 ─────────────────────────────────────────
function uniqueName(name: string, taken: Set<string>): string {
  let n = name
  for (let i = 2; taken.has(n); i++) n = `${name} ${i}`
  taken.add(n)
  return n
}

/** 只保留能在目标上找到节点的轨道;命中率 < 50% → 整段丢弃(返回 null)。 */
function fitClip(clip: THREE.AnimationClip, nodeNames: Set<string>): THREE.AnimationClip | null {
  if (!clip.tracks.length) return null
  const kept = clip.tracks.filter((t) => {
    try {
      return nodeNames.has(THREE.PropertyBinding.parseTrackName(t.name).nodeName)
    } catch {
      return false
    }
  })
  if (kept.length < clip.tracks.length * 0.5) return null
  clip.tracks = kept
  return clip
}

/** 根骨骼位移轨的 x / z 钉在第一帧:Mixamo 之类的片段会带着人走出画面。竖直方向保留(蹲、跳)。 */
function pinRootMotion(clip: THREE.AnimationClip, hipsNames: readonly string[]): void {
  for (const t of clip.tracks) {
    if (!(t instanceof THREE.VectorKeyframeTrack)) continue
    let parsed: { nodeName: string; propertyName: string }
    try {
      parsed = THREE.PropertyBinding.parseTrackName(t.name)
    } catch {
      continue
    }
    if (parsed.propertyName !== 'position' || !hipsNames.includes(parsed.nodeName)) continue
    const v = t.values
    const x0 = v[0]
    const z0 = v[2]
    for (let i = 0; i < v.length; i += 3) {
      v[i] = x0
      v[i + 2] = z0
    }
  }
}

// ── 通用收尾 ──────────────────────────────────────────────────────────────────
function indexScene(root: THREE.Object3D): Pick<LoadedModel, 'morphMeshes' | 'morphNames' | 'bones'> {
  const morphMeshes: THREE.Mesh[] = []
  const morphs = new Set<string>()
  const bones = new Map<string, THREE.Bone>()
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone && !bones.has(o.name)) bones.set(o.name, o as THREE.Bone)
    const m = o as THREE.Mesh
    if (m.isMesh && m.morphTargetDictionary && Object.keys(m.morphTargetDictionary).length) {
      morphMeshes.push(m)
      for (const k of Object.keys(m.morphTargetDictionary)) morphs.add(k)
    }
  })
  return { morphMeshes, morphNames: [...morphs], bones }
}

function disposeTree(root: THREE.Object3D): void {
  for (const t of collectTextures(root)) {
    const img = t.image as { close?: () => void } | null
    if (img && typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) img.close?.()
  }
  VRMUtils.deepDispose(root)
}

// ── three 这一种 ──────────────────────────────────────────────────────────────
async function loadThree(opts: LoadModelOptions): Promise<LoadedModel> {
  const path = opts.path
  const format = detectFormat(path)
  if (format === 'live2d') throw new LoadError('live2d', LIVE2D_REFUSAL)
  if (!format) throw unsupportedError(path)
  const dir = dirOf(path)
  const tm = trackedManager(dir, opts.assetUrl)
  const warnings: string[] = []
  let root: THREE.Object3D
  let vrm: VRM | undefined
  let own: THREE.AnimationClip[] = []
  let afterPose: (() => void) | undefined

  if (format === 'vrm' || format === 'glb' || format === 'gltf') {
    const gltf = await parseGltf(await fetchBytes(path, opts), tm.manager, { vrm: true, textureHook: opts.textureHook })
    vrm = (gltf.userData as { vrm?: VRM }).vrm
    root = vrm ? vrm.scene : gltf.scene
    own = gltf.animations ?? []
    if (vrm) {
      VRMUtils.removeUnnecessaryVertices(gltf.scene)
      VRMUtils.combineSkeletons(gltf.scene)
      VRMUtils.rotateVRM0(vrm)
      // VRMA 的 lookAt 轨需要这个代理节点(名字是约定);没有 lookAt 轨时它什么也不做。
      if (vrm.lookAt) {
        const proxy = new VRMLookAtQuaternionProxy(vrm.lookAt)
        proxy.name = 'lookAtQuaternionProxy'
        vrm.scene.add(proxy)
      }
    }
    if (format === 'vrm' && !vrm) warnings.push('The file has a .vrm extension but no VRM extension data; it is shown as a plain glTF model.')
  } else if (format === 'fbx') {
    const buf = await fetchBytes(path, opts)
    try {
      root = new FBXLoader(tm.manager).parse(buf, '')
    } catch (e) {
      throw new LoadError('parse-failed', toParseMsg(e), e)
    }
    own = root.animations ?? []
  } else if (format === 'pmx' || format === 'pmd') {
    // MMDLoader 只有 load(url)。给它**裸文件名**:模型与贴图(`tex\\体.png`)都经 URL 修改器按模型文件夹解析成
    // assetUrl,与 FBX / MTL 贴图同一条路;不包 blob: —— 老宿主 CSP 的 connect-src 不放行 blob:,fetch 会被拦。
    // ponytail: 于是 opts.readBytes 对 PMX 不生效(生产没传它);不接物理(头发 / 裙摆静止)、不跑 IK,
    // 要 VMD 动作时再接 mmd.update。付与(append)要跑:见 LoadedModel.afterPose。
    try {
      const mmd = await new MMDLoader(tm.manager).setResourcePath('./').loadAsync(baseName(path))
      root = mmd.mesh
      // 付与每帧「先把上一帧的输出还原成输入,再乘上源骨旋转」(GrantSolver.beginFrame),不跨帧累加 ——
      // 所以可以直接接在程序化姿势之后。没有付与骨的模型 entries 为空,update 近乎零开销。
      const grant = mmd.grantSolver
      afterPose = () => grant.update()
    } catch (e) {
      if ((e as { response?: Response })?.response?.status === 404) throw notFound(path)
      throw new LoadError('parse-failed', toParseMsg(e), e)
    }
  } else {
    const text = new TextDecoder().decode(await fetchBytes(path, opts))
    const obj = new OBJLoader(tm.manager)
    for (const lib of text.matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)) {
      const route = routeModelRef(lib[1], dir)
      if (!('rel' in route)) {
        warnings.push(`Material library ${lib[1]} is not a file in the model folder and was skipped; the model is shown untextured.`)
        continue
      }
      const rel = route.rel
      try {
        const mtl = new MTLLoader(tm.manager).parse(new TextDecoder().decode(await fetchBytes(rel, opts)), '')
        mtl.preload()
        obj.setMaterials(mtl)
      } catch (e) {
        warnings.push(`Material library ${lib[1]} could not be loaded (${e instanceof Error ? e.message : String(e)}); the model is shown untextured.`)
      }
    }
    try {
      root = obj.parse(text)
    } catch (e) {
      throw new LoadError('parse-failed', toParseMsg(e), e)
    }
  }

  let meshCount = 0
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshCount++
    if (vrm) o.frustumCulled = false // 弹簧骨 / 蒙皮会动出绑定包围盒
  })
  if (!meshCount) {
    disposeTree(root)
    throw new LoadError('empty', { zh: '模型里没有任何网格(是个空场景或只有骨骼 / 动画?)', en: 'The model contains no meshes (an empty scene, or only a skeleton / animation?)' })
  }
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) o.frustumCulled = false
  })

  // 片段:模型自带的 + 动作文件。名字清洗成唯一的可读名,根位移原地化。
  const taken = new Set<string>()
  const clips: THREE.AnimationClip[] = []
  const clipSources: Record<string, string> = {}
  const nodeNames = new Set<string>()
  root.traverse((o) => nodeNames.add(o.name))
  const idx = indexScene(root)
  const rig = findRigBones([...idx.bones.keys()])
  const hipsNames = [
    rig.hips,
    vrm?.humanoid?.getRawBoneNode('hips')?.name,
    vrm?.humanoid?.getNormalizedBoneNode('hips')?.name,
  ].filter((x): x is string => !!x)
  const accept = (clip: THREE.AnimationClip, source: string): void => {
    clip.name = uniqueName(clipDisplayName(clip.name, source), taken)
    pinRootMotion(clip, hipsNames)
    clips.push(clip)
    clipSources[clip.name] = source
  }
  for (const c of own) {
    if (!c.tracks.length) continue // FBX 常带一条空的 "Take 001",不算问题
    const fitted = fitClip(c, nodeNames)
    if (fitted) accept(fitted, path)
    else warnings.push(`Clip "${c.name}" in the model does not match its own nodes and was skipped.`)
  }

  for (const mp of opts.motionPaths ?? []) {
    const ext = extOf(mp)
    if (!MOTION_EXTS.includes(ext)) {
      warnings.push(`Motion file ${mp} has an unsupported extension and was skipped.`)
      continue
    }
    try {
      const got = await loadMotion(mp, ext, opts, tm.manager, vrm)
      if (!got.length) warnings.push(`Motion file ${mp} contains no animation clips.`)
      for (const c of got) {
        if (!c.tracks.length) continue
        const fitted = vrm && ext === 'vrma' ? c : fitClip(c, nodeNames)
        if (fitted) accept(fitted, mp)
        else warnings.push(`Clip "${c.name || baseName(mp)}" in ${mp} targets bones this model does not have (retargeting is not supported yet) and was skipped.`)
      }
    } catch (e) {
      const m = toMsg(e)
      warnings.push(`Motion file ${mp} could not be loaded: ${m.en}`)
    }
  }

  // 等 FBX / MTL 这类「先返回、图后到」的贴图落地,再把失败记进诊断。
  await tm.idle()
  warnings.push(...describeFailures(tm.failed, tm.refused))

  return {
    kind: 'three',
    format: vrm ? 'vrm' : format,
    path,
    root,
    vrm,
    clips,
    clipSources,
    ...idx,
    warnings,
    afterPose,
    dispose() {
      disposeTree(root)
    },
  }
}

async function loadMotion(
  mp: string, ext: string, opts: LoadModelOptions, manager: THREE.LoadingManager, vrm: VRM | undefined,
): Promise<THREE.AnimationClip[]> {
  const buf = await fetchBytes(mp, opts)
  if (ext === 'vrma') {
    if (!vrm) throw new LoadError('unsupported', { zh: '.vrma 动作只能用在 VRM 模型上', en: '.vrma motions only work on VRM models' })
    const gltf = await parseGltf(buf, manager, { vrma: true, textureHook: opts.textureHook })
    const anims = ((gltf.userData as { vrmAnimations?: VRMAnimation[] }).vrmAnimations ?? [])
    disposeTree(gltf.scene)
    return anims.map((a) => createVRMAnimationClip(a, vrm))
  }
  if (ext === 'fbx') {
    let group: THREE.Group
    try {
      group = new FBXLoader(manager).parse(buf, '')
    } catch (e) {
      throw new LoadError('parse-failed', toParseMsg(e), e)
    }
    const clips = group.animations ?? []
    disposeTree(group)
    return clips
  }
  const gltf = await parseGltf(buf, manager, { textureHook: opts.textureHook })
  disposeTree(gltf.scene)
  return gltf.animations ?? []
}

function unsupportedError(path: string): LoadError {
  return new LoadError('unsupported', {
    zh: `不支持「${baseName(path)}」这种格式。可直接导入:.vrm / .glb / .gltf / .fbx / .obj / .pmx / .pmd;其它格式(.blend / .max…)请用「让 Agent 协助导入」转换。`,
    en: `"${baseName(path)}" is not a supported format. Import .vrm / .glb / .gltf / .fbx / .obj / .pmx / .pmd directly; for other formats (.blend / .max…) use Agent-assisted import to convert.`,
  })
}

export const threeModelKind: ModelKindHandler = {
  kind: 'three',
  accepts: (p) => {
    const f = detectFormat(p)
    return !!f && f !== 'live2d'
  },
  load: loadThree,
}

const extraKinds: ModelKindHandler[] = []

/** 注册额外的模型种类(后注册的优先)。返回撤销函数。v1 没有调用方;留给 Live2D 等将来的渲染器。 */
export function registerModelKind(h: ModelKindHandler): () => void {
  extraKinds.push(h)
  return () => {
    const i = extraKinds.indexOf(h)
    if (i >= 0) extraKinds.splice(i, 1)
  }
}

/** 按路径挑一个 ModelKindHandler 加载。Live2D 在没有注册渲染器时给出授权说明;其它未知格式给出可导入格式清单。 */
export async function loadModel(opts: LoadModelOptions): Promise<LoadedModel> {
  for (let i = extraKinds.length - 1; i >= 0; i--) if (extraKinds[i].accepts(opts.path)) return extraKinds[i].load(opts)
  if (isLive2DPath(opts.path)) throw new LoadError('live2d', LIVE2D_REFUSAL)
  if (threeModelKind.accepts(opts.path)) return threeModelKind.load(opts)
  throw unsupportedError(opts.path)
}
