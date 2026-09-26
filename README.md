# Live3D

在 Tangu 聊天右侧的 **Agent Desk** 里放一个 3D 形象,让它跟着 Agent 的状态做反应。

| Agent 在干什么 | 形象的反应(缺省) |
| --- | --- |
| 空闲 | 轻轻呼吸摇摆,眼睛跟着鼠标 |
| 思考 | 抬眼琢磨、歪头 |
| 说话 | 口型随流式输出一张一合,轻轻点头 |
| 调用工具 | 低头干活 |
| 等你回应(审批 / 提问) | 看着你蹦一下 |
| 出错 | 垂头丧气 |
| 完成 | 开心地跳一下 |

模型自带的动画、表情会被自动挑出来对上这些状态(Idle / Talk / Typing / Wave / Cheer……,VRM 的 happy / sad / aa……);没导入模型时是一个会做表情的小球。全部离线渲染(three.js r186 + @pixiv/three-vrm 3.5.5 打进 main.js)。

## 显示模式

- **空闲显示**(缺省):Desk 上**没有任何展示内容**时才出现(新对话草稿、空会话、点了「清空 Desk」之后)。Agent 往 Desk 上展示文件时,形象让位。
- **总是显示**:**完全替换** Agent Desk 的文件展示 —— 卡片和展开的侧板都只显示形象;Agent 的展示、编辑自动上台、聊天里点引用 / 「正在编辑」一律改为在新标签页打开。

在 设置 → 插件 → Live3D 里切换,或命令面板「Live3D:切换显示模式」。

## 3D 小屋(独立 Space)与屏保

左侧功能条多了一个 **「3D 小屋」** Space(插件包里的 `spaces/live3d/space.json`):主区是一间三面剖开的小房间,右侧是聊天。形象住在房间里**自己过日子** —— 按场景里写的日常走来走去、坐下看书、躺上床睡觉、弹琴、用望远镜看星星……;Agent 一开始干活,它就起身去书桌前:思考时托腮、调工具时埋头干活、说话时在椅子上转过来对着你、等你回应时走到跟前招手、完成时欢呼、出错时叹气。

- **场景**是数据:`scenes/<名字>/scene.json` —— 房间尺寸 / 墙色 / 窗户、道具(床、书桌、钢琴、望远镜、书架、照片墙、剑架、鱼竿、小鸟、星辰花……共 24 种,全部程序化建模,不带外部资源)、活动(在哪、什么姿势、多久、权重、昼夜、头顶的 Zzz / 星星 / 音符、做完接什么)、Agent 各阶段做哪个活动。保存即生效;格式速查在 `scenes/README.md`(点「场景文件夹」会自动写出来)。没有自建场景时用内置小屋。
- `character` 写模型库里的文件夹名 = 这间房的住客;不写 = 和 Desk 同一套规矩(当前对话的 Agent 绑了哪个形象,没绑用默认形象)。
- 昼夜:缺省按本地时间(18:30–6:00 是夜);白天阳光、夜里月光从窗洞斜照进来,夜里台灯点亮。小屋右上角可以固定白天 / 夜晚。
- 交互:拖动转视角、滚轮缩放、双击复位;点一下角色 —— 醒着冲你打招呼,睡着的会被吵醒(皱眉、打哈欠)。
- **屏保**:设置 → Live3D → 「3D 小屋与屏保」里打开「空闲时显示屏保」(缺省关)。Forsion 窗口在前台、若干分钟没有键盘鼠标操作 → 铺满窗口显示小屋,镜头缓慢环绕,角落一只大钟;按任意键 / 点一下 / 移动鼠标即返回(叫醒它的那个键不会打进输入框)。手动启动(小屋里的「屏保」按钮或命令面板)会进入系统全屏。
- 小屋与屏保共用一块画布(模型只加载一次);全插件同时最多一个房间舞台。

## 导入模型

支持 **VRM 0.x / 1.0、GLB、glTF(含外部 .bin / 贴图)、FBX、OBJ(+ MTL)、PMX / PMD(MMD,贴图文件夹原样保留;不含物理与 .vmd 动作)**,动作可以额外带 **.vrma**(VRM 动画)。

- **直接导入**:设置页或模型库里的「导入模型…」/「导入文件夹…」,或把文件拖进模型库。插件把文件复制进工作文件夹 `models/<名字>/`,加载一遍做体检(`analysis.json`)、拍一张缩略图(`preview.png`)、按片段名与表情名自动生成 `live3d.json`,并设为 Desk 形象。
- **让 Agent 协助导入**:压缩包、Draco 压缩的 glTF、Blender 工程等不能直接显示的格式。插件照样先复制原文件,然后开一个与随包 Agent **Live3D Importer** 的可见对话;它按技能 `live3d-import` 识别、转换并写好 `live3d.json`,写好的那一刻形象自动载入。
- **任意 Agent 都能导入**:`live3d-import` 是**全局技能**(包根 `skills/`),你平时用的 Agent(包括自己新建的)也看得到。直接在聊天里丢一个文件或压缩包的路径、问「能导入到 Live3D 吗」,它会自己找到库里的 Live3D 工作文件夹、新建模型文件夹并写好配置;这种导入不会自动上 Desk,到模型库点「设为 Desk 形象」即可。
- **不支持 Live2D**:Live2D Cubism SDK 的授权要求「可加载任意用户模型」的应用单独申请发行许可,无法随免费插件分发。源码里保留了渲染器扩展点(`src/loaders.ts` 的 `ModelKindHandler` / `registerModelKind`),授权问题解决后可以接上。

## 文件夹结构

工作文件夹(缺省为笔记库里的 `Live3D/`,可在插件详情页改)下:

```
Live3D/
  README.md
  models/<slug>/
    live3d.json     形象配置(可手改,保存即重载)
    analysis.json   导入时的体检结果
    preview.png     缩略图
    <模型文件、贴图、.bin、动作文件>
  scenes/<slug>/
    scene.json      3D 小屋的场景(可手改,保存即重载)
```

`live3d.json` 的字段:`live3d`(固定为 1)、`name`、`model`、`motions`、`agents`、`transform`(`scale` / `rotateY` / `offsetY` / `upAxis`)、`framing`(`bust` / `full` / `face`)、`states`(按 `idle` / `thinking` / `speaking` / `tool` / `waiting` / `error` / `done` 配 `clip` / `expression` / `weight` / `mouth` / `once`)、`pose`(`armSpread` / `armForward` / `elbow` / `liveliness`)。完整说明见 `skills/live3d-import/SKILL.md`。写坏了,模型库会原样列出错误原因。

**按 Agent 绑定形象**:在模型库里勾选要绑的 Agent(写进这份模型的 `agents`),跟它们对话时 Desk 就显示这个形象;没绑定的对话显示设置页里的「Desk 默认形象」。一个 Agent 被两个形象绑住时,按模型文件夹名的字母序取第一个。

**待机姿势**:模型没有自带动作片段时(MMD、多数 VRoid 导出),手臂 / 躯干由插件自己摆。模型库详情页的四个滑块(手臂外张 / 手臂前摆 / 手肘弯曲 / 待机幅度)拖完即存;也可以直接跟 Agent 说「手陷进裙子里了」让它改。**有片段在驱动手臂的阶段,`pose` 不生效** —— 那一层由片段说了算。

## 命令

| 命令 | 作用 |
| --- | --- |
| Live3D:打开模型库 | 预览(可拖着转、滚轮缩放)、试七种状态、切换 Desk 形象、拖放导入 |
| Live3D:导入 3D 模型… | 直接导入 |
| Live3D:让 Agent 协助导入… | 交给 Live3D Importer |
| Live3D:切换显示模式 | 空闲显示 ↔ 总是显示 |
| Live3D:打开 3D 小屋 | 打开小屋视图(也可以点左侧功能条的「3D 小屋」Space) |
| Live3D:启动屏保 | 立刻进入全屏屏保 |
| Live3D:刷新模型库 | 重新扫描工作文件夹 |

## 宿主要求与已知限制

- **需要 Forsion 2.11.2 及以上的桌面 Tangu**(`manifest.minAppVersion`):伴随面要 `ctx.desk`,导入二进制文件要 `ctx.app.writeBytes`,开协助导入的对话要 `ctx.tangu.startChat`,按 Agent 绑定还要 `ctx.tangu.agents` 与状态接缝里的会话归属 —— 这批接缝随 2.11.2 一起发,2.11.1 及更早都还没有。更早的宿主会按 `minAppVersion` 直接挡下整个插件并说明要哪个版本,不会装上去静默不工作。
- 形象存放在笔记库里:没打开过笔记库时(宿主的库是惰性恢复的)Desk 先显示小球,打开库后自动换上。
- Mixamo 动作不能套到 VRM 上(不做骨骼重定向);VRM 请用 .vrma 动作。
- 只在桌面端运行(web / 移动端的 CSP 不允许 `new Function` 与 WebGL 资源协议)。

## 开发

```sh
npm install
npm run build        # src → main.js(提交 main.js;装包不构建)
node check.mjs       # 自检:产物形态、裸 ctx 装载 + 负对照、双语、Agent 捆绑、纯模块单测
LIVE3D_SAMPLES=… node scripts/render-smoke.mjs   # 真 Chromium 渲染冒烟(需要 Forsion-Genesis/desktop 的 playwright-core)
node scripts/render-smoke.mjs --only rig         # 只跑合成模型段:骨骼姿势 / 口型收回 / 帧间隔 / 小球配色 / FBX blob / 联网引用 / Draco
LIVE3D_SRC_ROOT=<旧源码目录> node scripts/render-smoke.mjs --only rig   # 负对照:同一台架测旧 src,合成模型段的断言必须红
LIVE3D_SAMPLES=… npm run smoke:shell            # 真 Chromium 插件壳冒烟:Desk 挂载与画布搬家、藏起来的卡片不抢画布、真文件选择器导入(listFiles 带宿主同款 1.5s 缓存)、Agent 协助导入、切语言、dispose
LIVE3D_MAIN=<旧 main.js> npm run smoke:shell     # 负对照:新加的壳断言必须红
LIVE3D_SAMPLES=… npm run live:agent             # 真模型 live 台架:真引擎装载捆绑包(全局技能 + live3d-importer),七个夹具 —— 导入 RobotExpressive、拒收 Live2D、解 MMD 压缩包、用户自建 Agent 从下载目录导入、自己截图看形象、把形象绑给某个 Agent、被说「站得像木头人」去调 pose(改 skills/ / agents/ 或提示词后跑;烧订阅额度,--model 可换)
LIVE3D_SRC_ROOT=<旧源码目录> node scripts/unit.mjs   # 负对照:旧源码拷进本仓一个目录(如 .negctl/,否则解析不到 three),新加的用例必须在那边红
LIVE3D_SCRATCH=… node scripts/room-smoke.mjs --vault <笔记库> --scene Live3D/scenes/<名字>/scene.json --shots night:nap,day:sunbathe,night:phase=thinking --view 90,18,3
                                                 # 房间台架:逐个强制活动,等角色走到位再截全景 + 特写(+ --view 指定方位的正面图)
node scripts/room-shell-smoke.mjs --vault <笔记库> --scene <名字>   # 整包冒烟:main.js 挂小屋视图 → Agent 思考 / 干活 / 说话 → 切白天 → 屏保进出(库只读)
npm run icon                                     # 重新生成 icon.png
sh install.sh        # 装到 ~/.forsion-dev(prod:sh install.sh prod)
```

---

## English

**Live3D** puts a 3D avatar on the **Agent Desk** to the right of the Tangu chat and makes it react to the agent: idle breathing and eyes that follow the pointer, looking up while thinking, lip sync that follows the streamed answer, looking down while a tool runs, a hop when it needs you, a droop on errors and a small celebration when a run finishes. Clips and expressions that come with the model (Idle / Talk / Typing / Wave / Cheer…, VRM happy / sad / aa…) are matched to these states automatically. Until you import a model, a friendly orb reacts instead. Everything renders offline.

**Display modes.** *When idle* (default): shown only while the Desk has nothing on it (a draft chat, an empty session, or after "Clear Desk"); it steps aside when the agent presents a file. *Always*: completely replaces the Agent Desk file presentation — the card and the expanded panel show only the avatar, and files the agent presents, edit auto-show and chat citations open in a new tab instead.

**3D room and screensaver.** A new **"3D room"** Space in the left bar (bundled as `spaces/live3d/space.json`): the main area is a cut-away little room, the chat sits on the right. The avatar lives there and goes about its day — wandering, reading, napping in bed, playing the piano, stargazing through a telescope — and heads to the desk when the agent works: chin in hand while thinking, busy while a tool runs, swivelling round to face you while it speaks, walking up to wave when it needs you, cheering when done, sighing on errors. Scenes are data (`scenes/<name>/scene.json`: room size, wall colours, windows, 24 procedural prop types, activities with where / pose / duration / weight / day or night / emote / what comes next, and which activity each agent phase triggers); saving reloads the room, and a quick reference is written to `scenes/README.md`. `character` names the resident model folder; without it the room follows the Desk rules. Day and night follow the local clock (sunlight or moonlight through the window, desk lamps at night) or can be pinned. Drag to turn, scroll to zoom, double-click to reset, click the character to poke it (a sleeping one wakes up grumpy). **Screensaver**: turn on "Show the screensaver when idle" in the settings (off by default); after a few minutes without keyboard or mouse input while Forsion is in front, the room fills the window with a slowly orbiting camera and a clock. Any key, click or mouse movement brings you back, and the key that woke it never reaches the page. Starting it by hand (the room's button or the command palette) goes full screen.

**Import.** VRM 0.x / 1.0, GLB, glTF (with external .bin and textures), FBX, OBJ (+ MTL) and PMX / PMD (MMD; texture folders kept as they are, no physics or .vmd motions), plus .vrma motions.
- *Direct import* ("Import model…", "Import folder…", or drop files onto the library): the plugin copies the files into `models/<slug>/` in its work folder, analyzes the model (`analysis.json`), renders a thumbnail (`preview.png`), writes a `live3d.json` from the clip and expression names, and puts it on the Desk.
- *Agent-assisted import* for archives, Draco-compressed glTF, Blender projects and the like: the plugin copies the raw files, then opens a visible chat with the bundled **Live3D Importer** agent, which follows the `live3d-import` skill to identify and convert the model and write `live3d.json`. The avatar loads the moment the file appears.
- *Any agent can import*: `live3d-import` is a **global skill** (bundle-root `skills/`), so your everyday agents, including ones you created, see it too. Paste the path to a file or archive and ask whether it can go into Live3D; the agent finds the Live3D work folder in your vault, creates a model folder and writes the profile. Such an import does not switch the Desk by itself: pick the model in the library and press "Use on the Desk".
- *Live2D is not supported*: the Live2D Cubism licence requires a separate publication licence for apps that load arbitrary user models. A renderer extension point is kept in the source (`ModelKindHandler` / `registerModelKind` in `src/loaders.ts`).

**Profile.** `live3d.json` fields: `live3d` (always 1), `name`, `model`, `motions`, `agents`, `transform` (`scale`, `rotateY`, `offsetY`, `upAxis`), `framing` (`bust` / `full` / `face`), `states` keyed by `idle`, `thinking`, `speaking`, `tool`, `waiting`, `error`, `done` with `clip`, `expression`, `weight`, `mouth` and `once`, and `pose` (`armSpread`, `armForward`, `elbow`, `liveliness`). The full reference is in `skills/live3d-import/SKILL.md`. A broken file is listed in the library with the exact reason.

**Per-agent companions.** Tick the agents a model belongs to in the library (this writes `agents` in that model's own profile): chats with those agents show it, every other chat shows the default companion from the settings. If two models claim the same agent, the one whose folder name sorts first wins.

**Idle pose.** When a model brings no animation clips (MMD, most VRoid exports), the plugin poses the arms and torso itself. Four sliders in the library (arms out / arms forward / elbow bend / liveliness) save as you release them, or just tell an agent "its hands are stuck in the skirt". Where a clip drives a bone, the clip wins and `pose` does nothing.

**Requirements and limits.** Needs desktop Forsion 2.11.2 or newer (`manifest.minAppVersion`): the companion needs `ctx.desk`, binary import needs `ctx.app.writeBytes`, the assisted-import chat needs `ctx.tangu.startChat`, and per-agent binding also needs `ctx.tangu.agents` plus the session's agent on the status seam — none of that shipped before host 2.11.2. Older hosts block the whole plugin and name the version they need, rather than installing something that silently does nothing. Models live in the vault, so until the vault has been opened this session the Desk shows the orb. Mixamo motions cannot be retargeted onto VRM avatars (use .vrma). Desktop only.
