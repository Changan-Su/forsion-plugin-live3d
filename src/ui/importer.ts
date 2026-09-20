// 导入:选文件 / 选文件夹 / 拖放 → 复制进 `<workFolder>/models/<slug>/` → 体检 + 缩略图 → live3d.json。
//
// 两条路:
//  - 直接导入:能直接显示的格式(.vrm > .glb > .gltf > .fbx > .obj > .pmx > .pmd 取一个主文件)。插件自己复制、分析、生成
//    缺省 profile、设为当前形象。
//  - Agent 协助导入:任何格式(压缩包、Draco 压缩的 glTF……)。插件照样先把原文件复制进模型文件夹,能直接
//    加载的顺手做体检与缩略图,然后经 ctx.tangu.startChat 开一个**可见的**对话交给捆绑的 live3d-importer;
//    它写出 live3d.json 的那一刻(state.ts 的轮询)自动载入。
// Live2D 两条路都拒(授权,见 contract.LIVE2D_REFUSAL)。
//
// ⚠️文件选择器必须在用户手势里**同步** click():命令面板回车 / 按钮点击的 run 里不能先 await 再 click。
import type { Analysis, ModelFormat, Msg } from '../contract'
import {
  ANALYSIS_FILE, LIVE2D_REFUSAL, MODEL_EXTS, PREVIEW_FILE, PROFILE_FILE, detectFormat, extOf, isLive2DPath, joinRel,
  modelFolder, normRel, slugify,
} from '../contract'
import { defaultProfileFor, parseProfile, serializeProfile } from '../profile'
import { buildImportPrompt } from '../prompt'
import { createStage, type Stage } from '../stage'
import { MSG, pick, t } from '../i18n'
import type { HostCtx, StartChatResult } from './host'
import { amadeusBridge } from './host'
import type { Shell } from './state'

export interface Picked {
  file: File
  /** 相对导入根的路径(选文件夹时去掉顶层文件夹名)。 */
  rel: string
}
export interface PickResult {
  files: Picked[]
  /** 选的 / 拖进来的文件夹名(给 slug 兜底)。 */
  rootName: string | null
}

type BytesWriter = (path: string, bytes: Uint8Array) => Promise<void>

/** 捆绑 Agent 的 slug —— 必须与 agents/<slug>/ 目录名逐字一致:宿主只对**本插件捆绑包里的** Agent 放行 send:true。 */
export const IMPORTER_AGENT = 'live3d-importer'

const DIRECT_ACCEPT = '.vrm,.glb,.gltf,.fbx,.obj,.pmx,.pmd,.mtl,.bin,.png,.jpg,.jpeg,.webp,.tga,.bmp,.spa,.sph,.vrma'
/** 只能走 Agent 的常见格式(主文件候选,排在可直接显示的格式后面)。 */
const AGENT_EXTS = ['zip', '7z', 'rar', 'blend', 'max', 'c4d', 'ma', 'mb', '3ds', 'dae', 'usd', 'usdz', 'usdc', 'abc', 'stl', 'ply', 'x', 'mqo', 'unitypackage']
const JUNK = /(^|\/)(\.[^/]*|__MACOSX|Thumbs\.db|desktop\.ini)(\/|$)/i
const OFFSCREEN_CSS = 'position:fixed;left:0;top:0;width:512px;height:512px;opacity:0;pointer-events:none;z-index:-1;contain:strict;'

/** 过滤系统垃圾、规整路径、拒绝越界(`..` / 绝对路径)。 */
export function cleanPicked(files: Picked[]): Picked[] {
  const out: Picked[] = []
  const seen = new Set<string>()
  for (const f of files) {
    const rel = normRel(f.rel || f.file?.name || '')
    if (!rel || JUNK.test(rel) || rel.split('/').includes('..') || /^[a-z]:/i.test(rel)) continue
    if (seen.has(rel)) continue
    seen.add(rel)
    out.push({ file: f.file, rel })
  }
  return out
}

const depth = (rel: string): number => rel.split('/').length
/** 按扩展名优先级挑主文件;同级按「更浅、更大」(FBX 模型比同文件夹里的纯动作 FBX 大)。 */
export function mainOf(files: Picked[], exts: readonly string[]): Picked | undefined {
  let best: Picked | undefined
  let bestRank = Infinity
  for (const f of files) {
    const rank = exts.indexOf(extOf(f.rel))
    if (rank < 0 || isLive2DPath(f.rel)) continue
    if (
      !best || rank < bestRank ||
      (rank === bestRank && (depth(f.rel) < depth(best.rel) || (depth(f.rel) === depth(best.rel) && (f.file?.size ?? 0) > (best.file?.size ?? 0))))
    ) {
      best = f
      bestRank = rank
    }
  }
  return best
}

export interface ImporterDeps {
  /** setup 时从 ctx.app.writeBytes 绑定(旧宿主 undefined)。 */
  writeBytes?: (path: string, bytes: Uint8Array | ArrayBuffer) => Promise<void>
  /** setup 时从 ctx.tangu.startChat 绑定(旧宿主 / 非 Tangu 宿主 undefined)。 */
  startChat?: (o: { agent?: string; prompt: string; send?: boolean; folder?: string }) => Promise<StartChatResult>
}

export interface Importer {
  /** 同步弹出选择器(必须在用户手势里调),选完走直接导入。 */
  pickDirect(folder: boolean): void
  /** 同步弹出选择器,选完走 Agent 协助导入。 */
  pickAgent(folder: boolean): void
  importDirect(res: PickResult): Promise<void>
  importWithAgent(res: PickResult): Promise<void>
  /** 对一个**已经复制好**的模型文件夹发起 Agent 协助(直接导入加载失败后的那颗按钮)。
   *  loadError = 直接加载时的报错(英文,写进提示词给 agent 看);缺省取这一程里这个 slug 最近一次的加载报错。 */
  agentForSlug(slug: string, loadError?: string): Promise<void>
  /** 拖放:必须在 drop 事件里**同步**调用(DataTransfer 在事件返回后作废)。 */
  fromDrop(dt: DataTransfer): Promise<PickResult>
  busy(): boolean
  dispose(): void
}

/** copyAll 途中插件被卸了:两条导入路都要就地收手(别再建 WebGL 舞台、别再写文件)。 */
const DISPOSED = Symbol('disposed')

export function createImporter(shell: Shell, deps: ImporterDeps): Importer {
  const ctx: HostCtx = shell.ctx
  let running = false
  /** slug → 这一程里直接加载它时的报错(英文)。「让 Agent 协助处理」按钮把它带进提示词。 */
  const lastLoadError = new Map<string, string>()
  const inputs = new Set<{ input: HTMLInputElement; done: (r: PickResult | null) => void }>()

  const writer = (): BytesWriter | null => {
    if (deps.writeBytes) return (p, b) => deps.writeBytes!(p, b)
    const bridge = amadeusBridge()
    if (typeof bridge?.saveVaultBytes === 'function') return async (p, b) => void (await bridge.saveVaultBytes!(p, b))
    return null
  }

  const noVault = (): boolean => (ctx.app.vaultRoot ? ctx.app.vaultRoot() === null : false)

  function choose(folder: boolean, accept: string | null): Promise<PickResult | null> {
    for (const it of [...inputs]) it.done(null) // 同时只留一个选择器
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    if (accept) input.accept = accept
    if (folder) input.setAttribute('webkitdirectory', '')
    input.className = 'l3-file-input'
    input.style.display = 'none'
    document.body.appendChild(input)
    return new Promise((resolve) => {
      const rec = {
        input,
        done: (r: PickResult | null): void => {
          if (!inputs.has(rec)) return
          inputs.delete(rec)
          input.removeEventListener('change', onChange)
          input.removeEventListener('cancel', onCancel)
          input.remove()
          resolve(r)
        },
      }
      const onChange = (): void => {
        const list = Array.from(input.files ?? [])
        let rootName: string | null = null
        const files = list.map((file) => {
          const wrp = (file as File & { webkitRelativePath?: string }).webkitRelativePath || ''
          if (folder && wrp.includes('/')) {
            rootName ??= wrp.slice(0, wrp.indexOf('/'))
            return { file, rel: wrp.slice(wrp.indexOf('/') + 1) }
          }
          return { file, rel: file.name }
        })
        rec.done({ files, rootName })
      }
      const onCancel = (): void => rec.done(null)
      input.addEventListener('change', onChange)
      input.addEventListener('cancel', onCancel)
      inputs.add(rec)
      input.click()
    })
  }

  /** 逐个复制;null = 成功,字符串 = 失败原因(宿主 / 系统给的原文,界面上套 import.writeFailed),
   *  DISPOSED = 复制途中插件被卸了(调用方直接收手,不当成功)。 */
  async function copyAll(files: Picked[], dir: string, w: BytesWriter): Promise<string | typeof DISPOSED | null> {
    shell.setBusy({ text: () => t('import.copying', { n: files.length }) })
    try {
      for (const f of files) {
        if (!shell.alive()) return DISPOSED
        await w(joinRel(dir, f.rel), new Uint8Array(await f.file.arrayBuffer()))
      }
      return shell.alive() ? null : DISPOSED
    } catch (e) {
      if (!shell.alive()) return DISPOSED
      return e instanceof Error ? e.message : String(e)
    }
  }

  /** 离屏舞台:加载一遍拿体检结果,等几帧姿态落定后拍 512×512 缩略图。 */
  async function analyzeInto(dir: string, mainRel: string, motions: string[], w: BytesWriter): Promise<{ analysis: Analysis | null; preview: boolean; error?: Msg }> {
    const parsed = parseProfile(JSON.stringify({ live3d: 1, model: mainRel, motions }), dir)
    if (!parsed.ok) return { analysis: null, preview: false, error: parsed }
    if (!shell.alive()) return { analysis: null, preview: false } // 卸了就别再建 WebGL 舞台 / 离屏节点
    shell.setBusy({ text: () => t('import.analyzing') })
    let stage: Stage
    try {
      stage = createStage({ surface: 'studio', interactive: false, assetUrl: shell.assetUrl })
    } catch {
      return { analysis: null, preview: false, error: { zh: MSG.zh['studio.webglOff'], en: MSG.en['studio.webglOff'] } }
    }
    const box = document.createElement('div')
    box.className = 'l3-offscreen'
    box.style.cssText = OFFSCREEN_CSS
    document.body.appendChild(box)
    try {
      stage.attach(box)
      const r = await stage.setProfile(parsed.value)
      if (!r.ok) return { analysis: null, preview: false, error: r }
      await shell.sleep(450) // 让程序化姿态(手臂放下、朝向)跑几帧再拍
      let preview = false
      try {
        const blob = await stage.snapshot()
        if (blob) {
          await w(joinRel(dir, PREVIEW_FILE), new Uint8Array(await blob.arrayBuffer()))
          preview = true
        }
      } catch {
        preview = false
      }
      if (r.analysis) {
        try {
          await ctx.app.writeFile?.(joinRel(dir, ANALYSIS_FILE), JSON.stringify(r.analysis, null, 2) + '\n')
        } catch {
          /* 体检只是给 agent 的提示,写不进去不拦导入 */
        }
      }
      return { analysis: r.analysis, preview }
    } finally {
      stage.dispose()
      box.remove()
    }
  }

  /** `base` 去重:库里已有的文件夹、待 agent 的导入都算占用。
   *  slugify() 只出小写 [a-z0-9-],但 models/ 下可能有用户手建的任意大小写文件夹(models/<name>/),而 APFS / NTFS
   *  把 'Alice' 与 'alice' 当成**同一个**目录 —— 按大小写敏感比会把导入写进用户自己的文件夹、覆盖同名模型文件。
   *  所以折成 NFKC + 小写再比(NFKC 顺带接住 APFS 会折成 ASCII 的兼容字符,如 U+212A KELVIN SIGN)。 */
  async function uniqueSlug(base: string): Promise<string> {
    await shell.refresh(true)
    const fold = (s: string): string => s.normalize('NFKC').toLowerCase()
    const used = new Set([...shell.lib.state().slugs, ...Object.keys(shell.data().pending)].map(fold))
    if (!used.has(fold(base))) return base
    for (let i = 2; ; i++) if (!used.has(fold(`${base}-${i}`))) return `${base}-${i}`
  }

  /** 重扫模型库,直到看见刚写的 slug 文件夹。宿主的 listFiles 有 1.5s 短缓存且旧版写文件不清缓存 ——
   *  导入全程常常不到 1.5s,紧接着的重扫拿到的是**复制前**的清单(Desk 留在小球、设置里显示 ⚠ slug)。
   *  看不见就等缓存过期再扫一次;新宿主写后清缓存,不会走到等待。返回:扫完后看见了没有。 */
  async function refreshUntilListed(slug: string): Promise<boolean> {
    await shell.refresh(true)
    const seen = (): boolean => shell.lib.state().slugs.has(slug)
    if (seen() || shell.lib.state().noList || !shell.alive()) return seen()
    await shell.sleep(1600)
    if (!shell.alive()) return false
    await shell.refresh(true)
    return seen()
  }

  /** 没法写二进制:把目录建出来、在访达里打开(宿主能打开的话),让用户自己拷。 */
  async function noWriter(): Promise<void> {
    const folder = joinRel(shell.workFolder(), 'models')
    const canReveal = !!ctx.app.reveal
    await shell.openFolder()
    shell.say('warning', () => t(canReveal ? 'import.noWriter' : 'import.noWriterNoReveal', { folder }))
  }

  const agentAction = (slug: string, loadError?: string) => ({ label: () => t('btn.agentFix'), run: () => void importer.agentForSlug(slug, loadError) })

  async function guard(res: PickResult | null): Promise<Picked[] | null> {
    if (!res) return null
    if (running) {
      shell.say('info', () => t('import.busy'))
      return null
    }
    const files = cleanPicked(res.files)
    if (!files.length) {
      shell.say('info', () => t('import.empty'))
      return null
    }
    if (noVault()) {
      shell.say('warning', () => t('import.noVault'))
      return null
    }
    return files
  }

  async function copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  }

  /** 提示词本体在 ../prompt(纯函数,dev 台架 scripts/live-agent.mjs 用同一份);这里只解析绝对路径。 */
  function buildPrompt(slug: string, fileRels: string[], hasAnalysis: boolean, hasPreview: boolean, loadError?: string): string {
    const workFolder = shell.workFolder()
    let abs: string | null = null
    try {
      abs = ctx.app.hostPath?.(modelFolder(workFolder, slug)) ?? null
    } catch {
      abs = null
    }
    return buildImportPrompt({ workFolder, slug, absFolder: abs, files: fileRels, hasAnalysis, hasPreview, loadError })
  }

  async function startAgent(slug: string, fileRels: string[], hasAnalysis: boolean, hasPreview: boolean, loadError?: string): Promise<void> {
    const prompt = buildPrompt(slug, fileRels, hasAnalysis, hasPreview, loadError)
    shell.addPending(slug)
    if (!deps.startChat) {
      const copied = await copyText(prompt)
      shell.say('info', () => (copied ? t('agent.noStartChat') : t('agent.manual', { folder: `models/${slug}/` })))
      return
    }
    let r: StartChatResult
    try {
      r = await deps.startChat({ agent: IMPORTER_AGENT, folder: shell.workFolder(), send: true, prompt })
    } catch (e) {
      r = { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    if (r?.ok) {
      shell.say('info', () => t('agent.started'))
      return
    }
    const copied = await copyText(prompt)
    const why = r?.error || 'unknown error'
    shell.say('warning', () => (copied ? t('agent.failed', { why }) : t('agent.failedManual', { why, folder: `models/${slug}/` })))
  }

  const importer: Importer = {
    pickDirect(folder) {
      void choose(folder, folder ? null : DIRECT_ACCEPT).then((r) => (r ? importer.importDirect(r) : undefined))
    },
    pickAgent(folder) {
      void choose(folder, null).then((r) => (r ? importer.importWithAgent(r) : undefined))
    },

    async importDirect(res) {
      const files = await guard(res)
      if (!files) return
      const main = mainOf(files, MODEL_EXTS)
      if (!main) {
        if (files.some((f) => isLive2DPath(f.rel))) {
          shell.say('error', () => pick(LIVE2D_REFUSAL))
          return
        }
        // 不是能直接显示的格式:留着这批文件,提示条上给一颗「让 Agent 协助」直接接着用(不必重选)
        shell.say('warning', () => t('import.noMain'), { label: () => t('btn.agentImport'), run: () => void importer.importWithAgent(res) })
        return
      }
      const w = writer()
      if (!w) return noWriter()
      running = true
      try {
        const slug = await uniqueSlug(slugify(res.rootName && depth(main.rel) > 1 ? res.rootName : main.rel))
        const dir = modelFolder(shell.workFolder(), slug)
        const err = await copyAll(files, dir, w)
        if (err === DISPOSED) return
        if (err) {
          shell.say('error', () => t('import.writeFailed', { why: err }))
          return
        }
        void shell.ensureReadme()
        const motions = files.filter((f) => extOf(f.rel) === 'vrma').map((f) => f.rel)
        const a = await analyzeInto(dir, main.rel, motions, w)
        if (!shell.alive()) return
        if (a.error) {
          await refreshUntilListed(slug)
          if (!shell.alive()) return
          const e = a.error
          lastLoadError.set(slug, e.en)
          shell.say('error', () => t('import.loadFailed', { folder: dir, why: pick(e) }), agentAction(slug, e.en))
          return
        }
        const profPath = joinRel(dir, PROFILE_FILE)
        let existing: string | null = null
        try {
          existing = (await ctx.app.readFile?.(profPath)) ?? null
        } catch {
          existing = null
        }
        const prof = defaultProfileFor(main.rel, a.analysis, motions)
        if (existing == null) await ctx.app.writeFile?.(profPath, serializeProfile(prof))
        await refreshUntilListed(slug)
        if (!shell.alive()) return
        shell.setActive(slug)
        const entry = shell.lib.find(slug)
        const name = entry?.profile.name ?? prof.name
        // 扫完还是看不见(列不出文件 / 宿主缓存异常):别报「已设为 Desk 形象」—— Desk 此刻还是小球
        if (entry) shell.say('success', () => t('import.done', { name }))
        else shell.say('warning', () => t('import.doneNotListed', { name }))
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e)
        shell.say('error', () => t('import.writeFailed', { why }))
      } finally {
        running = false
        shell.setBusy(null)
      }
    },

    async importWithAgent(res) {
      const files = await guard(res)
      if (!files) return
      const main = mainOf(files, [...MODEL_EXTS, ...AGENT_EXTS])
      if (!main && files.some((f) => isLive2DPath(f.rel))) {
        shell.say('error', () => pick(LIVE2D_REFUSAL))
        return
      }
      const w = writer()
      if (!w) return noWriter()
      running = true
      try {
        const base = res.rootName && (!main || depth(main.rel) > 1) ? res.rootName : (main?.rel ?? files[0].rel)
        const slug = await uniqueSlug(slugify(base))
        const dir = modelFolder(shell.workFolder(), slug)
        const err = await copyAll(files, dir, w)
        if (err === DISPOSED) return
        if (err) {
          shell.say('error', () => t('import.writeFailed', { why: err }))
          return
        }
        void shell.ensureReadme()
        let a: { analysis: Analysis | null; preview: boolean; error?: Msg } = { analysis: null, preview: false }
        const fmt = main ? detectFormat(main.rel) : null
        if (main && fmt && fmt !== 'live2d' && (MODEL_EXTS as readonly ModelFormat[]).includes(fmt)) {
          const motions = files.filter((f) => extOf(f.rel) === 'vrma').map((f) => f.rel)
          a = await analyzeInto(dir, main.rel, motions, w)
        }
        if (!shell.alive()) return
        shell.setBusy(null)
        await refreshUntilListed(slug)
        if (!shell.alive()) return
        if (a.error) lastLoadError.set(slug, a.error.en)
        await startAgent(slug, files.map((f) => f.rel), !!a.analysis, a.preview, a.error?.en)
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e)
        shell.say('error', () => t('import.writeFailed', { why }))
      } finally {
        running = false
        shell.setBusy(null)
      }
    },

    async agentForSlug(slug, loadError) {
      const dir = modelFolder(shell.workFolder(), slug)
      let all: string[] = []
      try {
        all = ((await ctx.app.listFiles?.()) ?? []).map(normRel)
      } catch {
        all = []
      }
      const inner = all.filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1))
      const own = new Set([PROFILE_FILE, ANALYSIS_FILE, PREVIEW_FILE])
      await startAgent(slug, inner.filter((p) => !own.has(p)), inner.includes(ANALYSIS_FILE), inner.includes(PREVIEW_FILE), loadError ?? lastLoadError.get(slug))
    },

    async fromDrop(dt) {
      // getAsEntry 必须在 drop 事件里同步取;之后的遍历可以异步。
      const items = Array.from(dt.items ?? []).filter((i) => i.kind === 'file')
      const entries = items.map((i) => (i as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.() ?? null)
      const plain = Array.from(dt.files ?? [])
      if (!entries.length || entries.some((e) => !e)) return { files: plain.map((file) => ({ file, rel: file.name })), rootName: null }
      const out: Picked[] = []
      let rootName: string | null = null
      for (const en of entries as FileSystemEntry[]) {
        if (en.isDirectory) {
          rootName ??= en.name
          await walk(en as FileSystemDirectoryEntry, '', out)
        } else if (en.isFile) {
          out.push({ file: await fileOf(en as FileSystemFileEntry), rel: en.name })
        }
      }
      return { files: out, rootName }
    },

    busy: () => running,
    dispose() {
      for (const it of [...inputs]) it.done(null)
    },
  }
  return importer
}

const fileOf = (en: FileSystemFileEntry): Promise<File> => new Promise((res, rej) => en.file(res, rej))

async function walk(dir: FileSystemDirectoryEntry, prefix: string, out: Picked[]): Promise<void> {
  const reader = dir.createReader()
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej)) // 一次最多 100 条,读到空为止
    if (!batch.length) break
    for (const en of batch) {
      const rel = prefix ? `${prefix}/${en.name}` : en.name
      if (en.isDirectory) await walk(en as FileSystemDirectoryEntry, rel, out)
      else if (en.isFile) out.push({ file: await fileOf(en as FileSystemFileEntry), rel })
    }
  }
}
