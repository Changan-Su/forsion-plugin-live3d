// 宿主 ctx 的本地镜像(手抄自 Forsion-Genesis desktop/frontend/src/amadeus/plugins/{types,deskCompanion,tanguSeam}.ts)。
// 外置插件没有 import 宿主类型的门路,只能抄;抄的原则:
//  - **比契约更保守**:契约里标「旧宿主没有」的成员一律可选,连 readFile / writeFile / registerView 这类
//    「现在都有」的也按可选写 —— check.mjs 的裸 ctx(老宿主)只给 app.notify / registerCommand / registerSetting,
//    setup 在那上面不许抛;
//  - 只抄本插件用得到的成员。

export type Locale = 'zh' | 'en'

/** = 宿主 TanguAgentPhase。 */
export type AgentPhase = 'idle' | 'thinking' | 'speaking' | 'tool' | 'waiting' | 'error' | 'done'

/** = 宿主 TanguAgentStatus。 */
export interface AgentStatus {
  phase: AgentPhase
  sessionId: string | null
  runId: string | null
  tool?: string
  toolStage?: 'args' | 'exec'
  waitingFor?: 'approval' | 'inquiry'
  since: number
  until?: number
  messageId?: string
  textChars: number
  reasoningChars: number
  /** 2026-09-20+:这个会话用的是哪个 Agent(slug)。旧宿主 / 外部引擎会话 / 草稿之外推导不出来 → undefined。 */
  agentSlug?: string
  /** 该 Agent 的展示名;名册里查不到时省略。 */
  agentName?: string
}

/** = 宿主 TanguAgentInfo(2026-09-20+)。 */
export interface AgentInfo {
  slug: string
  name: string
}

export const idleStatus = (sessionId: string | null = null): AgentStatus =>
  ({ phase: 'idle', sessionId, runId: null, since: 0, textChars: 0, reasoningChars: 0 })

/** = 宿主 DeskCompanionMode / Surface / Host / Contribution / Handle。 */
export type CompanionMode = 'always' | 'idle'
export type CompanionSurface = 'desk-card' | 'desk-panel'
export interface CompanionHost {
  surface: CompanionSurface
  sessionId(): string | null
  status(): AgentStatus
  onStatus(cb: (s: AgentStatus) => void): () => void
}
export interface CompanionContribution {
  id: string
  mode: CompanionMode
  mount(el: HTMLElement, host: CompanionHost): void | (() => void)
}
export interface CompanionHandle {
  update(patch: { mode?: CompanionMode }): void
  dispose(): void
}

export interface StartChatResult {
  ok: boolean
  sessionId?: string
  error?: string
}

export interface HostApp {
  notify(message: string): void
  /** 没有活动库 / 不存在 → null(不抛)。 */
  readFile?(path: string): Promise<string | null>
  /** 自写账本:同路径 watchFile 不回声。没有活动库 → reject。 */
  writeFile?(path: string, text: string): Promise<void>
  workFolder?(): string
  /** 2026-09-19+。⚠️不走自写账本 —— 别 watch 自己写的二进制。 */
  writeBytes?(path: string, bytes: Uint8Array | ArrayBuffer): Promise<void>
  readBytes?(path: string): Promise<Uint8Array | null>
  assetUrl?(path: string): string
  reveal?(path: string): void
  vaultRoot?(): string | null
  hostPath?(path: string): string | null
  /** 只报「内容变了」(chokidar 'change'),**新建不报**。 */
  watchFile?(path: string, cb: () => void): () => void
  listFiles?(): Promise<string[]>
  openFile?(path: string): void
}

export interface ViewDef {
  id: string
  title: string
  mount(el: HTMLElement): (() => void) | void
  singleton?: boolean
}

export interface HostCtx {
  app: HostApp
  registerCommand(def: { id: string; title: string; keywords?: string; run(): void | Promise<void> }): void
  registerView?(def: ViewDef): void
  openView?(viewId: string, opts?: { location?: 'main' | 'left' | 'right' }): void
  registerSettingsView?(def: { id: string; title?: string; mount(el: HTMLElement): void | (() => void) }): void
  notify?(message: string, opts?: { level?: 'info' | 'success' | 'warning' | 'error'; title?: string; sticky?: boolean }): void
  getLocale?(): Locale
  subscribeLocale?(cb: (locale: Locale) => void): () => void
  loadData?<T = unknown>(): Promise<T | null>
  saveData?(value: unknown): Promise<void>
  tangu?: {
    activeSpace?(): string | null
    /** Agent 名册(2026-09-20+)。旧宿主没有 → 绑定界面退回「只能绑当前对话的 Agent」。 */
    agents?(): AgentInfo[]
    agentStatus?(sessionId?: string | null): AgentStatus
    subscribeAgentStatus?(cb: (s: AgentStatus) => void, sessionId?: string | null): () => void
    startChat?(o: { agent?: string; prompt: string; send?: boolean; folder?: string }): Promise<StartChatResult>
  }
  desk?: {
    registerCompanion(def: CompanionContribution): CompanionHandle
  }
  /** 活动日志(喂给 Muse 这类后台 Agent);事件名宿主自动加 `plugin:<id>:` 前缀。 */
  activity?: {
    log(event: string, detail?: Record<string, unknown>): void
  }
}

/** 旧宿主没有 ctx.app.writeBytes 时的降级口:渲染进程主世界上的 Amadeus 桥(types.ts 承认的 ambient authority)。
 *  **只作降级,不是设计**。 */
export interface AmadeusBridgeLike {
  saveVaultBytes?(rel: string, bytes: Uint8Array): Promise<unknown>
}
export const amadeusBridge = (): AmadeusBridgeLike | null => {
  try {
    const w = globalThis as unknown as { amadeus?: AmadeusBridgeLike; window?: { amadeus?: AmadeusBridgeLike } }
    return w.window?.amadeus ?? w.amadeus ?? null
  } catch {
    return null
  }
}
