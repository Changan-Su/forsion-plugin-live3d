// 导入体检:LoadedModel → analysis.json。分两半 ——
//   collectFacts(loaded)  用 three 数网格 / 三角面 / 贴图、量包围盒(只在浏览器里跑);
//   buildAnalysis(facts)  纯函数:骨架流派、上轴猜测、states 建议、诊断文案(node 单测直接测它)。
// analysis.json 主要给 agent 辅助导入读,所以 warnings 是英文诊断句。

import * as THREE from 'three'
import type { Analysis, ClipInfo, ModelFormat } from './contract'
import { baseName, dirOf } from './contract'
import { findRigBones, guessRig, guessUpAxis, suggestStates } from './heuristics'
import type { LoadedModel } from './loaders'

/** analyze 的纯输入(collectFacts 产出,单测手写)。 */
export interface AnalysisFacts {
  format: ModelFormat
  vrm?: { specVersion: '0' | '1'; title?: string; expressions: string[]; humanBones: string[]; head?: string; neck?: string }
  clips: ClipInfo[]
  morphs: string[]
  boneNames: string[]
  meshes: number
  triangles: number
  textures: number
  size: [number, number, number]
  warnings: string[]
}

const round = (x: number): number => Math.round(x * 1000) / 1000

/** 纯:facts → Analysis。`now` 可注入(单测钉时间)。 */
export function buildAnalysis(facts: AnalysisFacts, fileName: string, now: number = Date.now()): Analysis {
  const rigBones = findRigBones(facts.boneNames)
  const head = facts.vrm?.head ?? rigBones.head
  const neck = facts.vrm?.neck ?? rigBones.neck
  const warnings = [...facts.warnings]
  if (!facts.clips.length) warnings.push('No animation clips found; the companion will use procedural motion only (breathing, blinking, look-at).')
  if (!facts.vrm && !head) warnings.push('No head bone found; head look-at falls back to turning the whole model.')
  if (facts.triangles > 300_000) warnings.push(`High triangle count (${facts.triangles}); consider decimating the model for the small Desk card.`)
  const upAxisGuess = guessUpAxis(facts.size)
  if (upAxisGuess === 'z') warnings.push('The model looks Z-up (lying down); set "transform.upAxis": "z" in live3d.json if it renders on its back.')
  const vrm = facts.vrm
    ? { specVersion: facts.vrm.specVersion, ...(facts.vrm.title ? { title: facts.vrm.title } : {}), expressions: facts.vrm.expressions, humanBones: facts.vrm.humanBones }
    : undefined
  return {
    live3d: 1,
    generatedAt: new Date(now).toISOString(),
    file: fileName,
    format: facts.format,
    ...(vrm ? { vrm } : {}),
    clips: facts.clips,
    morphs: facts.morphs,
    bones: {
      count: facts.boneNames.length,
      ...(head ? { head } : {}),
      ...(neck ? { neck } : {}),
      rig: guessRig(facts.boneNames, !!facts.vrm),
    },
    meshes: facts.meshes,
    triangles: facts.triangles,
    textures: facts.textures,
    size: [round(facts.size[0]), round(facts.size[1]), round(facts.size[2])],
    upAxisGuess,
    warnings,
    suggested: suggestStates({ clips: facts.clips, morphs: facts.morphs, vrm }),
  }
}

/** 场景里被材质引用、且真的有图的贴图(含 MToon 的 uniforms)。 */
export function collectTextures(root: THREE.Object3D): Set<THREE.Texture> {
  const out = new Set<THREE.Texture>()
  const add = (v: unknown): void => {
    const t = v as THREE.Texture | null
    if (t && (t as { isTexture?: boolean }).isTexture) out.add(t)
  }
  root.traverse((o) => {
    const mat = (o as THREE.Mesh).material
    for (const m of Array.isArray(mat) ? mat : mat ? [mat] : []) {
      for (const v of Object.values(m)) add(v)
      const uniforms = (m as THREE.ShaderMaterial).uniforms
      if (uniforms) for (const u of Object.values(uniforms)) add(u?.value)
    }
  })
  return out
}

export const textureHasImage = (t: THREE.Texture): boolean => {
  const img = t.image as { width?: number; naturalWidth?: number; videoWidth?: number } | null | undefined
  return !!img && ((img.naturalWidth ?? img.width ?? img.videoWidth ?? 0) > 0)
}

/** 包围盒(原始单位)。蒙皮网格按当前姿势算(先清掉缓存的 boundingBox)。 */
export function measure(root: THREE.Object3D): THREE.Box3 {
  root.updateMatrixWorld(true)
  root.traverse((o) => {
    const sm = o as THREE.SkinnedMesh
    if (sm.isSkinnedMesh) (sm as unknown as { boundingBox: THREE.Box3 | null }).boundingBox = null
  })
  return new THREE.Box3().setFromObject(root)
}

/** 浏览器半边:从加载结果里数出 facts。 */
export function collectFacts(m: LoadedModel, fileName: string = baseName(m.path)): AnalysisFacts {
  let meshes = 0
  let triangles = 0
  m.root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    meshes++
    const g = mesh.geometry as THREE.BufferGeometry
    const n = g.index ? g.index.count : g.getAttribute('position')?.count ?? 0
    triangles += Math.floor(n / 3)
  })
  const box = measure(m.root)
  const size = box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3())
  // 按图源去重(GLTFLoader 会为不同采样参数克隆 Texture,同一张图算一次)
  const textures = new Set([...collectTextures(m.root)].filter(textureHasImage).map((t) => t.source ?? t.image)).size
  // 来源写成相对 profile 文件夹的路径(和 profile 的 motions 同一口径);profile 文件夹 = 模型路径去掉 fileName。
  const dir = fileName && m.path.endsWith(fileName) ? m.path.slice(0, m.path.length - fileName.length).replace(/\/$/, '') : dirOf(m.path)
  const rel = (p: string): string => (dir && p.startsWith(dir + '/') ? p.slice(dir.length + 1) : p)
  const clips: ClipInfo[] = m.clips.map((c) => ({ name: c.name, duration: Math.round(c.duration * 1000) / 1000, source: rel(m.clipSources[c.name] ?? m.path) }))

  let vrm: AnalysisFacts['vrm']
  if (m.vrm) {
    const meta = m.vrm.meta as { metaVersion?: string; title?: string; name?: string }
    const humanoid = m.vrm.humanoid
    const humanBones = humanoid ? Object.entries(humanoid.humanBones).filter(([, b]) => !!b?.node).map(([k]) => k) : []
    vrm = {
      specVersion: meta?.metaVersion === '0' ? '0' : '1',
      title: (meta?.metaVersion === '0' ? meta.title : meta?.name) || undefined,
      expressions: m.vrm.expressionManager?.expressions.map((e) => e.expressionName) ?? [],
      humanBones,
      head: humanoid?.getRawBoneNode('head')?.name,
      neck: humanoid?.getRawBoneNode('neck')?.name,
    }
  }
  return {
    format: m.format,
    vrm,
    clips,
    morphs: m.morphNames,
    boneNames: [...m.bones.keys()],
    meshes,
    triangles,
    textures,
    size: [size.x, size.y, size.z],
    warnings: [...m.warnings],
  }
}

/** 加载结果 → analysis.json 的内容。`fileName` = 模型相对 profile 文件夹的路径(通常就是文件名)。 */
export function analyze(m: LoadedModel, fileName: string = baseName(m.path)): Analysis {
  return buildAnalysis(collectFacts(m, fileName), fileName)
}
