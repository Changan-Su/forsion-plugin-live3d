// 展开侧板右上角的小工具条:换形象 + 打开模型库。卡片态不挂(卡片 pointer-events:none,点不到)。
// ⚠️根元素 -webkit-app-region:no-drag(见 live3d.css):侧板顶部落在窗口拖拽区里,不声明的话 mac 上点不动。
import { esc } from './dom'
import { t } from '../i18n'
import type { Shell } from './state'

export interface Toolbar {
  el: HTMLElement
  dispose(): void
}

export function createToolbar(shell: Shell, openStudio: () => void): Toolbar {
  const el = document.createElement('div')
  el.className = 'l3-toolbar'
  let key = ''

  const render = (): void => {
    const st = shell.lib.state()
    const active = shell.data().active ?? ''
    const opts = [{ v: '', label: t('orb.name') }, ...st.entries.map((e) => ({ v: e.slug, label: e.profile.name }))]
    // 悬空的当前形象(文件夹被删 / 还没扫到)也要显示出来,别静默跳回小球那一项
    if (active && !st.entries.some((e) => e.slug === active)) opts.push({ v: active, label: `⚠ ${active}` })
    const next = JSON.stringify([opts, active, t('toolbar.model'), t('btn.library')])
    if (next === key) return
    key = next
    el.innerHTML = `<select class="l3-tb-select" aria-label="${esc(t('toolbar.model'))}" title="${esc(t('toolbar.model'))}">${opts
      .map((o) => `<option value="${esc(o.v)}"${o.v === active ? ' selected' : ''}>${esc(o.label)}</option>`)
      .join('')}</select><button type="button" class="l3-tb-btn">${esc(t('btn.library'))}</button>`
  }

  const onChange = (e: Event): void => {
    const sel = e.target as HTMLSelectElement
    if (sel.classList.contains('l3-tb-select')) shell.setActive(sel.value || null)
  }
  const onClick = (e: Event): void => {
    if ((e.target as HTMLElement).closest('.l3-tb-btn')) openStudio()
  }
  // 侧板的画布可拖拽旋转:工具条上的按下不许冒泡成「开始拖拽」
  const stop = (e: Event): void => e.stopPropagation()
  el.addEventListener('change', onChange)
  el.addEventListener('click', onClick)
  el.addEventListener('pointerdown', stop)
  const off = shell.onChange(render)
  render()
  return {
    el,
    dispose() {
      off()
      el.removeEventListener('change', onChange)
      el.removeEventListener('click', onClick)
      el.removeEventListener('pointerdown', stop)
      el.remove()
    },
  }
}
