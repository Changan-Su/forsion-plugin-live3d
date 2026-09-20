// 打包 src/index.ts(含 three.js + @pixiv/three-vrm)→ 单文件 IIFE main.js。照 forsion-plugin-inspect/build.mjs:
//  - format:'iife' → 顶层无 import/export,过 Forsion 的「main.js 必须是裸 setup 体」闸;
//  - `ctx` 是自由变量,由宿主 new Function('ctx', code) 注入,esbuild 原样保留其引用;
//  - globalName + footer:把模块导出的 dispose 在**函数体最外层** return 给宿主(禁用插件时摘监听 / 释放 WebGL);
//  - three 内联进包(CSP 是 default-src 'self',没有 CDN,也要能离线跑);.css 当文本进包,运行时注入 <style>。
//  - define['import.meta.url']:three r186 的 DRACOLoader / KTX2Loader 在**模块顶层** new URL('…', import.meta.url),
//    IIFE 里 esbuild 把 import.meta 换成 {} → 装载即抛 Invalid URL,而且 esbuild 不给任何警告。本插件不 import
//    这两个加载器,这一行是防有人哪天顺手加上时整个插件静默装不上(formats.md §1.2)。
//  - main.js 必须提交并与 src 同步(装包不构建)—— 改 src 后务必重跑本脚本。
import { build } from 'esbuild'

const dev = process.argv.includes('--dev')

const out = await build({
  entryPoints: ['src/index.ts'],
  outfile: 'main.js',
  bundle: true,
  format: 'iife',
  globalName: 'forsionLive3d',
  footer: { js: 'return forsionLive3d.dispose;' },
  platform: 'browser',
  target: 'es2022',
  minify: !dev,
  sourcemap: false,
  legalComments: 'none',
  loader: { '.css': 'text' },
  define: {
    'process.env.NODE_ENV': '"production"',
    'import.meta.url': '"https://invalid.local/x/"',
  },
  metafile: true,
  logLevel: 'info',
})

const bytes = out.metafile.outputs['main.js'].bytes
console.log(`built main.js (${(bytes / 1024).toFixed(0)} KB)`)
