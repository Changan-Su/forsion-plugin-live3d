// 3D 小屋视图(ctx.registerView 'room',Live3D 的 Space 主区就是它):画布铺满,左上角是场景名与「他正在干什么」,
// 右上角是场景 / 昼夜 / 屏保 / 场景文件夹。画布借自 roomHost(与屏保共用一块),被屏保借走时这里显示一句占位。
// 重画只换 HUD 几段 innerHTML,画布容器从不重建。
import { joinRel } from '../contract'
import { currentLocale, t, type MsgKey } from '../i18n'
import { pickLabel, SCENE_FILE, type TimeMode } from '../room/scene'
import { SCENES_README, sceneTemplate, scenesFolder } from '../room/sceneLibrary'
import { button, esc, handleCommon, noticeBar } from './dom'
import type { RoomHost } from './roomHost'
import type { Screensaver } from './screensaver'
import type { Shell } from './state'

const HINT_MS = 7000

/** 此刻在做的事,给人看的一句话:场景里写了 label 用它,没写按姿势给一句通用的。 */
export function doingText(host: RoomHost): string {
  const d = host.stage()?.doing()
  if (!d) return ''
  const label = pickLabel(d.label, currentLocale()) ?? t(`pose.${d.pose === 'walk' ? 'stand' : d.pose}` as MsgKey)
  return d.pose === 'walk' ? t('room.walking', { what: label }) : label
}

export function mountRoom(el: HTMLElement, shell: Shell, host: RoomHost, saver: Screensaver, openStudio: () => void): () => void {
  const ctx = shell.ctx
  el.classList.add('l3-view', 'l3-room-view')
  el.innerHTML = `
    <div class="l3-room">
      <div class="l3-room-stage" data-part="stage"></div>
      <div class="l3-room-ph" data-part="ph" hidden></div>
      <div class="l3-room-top">
        <div class="l3-room-title"><b data-part="name"></b><span data-part="doing"></span></div>
        <div class="l3-room-tools" data-part="tools"></div>
      </div>
      <div class="l3-room-notes" data-part="notes"></div>
      <div class="l3-room-hint" data-part="hint"></div>
    </div>`
  const part = (n: string): HTMLElement => el.querySelector<HTMLElement>(`[data-part="${n}"]`)!
  const root = el.querySelector<HTMLElement>('.l3-room')!
  let disposed = false
  let toolsKey = ''

  const borrow = host.borrow(part('stage'), {
    mode: 'view',
    priority: 1,
    onOwner: (owns) => {
      if (disposed) return
      const ph = part('ph')
      ph.hidden = owns
      ph.textContent = owns ? '' : t('room.elsewhere')
    },
  })
  if (!borrow.owns()) {
    part('ph').hidden = false
    part('ph').textContent = t('room.elsewhere')
  }

  function renderTools(): void {
    const st = shell.scenes.state()
    const cur = host.scene()
    const time: TimeMode | 'scene' = shell.data().time ?? 'scene'
    const opts = [
      ...st.entries.map((e) => ({ v: e.slug, label: pickLabel(e.scene.name, currentLocale()) ?? e.slug })),
      ...(st.entries.length ? [] : [{ v: '', label: t('room.builtin') }]),
    ]
    const key = JSON.stringify([opts, cur.entry?.slug ?? '', time, currentLocale()])
    if (key === toolsKey) return
    toolsKey = key
    const seg = (v: TimeMode | 'scene', label: string): string =>
      `<button type="button" class="l3-seg-btn${time === v ? ' is-on' : ''}" data-act="time" data-v="${v}">${esc(label)}</button>`
    part('tools').innerHTML = `
      <select class="l3-room-select" data-act="scene" aria-label="${esc(t('room.scene'))}" title="${esc(t('room.scene'))}">${opts
        .map((o) => `<option value="${esc(o.v)}"${o.v === (cur.entry?.slug ?? '') ? ' selected' : ''}>${esc(o.label)}</option>`)
        .join('')}</select>
      <div class="l3-seg" role="group" aria-label="${esc(t('room.time'))}">${seg('scene', t('room.time.auto'))}${seg('day', t('room.time.day'))}${seg('night', t('room.time.night'))}</div>
      ${button('saver', t('room.saver'), ' data-primary')}
      ${ctx.app.writeFile ? button('new-scene', t('room.newScene')) : ''}
      ${ctx.app.reveal ? button('open-scenes', t('room.openScenes')) : ''}
      ${button('library', t('btn.library'))}`
  }

  function renderTitle(): void {
    const cur = host.scene()
    part('name').textContent = pickLabel(cur.scene.name, currentLocale()) ?? ''
    const err = host.error()
    const doing = host.loading() ? t('room.loading') : err ? '' : doingText(host)
    const d = part('doing')
    if (d.textContent !== doing) d.textContent = doing
  }

  function renderNotes(): void {
    const err = host.error()
    const probs = shell.scenes.state().problems
    part('notes').innerHTML = noticeBar(shell) +
      (err ? `<div class="l3-notice is-error"><span class="l3-notice-text">${esc(err())}</span></div>` : '') +
      (probs.length
        ? `<div class="l3-notice is-warning"><span class="l3-notice-text">${esc(t('room.problems'))} ${probs
            .map((p) => `<code>${esc(p.slug)}</code> ${esc(currentLocale() === 'en' ? p.reason.en : p.reason.zh)}`)
            .join(' · ')}</span></div>`
        : '')
  }

  function render(): void {
    if (disposed) return
    renderTools()
    renderTitle()
    renderNotes()
    // 切语言:提示条与占位也要跟着换(它们不在上面几段里)
    hint.textContent = t('room.hint')
    if (!part('ph').hidden) part('ph').textContent = t('room.elsewhere')
  }

  const hint = part('hint')
  const hideHint = setTimeout(() => hint.classList.add('is-gone'), HINT_MS)
  // 「他在干什么」半秒刷一次(舞台是拉取式的,不为这行字加订阅)
  const offTick = shell.every(500, renderTitle)

  async function newScene(): Promise<void> {
    // 没法先确认文件在不在就不写(老宿主有写无读):宁可不新建,也不冒覆盖用户文件的险
    if (!ctx.app.writeFile || !ctx.app.readFile) return
    // 写坏了的场景也占着名字(problems 里),绝不能被模板覆盖 —— 写前再读一次确认文件真的不存在
    const st = shell.scenes.state()
    const taken = new Set([...st.entries.map((e) => e.slug), ...st.problems.map((p) => p.slug)])
    let slug = 'my-room'
    let path = ''
    for (let i = 2; ; i++) {
      path = joinRel(scenesFolder(ctx), `${slug}/${SCENE_FILE}`)
      let exists = taken.has(slug)
      if (!exists) {
        try {
          exists = (await ctx.app.readFile?.(path)) != null
        } catch {
          exists = true // 读不出来就当它在,换个名字
        }
      }
      if (!exists) break
      if (i > 99) return
      slug = `my-room-${i}`
    }
    try {
      await ctx.app.writeFile(path, sceneTemplate(t('room.newSceneName')))
    } catch (e) {
      shell.say('error', () => t('room.writeFailed', { why: e instanceof Error ? e.message : String(e) }))
      return
    }
    await shell.refresh(true)
    shell.setRoom({ scene: slug })
    shell.say('success', () => t('room.created', { path }))
    ctx.app.openFile?.(path)
  }

  const onClick = (ev: Event): void => {
    const target = ev.target as HTMLElement
    if (handleCommon(shell, target)) return
    const btn = target.closest<HTMLElement>('[data-act]')
    switch (btn?.dataset.act) {
      case 'time': {
        const v = btn.dataset.v
        shell.setRoom({ time: v === 'day' || v === 'night' ? v : null })
        break
      }
      case 'saver':
        saver.start(true) // 在点击手势里同步调用:全屏请求要用户激活
        break
      case 'new-scene':
        void newScene()
        break
      case 'open-scenes':
        void shell.openFolder(scenesFolder(ctx), SCENES_README)
        break
      case 'library':
        openStudio()
        break
    }
  }
  const onChange = (ev: Event): void => {
    const s = ev.target as HTMLSelectElement
    if (s.dataset.act === 'scene') shell.setRoom({ scene: s.value || null })
  }
  // 画布上的拖拽 / 滚轮归舞台;HUD 上的按下别冒泡成拖拽
  const stop = (e: Event): void => e.stopPropagation()
  root.addEventListener('click', onClick)
  root.addEventListener('change', onChange)
  for (const p of ['tools', 'notes']) part(p).addEventListener('pointerdown', stop)
  const offShell = shell.onChange(render)
  const offHost = host.onChange(render)
  render()
  void shell.refresh(true) // 打开即重扫(可能刚在访达里新建 / 改好了场景)

  return () => {
    disposed = true
    clearTimeout(hideHint)
    offTick()
    offShell()
    offHost()
    root.removeEventListener('click', onClick)
    root.removeEventListener('change', onChange)
    borrow.release()
    el.classList.remove('l3-view', 'l3-room-view')
    el.innerHTML = ''
  }
}
