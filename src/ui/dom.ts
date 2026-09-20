// 视图共用的小零件:转义、按钮、模式单选、提示条、问题列表。全部返回 HTML 字符串,由各视图按事件委托接线
// (`data-act="…"`)—— 重画只换这几段 innerHTML,画布所在的容器从不重建。
import { PHASES, type Phase } from '../contract'
import { pick, t, type MsgKey } from '../i18n'
import type { LibProblem } from '../library'
import type { Shell } from './state'

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export const button = (act: string, label: string, extra = ''): string =>
  `<button type="button" class="l3-btn" data-act="${esc(act)}"${extra}>${esc(label)}</button>`

export const phaseLabel = (p: Phase): string => t(`phase.${p}` as MsgKey)
export { PHASES }

/** 显示模式两选一(设置页用单选,模型库用分段按钮 —— 同一份文案与说明)。 */
export function modeRadios(shell: Shell, name: string): string {
  const mode = shell.data().mode
  const opt = (m: 'idle' | 'always'): string => `
    <label class="l3-radio${mode === m ? ' is-on' : ''}">
      <input type="radio" name="${esc(name)}" value="${m}" data-act="mode"${mode === m ? ' checked' : ''}>
      <span class="l3-radio-body"><b>${esc(t(m === 'idle' ? 'mode.idle' : 'mode.always'))}</b>
      <small>${esc(t(m === 'idle' ? 'mode.idleHint' : 'mode.alwaysHint'))}</small></span>
    </label>`
  return `<div class="l3-modes" role="radiogroup" aria-label="${esc(t('mode.label'))}">${opt('idle')}${opt('always')}</div>`
}

/** 顶部提示条 + 忙碌态。 */
export function noticeBar(shell: Shell): string {
  const busy = shell.busy()
  const n = shell.notice()
  let out = ''
  if (busy) out += `<div class="l3-notice is-busy"><span class="l3-spinner" aria-hidden="true"></span><span>${esc(busy.text())}</span></div>`
  if (n) {
    out += `<div class="l3-notice is-${n.level}"><span class="l3-notice-text">${esc(n.text())}</span>${
      n.action ? button('notice-action', n.action.label(), ' data-primary') : ''
    }${button('notice-dismiss', t('btn.dismiss'))}</div>`
  }
  return out
}

export function problemList(problems: LibProblem[]): string {
  if (!problems.length) return ''
  return `<div class="l3-problems"><div class="l3-problems-title">${esc(t('lib.problems'))}</div>${problems
    .map((p) => `<div class="l3-problem is-${p.kind}"><code>${esc(p.path)}</code><span>${esc(pick(p.reason))}</span></div>`)
    .join('')}</div>`
}

/** 库状态的一行说明(没打开库 / 宿主不能列文件 / 空库)。 */
export function libraryHint(shell: Shell): string {
  const st = shell.lib.state()
  if (st.noList) return `<div class="l3-hint">${esc(t('lib.noList'))}</div>`
  if (st.noVault) return `<div class="l3-hint">${esc(t('lib.noVault'))}</div>`
  if (!st.entries.length && !st.problems.length && st.root !== undefined) return `<div class="l3-hint">${esc(t('lib.empty'))}</div>`
  return ''
}

/** 统一处理 notice 两颗按钮 + 模式单选;返回 true = 已处理。 */
export function handleCommon(shell: Shell, target: HTMLElement): boolean {
  const act = target.closest<HTMLElement>('[data-act]')?.dataset.act
  if (act === 'notice-dismiss') {
    shell.setNotice(null)
    return true
  }
  if (act === 'notice-action') {
    const a = shell.notice()?.action
    shell.setNotice(null)
    a?.run()
    return true
  }
  return false
}
