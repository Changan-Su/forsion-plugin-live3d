// Agent 协助导入的首条消息(发给捆绑的 live3d-importer)。纯函数:只依赖 contract + i18n,不碰 DOM / three / ctx ——
// 插件(ui/importer.ts)与 dev 台架 scripts/live-agent.mjs 用的是**同一份**构造,台架测到的就是用户真实发出去的那句话。
// 语言跟随 i18n 的当前语言(setLocale);`absFolder` 由调用方经 ctx.app.hostPath 解析(拿不到就 null,整行省略)。
import { PROFILE_FILE, modelFolder } from './contract'
import { t } from './i18n'

export interface ImportPromptInput {
  /** 插件工作文件夹(库内相对,如 `Live3D`)。 */
  workFolder: string
  /** 模型文件夹名(`models/<slug>/`)。 */
  slug: string
  /** 模型文件夹的本机绝对路径;宿主给不出时 null。 */
  absFolder: string | null
  /** 用户导入的文件(相对模型文件夹;不含插件自己生成的 analysis.json / preview.png / live3d.json)。 */
  files: string[]
  hasAnalysis: boolean
  hasPreview: boolean
  /** 插件直接加载时的报错(英文原文,给 agent 看:Draco / KTX2 / 解析失败都靠它认出来);没试过或没出错时省略。 */
  loadError?: string | null
}

/** 提示词里最多列出的文件数;其余只报个数。 */
export const PROMPT_MAX_FILES = 20

export function buildImportPrompt(i: ImportPromptInput): string {
  const dirVault = modelFolder(i.workFolder, i.slug)
  const rel = `models/${i.slug}/`
  const shown = i.files.slice(0, PROMPT_MAX_FILES).join(', ')
  const lines = [
    t('prompt.intro'),
    '',
    `- ${t('prompt.folder', { path: rel })}`,
    `- ${t('prompt.vault', { path: dirVault })}`,
    ...(i.absFolder ? [`- ${t('prompt.abs', { path: i.absFolder })}`] : []),
    `- ${t('prompt.files', { files: shown })}${i.files.length > PROMPT_MAX_FILES ? ` ${t('prompt.more', { n: i.files.length - PROMPT_MAX_FILES })}` : ''}`,
    `- ${t('prompt.analysis', { state: t(i.hasAnalysis ? 'prompt.yes' : 'prompt.no') })}`,
    `- ${t('prompt.preview', { state: t(i.hasPreview ? 'prompt.yes' : 'prompt.no') })}`,
    ...(i.loadError ? [`- ${t('prompt.loadError', { why: i.loadError.replace(/\s+/g, ' ').trim() })}`] : []),
    '',
    t('prompt.ask', { path: `${rel}${PROFILE_FILE}` }),
  ]
  return lines.join('\n')
}
