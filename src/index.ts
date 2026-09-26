// Live3D —— 在 Tangu 的 Agent Desk 里放一个会跟着 agent 状态做反应的 3D 形象(VRM / GLB / glTF / FBX / OBJ / PMX)。
//
// 由 Forsion 以 new Function('ctx', <本文件的 esbuild IIFE 产物>) 装载:
//  - `ctx` 是宿主注入的自由变量;打包产物顶层不得有 import/export(build.mjs:format 'iife');
//  - 模块导出的 dispose 经 build.mjs 的 footer 在函数体最外层 return 给宿主(禁用插件时摘监听、释放 WebGL)。
//
// 生态铁律:**每个新接缝都可选链**(ctx.desk?、ctx.tangu?.startChat?、ctx.app.writeBytes? …)——
// 老宿主缺哪条就少哪块功能,setup 本身绝不抛。check.mjs 用裸 ctx 装载 + 逐条拆守卫的负对照钉住这一条。
//
// 分工:ui/state(落盘设置 / 模型库 / 场景库 / 定时器)· ui/importer(直接导入 / Agent 协助导入)·
//       ui/companion(Desk 伴随面,单舞台多挂载点)· ui/studio(模型库视图)· ui/settings(设置面)·
//       ui/roomHost + ui/room(3D 小屋:Space 主区视图,场景 + 行为)· ui/screensaver(空闲全屏屏保,与小屋共用一块画布)。
// 独立 Space 是数据:包根 spaces/live3d/space.json 引用本插件的视图 `plugin:live3d:room`,宿主扫捆绑包时装上 ribbon。
import css from './live3d.css'
import { setLocale, t } from './i18n'
import type { HostCtx } from './ui/host'
import { createShell } from './ui/state'
import { createImporter } from './ui/importer'
import { createCompanion } from './ui/companion'
import { mountStudio } from './ui/studio'
import { mountSettings } from './ui/settings'
import { createRoomHost } from './ui/roomHost'
import { mountRoom } from './ui/room'
import { createScreensaver } from './ui/screensaver'

declare const ctx: HostCtx

setLocale(ctx.getLocale?.() ?? 'zh')

// ── 能力探测(setup 时一次性取定;ctx 的成员在建 context 那一刻就定了)──────────────────
// 每一条都经过一个可选链 —— check.mjs 的负对照把它拆成非可选后,裸 ctx 上必须当场抛。
const hostWriteBytes = ctx.app.writeBytes?.bind(ctx.app)
const hostStartChat = ctx.tangu?.startChat?.bind(ctx.tangu)
const deskApi = ctx.desk?.registerCompanion ? ctx.desk : null

const style = document.createElement('style')
style.setAttribute('data-live3d', '')
style.textContent = css
document.head.appendChild(style)

const shell = createShell(ctx)
const importer = createImporter(shell, { writeBytes: hostWriteBytes, startChat: hostStartChat })
/** 还挂着的视图 / 设置面的卸载函数:插件被禁用时宿主不一定先卸它们,dispose 里兜底收掉(画布 = GL 上下文)。 */
const mounted = new Set<() => void>()

const STUDIO_VIEW = 'studio'
const ROOM_VIEW = 'room'
const openStudio = (): void => {
  if (ctx.openView) ctx.openView(STUDIO_VIEW)
  else shell.say('info', () => t('studio.noView'))
}
const openRoom = (): void => {
  if (ctx.openView) ctx.openView(ROOM_VIEW)
  else shell.say('info', () => t('studio.noView'))
}
const roomHost = createRoomHost(shell)
const saver = createScreensaver(shell, roomHost)

const track = (off: () => void): (() => void) => {
  let done = false
  const once = (): void => {
    if (done) return
    done = true
    mounted.delete(once)
    off()
  }
  mounted.add(once)
  return once
}

ctx.registerView?.({
  id: STUDIO_VIEW,
  title: t('studio.title'),
  singleton: true,
  mount: (el) => track(mountStudio(el, shell, importer)),
})

ctx.registerView?.({
  id: ROOM_VIEW,
  title: t('room.title'),
  singleton: true,
  mount: (el) => track(mountRoom(el, shell, roomHost, saver, openStudio)),
})

ctx.registerSettingsView?.({
  id: 'live3d-settings',
  title: t('settings.title'),
  mount: (el) => track(mountSettings(el, shell, importer, openStudio, { openRoom, saver })),
})

const companion = deskApi ? createCompanion(shell, deskApi, openStudio) : null

// ── 命令(只做导航 / 打开选择器;没有热键 —— 宿主热键表没有输入焦点闸)────────────────────
ctx.registerCommand({
  id: 'live3d-open-studio',
  title: t('cmd.openStudio'),
  keywords: 'live3d 3d avatar vrm model library companion desk 模型库 形象 伴随 moxingku',
  run: openStudio,
})
ctx.registerCommand({
  id: 'live3d-open-room',
  title: t('cmd.openRoom'),
  keywords: 'live3d 3d room scene space companion 小屋 场景 房间 xiaowu changjing',
  run: openRoom,
})
ctx.registerCommand({
  id: 'live3d-screensaver',
  title: t('cmd.saver'),
  keywords: 'live3d screensaver fullscreen idle 屏保 全屏 pingbao',
  // 在用户手势里同步调用:全屏请求要用户激活
  run: () => saver.start(true),
})
ctx.registerCommand({
  id: 'live3d-import',
  title: t('cmd.import'),
  keywords: 'live3d import vrm glb gltf fbx obj avatar 导入 模型 daoru',
  // 选择器必须在用户手势里同步弹出:这里不许先 await
  run: () => importer.pickDirect(false),
})
ctx.registerCommand({
  id: 'live3d-agent-import',
  title: t('cmd.agentImport'),
  keywords: 'live3d agent import convert pmx mmd zip 协助 导入 转换 agent',
  run: () => importer.pickAgent(false),
})
ctx.registerCommand({
  id: 'live3d-toggle-mode',
  title: t('cmd.toggleMode'),
  keywords: 'live3d mode idle always desk 显示模式 空闲 总是 moshi',
  run: () => {
    const next = shell.data().mode === 'always' ? 'idle' : 'always'
    shell.setMode(next)
    shell.say('info', () => t('mode.switched', { mode: t(next === 'always' ? 'mode.always' : 'mode.idle') }))
  },
})
ctx.registerCommand({
  id: 'live3d-refresh',
  title: t('cmd.refresh'),
  keywords: 'live3d refresh reload library 刷新 模型库 shuaxin',
  run: async () => {
    await shell.refresh(true)
    shell.say('info', () => t('lib.refreshed', { n: shell.lib.state().entries.length }))
  },
})

// 切语言:只换文案、不拆 DOM(画布与模型不动)。命令标题 / 视图标题是注册时定格的字符串(宿主契约如此)。
const offLocale = ctx.subscribeLocale?.((l) => {
  setLocale(l)
  shell.emit()
})

void shell.ready.then(() => shell.refresh())

/** 宿主的 teardown 出口 —— build.mjs 的 footer 把它 `return` 出去。 */
export function dispose(): void {
  companion?.dispose()
  saver.dispose()
  for (const off of [...mounted]) off()
  roomHost.dispose()
  importer.dispose()
  try {
    offLocale?.()
  } catch {
    /* 宿主已统一收掉 */
  }
  shell.dispose()
  style.remove()
}
