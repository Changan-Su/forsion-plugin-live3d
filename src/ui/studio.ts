// 模型库视图(ctx.registerView 'studio'):左边模型列表(默认小球 + 已导入 + 问题),右边一块可拖拽旋转的预览舞台、
// 7 个阶段的「试一下」、导入按钮、显示模式;整块视图接受拖放导入。
// 预览舞台是**自己的**一个 stage(不借 Desk 那个:Desk 可能正同时显示在旁边)。「实时」档跟着主区会话的真实状态走。
import type { Phase, ProfilePose } from '../contract'
import { DEFAULT_POSE, duplicateClaims } from '../contract'
import { withAgents } from '../profile'
import { createStage, type Stage } from '../stage'
import { pick, t } from '../i18n'
import type { LibEntry } from '../library'
import { PHASES, button, esc, handleCommon, libraryHint, modeRadios, noticeBar, phaseLabel, problemList } from './dom'
import { idleStatus, type AgentStatus } from './host'
import type { Importer } from './importer'
import type { Shell } from './state'

export function mountStudio(el: HTMLElement, shell: Shell, importer: Importer): () => void {
  const ctx = shell.ctx
  el.classList.add('l3-view')
  el.innerHTML = `
    <div class="l3-studio">
      <aside class="l3-side">
        <div class="l3-side-head" data-part="head"></div>
        <div class="l3-list" data-part="list"></div>
        <div data-part="problems"></div>
        <div class="l3-side-actions" data-part="actions"></div>
      </aside>
      <section class="l3-main">
        <div data-part="notice"></div>
        <div class="l3-stage-box"><div class="l3-stage" data-part="stage"></div><div class="l3-stage-msg" data-part="msg"></div></div>
        <div class="l3-phases" data-part="phases"></div>
        <div class="l3-detail" data-part="detail"></div>
        <div class="l3-mode-block" data-part="mode"></div>
      </section>
      <div class="l3-drop" data-part="drop" hidden></div>
    </div>`
  const part = (name: string): HTMLElement => el.querySelector<HTMLElement>(`[data-part="${name}"]`)!
  const root = el.querySelector<HTMLElement>('.l3-studio')!

  let sel = shell.data().active ?? ''
  let lastActive = sel
  let phase: Phase | null = null
  let loadedKey: string | null = null
  let msg: (() => string) | null = null
  let info: (() => string) | null = null
  let stage: Stage | null = null
  let disposed = false
  /** 拖滑块期间的姿势草稿:先在预览里看效果,松手(change)才写盘。选别的模型 / 写完即清空。 */
  let poseDraft: ProfilePose | null = null

  try {
    stage = createStage({ surface: 'studio', interactive: true, assetUrl: shell.assetUrl })
    stage.attach(part('stage'))
  } catch (e) {
    console.error('[live3d] WebGL unavailable', e)
    stage = null
    msg = () => t('studio.webglOff')
  }

  // 「实时」档:跟主区会话的 agent 状态(旧宿主没有探针 → 恒 idle)
  const liveStatus = (): AgentStatus => {
    try {
      return ctx.tangu?.agentStatus?.() ?? idleStatus(null)
    } catch {
      return idleStatus(null)
    }
  }
  let offStatus: (() => void) | undefined
  if (stage) {
    const st = stage
    try {
      offStatus = ctx.tangu?.subscribeAgentStatus?.((s) => st.setStatus(s))
    } catch {
      offStatus = undefined
    }
    st.setStatus(liveStatus())
    st.setStatusSource(liveStatus)
  }

  const selected = (): LibEntry | null => (sel ? shell.lib.find(sel) : null)

  function load(): void {
    if (!stage) return
    const e = selected()
    const base = e && !e.modelMissing ? e.profile : null
    // 草稿只改 pose —— setProfile 认出「同一模型、摆放没变」就只换姿势,不重载模型(PMX 重载要好几秒)。
    const p = base && poseDraft ? { ...base, pose: poseDraft } : base
    const key = p ? `${p.dir}\n${JSON.stringify(p)}` : `orb:${sel}`
    if (key === loadedKey) return
    loadedKey = key
    info = null
    if (e?.modelMissing) {
      msg = () => t('lib.missingModel', { file: e.profile.model })
      void stage.setProfile(null)
      renderMsg()
      return
    }
    msg = p ? () => t('studio.loading') : null
    renderMsg()
    const st = stage
    void st.setProfile(p).then((r) => {
      if (disposed || st !== stage || loadedKey !== key) return
      if (!r.ok) {
        if (r.code === 'superseded' || r.code === 'disposed') return
        msg = () => t('studio.loadFailed', { why: pick(r) })
      } else {
        msg = null
        const a = r.analysis
        info = a ? () => t('studio.info', { format: a.format.toUpperCase(), clips: a.clips.length, expr: a.vrm ? a.vrm.expressions.length : a.morphs.length }) : null
      }
      renderMsg()
      renderDetail()
    })
  }

  const renderMsg = (): void => {
    const box = part('msg')
    box.textContent = msg ? msg() : ''
    box.hidden = !msg
  }

  function renderHead(): void {
    part('head').innerHTML = `<b>${esc(t('studio.title'))}</b>${button('refresh', t('btn.refresh'), ' data-quiet')}`
  }

  function renderList(): void {
    const st = shell.lib.state()
    const active = shell.data().active ?? ''
    const item = (slug: string, name: string, sub: string, thumb: string, flags: string[]): string => `
      <button type="button" class="l3-item${slug === sel ? ' is-sel' : ''}" data-act="select" data-slug="${esc(slug)}">
        <span class="l3-thumb">${thumb}</span>
        <span class="l3-item-text"><b>${esc(name)}</b><small>${esc(sub)}</small></span>
        ${flags.map((f) => `<span class="l3-badge">${esc(f)}</span>`).join('')}
      </button>`
    const rows = [item('', t('orb.name'), t('orb.hint'), '<span class="l3-orb-dot"></span>', active === '' ? [t('lib.badge.active')] : [])]
    for (const e of st.entries) {
      const thumb = e.hasPreview ? `<img alt="" src="${esc(shell.assetUrl(`${e.dir}/preview.png`))}">` : '<span class="l3-orb-dot is-model"></span>'
      const flags = [
        ...(e.slug === active ? [t('lib.badge.active')] : []),
        ...(e.profile.agents.length ? [t('lib.badge.bound')] : []),
        ...(e.modelMissing ? [t('lib.badge.problem')] : []),
      ]
      rows.push(item(e.slug, e.profile.name, e.profile.model, thumb, flags))
    }
    part('list').innerHTML = rows.join('') + libraryHint(shell)
    part('problems').innerHTML = problemList(st.problems)
  }

  function renderActions(): void {
    part('actions').innerHTML = [
      button('import', t('btn.import'), ' data-primary'),
      button('import-folder', t('btn.importFolder')),
      button('agent-import', t('btn.agentImport')),
      ...(ctx.app.reveal ? [button('open-folder', t('btn.openFolder'))] : []), // 宿主打不开文件夹就别放一颗点了没反应的按钮
    ].join('') + `<div class="l3-hint">${esc(t('studio.dropHint'))}</div>`
  }

  function renderPhases(): void {
    const b = (p: Phase | null, label: string): string =>
      `<button type="button" class="l3-chip${phase === p ? ' is-on' : ''}" data-act="phase" data-phase="${p ?? ''}">${esc(label)}</button>`
    part('phases').innerHTML = `<span class="l3-phases-label">${esc(t('studio.try'))}</span>${b(null, t('phase.live'))}${PHASES.map((p) => b(p, phaseLabel(p))).join('')}`
  }

  function renderDetail(): void {
    // 正在拖姿势滑块:这一面重画会把滑块从 DOM 里摘走,拖拽当场中断、change 也丢了(滑块变成一次性的)。
    // 触发点不止一处:load() 完成后要刷体检摘要,库刷新也会整面重画。
    if (poseDraft) return
    const e = selected()
    const active = shell.data().active ?? ''
    const inUse = (e ? e.slug : '') === active
    const use = inUse
      ? `<button type="button" class="l3-btn" disabled>${esc(t('btn.inUse'))}</button>`
      : button('use', t('btn.useInDesk'), ' data-primary')
    if (!e) {
      part('detail').innerHTML = `<div class="l3-detail-head"><b>${esc(t('orb.name'))}</b></div><div class="l3-hint">${esc(t('orb.hint'))}</div><div class="l3-row">${use}</div>`
      return
    }
    const warns = e.warnings.length
      ? `<div class="l3-warns"><b>${esc(t('studio.notes'))}</b>${e.warnings.map((w) => `<div>${esc(pick(w))}</div>`).join('')}</div>`
      : ''
    part('detail').innerHTML = `
      <div class="l3-detail-head"><b>${esc(e.profile.name)}</b><code>${esc(e.profilePath)}</code></div>
      ${info ? `<div class="l3-info">${esc(info())}</div>` : ''}
      ${warns}
      <div class="l3-row">${use}${ctx.app.reveal ? button('reveal', t('btn.reveal')) : ''}</div>
      ${bindSection(e)}
      ${poseSection(e)}
      <div class="l3-hint">${esc(t('studio.editHint'))}</div>`
  }

  /** 「绑给哪些 Agent」。宿主给不出名册(旧宿主 / 非 Tangu 壳)→ 只给一句「自己写 live3d.json」,不画空清单。 */
  function bindSection(e: LibEntry): string {
    const roster = shell.agents()
    const body = roster.length
      ? `<div class="l3-agents">${roster
          .map(
            (a) => `<label class="l3-check"><input type="checkbox" data-act="bind" data-slug="${esc(a.slug)}"${
              e.profile.agents.includes(a.slug) ? ' checked' : ''
            }><span>${esc(a.name)}</span><code>${esc(a.slug)}</code></label>`,
          )
          .join('')}</div>`
      : `<div class="l3-hint">${esc(t('bind.noHost'))}</div>`
    // 同一个 Agent 被两个形象认领:按形象 slug 字典序取第一个 —— 在造成冲突的这一页当场说清楚,别等用户自己猜。
    const dup = duplicateClaims(shell.lib.state().entries.map((x) => ({ slug: x.slug, agents: x.profile.agents })))
    const clashes: string[] = []
    for (const [agent, losers] of dup) {
      if (!e.profile.agents.includes(agent)) continue
      const winner = shell.lib.state().entries.filter((x) => x.profile.agents.includes(agent)).map((x) => x.slug).sort()[0]
      const other = losers.includes(e.slug) ? winner : losers.join(', ')
      clashes.push(t('bind.taken', { agent, other, winner }))
    }
    return `
      <div class="l3-section">
        <div class="l3-section-title">${esc(t('bind.title'))}</div>
        <div class="l3-hint">${esc(t('bind.hint'))}</div>
        ${body}
        ${clashes.length ? `<div class="l3-warns">${clashes.map((c) => `<div>${esc(c)}</div>`).join('')}</div>` : ''}
      </div>`
  }

  /** 「待机姿势」四个滑块。拖 = 只改预览(input),松手 = 写盘(change)。 */
  function poseSection(e: LibEntry): string {
    const pose = poseDraft ?? e.profile.pose
    const keys: Array<keyof ProfilePose> = ['armSpread', 'armForward', 'elbow', 'liveliness']
    const row = (k: keyof ProfilePose): string => `
      <label class="l3-slider">
        <span>${esc(t(`pose.${k}` as 'pose.armSpread'))}</span>
        <input type="range" min="0" max="${k === 'liveliness' ? 2 : 1}" step="0.01" value="${pose[k]}" data-act="pose" data-k="${k}">
        <output>${pose[k].toFixed(2)}</output>
      </label>`
    return `
      <div class="l3-section">
        <div class="l3-section-title">${esc(t('pose.title'))}</div>
        <div class="l3-hint">${esc(t('pose.hint'))}</div>
        ${keys.map(row).join('')}
        <div class="l3-row">${button('pose-reset', t('pose.reset'), ' data-quiet')}</div>
      </div>`
  }

  function renderMode(): void {
    part('mode').innerHTML = `<div class="l3-section-title">${esc(t('mode.label'))}</div>${modeRadios(shell, 'l3-mode-studio')}`
  }

  function render(): void {
    if (disposed) return
    // Desk 形象换了(刚导入完 / 侧板工具条里换的)→ 预览跟过去
    const act = shell.data().active ?? ''
    if (act !== lastActive) {
      lastActive = act
      sel = act
    }
    // 选中的模型被删了 → 回到当前 Desk 形象(再不行回小球),别让预览指向一个不存在的条目
    if (sel && !shell.lib.find(sel)) sel = shell.lib.find(shell.data().active) ? shell.data().active ?? '' : ''
    renderHead()
    renderList()
    renderActions()
    renderPhases()
    renderDetail()
    renderMode()
    part('notice').innerHTML = noticeBar(shell)
    renderMsg()
    load()
  }

  const onClick = (ev: Event): void => {
    const target = ev.target as HTMLElement
    if (handleCommon(shell, target)) return
    const btn = target.closest<HTMLElement>('[data-act]')
    const act = btn?.dataset.act
    switch (act) {
      case 'select':
        sel = btn!.dataset.slug ?? ''
        poseDraft = null
        render()
        break
      case 'pose-reset': {
        const e = selected()
        if (e) void savePose(e, { ...DEFAULT_POSE })
        break
      }
      case 'use':
        shell.setActive(sel || null)
        break
      case 'reveal': {
        const e = selected()
        if (e) ctx.app.reveal?.(e.profilePath)
        break
      }
      case 'phase': {
        const p = (btn!.dataset.phase || null) as Phase | null
        phase = p
        stage?.previewPhase(p)
        renderPhases()
        break
      }
      case 'import':
        importer.pickDirect(false)
        break
      case 'import-folder':
        importer.pickDirect(true)
        break
      case 'agent-import':
        importer.pickAgent(false)
        break
      case 'open-folder':
        void shell.openFolder()
        break
      case 'refresh':
        void shell.refresh(true)
        break
    }
  }
  /** 姿势写盘:草稿清掉,让 load() 重新按库里那份(已经是新的)来。 */
  const savePose = async (e: LibEntry, pose: ProfilePose): Promise<void> => {
    poseDraft = null
    if (!(await shell.writeProfile(e, { ...e.profile, pose }))) return
    if (!disposed) render()
  }

  const poseFrom = (e: LibEntry, k: keyof ProfilePose, v: number): ProfilePose => ({ ...(poseDraft ?? e.profile.pose), [k]: v })

  const onChange = (ev: Event): void => {
    const input = ev.target as HTMLInputElement
    const act = input.dataset.act
    if (act === 'mode' && (input.value === 'idle' || input.value === 'always')) return shell.setMode(input.value)
    const e = selected()
    if (!e) return
    if (act === 'bind') {
      const slug = input.dataset.slug ?? ''
      const next = input.checked ? [...e.profile.agents, slug] : e.profile.agents.filter((a) => a !== slug)
      void shell.writeProfile(e, withAgents(e.profile, next))
      return
    }
    if (act === 'pose') {
      const k = input.dataset.k as keyof ProfilePose
      const v = Number(input.value)
      if (!(k in DEFAULT_POSE) || !Number.isFinite(v)) return
      void savePose(e, poseFrom(e, k, v))
    }
  }

  // 拖滑块:只动预览(setProfile 的「同一模型」分支就地换姿势,不重载),松手的 change 才落盘。
  const onInput = (ev: Event): void => {
    const input = ev.target as HTMLInputElement
    if (input.dataset.act !== 'pose') return
    const e = selected()
    const k = input.dataset.k as keyof ProfilePose
    const v = Number(input.value)
    if (!e || !(k in DEFAULT_POSE) || !Number.isFinite(v)) return
    poseDraft = poseFrom(e, k, v)
    const out = input.parentElement?.querySelector('output')
    if (out) out.textContent = v.toFixed(2)
    load()
  }

  // 拖放导入:dragenter/leave 成对计数(进子元素也会触发 leave),drop 里**同步**取 DataTransfer 的条目
  let dragDepth = 0
  const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files')
  const onDragEnter = (e: DragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth++
    const d = part('drop')
    d.textContent = t('studio.drop')
    d.hidden = false
  }
  const onDragOver = (e: DragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }
  const onDragLeave = (e: DragEvent): void => {
    if (!hasFiles(e)) return
    dragDepth = Math.max(0, dragDepth - 1)
    if (!dragDepth) part('drop').hidden = true
  }
  const onDrop = (e: DragEvent): void => {
    if (!hasFiles(e) || !e.dataTransfer) return
    e.preventDefault()
    dragDepth = 0
    part('drop').hidden = true
    void importer.fromDrop(e.dataTransfer).then((r) => importer.importDirect(r))
  }

  root.addEventListener('click', onClick)
  root.addEventListener('change', onChange)
  root.addEventListener('input', onInput)
  root.addEventListener('dragenter', onDragEnter)
  root.addEventListener('dragover', onDragOver)
  root.addEventListener('dragleave', onDragLeave)
  root.addEventListener('drop', onDrop)
  const off = shell.onChange(render)
  render()
  void shell.refresh(true) // 打开即重扫(用户可能刚在访达里放了东西)

  return () => {
    disposed = true
    off()
    try {
      offStatus?.()
    } catch {
      /* ignore */
    }
    root.removeEventListener('click', onClick)
    root.removeEventListener('change', onChange)
    root.removeEventListener('input', onInput)
    root.removeEventListener('dragenter', onDragEnter)
    root.removeEventListener('dragover', onDragOver)
    root.removeEventListener('dragleave', onDragLeave)
    root.removeEventListener('drop', onDrop)
    stage?.dispose()
    stage = null
    el.classList.remove('l3-view')
    el.innerHTML = ''
  }
}
