# Changelog

## 0.1.0 — 2026-09-20

首个版本 / First release.

- Agent Desk 伴随面:卡片与展开侧板共用一个 WebGL 舞台(收起 / 展开之间搬画布,不重载模型),跟着 Agent 的七种状态(空闲 / 思考 / 说话 / 调用工具 / 等你回应 / 出错 / 完成)做反应;说话时口型跟随流式输出。
  Agent Desk companion: the card and the expanded panel share one WebGL stage (the canvas moves between them without reloading the model) and react to seven agent states; lip sync follows the streamed answer.
- 两种显示模式:空闲显示 / 总是显示(完全替换 Desk 的文件展示)。
  Two display modes: when idle / always (completely replaces the Desk file presentation).
- 直接导入 VRM 0.x / 1.0、GLB、glTF、FBX、OBJ、PMX / PMD(MMD,不含物理与 .vmd 动作)(+ .vrma 动作),自动体检、缩略图、生成 live3d.json;模型库视图可预览、试七种状态、拖放导入。
  Direct import of VRM 0.x / 1.0, GLB, glTF, FBX, OBJ and PMX / PMD (MMD, no physics or .vmd motions) (+ .vrma motions) with automatic analysis, thumbnail and profile; a library view to preview, try all seven states and drop files in.
- 捆绑 Agent「Live3D Importer」:经 ctx.tangu.startChat 开可见对话,解压压缩包(中文 / 日文文件名走 tar 保住原名)、转换 Draco 等格式并写好配置;写好即自动载入。
  Bundled "Live3D Importer" agent, opened as a visible chat via ctx.tangu.startChat; the avatar loads as soon as its profile is written.
- 全局技能 live3d-import(包根 skills/):任何 Agent(包括用户自建的)都能在普通聊天里接一个文件 / 压缩包路径完成导入,再到模型库「设为 Desk 形象」。
  Global skill live3d-import (bundle-root skills/): any agent, including user-created ones, can import from a pasted file or archive path; then pick the model in the library and press "Use on the Desk".
- **形象可以按 Agent 绑定**:在模型库里勾选 Agent(写进该模型 `live3d.json` 的 `agents`),跟它们对话时 Desk 显示这个形象,其余对话显示「Desk 默认形象」。一个 Agent 被两个形象绑住时按文件夹名字母序取第一个。
  Companions can be bound to agents: tick them in the library (this writes `agents` in the model's own profile). Chats with those agents show that companion; every other chat shows the default one. If two models claim the same agent, the one whose folder name sorts first wins.
- **待机姿势可调**:没有动作片段的模型(MMD、多数 VRoid 导出)由插件自己摆手臂与躯干。缺省姿势重做 —— 手臂略微外张前摆、手肘微弯、两侧缓慢漂移,不再像挂在衣架上,手也不会陷进裙摆。`live3d.json` 新增 `pose`(`armSpread` / `armForward` / `elbow` / `liveliness`),模型库有四个滑块,也可以直接让 Agent 看着截图帮你调。有片段驱动的骨骼仍由片段说了算。
  Tunable idle pose for models with no clips: new defaults (arms slightly out and forward, elbows bent, each side drifting on its own period) plus a `pose` block, four sliders in the library, and a skill an agent can follow to tune it from a screenshot. Clips still win over `pose` on the bones they drive.
- 暂不支持 Live2D(授权原因),保留渲染器扩展点。
  Live2D is not supported (licence); a renderer extension point is kept.

⚠️ `minAppVersion` 钉在 **2.11.2**:本插件依赖 `ctx.desk`(Agent Desk 伴随面)、`ctx.tangu.startChat`、`ctx.app.writeBytes`,按 Agent 绑定还要 `ctx.tangu.agents` 与状态接缝里的会话归属 —— 这批宿主接缝随 Forsion 2.11.2 一起发,2.11.1 及更早都还没有。更早的宿主会按 `minAppVersion` 把插件挡下并说明要哪个版本,不会装上去静默不工作。宿主发版时若不是 2.11.2,改这一行并重打 release。
`minAppVersion` is pinned to **2.11.2**: the plugin needs `ctx.desk` (the Agent Desk companion seam), `ctx.tangu.startChat` and `ctx.app.writeBytes`, and per-agent binding additionally needs `ctx.tangu.agents` and the session's agent on the status seam — none of which shipped before host 2.11.2. Older hosts block the plugin and name the version they need instead of installing something that silently does nothing.
