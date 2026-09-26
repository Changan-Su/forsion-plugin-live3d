// 内置场景:用户还没建过自己的场景时,Space 里也有一间能住人的小屋(住客 = Desk 的默认形象)。
// 写成 scene.json 的原文再走一遍 parseScene —— 内置场景和用户场景同一条校验路,改格式时它先红。
import { parseScene, type ResolvedScene } from './scene'

export const BUILTIN_SCENE_ID = 'builtin:cozy'

const COZY = {
  live3d: 1,
  name: { zh: '小屋', en: 'Cozy room' },
  character: null,
  height: 1.3,
  time: 'auto',
  room: { width: 4.2, depth: 4, height: 2.6, floor: '#b58a64', wallLeft: '#ece4d8', wallRight: '#e4dccf', trim: '#f7f3ec', windows: [{ wall: 'right', at: 0.55, width: 1.5, height: 1.3, sill: 0.8 }] },
  props: [
    { type: 'bed', id: 'bed', at: [-1.5, -0.9], color: '#6f8fb8', color2: '#a07a58' },
    { type: 'nightstand', at: [-0.72, -1.78] },
    { type: 'desk', id: 'desk', at: [0.55, -1.38], variant: 'books,cup' },
    { type: 'bookshelf', id: 'shelf', at: [-1.88, 1.1], rot: 90 },
    { type: 'rug', id: 'rug', at: [0.5, 0.3], color: '#c9a27e', color2: '#f3e3c3' },
    { type: 'plant', id: 'plant', at: [1.8, -1.72] },
    { type: 'poster', at: [-1.45, -1.99], y: 1.35, variant: 'planet' },
    { type: 'clock', at: [-2.09, 0.35], rot: 90 },
    { type: 'lights', at: [-2.09, -0.6], rot: 90, y: 2.3 },
  ],
  activities: [
    { id: 'wander', at: 'center', pose: 'stand', time: [6, 12], weight: 2 },
    { id: 'window', at: 'window', pose: 'gaze', time: [10, 20], weight: 2, emote: 'star', label: { zh: '看窗外', en: 'Looking out of the window' } },
    { id: 'read', at: 'desk', pose: 'sit-read', time: [20, 40], weight: 3, label: { zh: '看书', en: 'Reading' } },
    { id: 'browse', at: 'shelf', pose: 'browse', time: [8, 14], weight: 2, label: { zh: '挑一本书', en: 'Picking a book' } },
    { id: 'plant', at: 'plant', pose: 'water', time: [6, 10], weight: 1, label: { zh: '照料植物', en: 'Tending the plant' } },
    { id: 'nap', at: 'bed', pose: 'sleep', time: [30, 60], weight: 2, emote: 'zzz', then: 'wake', label: { zh: '睡午觉', en: 'Napping' } },
    { id: 'wake', at: 'here', pose: 'stretch', time: [3, 3.5], weight: 0, chained: true },
    { id: 'sun', at: 'rug', pose: 'sunbathe', time: [20, 40], weight: 1, when: 'day', label: { zh: '晒太阳', en: 'Sunbathing' } },
    { id: 'wave', at: 'front', pose: 'wave', time: [3, 5], weight: 1, label: { zh: '冲你挥手', en: 'Waving at you' } },
  ],
}

let cached: ResolvedScene | null = null
export function builtinScene(): ResolvedScene {
  if (cached) return cached
  const r = parseScene(JSON.stringify(COZY), BUILTIN_SCENE_ID, 'cozy')
  if (!r.ok) throw new Error(`builtin scene invalid: ${r.en}`)
  cached = r.value
  return cached
}
