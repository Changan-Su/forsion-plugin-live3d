// 插件壳的共享状态:落盘设置(模式 / 当前形象 / 待 agent 写好的导入)、模型库、提示条、忙碌态,外加
// 一切需要在 dispose 时收干净的定时器与文件监听。视图(设置页 / 模型库 / Desk 工具条)只订阅 `onChange` 重画。
import type { Profile, ResolvedProfile } from '../contract'
import { PROFILE_FILE, claimFor, joinRel, modelFolder } from '../contract'
import { createLibrary, workFolderOf, FOLDER_README, type LibEntry, type Library } from '../library'
import { serializeProfile } from '../profile'
import { pick, t } from '../i18n'
import type { AgentInfo, CompanionMode, HostCtx } from './host'

export interface Data {
  mode: CompanionMode
  /** 当前 Desk 形象的 slug;null = 默认小球。 */
  active: string | null
  /** 交给 Live3D Importer 的导入:slug → 开始时刻(ms)。它的 live3d.json 出现就自动载入并设为当前。
   *  落盘是为了「agent 还在干活时重启了 app」也能接上。 */
  pending: Record<string, number>
}

const DEFAULT_DATA: Data = { mode: 'idle', active: null, pending: {} }
/** 超过这么久还没写出 live3d.json 的待办就不再轮询(agent 早就放弃了,或用户换了别的办法)。 */
const PENDING_MAX_MS = 6 * 3600_000
const PENDING_POLL_MS = 3000
/** profile 已写好、模型文件还没落盘时的重扫间隔(重扫 = 整库 listFiles,别每 3s 一次;转换失败的待办能挂 6h)。 */
const MISSING_RESCAN_MS = 10_000
/** 库根轮询:宿主的库是惰性恢复的,用户进 Amadeus 之前 vaultRoot() 是 null —— 恢复那一刻没有事件可听。 */
const STALE_POLL_MS = 4000

export interface NoticeAction {
  label: () => string
  run: () => void
}

export interface Notice {
  level: 'info' | 'success' | 'warning' | 'error'
  /** 函数形式:切语言时照新语言重画。 */
  text: () => string
  /** 附带一颗按钮(典型:「让 Agent 协助处理」)。 */
  action?: NoticeAction
}

export interface Busy {
  text: () => string
}

export interface Shell {
  ctx: HostCtx
  lib: Library
  data(): Data
  ready: Promise<void>
  workFolder(): string
  /** 库内相对路径 → 可 fetch / 可作 <img src> 的 URL。 */
  assetUrl(rel: string): string
  setMode(mode: CompanionMode): void
  setActive(slug: string | null): void
  activeEntry(): LibEntry | null
  /** Desk 该显示的 profile:没有 / 模型文件丢了 → null(小球)。 */
  activeProfile(): ResolvedProfile | null
  /** 这个 Agent 在 Desk 上该用哪个形象:先看谁在 `agents` 里认领了它,没人认领退回「默认形象」。
   *  `agentSlug` 为空(旧宿主 / 外部引擎会话)= 一直用默认形象。 */
  entryForAgent(agentSlug: string | null | undefined): LibEntry | null
  profileForAgent(agentSlug: string | null | undefined): ResolvedProfile | null
  /** 宿主的 Agent 名册;旧宿主拿不到 → 空数组(绑定界面据此退化)。 */
  agents(): AgentInfo[]
  /** 改一份 profile 并落盘(绑定、姿势都走它),写完重扫。宿主不能写文件 → false 并已出声。 */
  writeProfile(entry: LibEntry, next: Profile): Promise<boolean>
  refresh(force?: boolean): Promise<void>
  addPending(slug: string): void
  isPending(slug: string): boolean
  notice(): Notice | null
  setNotice(n: Notice | null): void
  busy(): Busy | null
  setBusy(b: Busy | null): void
  /** 提示:右上角通知 + 模型库顶部提示条(后者带按钮)。 */
  say(level: Notice['level'], text: () => string, action?: NoticeAction): void
  /** 先落 README(把目录建出来),再在系统文件管理器里选中它。 */
  openFolder(): Promise<void>
  ensureReadme(): Promise<boolean>
  onChange(cb: () => void): () => void
  emit(): void
  /** 可取消的等待:dispose 时立刻放行(不留悬空定时器)。 */
  sleep(ms: number): Promise<void>
  /** 定时器登记:dispose 统一清。 */
  every(ms: number, fn: () => void): () => void
  alive(): boolean
  dispose(): void
}

export function createShell(ctx: HostCtx): Shell {
  let data: Data = { ...DEFAULT_DATA, pending: {} }
  let notice: Notice | null = null
  let busy: Busy | null = null
  let disposed = false
  const subs = new Set<() => void>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const intervals = new Set<ReturnType<typeof setInterval>>()
  const wakers = new Set<() => void>()

  const isPending = (slug: string): boolean => Object.prototype.hasOwnProperty.call(data.pending, slug)
  const lib = createLibrary(ctx, isPending)

  const save = (): void => {
    try {
      void ctx.saveData?.(data)?.catch?.(() => {})
    } catch {
      /* 旧宿主 / 写失败:内存里的值照用 */
    }
  }

  const emit = (): void => {
    if (disposed) return
    for (const cb of [...subs]) {
      try {
        cb()
      } catch (e) {
        console.error('[live3d] listener failed', e)
      }
    }
  }
  const offLib = lib.onChange(() => {
    syncWatch()
    emit()
  })

  const ready = Promise.resolve()
    .then(() => ctx.loadData?.<Partial<Data>>())
    .then((v) => {
      if (!v || typeof v !== 'object') return
      data = {
        mode: v.mode === 'always' ? 'always' : 'idle',
        active: typeof v.active === 'string' && v.active ? v.active : null,
        pending: v.pending && typeof v.pending === 'object' ? { ...v.pending } : {},
      }
    })
    .catch(() => {})
    .then(() => {
      if (disposed) return
      prunePending()
      emit()
    })

  // ── 文件监听 ─────────────────────────────────────────────────────────────────
  // 盯「当前形象」与「待 agent 写好」的 live3d.json 的**内容变化**(watchFile 只报 change,新建不报 —— 新建靠下面的轮询)。
  // 只 watch 文本 profile(经 writeFile 落盘有自写账本,不回声);绝不 watch 自己 writeBytes 的二进制。
  const watches = new Map<string, () => void>()
  function syncWatch(): void {
    if (disposed || !ctx.app.watchFile) return
    const want = new Set<string>()
    const work = workFolderOf(ctx)
    if (data.active) want.add(joinRel(modelFolder(work, data.active), PROFILE_FILE))
    for (const slug of Object.keys(data.pending)) want.add(joinRel(modelFolder(work, slug), PROFILE_FILE))
    // 绑给 Agent 的那些也要盯着:调姿势(pose)天生是「让 agent 改一个数、立刻看一眼」的来回,
    // 只盯「默认形象」的话,正在 Desk 上显示的那份反而不会热更新。
    for (const e of lib.state().entries) if (e.profile.agents.length) want.add(e.profilePath)
    for (const [p, off] of watches) {
      if (!want.has(p)) {
        off()
        watches.delete(p)
      }
    }
    for (const p of want) {
      if (watches.has(p)) continue
      try {
        watches.set(p, ctx.app.watchFile(p, () => void shell.refresh(true)))
      } catch {
        /* 旧宿主 / 无库 */
      }
    }
  }

  // ── 待 agent 写好的导入:轮询 live3d.json 出现 ──────────────────────────────────
  /** slug → 已经**处理过**的那一版 live3d.json 文本(同一版不重复扫 / 重复提示)。只在扫描真的看到了这份 profile
   *  (载入成功 / 模型未到 / 写坏了)之后才记;扫描结果比文件旧(宿主 listFiles 有 1.5s 缓存)时不记,下一轮重来 ——
   *  否则这一版被当成「处理过」,之后永远跳过,导入卡死在「导入中」。 */
  const seenPending = new Map<string, string>()
  /** profile 写好了、但它指的模型文件还没到(agent 先写 profile 后转换 / 转换失败):slug → 上次重扫时刻。 */
  const waitingModel = new Map<string, number>()
  let polling = false
  function prunePending(): void {
    const now = Date.now()
    let changed = false
    for (const [slug, at] of Object.entries(data.pending)) {
      if (typeof at !== 'number' || now - at > PENDING_MAX_MS) {
        delete data.pending[slug]
        seenPending.delete(slug)
        waitingModel.delete(slug)
        changed = true
      }
    }
    if (changed) save()
    syncWatch()
  }
  async function pollPending(): Promise<void> {
    if (polling || disposed || !Object.keys(data.pending).length) return
    polling = true
    try {
      prunePending()
      const work = workFolderOf(ctx)
      for (const slug of Object.keys(data.pending)) {
        let text: string | null = null
        try {
          text = (await ctx.app.readFile?.(joinRel(modelFolder(work, slug), PROFILE_FILE))) ?? null
        } catch {
          text = null
        }
        if (disposed) return
        if (text == null) continue
        const repeat = seenPending.get(slug) === text
        if (repeat) {
          // 同一版处理过了;只有「模型文件还没到」的才隔一阵重扫一次,看它到了没有
          const last = waitingModel.get(slug)
          if (last == null || Date.now() - last < MISSING_RESCAN_MS) continue
        }
        await lib.refresh(true)
        if (disposed) return
        const entry = lib.find(slug)
        const bad = lib.state().problems.find((p) => p.slug === slug)
        if (entry && !entry.modelMissing) {
          delete data.pending[slug]
          seenPending.delete(slug)
          waitingModel.delete(slug)
          data.active = slug
          save()
          syncWatch()
          emit()
          shell.say('success', () => t('agent.loaded', { name: entry.profile.name }))
        } else if (entry) {
          // profile 合法但模型文件还没到:**不**算完成(Desk 会是小球),留在待办里隔一阵重扫;每个版本只提示一次
          waitingModel.set(slug, Date.now())
          seenPending.set(slug, text)
          if (!repeat && bad) shell.say('warning', () => t('agent.badProfile', { why: pick(bad.reason) }))
        } else if (bad && bad.kind !== 'pending' && bad.kind !== 'no-profile') {
          // 写了但写坏了:说一声(每个版本只说一次),继续等它改好
          waitingModel.delete(slug)
          seenPending.set(slug, text)
          if (!repeat) shell.say('warning', () => t('agent.badProfile', { why: pick(bad.reason) }))
        }
        // 否则:文件读得到,扫描却还没看见它(清单是旧的)—— 什么都不记、不提示,下一轮再扫
      }
    } finally {
      polling = false
    }
  }

  const shell: Shell = {
    ctx,
    lib,
    data: () => data,
    ready,
    workFolder: () => workFolderOf(ctx),
    assetUrl: (rel) => {
      try {
        const u = ctx.app.assetUrl?.(rel)
        if (u) return u
      } catch {
        /* 退回手拼 */
      }
      return `amadeus-asset://v/${encodeURIComponent(rel)}`
    },
    setMode(mode) {
      if (mode !== 'idle' && mode !== 'always') return
      if (data.mode === mode) return
      data.mode = mode
      save()
      emit()
    },
    setActive(slug) {
      const next = slug || null
      if (data.active === next) return
      data.active = next
      save()
      syncWatch()
      emit()
    },
    activeEntry: () => lib.find(data.active),
    activeProfile() {
      const e = lib.find(data.active)
      return e && !e.modelMissing ? e.profile : null
    },
    entryForAgent(agentSlug) {
      const claimed = claimFor(
        lib.state().entries.map((e) => ({ slug: e.slug, agents: e.profile.agents, entry: e })),
        agentSlug,
      )
      // 绑定的那份模型文件丢了 → 退回默认形象(总比一个小球加一句看不见的报错强)
      if (claimed && !claimed.entry.modelMissing) return claimed.entry
      return lib.find(data.active)
    },
    profileForAgent(agentSlug) {
      const e = shell.entryForAgent(agentSlug)
      return e && !e.modelMissing ? e.profile : null
    },
    agents() {
      try {
        return ctx.tangu?.agents?.() ?? []
      } catch {
        return []
      }
    },
    async writeProfile(entry, next) {
      if (!ctx.app.writeFile) {
        shell.say('warning', () => t('profile.noWriter'))
        return false
      }
      try {
        await ctx.app.writeFile(entry.profilePath, serializeProfile(next))
      } catch (e) {
        shell.say('error', () => t('profile.writeFailed', { why: e instanceof Error ? e.message : String(e) }))
        return false
      }
      await lib.refresh(true)
      return true
    },
    async refresh(force = false) {
      await lib.refresh(force)
    },
    addPending(slug) {
      data.pending[slug] = Date.now()
      seenPending.delete(slug)
      waitingModel.delete(slug)
      save()
      syncWatch()
      emit()
    },
    isPending,
    notice: () => notice,
    setNotice(n) {
      notice = n
      emit()
    },
    busy: () => busy,
    setBusy(b) {
      busy = b
      emit()
    },
    say(level, text, action) {
      if (disposed) return
      const msg = text()
      if (ctx.notify) ctx.notify(msg, { level, title: 'Live3D' })
      else ctx.app.notify(msg)
      notice = { level, text, ...(action ? { action } : {}) }
      emit()
    },
    async ensureReadme() {
      const guide = `${workFolderOf(ctx)}/README.md`
      try {
        if ((await ctx.app.readFile?.(guide)) == null) {
          if (!ctx.app.writeFile) return false
          await ctx.app.writeFile(guide, FOLDER_README)
        }
        return true
      } catch {
        return false
      }
    },
    async openFolder() {
      const home = workFolderOf(ctx)
      const okReadme = await shell.ensureReadme()
      if (!okReadme) {
        // 目录也不存在的话 reveal 是**静默无反应** —— 必须出声,一颗点了没反应的按钮比没有按钮更难查。
        shell.say('warning', () => t('import.folderFailed', { folder: home }))
      }
      ctx.app.reveal?.(okReadme ? `${home}/README.md` : home)
    },
    onChange(cb) {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    emit,
    sleep(ms) {
      return new Promise<void>((resolve) => {
        if (disposed) return resolve()
        const wake = (): void => {
          clearTimeout(h)
          timers.delete(h)
          wakers.delete(wake)
          resolve()
        }
        const h = setTimeout(wake, ms)
        timers.add(h)
        wakers.add(wake)
      })
    },
    every(ms, fn) {
      const h = setInterval(() => {
        try {
          fn()
        } catch (e) {
          console.error('[live3d] timer failed', e)
        }
      }, ms)
      intervals.add(h)
      return () => {
        clearInterval(h)
        intervals.delete(h)
      }
    },
    alive: () => !disposed,
    dispose() {
      if (disposed) return
      disposed = true
      offLib()
      for (const off of watches.values()) {
        try {
          off()
        } catch {
          /* ignore */
        }
      }
      watches.clear()
      for (const h of intervals) clearInterval(h)
      intervals.clear()
      for (const wake of [...wakers]) wake()
      for (const h of timers) clearTimeout(h)
      timers.clear()
      subs.clear()
    },
  }

  shell.every(PENDING_POLL_MS, () => void pollPending())
  // 库根变了(库惰性恢复 / 换库)→ 重扫。只比对字符串,很便宜。
  shell.every(STALE_POLL_MS, () => {
    if (lib.stale()) void lib.refresh()
  })
  return shell
}

