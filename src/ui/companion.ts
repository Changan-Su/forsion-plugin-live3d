// Agent Desk 伴随面(ctx.desk.registerCompanion)。
//
// 宿主的挂载点不止一个:卡片(desk-card)与展开侧板(desk-panel)是**两个**挂载点,收起 / 展开在两者之间切换;
// 多个聊天面板各有一张卡片。WebGL 上下文(Chromium 同时 ~16 个)与解析好的模型都贵,所以:
//  - 全插件只有**一个** Desk 舞台,画布搬到**最近挂上来、且看得见**(尺寸非 0)的那个挂载点(stage.attach 会先从旧
//    容器摘下)。宿主会把伴随面挂进被 CSS 藏起来的卡片(窄栏 @container 下的 display:none、迷你窗)—— 只按「最近挂上」
//    的话,一个看不见的卡片就能把画布抢走,看得见的那张只剩占位。每个挂载点挂一个 ResizeObserver,显隐一变就重挑;
//    全都看不见时不搬(保持原主人)。
//  - 同时挂着的其它挂载点显示一行轻提示,不再各起一个上下文;
//  - 所有挂载点都卸了之后留一会儿(收起→展开之间有空档),超时才真正释放 GL 与模型。
// 驱动状态的是**持有画布的那个挂载点**的 host:换主人时退订旧 host.onStatus、订新的;说话期间逐帧拉 host.status()
// 的 textChars 做口型。宿主 onStatus 不补发初值 → 挂上时先拉一次 host.status()。
import { serializeProfile } from '../profile'
import { createStage, type Stage, type StageSurface } from '../stage'
import { pick, t } from '../i18n'
import { esc } from './dom'
import { idleStatus, type AgentStatus, type CompanionHandle, type CompanionHost, type HostCtx } from './host'
import type { Shell } from './state'
import { createToolbar, type Toolbar } from './toolbar'

/** 所有挂载点都卸了之后,Desk 舞台保留多久再释放 GL / 模型。 */
const RELEASE_AFTER_MS = 60_000

interface Slot {
  host: CompanionHost
  surface: StageSurface
  wrap: HTMLElement
  toolbar: Toolbar | null
  note: HTMLElement | null
  off: (() => void) | null
}

export interface Companion {
  dispose(): void
}

export function createCompanion(shell: Shell, desk: NonNullable<HostCtx['desk']>, openStudio: () => void): Companion {
  const slots: Slot[] = []
  let owner: Slot | null = null
  let stage: Stage | null = null
  let webglBroken = false
  let appliedKey: string | null = null
  let failedKey: string | null = null
  let releaseOff: (() => void) | null = null
  let lastMode = shell.data().mode
  /** 画布主人那个会话属于哪个 Agent(宿主 2026-09-20+ 才给);决定 Desk 上显示哪个形象。 */
  let ownerAgent: string | null = null
  let disposed = false
  // 显隐变化 → 重挑画布主人(check.mjs 的节点桩没有 ResizeObserver:那里退回「最近挂上」)
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => repick()) : null

  const statusOf = (host: CompanionHost): AgentStatus => {
    try {
      return host.status() ?? idleStatus(null)
    } catch {
      return idleStatus(null)
    }
  }

  const ensureStage = (): Stage | null => {
    if (stage || webglBroken) return stage
    try {
      stage = createStage({ surface: 'card', interactive: false, assetUrl: shell.assetUrl })
    } catch (e) {
      console.error('[live3d] WebGL unavailable', e)
      webglBroken = true
      stage = null
    }
    appliedKey = null
    return stage
  }

  const setNote = (slot: Slot, text: string | null): void => {
    if (!text) {
      slot.note?.remove()
      slot.note = null
      return
    }
    if (!slot.note) {
      slot.note = document.createElement('div')
      slot.note.className = 'l3-placeholder'
      slot.wrap.appendChild(slot.note)
    }
    slot.note.innerHTML = `<span>${esc(text)}</span>`
  }

  function syncProfile(): void {
    if (!stage) return
    const p = shell.profileForAgent(ownerAgent)
    const key = p ? `${p.dir}\n${serializeProfile(p)}` : 'orb'
    if (key === appliedKey) return
    appliedKey = key
    const name = shell.entryForAgent(ownerAgent)?.profile.name ?? ''
    const st = stage
    void st.setProfile(p).then((r) => {
      if (r.ok || r.code === 'superseded' || r.code === 'disposed' || st !== stage) return
      if (failedKey === key) return // 同一份配置只报一次(别每次重画都弹)
      failedKey = key
      shell.say('error', () => t('active.loadFailed', { name, why: pick(r) }))
    })
  }

  function claim(slot: Slot): void {
    const st = ensureStage()
    if (!st) {
      setNote(slot, t('placeholder.webgl'))
      return
    }
    if (owner && owner !== slot) {
      owner.off?.()
      owner.off = null
      setNote(owner, t('placeholder.elsewhere'))
    }
    owner = slot
    setNote(slot, null)
    st.attach(slot.wrap, { surface: slot.surface })
    if (slot.toolbar) slot.wrap.appendChild(slot.toolbar.el) // 叠在画布之上
    // 换了主人 = 多半换了会话,也就可能换了 Agent → 形象要跟着换(下面 syncProfile 那一步)。
    ownerAgent = statusOf(slot.host).agentSlug ?? null
    slot.off = slot.host.onStatus((s) => {
      st.setStatus(s)
      const next = s.agentSlug ?? null
      if (next === ownerAgent) return
      ownerAgent = next
      syncProfile()
    })
    st.setStatus(statusOf(slot.host))
    st.setStatusSource(() => statusOf(slot.host))
    syncProfile()
  }

  const shown = (s: Slot): boolean => {
    const r = s.wrap.getBoundingClientRect()
    return r.width > 1 && r.height > 1
  }
  /** 画布该在哪:最近挂上的**看得见**的挂载点;一个都看不见 → 原主人还在就不动,没有主人就给最近挂上的。 */
  function pickOwner(): Slot | null {
    for (let i = slots.length - 1; i >= 0; i--) if (shown(slots[i])) return slots[i]
    return owner && slots.includes(owner) ? owner : slots[slots.length - 1] ?? null
  }
  function repick(): void {
    if (disposed) return
    const next = pickOwner()
    if (next && next !== owner) claim(next)
  }

  function release(slot: Slot): void {
    const i = slots.indexOf(slot)
    if (i < 0) return
    slots.splice(i, 1)
    ro?.unobserve(slot.wrap)
    slot.off?.()
    slot.off = null
    slot.toolbar?.dispose()
    slot.toolbar = null
    if (owner === slot) {
      owner = null
      stage?.setStatusSource(null)
      stage?.detach() // 先摘画布,宿主随后 replaceChildren
      const next = pickOwner()
      if (next) claim(next)
    }
    slot.wrap.remove()
    if (!slots.length) scheduleRelease()
  }

  function scheduleRelease(): void {
    releaseOff?.()
    let fired = false
    const off = shell.every(RELEASE_AFTER_MS, () => {
      if (fired) return
      fired = true
      off()
      releaseOff = null
      if (slots.length || !stage) return
      stage.dispose()
      stage = null
      appliedKey = null
    })
    releaseOff = off
  }

  const handle: CompanionHandle = desk.registerCompanion({
    id: 'avatar',
    mode: shell.data().mode,
    mount(el, host) {
      if (disposed) return
      releaseOff?.()
      releaseOff = null
      const wrap = document.createElement('div')
      wrap.className = 'l3-slot'
      const surface: StageSurface = host.surface === 'desk-panel' ? 'panel' : 'card'
      wrap.dataset.surface = surface
      el.appendChild(wrap)
      const slot: Slot = { host, surface, wrap, toolbar: null, note: null, off: null }
      if (surface === 'panel') slot.toolbar = createToolbar(shell, openStudio)
      slots.push(slot)
      ro?.observe(wrap)
      const next = pickOwner()
      if (next && next !== owner) claim(next)
      else if (next !== slot) setNote(slot, stage || !webglBroken ? t('placeholder.elsewhere') : t('placeholder.webgl'))
      void shell.refresh() // 库根没变就是空操作;变了(库刚恢复)顺手重扫
      return () => release(slot)
    },
  })

  const offShell = shell.onChange(() => {
    const mode = shell.data().mode
    if (mode !== lastMode) {
      lastMode = mode
      handle.update({ mode })
    }
    syncProfile()
    for (const s of slots) {
      if (s === owner) continue
      setNote(s, stage || !webglBroken ? t('placeholder.elsewhere') : t('placeholder.webgl'))
    }
  })
  // loadData 回来之前注册用的是缺省 'idle';读到用户存的模式后补一次
  void shell.ready.then(() => {
    if (disposed) return
    const mode = shell.data().mode
    if (mode !== lastMode) {
      lastMode = mode
      handle.update({ mode })
    }
  })

  return {
    dispose() {
      if (disposed) return
      disposed = true
      ro?.disconnect()
      offShell()
      releaseOff?.()
      releaseOff = null
      // 不走 release():那条会把画布交给下一个挂载点、最后还排一个释放定时器 —— 插件都要卸了,直接收
      for (const s of slots.splice(0)) {
        s.off?.()
        s.toolbar?.dispose()
        s.wrap.remove()
      }
      owner = null
      stage?.dispose()
      stage = null
      try {
        handle.dispose()
      } catch {
        /* 宿主已吊销 */
      }
    },
  }
}
