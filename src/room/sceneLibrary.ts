// 场景库:扫 `<workFolder>/scenes/<slug>/scene.json`,逐份 parseScene。纪律同模型库(library.ts):
// 坏文件不吞(problems 带双语原因,原样列给用户)、按库根判断要不要重扫(库是惰性恢复的)。
import type { Msg } from '../contract'
import { joinRel, normRel } from '../contract'
import { workFolderOf } from '../library'
import type { HostCtx } from '../ui/host'
import { SCENE_FILE, SCENES_DIR, parseScene, type ResolvedScene } from './scene'

export interface SceneEntry {
  slug: string
  path: string
  scene: ResolvedScene
  warnings: Msg[]
}

export interface SceneProblem {
  slug: string
  path: string
  reason: Msg
}

export interface SceneLibState {
  entries: SceneEntry[]
  problems: SceneProblem[]
  root: string | null | undefined
}

export interface SceneLibrary {
  state(): SceneLibState
  stale(): boolean
  refresh(force?: boolean): Promise<SceneLibState>
  find(slug: string | null | undefined): SceneEntry | null
  onChange(cb: () => void): () => void
}

export const scenesFolder = (ctx: HostCtx): string => joinRel(workFolderOf(ctx), SCENES_DIR)
export const scenePath = (ctx: HostCtx, slug: string): string => joinRel(scenesFolder(ctx), `${slug}/${SCENE_FILE}`)

const currentRoot = (ctx: HostCtx): string | null => (ctx.app.vaultRoot ? ctx.app.vaultRoot() : 'no-vaultroot-api')

export function createSceneLibrary(ctx: HostCtx): SceneLibrary {
  let state: SceneLibState = { entries: [], problems: [], root: undefined }
  let loading: Promise<SceneLibState> | null = null
  let again = false
  const subs = new Set<() => void>()

  async function scan(): Promise<SceneLibState> {
    const root = currentRoot(ctx)
    const prefix = `${scenesFolder(ctx)}/`
    const next: SceneLibState = { entries: [], problems: [], root }
    let files: string[] = []
    try {
      files = ((await ctx.app.listFiles?.()) ?? []).map(normRel)
    } catch {
      files = []
    }
    const slugs = new Set<string>()
    for (const p of files) {
      if (!p.startsWith(prefix)) continue
      const rest = p.slice(prefix.length)
      const i = rest.indexOf('/')
      if (i > 0 && rest.slice(i + 1) === SCENE_FILE) slugs.add(rest.slice(0, i))
    }
    for (const slug of [...slugs].sort()) {
      const path = `${prefix}${slug}/${SCENE_FILE}`
      let text: string | null = null
      try {
        text = (await ctx.app.readFile?.(path)) ?? null
      } catch {
        text = null
      }
      if (text == null) {
        next.problems.push({ slug, path, reason: { zh: '读不出这个文件', en: 'This file could not be read' } })
        continue
      }
      const r = parseScene(text, `${prefix}${slug}`, slug)
      if (!r.ok) next.problems.push({ slug, path, reason: { zh: r.zh, en: r.en } })
      else next.entries.push({ slug, path, scene: r.value, warnings: r.warnings })
    }
    return next
  }

  const emit = (): void => {
    for (const cb of [...subs]) {
      try {
        cb()
      } catch (e) {
        console.error('[live3d] scene library listener failed', e)
      }
    }
  }

  const lib: SceneLibrary = {
    state: () => state,
    stale: () => state.root !== currentRoot(ctx),
    refresh(force = false) {
      if (!force && !lib.stale()) return Promise.resolve(state)
      if (loading) {
        if (force) again = true
        return loading
      }
      loading = (async () => {
        do {
          again = false
          state = await scan()
        } while (again)
        emit()
        return state
      })().finally(() => {
        loading = null
      })
      return loading
    },
    find: (slug) => (slug ? state.entries.find((e) => e.slug === slug) ?? null : null),
    onChange(cb) {
      subs.add(cb)
      return () => subs.delete(cb)
    },
  }
  return lib
}

/** 新建场景时写进去的模板(一间空一点的小屋,注释写在 README 里 —— JSON 不能带注释)。 */
export function sceneTemplate(name: string): string {
  return JSON.stringify(
    {
      live3d: 1,
      kind: 'room',
      name,
      character: null,
      height: 1.3,
      time: 'auto',
      room: { width: 4, depth: 4, height: 2.6, floor: '#b58a64', wallLeft: '#ece4d8', wallRight: '#e4dccf', trim: '#f7f3ec', windows: [{ wall: 'right', at: 0.55, width: 1.4, height: 1.3, sill: 0.8 }] },
      props: [
        { type: 'bed', id: 'bed', at: [-1.4, -0.9] },
        { type: 'desk', id: 'desk', at: [0.5, -1.38], variant: 'books,cup' },
        { type: 'rug', id: 'rug', at: [0.4, 0.4] },
        { type: 'plant', id: 'plant', at: [1.6, -1.6] },
      ],
      activities: [
        { id: 'wander', at: 'center', pose: 'stand', time: [6, 12], weight: 2 },
        { id: 'window', at: 'window', pose: 'gaze', time: [10, 20], weight: 2, emote: 'star' },
        { id: 'read', at: 'desk', pose: 'sit-read', time: [20, 40], weight: 2 },
        { id: 'nap', at: 'bed', pose: 'sleep', time: [30, 60], weight: 2, emote: 'zzz', then: 'wake' },
        { id: 'wake', at: 'here', pose: 'stretch', time: [3, 3.5], weight: 0, chained: true },
      ],
    },
    null,
    2,
  ) + '\n'
}

/** 写进 scenes/ 的 README(打开场景文件夹时落盘,兼作「把目录建出来」)。落盘文件不随界面语言变,双语同一份。 */
export const SCENES_README = `# Live3D scenes / 场景

每个场景一个文件夹 / One folder per scene: \`scenes/<name>/scene.json\`. 保存即生效 / Saving reloads the room.

\`\`\`json
{
  "live3d": 1,
  "name": { "zh": "我的小屋", "en": "My room" },
  "character": "my-model-folder",
  "height": 1.25,
  "time": "auto",
  "room": { "width": 4.2, "depth": 4, "height": 2.6, "floor": "#b58a64", "wallLeft": "#ece4d8", "wallRight": "#e4dccf",
            "windows": [{ "wall": "right", "at": 0.55, "width": 1.5, "height": 1.3, "sill": 0.8 }] },
  "props": [ { "type": "bed", "id": "bed", "at": [-1.4, -0.9] }, { "type": "desk", "id": "desk", "at": [0.5, -1.38] } ],
  "activities": [ { "id": "nap", "at": "bed", "pose": "sleep", "time": [30, 60], "weight": 2, "emote": "zzz" } ],
  "agent": { "thinking": "@think", "tool": "@work" }
}
\`\`\`

- 坐标(米)/ Coordinates in metres: 原点在地板中心 / origin at the floor centre; +X 右 / right, +Z 朝镜头 / towards the camera.
  左墙 / left wall at x = -width/2, 右墙 / right wall at z = -depth/2. \`rot\` 是角度 / is in degrees.
- character: 模型库里的文件夹名 / a folder under models/; 省略 = Desk 默认形象 / omit for the Desk default.
- 道具 / props: bed, desk, chair, piano, telescope, bookshelf, shelf, nightstand, rug, beanbag, plant, lamp, poster, photos,
  scroll, sword, clock, lights, rod, plush, bird, flowers, radio, box.
  挂墙的道具用 y 定高度 / wall props take a y height; variant 选款式 / picks a style (poster: starmap | planet;
  plush: bunny | cat | bear | star; desk: "camera,brush,globe,books,cup"); scroll 用 text 写字 / scroll takes text.
- 活动 / activities: at = 道具 id(或 \`bed.sit\` 这类锚点)/ a prop id or anchor, window, center, front, here;
  pose = stand, gaze, telescope, browse, view, water, stretch, yawn, nod-off, wave, talk, cheer, sigh, crouch, sit, sit-read,
  sit-work, sit-think, sit-doze, desk-sleep, piano, hug, lie, sleep, sunbathe;
  time = 秒数或 [最短, 最长] / seconds or [min, max]; weight = 抽中的权重 / how often; when = day | night;
  emote = zzz, star, note, heart, question, exclaim, sweat, anger, sparkle, dots; then = 做完接哪个 / what comes next;
  label = 一句话或 { "zh", "en" } / a line or a bilingual object.
- agent: Agent 在思考 / 干活 / 说话 / 等你时去做哪个活动 / which activity the agent phases trigger
  (thinking, tool, speaking, waiting, error, done); 内置 / built-ins: @think @work @talk @call @sigh @cheer.
`
