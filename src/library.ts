// 模型库:扫 `<workFolder>/models/<slug>/live3d.json`,逐份 parseProfile。
//
// 两条从 inspect 学来的纪律:
//  ① **坏文件不吞**:解析失败 / 模型文件丢了 / 文件夹里还没有 live3d.json,一律进 problems 带双语原因,
//     设置页与模型库照原样列出来 —— 静默隐藏 = 用户改半天不知道错在哪。
//  ② **按库根缓存**(libStale):插件在启动期同步装载,而宿主的库是**惰性恢复**的(用户这一程没进过 Amadeus
//     之前 vaultRoot() 是 null、listFiles() 是空数组且不报错)。按「上次扫的是哪个库根」比对,自然覆盖
//     没扫过 / 扫的时候库还没起来 / 换了库 三种情况。
import type { Msg, ResolvedProfile } from './contract'
import { MODELS_DIR, PREVIEW_FILE, ANALYSIS_FILE, PROFILE_FILE, joinRel, modelFolder, normRel } from './contract'
import { parseProfile } from './profile'
import type { HostCtx } from './ui/host'
import { MSG } from './i18n'

export interface LibEntry {
  slug: string
  /** 库内相对:`<workFolder>/models/<slug>`。 */
  dir: string
  profilePath: string
  profile: ResolvedProfile
  warnings: Msg[]
  hasPreview: boolean
  hasAnalysis: boolean
  /** live3d.json 里的 model 在库里找不到。条目照列(方便改),但 Desk 不去加载它。 */
  modelMissing: boolean
}

export type ProblemKind = 'invalid' | 'unreadable' | 'no-profile' | 'missing-model' | 'pending'

export interface LibProblem {
  slug: string
  path: string
  kind: ProblemKind
  reason: Msg
}

export interface LibState {
  entries: LibEntry[]
  problems: LibProblem[]
  /** 库里 `models/` 下已经存在的 slug(含没有 profile 的文件夹)—— 导入去重用。 */
  slugs: Set<string>
  /** 扫描时 vaultRoot() 给了 null(旧宿主没有这个 API 时按「有库」算)。 */
  noVault: boolean
  /** 宿主没有 listFiles(旧宿主)。 */
  noList: boolean
  /** 上次扫的是哪个库根;undefined = 还没扫过。 */
  root: string | null | undefined
}

const bi = (k: keyof typeof MSG.zh, vars?: Record<string, string>): Msg => {
  const fill = (s: string): string => (vars ? s.replace(/\{(\w+)\}/g, (m, n: string) => vars[n] ?? m) : s)
  return { zh: fill(MSG.zh[k]), en: fill(MSG.en[k]) }
}

export const workFolderOf = (ctx: HostCtx): string => normRel(ctx.app.workFolder?.() ?? 'Live3D') || 'Live3D'

/** 旧宿主没有 vaultRoot:用一个常量顶上 —— 扫一次就算数,不至于每次都重扫。 */
const currentRoot = (ctx: HostCtx): string | null => (ctx.app.vaultRoot ? ctx.app.vaultRoot() : 'no-vaultroot-api')

export interface Library {
  state(): LibState
  stale(): boolean
  /** force = 不管库根变没变都重扫(用户点「刷新」/ 文件变了 / 导入完)。并发调用合并成一趟,扫描期间
   *  又被要求重扫会在这一趟结束后**再扫一次**(不丢最后那次改动)。 */
  refresh(force?: boolean): Promise<LibState>
  find(slug: string | null | undefined): LibEntry | null
  onChange(cb: () => void): () => void
}

export function createLibrary(ctx: HostCtx, isPending: (slug: string) => boolean): Library {
  let state: LibState = { entries: [], problems: [], slugs: new Set(), noVault: false, noList: !ctx.app.listFiles, root: undefined }
  let loading: Promise<LibState> | null = null
  let again = false
  const subs = new Set<() => void>()

  async function scan(): Promise<LibState> {
    const root = currentRoot(ctx) // 先记库根:扫完再取的话,中途换库会把新库根按在旧库的结果上
    const work = workFolderOf(ctx)
    const prefix = `${joinRel(work, MODELS_DIR)}/`
    const next: LibState = { entries: [], problems: [], slugs: new Set(), noVault: root === null, noList: !ctx.app.listFiles, root }
    let files: string[] = []
    try {
      files = ((await ctx.app.listFiles?.()) ?? []).map(normRel)
    } catch {
      files = []
    }
    const all = new Set(files)
    const folders = new Map<string, string[]>()
    for (const p of files) {
      if (!p.startsWith(prefix)) continue
      const rest = p.slice(prefix.length)
      const i = rest.indexOf('/')
      if (i <= 0) continue // models/ 下的散文件不算模型
      const slug = rest.slice(0, i)
      if (!folders.has(slug)) folders.set(slug, [])
      folders.get(slug)!.push(rest.slice(i + 1))
    }
    for (const [slug, inner] of [...folders.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      next.slugs.add(slug)
      const dir = modelFolder(work, slug)
      const profilePath = `${dir}/${PROFILE_FILE}`
      if (!inner.includes(PROFILE_FILE)) {
        const pending = isPending(slug)
        next.problems.push({ slug, path: dir, kind: pending ? 'pending' : 'no-profile', reason: bi(pending ? 'lib.pending' : 'lib.noProfile') })
        continue
      }
      // readFile 的两种失败形态都要接:读不到给 null;宿主桥整个缺席时当场抛(inspect 踩过)。
      let text: string | null = null
      try {
        text = (await ctx.app.readFile?.(profilePath)) ?? null
      } catch {
        text = null
      }
      if (text == null) {
        next.problems.push({ slug, path: profilePath, kind: 'unreadable', reason: bi('lib.unreadable') })
        continue
      }
      const r = parseProfile(text, dir)
      if (!r.ok) {
        next.problems.push({ slug, path: profilePath, kind: 'invalid', reason: { zh: r.zh, en: r.en } })
        continue
      }
      const modelMissing = !all.has(r.value.modelPath)
      if (modelMissing) {
        next.problems.push({ slug, path: profilePath, kind: 'missing-model', reason: bi('lib.missingModel', { file: r.value.model }) })
      }
      next.entries.push({
        slug, dir, profilePath, profile: r.value, warnings: r.warnings, modelMissing,
        hasPreview: all.has(`${dir}/${PREVIEW_FILE}`),
        hasAnalysis: all.has(`${dir}/${ANALYSIS_FILE}`),
      })
    }
    next.entries.sort((a, b) => a.profile.name.localeCompare(b.profile.name) || a.slug.localeCompare(b.slug))
    return next
  }

  const emit = (): void => {
    for (const cb of [...subs]) {
      try {
        cb()
      } catch (e) {
        console.error('[live3d] library listener failed', e)
      }
    }
  }

  const lib: Library = {
    state: () => state,
    stale: () => state.root !== currentRoot(ctx),
    refresh(force = false) {
      if (!force && !lib.stale()) return Promise.resolve(state)
      if (loading) {
        if (force) again = true
        return loading
      }
      loading = (async () => {
        do {
          again = false
          state = await scan()
        } while (again)
        emit()
        return state
      })().finally(() => {
        loading = null
      })
      return loading
    },
    find: (slug) => (slug ? state.entries.find((e) => e.slug === slug) ?? null : null),
    onChange(cb) {
      subs.add(cb)
      return () => subs.delete(cb)
    },
  }
  return lib
}

/** 写进工作文件夹根的 README.md:目录约定 + 手写 live3d.json 的速查。**双语同一份**(落盘文件不跟随界面语言切换
 *  而变,两种语言都写上最稳)。兼作「把目录建出来」的载体:reveal 对不存在的路径是静默 no-op。 */
export const FOLDER_README = `# Live3D

模型文件夹 / Model folders:

\`\`\`
models/<slug>/
  live3d.json     形象配置 / profile (edit it; the Desk reloads on save)
  analysis.json   导入时的体检结果 / import analysis (a hint, read-only)
  preview.png     缩略图 / thumbnail
  <model>.vrm | .glb | .gltf | .fbx | .obj | .pmx | .pmd   (+ textures, .bin, motions)
\`\`\`

## live3d.json

\`\`\`json
{
  "live3d": 1,
  "name": "Alice",
  "model": "alice.vrm",
  "motions": ["motions/wave.vrma"],
  "agents": ["xyra"],
  "transform": { "scale": 1, "rotateY": 0, "offsetY": 0 },
  "framing": "bust",
  "pose": { "armSpread": 0.36, "armForward": 0.2, "elbow": 0.26, "liveliness": 1 },
  "states": {
    "idle":     { "clip": "Idle" },
    "thinking": { "expression": "surprised", "weight": 0.4 },
    "speaking": { "mouth": "aa" },
    "tool":     { "clip": "Typing" },
    "waiting":  { "clip": "Wave", "once": true },
    "error":    { "expression": "sad" },
    "done":     { "clip": "Jump", "once": true, "expression": "happy" }
  }
}
\`\`\`

- 路径一律相对 live3d.json 所在文件夹 / All paths are relative to the folder that holds live3d.json.
- framing: "bust" | "full" | "face"; transform.upAxis: "y" | "z"(躺倒的 OBJ 用 "z" / use "z" for an OBJ lying down).
- agents: 绑给哪些 Agent(slug);跟它们对话时 Desk 显示这个形象,其余对话显示设置里的「默认形象」/
  agent slugs this companion is bound to; other chats show the default companion from the settings.
- pose: 没有动作片段时的待机姿势,四个数都在 0–1(liveliness 0–2)/ idle pose when the model has no clips;
  armSpread 手臂外张 · armForward 手臂前摆 · elbow 手肘弯曲 · liveliness 待机幅度。手陷进裙摆就调大 armSpread /
  raise armSpread when the hands sink into a wide skirt.
- 不会写?在 Live3D 设置里点「让 Agent 协助导入」/ Not sure? Use "Agent-assisted import" in the Live3D settings.
- 不支持 Live2D(授权原因)/ Live2D models are not supported (licence).
`
