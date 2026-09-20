// 插件详情页里的自绘设置面(ctx.registerSettingsView):显示模式、当前 Desk 形象、导入入口、工作文件夹的
// **绝对路径**(技能与用户都要靠它找到目录)、问题清单。宿主可能反复挂载卸载这一面 —— 状态全在 shell 里。
import { joinRel } from '../contract'
import { t } from '../i18n'
import { button, esc, handleCommon, libraryHint, modeRadios, noticeBar, problemList } from './dom'
import type { Importer } from './importer'
import type { Shell } from './state'

export function mountSettings(el: HTMLElement, shell: Shell, importer: Importer, openStudio: () => void): () => void {
  const ctx = shell.ctx
  el.classList.add('l3-view', 'l3-settings')
  let disposed = false

  const folderPath = (): { text: string; abs: boolean } => {
    const rel = joinRel(shell.workFolder(), 'models')
    let root: string | null = null
    try {
      root = ctx.app.vaultRoot?.() ?? null
    } catch {
      root = null
    }
    return root ? { text: `${root.replace(/[\\/]+$/, '')}/${rel}`, abs: true } : { text: rel, abs: false }
  }

  function render(): void {
    if (disposed) return
    const st = shell.lib.state()
    const active = shell.data().active ?? ''
    const opts = [{ v: '', label: t('orb.name') }, ...st.entries.map((e) => ({ v: e.slug, label: e.profile.name }))]
    // 当前形象指向的文件夹不在了 → 也要显示出来(静默跳回小球正是 inspect 08-29 坑住用户的那一下)
    if (active && !st.entries.some((e) => e.slug === active)) opts.push({ v: active, label: `⚠ ${active}` })
    const folder = folderPath()
    el.innerHTML = `
      ${ctx.desk ? '' : `<div class="l3-notice is-warning"><span class="l3-notice-text">${esc(t('settings.noDesk'))}</span></div>`}
      ${noticeBar(shell)}
      <div class="l3-section">
        <div class="l3-section-title">${esc(t('mode.label'))}</div>
        ${modeRadios(shell, 'l3-mode-settings')}
      </div>
      <div class="l3-section">
        <div class="l3-section-title">${esc(t('settings.active'))}</div>
        <select class="l3-select" data-act="active" aria-label="${esc(t('settings.active'))}">${opts
          .map((o) => `<option value="${esc(o.v)}"${o.v === active ? ' selected' : ''}>${esc(o.label)}</option>`)
          .join('')}</select>
        <div class="l3-hint">${esc(t('settings.activeHint'))}</div>
      </div>
      <div class="l3-section l3-row">
        ${button('import', t('btn.import'), ' data-primary')}
        ${button('import-folder', t('btn.importFolder'))}
        ${button('agent-import', t('btn.agentImport'))}
        ${ctx.registerView ? button('open-library', t('btn.openLibrary')) : ''}
        ${button('refresh', t('btn.refresh'))}
      </div>
      <div class="l3-section l3-folder">
        <div class="l3-folder-text">
          <b>${esc(t('settings.folder'))}</b>
          <code>${esc(folder.text)}</code>${folder.abs ? '' : `<small>${esc(t('settings.folderRel'))}</small>`}
          <small>${esc(t('settings.folderHint'))}</small>
        </div>
        ${ctx.app.reveal ? button('open-folder', t('btn.openFolder')) : ''}
      </div>
      ${libraryHint(shell)}
      ${problemList(st.problems)}`
  }

  const onClick = (ev: Event): void => {
    const target = ev.target as HTMLElement
    if (handleCommon(shell, target)) return
    switch (target.closest<HTMLElement>('[data-act]')?.dataset.act) {
      case 'import':
        importer.pickDirect(false)
        break
      case 'import-folder':
        importer.pickDirect(true)
        break
      case 'agent-import':
        importer.pickAgent(false)
        break
      case 'open-library':
        openStudio()
        break
      case 'open-folder':
        void shell.openFolder()
        break
      case 'refresh':
        void shell.refresh(true)
        break
    }
  }
  const onChange = (ev: Event): void => {
    const input = ev.target as HTMLInputElement | HTMLSelectElement
    if (input.dataset.act === 'mode' && (input.value === 'idle' || input.value === 'always')) shell.setMode(input.value)
    else if (input.dataset.act === 'active') shell.setActive(input.value || null)
  }
  el.addEventListener('click', onClick)
  el.addEventListener('change', onChange)
  const off = shell.onChange(render)
  render()
  void shell.refresh(true)
  return () => {
    disposed = true
    off()
    el.removeEventListener('click', onClick)
    el.removeEventListener('change', onChange)
    el.classList.remove('l3-view', 'l3-settings')
    el.innerHTML = ''
  }
}
