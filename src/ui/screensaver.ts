// 全屏屏保:Forsion 窗口在前台、一段时间没有键盘鼠标操作 → 盖一层铺满窗口的小屋(借 roomHost 的画布),
// 镜头缓慢环绕,角落一只大钟。按任意键 / 点一下 / 明显移动鼠标 → 退出。
//
// 全屏:HTML Fullscreen API 要「用户激活」—— 命令面板 / 按钮点出来的(手动启动)能进系统全屏;空闲计时触发的
// 没有手势,requestFullscreen 会被拒,那就只铺满窗口(失败静默吞掉,不报错)。宿主主窗口 fullscreenable 缺省为真。
// 覆盖层必须 -webkit-app-region:no-drag:mac 上窗口顶部是拖拽区,不声明的话那一条点不动、退不出去。
// 只统计本窗口里的输入:用户在别的 app 里干活时 Forsion 不在前台,document.hasFocus() 为假,屏保不启动。
import { currentLocale, t } from '../i18n'
import { doingText } from './room'
import type { Borrow, RoomHost } from './roomHost'
import type { Shell } from './state'

export interface Screensaver {
  /** manual = 用户手势里调的(能进系统全屏)。 */
  start(manual: boolean): void
  stop(): void
  active(): boolean
  dispose(): void
}

const CHECK_MS = 5000
/** 刚启动这么久内的鼠标移动不算「要退出」(启动那一下常伴着手的余动)。 */
const GRACE_MS = 800
/** 鼠标累计移动超过这么多像素才退出(桌子轻轻一碰不该把屏保踢掉)。 */
const MOVE_PX = 36

export function createScreensaver(shell: Shell, host: RoomHost): Screensaver {
  let lastInput = Date.now()
  let overlay: HTMLElement | null = null
  let borrow: Borrow | null = null
  let startedAt = 0
  let moved = 0
  let lastMove: { x: number; y: number } | null = null
  let weFullscreened = false
  let offClock: (() => void) | null = null
  let disposed = false
  /** 每次启动一个代号:全屏请求是异步的,回来时屏保可能已经退了(甚至又开了下一次)。 */
  let run = 0
  /** 启动前的焦点(聊天框里停下来 → 叫醒后接着打字)。 */
  let prevFocus: Element | null = null

  const bump = (): void => {
    lastInput = Date.now()
  }
  const INPUT = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const
  for (const ev of INPUT) window.addEventListener(ev, bump, { capture: true, passive: true })

  const offCheck = shell.every(CHECK_MS, () => {
    const s = shell.data().saver
    if (!s.enabled || overlay || disposed) return
    // 窗口不在前台(用户在别的 app 里)不算空闲;已经有东西全屏(看视频)也别抢
    if (typeof document === 'undefined' || document.hidden || document.fullscreenElement) return
    if (typeof document.hasFocus === 'function' && !document.hasFocus()) return
    if (Date.now() - lastInput >= s.minutes * 60_000) api.start(false)
  })

  function renderClock(): void {
    if (!overlay) return
    const now = new Date()
    const loc = currentLocale() === 'en' ? 'en-US' : 'zh-CN'
    const time = now.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit', hour12: false })
    const date = now.toLocaleDateString(loc, { month: 'long', day: 'numeric', weekday: 'long' })
    const c = overlay.querySelector<HTMLElement>('.l3-saver-clock')
    if (c) c.innerHTML = `<b>${time}</b><span>${date}</span>`
    const d = overlay.querySelector<HTMLElement>('.l3-saver-doing')
    if (d) d.textContent = doingText(host)
  }

  // 退出:覆盖层上的任何按键 / 点击 / 滚轮 / 明显移动。按键在捕获阶段吃掉 —— 叫醒屏保的那个键不该打进聊天框。
  const onKey = (e: KeyboardEvent): void => {
    e.preventDefault()
    e.stopImmediatePropagation() // 同在 window 捕获阶段、比我们后注册的监听也别收到(先注册的宿主监听拦不住,那得宿主出接缝)
    // 叫醒它的那个键:按住时的自动重复与松开都吞掉(焦点已经还给输入框了,重复的按键会打进去;有的快捷键在
    // keyup 上生效),直到松开或一秒超时
    const code = e.code
    const swallow = (k: KeyboardEvent): void => {
      if (k.code !== code) return
      k.preventDefault()
      k.stopImmediatePropagation()
      if (k.type === 'keyup') done()
    }
    const done = (): void => {
      window.removeEventListener('keydown', swallow, { capture: true })
      window.removeEventListener('keyup', swallow, { capture: true })
    }
    window.addEventListener('keydown', swallow, { capture: true })
    window.addEventListener('keyup', swallow, { capture: true })
    setTimeout(done, 1000)
    api.stop()
  }
  const onPointerDown = (e: Event): void => {
    e.preventDefault()
    e.stopPropagation()
    api.stop()
  }
  const onMove = (e: PointerEvent): void => {
    if (Date.now() - startedAt < GRACE_MS) {
      lastMove = { x: e.clientX, y: e.clientY }
      return
    }
    if (lastMove) moved += Math.abs(e.clientX - lastMove.x) + Math.abs(e.clientY - lastMove.y)
    lastMove = { x: e.clientX, y: e.clientY }
    if (moved > MOVE_PX) api.stop()
  }
  const onFsChange = (): void => {
    // 用户在系统全屏里按了 Esc / 绿灯退出全屏 → 屏保也一起退
    if (weFullscreened && !document.fullscreenElement) api.stop()
  }
  const onHidden = (): void => {
    if (document.hidden) api.stop()
  }

  const api: Screensaver = {
    start(manual) {
      if (overlay || disposed) return
      const el = document.createElement('div')
      el.className = 'l3-saver'
      el.tabIndex = -1
      el.setAttribute('role', 'dialog')
      el.setAttribute('aria-label', t('saver.title'))
      el.innerHTML = `
        <div class="l3-saver-stage"></div>
        <div class="l3-saver-clock"></div>
        <div class="l3-saver-doing"></div>
        <div class="l3-saver-hint">${t('saver.exitHint')}</div>`
      prevFocus = document.activeElement
      document.body.appendChild(el)
      overlay = el
      const my = ++run
      startedAt = Date.now()
      moved = 0
      lastMove = null
      borrow = host.borrow(el.querySelector<HTMLElement>('.l3-saver-stage')!, { mode: 'screensaver', priority: 10 })
      renderClock()
      offClock = shell.every(1000, renderClock)
      window.addEventListener('keydown', onKey, { capture: true })
      el.addEventListener('pointerdown', onPointerDown)
      el.addEventListener('wheel', onPointerDown, { passive: false })
      el.addEventListener('touchstart', onPointerDown, { passive: false })
      el.addEventListener('pointermove', onMove)
      document.addEventListener('fullscreenchange', onFsChange)
      document.addEventListener('visibilitychange', onHidden)
      el.focus?.({ preventScroll: true })
      requestAnimationFrame(() => el.classList.add('is-on'))
      // 全屏:手动启动在用户手势里,能成;空闲触发多半被拒 —— 都试,拒了就铺满窗口
      weFullscreened = false
      try {
        const p = el.requestFullscreen?.({ navigationUI: 'hide' })
        void p?.then(() => {
          // 请求回来时这一次屏保已经退了:进了全屏也立刻退出来,别把窗口留在系统全屏里
          if (my !== run || overlay !== el) {
            if (document.fullscreenElement === el) void document.exitFullscreen?.().catch(() => {})
            return
          }
          weFullscreened = document.fullscreenElement === el
        }).catch(() => {})
      } catch {
        /* 老 Chromium / 被策略拦下:铺满窗口就好 */
      }
      if (!manual) shell.ctx.activity?.log?.('screensaver-start', { trigger: 'idle' })
    },
    stop() {
      const el = overlay
      if (!el) return
      overlay = null
      run++
      offClock?.()
      offClock = null
      window.removeEventListener('keydown', onKey, { capture: true })
      document.removeEventListener('fullscreenchange', onFsChange)
      document.removeEventListener('visibilitychange', onHidden)
      if (document.fullscreenElement === el) void document.exitFullscreen?.().catch(() => {})
      weFullscreened = false
      borrow?.release()
      borrow = null
      el.classList.remove('is-on')
      setTimeout(() => el.remove(), 260)
      // 焦点还给启动前的元素(还在文档里的话)
      const f = prevFocus as (Element & { focus?: (o?: FocusOptions) => void; isConnected?: boolean }) | null
      prevFocus = null
      if (f && f.isConnected !== false && typeof f.focus === 'function') {
        try {
          f.focus({ preventScroll: true })
        } catch {
          /* ignore */
        }
      }
      lastInput = Date.now()
    },
    active: () => !!overlay,
    dispose() {
      if (disposed) return
      api.stop()
      disposed = true
      offCheck()
      for (const ev of INPUT) window.removeEventListener(ev, bump, { capture: true })
    },
  }
  return api
}
