// 3D 小屋的共享舞台:全插件只有**一个**房间舞台(WebGL 上下文 + 解析好的模型都贵 —— 一份 MMD 模型几十 MB、
// 几十万面),Space 里的小屋视图与全屏屏保**借用**同一块画布:谁优先级高(屏保 > 视图)、谁最近借,画布就搬到谁那里。
// 全部还回来之后留一会儿(切 Space 来回的空档)再释放。
//
// 住在房间里的是谁:场景写了 character 就用那个模型;没写 = 跟 Desk 同一套规矩(当前对话的 Agent 绑了哪个形象,
// 没绑就用 Desk 默认形象;都没有就是小球)。
import { pick, t } from '../i18n'
import type { ResolvedProfile } from '../contract'
import { createRoomStage, type RoomMode, type RoomStage } from '../room/roomStage'
import { builtinScene } from '../room/presets'
import type { ResolvedScene } from '../room/scene'
import type { SceneEntry } from '../room/sceneLibrary'
import { idleStatus, type AgentStatus } from './host'
import type { Shell } from './state'

const RELEASE_AFTER_MS = 60_000

export interface Borrow {
  release(): void
  /** 画布此刻在不在我这里。 */
  owns(): boolean
}

export interface RoomHost {
  borrow(el: HTMLElement, o: { mode: RoomMode; priority: number; onOwner?: (owns: boolean) => void }): Borrow
  /** 此刻用的场景(自建的 / 内置的)。 */
  scene(): { scene: ResolvedScene; entry: SceneEntry | null }
  stage(): RoomStage | null
  /** 住客加载失败的原因(没有 = null)。 */
  error(): (() => string) | null
  loading(): boolean
  onChange(cb: () => void): () => void
  dispose(): void
}

interface Holder {
  el: HTMLElement
  mode: RoomMode
  priority: number
  seq: number
  onOwner?: (owns: boolean) => void
}

export function createRoomHost(shell: Shell): RoomHost {
  const ctx = shell.ctx
  const holders: Holder[] = []
  let owner: Holder | null = null
  let stage: RoomStage | null = null
  let seq = 0
  let releaseOff: (() => void) | null = null
  let offStatus: (() => void) | undefined
  let appliedScene = ''
  let appliedChar = ''
  let err: (() => string) | null = null
  let loading = false
  /** 住客加载请求的编号:A 还在加载时换成 B,A 的结果回来不许动 B 的「加载中」。 */
  let charReq = 0
  let disposed = false
  const subs = new Set<() => void>()
  const emit = (): void => {
    for (const cb of [...subs]) {
      try {
        cb()
      } catch (e) {
        console.error('[live3d] room listener failed', e)
      }
    }
  }

  const liveStatus = (): AgentStatus => {
    try {
      return ctx.tangu?.agentStatus?.() ?? idleStatus(null)
    } catch {
      return idleStatus(null)
    }
  }

  function currentScene(): { scene: ResolvedScene; entry: SceneEntry | null } {
    const st = shell.scenes.state()
    const want = shell.data().scene
    const entry = (want ? shell.scenes.find(want) : null) ?? st.entries[0] ?? null
    return { scene: entry?.scene ?? builtinScene(), entry }
  }

  function residentProfile(scene: ResolvedScene): ResolvedProfile | null {
    if (scene.character) {
      const e = shell.lib.find(scene.character)
      if (e && !e.modelMissing) return e.profile
    }
    return shell.profileForAgent(liveStatus().agentSlug ?? null)
  }

  function sync(): void {
    if (!stage) return
    const { scene } = currentScene()
    const sk = JSON.stringify(scene)
    if (sk !== appliedScene) {
      appliedScene = sk
      stage.setScene(scene)
    }
    stage.setTime(shell.data().time)
    const p = residentProfile(scene)
    const ck = p ? `${p.dir}\n${JSON.stringify(p)}` : 'orb'
    if (ck === appliedChar) return
    appliedChar = ck
    loading = !!p
    err = null
    emit()
    const st = stage
    const my = ++charReq
    void st.setCharacter(p).then((r) => {
      if (st !== stage || disposed || my !== charReq) return
      loading = false
      if (!r.ok && r.code !== 'superseded' && r.code !== 'disposed') {
        const name = p?.name ?? ''
        err = () => t('room.loadFailed', { name, why: pick(r) })
      }
      emit()
    })
  }

  function ensureStage(): RoomStage | null {
    if (stage) return stage
    try {
      stage = createRoomStage({ assetUrl: shell.assetUrl })
    } catch (e) {
      console.error('[live3d] WebGL unavailable', e)
      err = () => t('studio.webglOff')
      return null
    }
    appliedScene = appliedChar = ''
    try {
      offStatus = ctx.tangu?.subscribeAgentStatus?.((s) => {
        stage?.setStatus(s)
        sync() // 换了会话 = 可能换了 Agent → 住客跟着换(场景没写 character 时)
      })
    } catch {
      offStatus = undefined
    }
    stage.setStatus(liveStatus())
    stage.setStatusSource(liveStatus)
    sync()
    return stage
  }

  function pickOwner(): Holder | null {
    let best: Holder | null = null
    for (const h of holders) if (!best || h.priority > best.priority || (h.priority === best.priority && h.seq > best.seq)) best = h
    return best
  }

  function repick(): void {
    const next = pickOwner()
    if (next === owner) return
    const prev = owner
    owner = next
    prev?.onOwner?.(false)
    if (!next) {
      stage?.detach()
      scheduleRelease()
      return
    }
    const st = ensureStage()
    if (!st) return
    st.attach(next.el, { mode: next.mode })
    next.onOwner?.(true)
  }

  function scheduleRelease(): void {
    releaseOff?.()
    let fired = false
    const off = shell.every(RELEASE_AFTER_MS, () => {
      if (fired) return
      fired = true
      off()
      releaseOff = null
      if (holders.length || !stage) return
      try {
        offStatus?.()
      } catch {
        /* 宿主已收 */
      }
      offStatus = undefined
      stage.dispose()
      stage = null
    })
    releaseOff = off
  }

  const offShell = shell.onChange(() => {
    sync()
    emit()
  })

  return {
    borrow(el, o) {
      if (disposed) return { release() {}, owns: () => false }
      releaseOff?.()
      releaseOff = null
      const h: Holder = { el, mode: o.mode, priority: o.priority, seq: ++seq, onOwner: o.onOwner }
      holders.push(h)
      repick()
      void shell.refresh()
      let done = false
      return {
        release() {
          if (done) return
          done = true
          const i = holders.indexOf(h)
          if (i >= 0) holders.splice(i, 1)
          if (owner === h) {
            owner = null
            stage?.detach()
            h.onOwner?.(false)
          }
          repick()
          if (!holders.length) scheduleRelease()
        },
        owns: () => owner === h,
      }
    },
    scene: currentScene,
    stage: () => stage,
    error: () => err,
    loading: () => loading,
    onChange(cb) {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    dispose() {
      if (disposed) return
      disposed = true
      offShell()
      releaseOff?.()
      try {
        offStatus?.()
      } catch {
        /* ignore */
      }
      holders.splice(0)
      owner = null
      stage?.dispose()
      stage = null
      subs.clear()
    },
  }
}
