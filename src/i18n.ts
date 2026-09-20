// 双语文案。两张表键集必须一致、en 不许含汉字、{占位符} zh/en 逐字一致 —— check.mjs 钉这三条。
// 当前语言是**模块级可变**的(不是 inspect 那种装载时定格的常量):宿主 subscribeLocale 回调里 setLocale,
// 各视图随后按新语言重画 DOM(不拆不重挂,画布与模型不动)。
import type { Locale } from './ui/host'
import type { Msg } from './contract'

const zh = {
  // 阶段
  'phase.idle': '空闲',
  'phase.thinking': '思考',
  'phase.speaking': '说话',
  'phase.tool': '调用工具',
  'phase.waiting': '等你回应',
  'phase.error': '出错',
  'phase.done': '完成',
  'phase.live': '实时',

  // 命令
  'cmd.openStudio': 'Live3D:打开模型库',
  'cmd.import': 'Live3D:导入 3D 模型…',
  'cmd.agentImport': 'Live3D:让 Agent 协助导入…',
  'cmd.toggleMode': 'Live3D:切换显示模式(空闲显示 / 总是显示)',
  'cmd.refresh': 'Live3D:刷新模型库',

  // 显示模式
  'mode.label': '显示模式',
  'mode.idle': '空闲显示',
  'mode.idleHint': 'Agent Desk 上没有任何展示内容时才出现;Agent 展示文件时让位,点 Desk 上的「清空 Desk」即可请回来。',
  'mode.always': '总是显示',
  'mode.alwaysHint': '总是显示会完全替换 Agent Desk 的文件展示:卡片和展开的侧板都只显示形象,Agent 展示的文件、聊天里的引用改为在新标签页打开。',
  'mode.switched': '显示模式已切换为「{mode}」',

  // 视图 / 设置
  'studio.title': 'Live3D 模型库',
  'settings.title': 'Live3D 形象',
  'settings.noDesk': '当前宿主没有 Agent Desk 伴随面接口(需要新版桌面 Tangu),Desk 里不会出现形象;模型库与导入照常可用。',
  'settings.active': 'Desk 默认形象',
  'settings.activeHint': '没有绑定 Agent 的对话用它。要让某个 Agent 用自己的形象,去模型库里绑定。',
  'settings.folder': '模型文件夹',
  'settings.folderHint': '每个模型一个子文件夹 models/<名字>/,里面放模型文件与 live3d.json。',
  'settings.folderRel': '(笔记库内路径;打开笔记库后显示完整路径)',
  'orb.name': '默认小球',
  'orb.hint': '没导入模型时,Desk 里显示这个小球。',

  // 按钮
  'btn.import': '导入模型…',
  'btn.importFolder': '导入文件夹…',
  'btn.agentImport': '让 Agent 协助导入…',
  'btn.agentFix': '让 Agent 协助处理',
  'btn.openLibrary': '打开模型库',
  'btn.openFolder': '打开文件夹',
  'btn.refresh': '刷新',
  'btn.useInDesk': '设为 Desk 形象',
  'btn.inUse': '正在 Desk 上',
  'btn.reveal': '在文件夹中显示',
  'btn.dismiss': '知道了',
  'btn.library': '模型库',

  // 模型库
  'lib.models': '模型',
  'lib.empty': '还没有导入任何模型。',
  'lib.noVault': '没有打开笔记库:模型存放在笔记库里的插件工作文件夹中,请先在 Amadeus 打开一个库。',
  'lib.noList': '这个宿主不能列出库内文件,模型库无法扫描。',
  'lib.problems': '这些模型没能读进来:',
  'lib.missingModel': '找不到模型文件「{file}」',
  'lib.noProfile': '还没有 live3d.json(导入没完成?可以让 Agent 协助导入,或照 README 手写一份)',
  'lib.pending': '等 Live3D Importer 写 live3d.json…',
  'lib.unreadable': '读不到 live3d.json',
  'lib.refreshed': '模型库已刷新({n})',
  'lib.badge.active': '默认',
  'lib.badge.bound': '已绑定',
  'lib.badge.pending': '导入中',
  'lib.badge.problem': '有问题',

  // 工作室
  'studio.try': '试一下',
  'studio.drop': '松开即导入模型文件或文件夹',
  'studio.dropHint': '也可以把模型文件或文件夹拖进这里',
  'studio.loading': '正在加载…',
  'studio.loadFailed': '加载失败:{why}',
  'studio.info': '{format} · 动作 {clips} · 表情 {expr}',
  'studio.webglOff': 'WebGL 不可用,无法预览。',
  'studio.editHint': '想调动作映射、表情或构图?直接改 live3d.json(保存后自动重载),或让 Agent 协助。',
  'studio.notes': '提示',
  'studio.noView': '这个宿主不能打开插件视图。',

  // 绑定 / 姿势
  'bind.title': '绑给哪些 Agent',
  'bind.hint': '跟这些 Agent 对话时,Desk 上显示这个形象;其它对话显示「默认形象」。',
  'bind.noHost': '这个宿主不提供 Agent 名册,无法在这里绑定。可以直接在 live3d.json 里写 "agents": ["slug"]。',
  'bind.none': '没有绑定任何 Agent',
  'bind.badge': '{n} 个 Agent',
  'bind.taken': '「{agent}」也被形象「{other}」绑着,按文件夹名字母序生效的是「{winner}」。',
  'pose.title': '待机姿势',
  'pose.hint': '模型没有自带动作片段时才用得上。改完保存即生效,也可以直接让 Agent 帮你调。',
  'pose.armSpread': '手臂外张',
  'pose.armForward': '手臂前摆',
  'pose.elbow': '手肘弯曲',
  'pose.liveliness': '待机幅度',
  'pose.reset': '恢复缺省',
  'profile.noWriter': '这个宿主不能写入文件,改不了 live3d.json。请手动编辑这个文件。',
  'profile.writeFailed': '写入 live3d.json 失败:{why}',

  // 侧板工具条 / 占位
  'toolbar.model': 'Desk 默认形象',
  'placeholder.elsewhere': 'Live3D 形象正显示在另一个面板里',
  'placeholder.webgl': 'WebGL 不可用,Live3D 无法显示形象',

  // 导入
  'import.busy': '上一个导入还没完成,请稍候。',
  'import.empty': '没有选中任何文件。',
  'import.noVault': '没有打开笔记库,无法导入:请先在 Amadeus 打开一个库。',
  'import.noMain': '这些文件里没有能直接显示的 3D 模型(.vrm / .glb / .gltf / .fbx / .obj / .pmx / .pmd)。压缩包请先解压再导入文件夹;Blender 等工程文件请用「让 Agent 协助导入」。',
  'import.copying': '正在复制 {n} 个文件…',
  'import.analyzing': '正在分析模型…',
  'import.done': '已导入「{name}」,并设为 Desk 形象。',
  'import.loadFailed': '文件已复制到 {folder},但模型加载失败:{why}',
  'import.noWriter': '这个宿主不能写入二进制文件,无法自动复制模型。请手动把模型文件复制到 {folder}(已为你打开文件夹),再点「刷新」。',
  'import.noWriterNoReveal': '这个宿主不能写入二进制文件,无法自动复制模型。请手动把模型文件复制到笔记库里的 {folder},再点「刷新」。',
  'import.doneNotListed': '已导入「{name}」,但模型库暂时还没看到它;稍后点「刷新」,它就会出现在 Desk 上。',
  'import.writeFailed': '复制文件失败:{why}',
  'import.folderFailed': '建不出「{folder}」文件夹,请手动在笔记库里新建。',

  // Agent 协助导入
  'agent.started': '已打开与 Live3D Importer 的对话;它写好 live3d.json 后形象会自动载入。',
  'agent.noStartChat': '这个宿主不能替你开对话。提示词已复制到剪贴板:请新建与「Live3D Importer」的对话并粘贴。',
  'agent.manual': '这个宿主不能替你开对话:请新建与「Live3D Importer」的对话,让它导入 {folder}。',
  'agent.failed': '没能打开对话:{why}。提示词已复制到剪贴板,可以手动发给「Live3D Importer」。',
  'agent.failedManual': '没能打开对话:{why}。请新建与「Live3D Importer」的对话,让它导入 {folder}。',
  'agent.loaded': 'Live3D Importer 写好了「{name}」,已设为 Desk 形象。',
  'agent.badProfile': 'Live3D Importer 写的 live3d.json 有问题:{why}',
  'prompt.intro': '请把这个 3D 模型导入为 Live3D 的 Desk 形象。',
  'prompt.folder': '模型文件夹(相对当前工作目录):{path}',
  'prompt.vault': '笔记库内路径:{path}',
  'prompt.abs': '绝对路径:{path}',
  'prompt.files': '文件:{files}',
  'prompt.more': '……另有 {n} 个文件',
  'prompt.analysis': 'analysis.json:{state}',
  'prompt.preview': 'preview.png:{state}',
  'prompt.yes': '已生成',
  'prompt.no': '没有(模型没能直接加载)',
  'prompt.loadError': '插件直接加载时的报错:{why}',
  'prompt.ask': '请按 live3d-import 技能识别这个模型,并写好 {path}。',

  // Desk
  'active.loadFailed': 'Desk 形象「{name}」加载失败:{why}',
} as const

export type MsgKey = keyof typeof zh

const en: Record<MsgKey, string> = {
  'phase.idle': 'Idle',
  'phase.thinking': 'Thinking',
  'phase.speaking': 'Speaking',
  'phase.tool': 'Using a tool',
  'phase.waiting': 'Waiting for you',
  'phase.error': 'Error',
  'phase.done': 'Done',
  'phase.live': 'Live',

  'cmd.openStudio': 'Live3D: Open model library',
  'cmd.import': 'Live3D: Import a 3D model…',
  'cmd.agentImport': 'Live3D: Agent-assisted import…',
  'cmd.toggleMode': 'Live3D: Toggle display mode (when idle / always)',
  'cmd.refresh': 'Live3D: Refresh model library',

  'mode.label': 'Display mode',
  'mode.idle': 'When idle',
  'mode.idleHint': 'Appears only while the Agent Desk has nothing on it. It steps aside when the agent presents a file; click "Clear Desk" on the Desk to bring it back.',
  'mode.always': 'Always',
  'mode.alwaysHint': 'Always completely replaces the Agent Desk file presentation: the card and the expanded panel show only the companion, and files the agent presents or you open from chat citations open in a new tab instead.',
  'mode.switched': 'Display mode switched to "{mode}"',

  'studio.title': 'Live3D library',
  'settings.title': 'Live3D companion',
  'settings.noDesk': 'This host has no Agent Desk companion API (a newer desktop Tangu is required), so nothing appears on the Desk. The model library and import still work.',
  'settings.active': 'Default Desk companion',
  'settings.activeHint': 'Used in chats whose agent has no companion of its own. Bind a companion to an agent in the library.',
  'settings.folder': 'Models folder',
  'settings.folderHint': 'One subfolder per model, models/<name>/, holding the model files and live3d.json.',
  'settings.folderRel': '(path inside the vault; open a vault to see the full path)',
  'orb.name': 'Default orb',
  'orb.hint': 'The Desk shows this orb until you import a model.',

  'btn.import': 'Import model…',
  'btn.importFolder': 'Import folder…',
  'btn.agentImport': 'Agent-assisted import…',
  'btn.agentFix': 'Ask the agent to handle it',
  'btn.openLibrary': 'Open library',
  'btn.openFolder': 'Open folder',
  'btn.refresh': 'Refresh',
  'btn.useInDesk': 'Use on the Desk',
  'btn.inUse': 'On the Desk',
  'btn.reveal': 'Show in folder',
  'btn.dismiss': 'Dismiss',
  'btn.library': 'Library',

  'lib.models': 'Models',
  'lib.empty': 'No models imported yet.',
  'lib.noVault': 'No vault is open. Models live in the plugin work folder inside your vault, so open a vault in Amadeus first.',
  'lib.noList': 'This host cannot list vault files, so the library cannot be scanned.',
  'lib.problems': 'These models could not be loaded:',
  'lib.missingModel': 'Model file "{file}" is missing',
  'lib.noProfile': 'No live3d.json yet (import not finished?). Use Agent-assisted import, or write one by hand following the README.',
  'lib.pending': 'Waiting for Live3D Importer to write live3d.json…',
  'lib.unreadable': 'Could not read live3d.json',
  'lib.refreshed': 'Library refreshed ({n})',
  'lib.badge.active': 'Default',
  'lib.badge.bound': 'Bound',
  'lib.badge.pending': 'Importing',
  'lib.badge.problem': 'Problem',

  'studio.try': 'Try a state',
  'studio.drop': 'Drop to import model files or a folder',
  'studio.dropHint': 'You can also drag model files or a folder here',
  'studio.loading': 'Loading…',
  'studio.loadFailed': 'Could not load: {why}',
  'studio.info': '{format} · clips {clips} · expressions {expr}',
  'studio.webglOff': 'WebGL is unavailable, so there is no preview.',
  'studio.editHint': 'To change clip mapping, expressions or framing, edit live3d.json (it reloads on save) or ask the agent.',
  'studio.notes': 'Notes',
  'studio.noView': 'This host cannot open plugin views.',

  'toolbar.model': 'Default Desk companion',
  'bind.title': 'Agents using this companion',
  'bind.hint': 'In chats with these agents the Desk shows this companion; every other chat shows the default one.',
  'bind.noHost': 'This host does not expose the agent list, so binding is not available here. You can write "agents": ["slug"] in live3d.json instead.',
  'bind.none': 'Not bound to any agent',
  'bind.badge': '{n} agents',
  'bind.taken': '"{agent}" is also bound to "{other}"; "{winner}" wins because folder names are compared alphabetically.',
  'pose.title': 'Idle pose',
  'pose.hint': 'Only used when the model has no animation clips of its own. Saved changes apply right away, and you can also ask an agent to tune it.',
  'pose.armSpread': 'Arms out',
  'pose.armForward': 'Arms forward',
  'pose.elbow': 'Elbow bend',
  'pose.liveliness': 'Liveliness',
  'pose.reset': 'Reset',
  'profile.noWriter': 'This host cannot write files, so live3d.json cannot be changed here. Edit the file yourself.',
  'profile.writeFailed': 'Could not write live3d.json: {why}',

  'placeholder.elsewhere': 'The Live3D companion is showing in another panel',
  'placeholder.webgl': 'WebGL is unavailable, so Live3D cannot show the companion',

  'import.busy': 'Another import is still running. Please wait.',
  'import.empty': 'No files were selected.',
  'import.noVault': 'No vault is open, so nothing can be imported. Open a vault in Amadeus first.',
  'import.noMain': 'None of these files is a 3D model that can be shown directly (.vrm / .glb / .gltf / .fbx / .obj / .pmx / .pmd). Unzip archives first and import the folder; for Blender and other project files, use Agent-assisted import.',
  'import.copying': 'Copying {n} files…',
  'import.analyzing': 'Analyzing the model…',
  'import.done': 'Imported "{name}" and set it as the Desk companion.',
  'import.loadFailed': 'The files were copied to {folder}, but the model failed to load: {why}',
  'import.noWriter': 'This host cannot write binary files, so the model was not copied. Copy the model files into {folder} yourself (the folder is now open), then click Refresh.',
  'import.noWriterNoReveal': 'This host cannot write binary files, so the model was not copied. Copy the model files into {folder} in your vault yourself, then click Refresh.',
  'import.doneNotListed': 'Imported "{name}", but the library cannot see it yet. Click Refresh in a moment and it will appear on the Desk.',
  'import.writeFailed': 'Could not copy the files: {why}',
  'import.folderFailed': 'Could not create "{folder}". Create it in your vault manually.',

  'agent.started': 'Opened a chat with Live3D Importer. The companion loads automatically once it writes live3d.json.',
  'agent.noStartChat': 'This host cannot open a chat for you. The prompt is on your clipboard: start a chat with "Live3D Importer" and paste it.',
  'agent.manual': 'This host cannot open a chat for you. Start a chat with "Live3D Importer" and ask it to import {folder}.',
  'agent.failed': 'Could not open the chat: {why}. The prompt is on your clipboard, so you can send it to "Live3D Importer" yourself.',
  'agent.failedManual': 'Could not open the chat: {why}. Start a chat with "Live3D Importer" and ask it to import {folder}.',
  'agent.loaded': 'Live3D Importer finished "{name}", and it is now the Desk companion.',
  'agent.badProfile': 'The live3d.json written by Live3D Importer has a problem: {why}',
  'prompt.intro': 'Please import this 3D model as the Live3D Desk companion.',
  'prompt.folder': 'Model folder (relative to the current working directory): {path}',
  'prompt.vault': 'Path inside the vault: {path}',
  'prompt.abs': 'Absolute path: {path}',
  'prompt.files': 'Files: {files}',
  'prompt.more': '…and {n} more files',
  'prompt.analysis': 'analysis.json: {state}',
  'prompt.preview': 'preview.png: {state}',
  'prompt.yes': 'generated',
  'prompt.no': 'missing (the model could not be loaded directly)',
  'prompt.loadError': 'Error when the plugin tried to load it directly: {why}',
  'prompt.ask': 'Identify this model following the live3d-import skill, and write {path}.',

  'active.loadFailed': 'Could not load the Desk companion "{name}": {why}',
}

export const MSG: { zh: Record<MsgKey, string>; en: Record<MsgKey, string> } = { zh, en }

let locale: Locale = 'zh'

export const setLocale = (l: unknown): void => {
  locale = l === 'en' ? 'en' : 'zh'
}
export const currentLocale = (): Locale => locale

/** 取当前语言的文案;`{name}` 占位按 vars 替换(缺的原样保留,别吞成空串)。 */
export function t(key: MsgKey, vars?: Record<string, string | number>): string {
  const s = (locale === 'en' ? MSG.en[key] : MSG.zh[key]) ?? MSG.zh[key] ?? key
  if (!vars) return s
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}

/** 双语消息({zh,en},P1 的 LoadError / parseProfile 警告)按当前语言挑一个。 */
export const pick = (m: Msg | null | undefined): string => (m ? (locale === 'en' ? m.en : m.zh) : '')
