/**
 * 纯模块单测:`node scripts/unit.mjs`。esbuild 把 contract / heuristics / profile / reactions / analysis(+ loaders
 * 里的几个纯函数)打成一个临时 ESM 文件再 import,node:assert 断言。analysis / loaders 会带进 three 与 three-vrm
 * (node 下能正常 import;只调用其中的纯函数)。P2 会把这些用例并进 check.mjs。
 *
 * 用例里的片段 / morph / 骨骼名都取自真实样例(three.js r170 RobotExpressive / Xbot / Soldier / Samba Dancing、
 * pixiv three-vrm-girl(VRM0)/ VRM1_Constraint_Twist_Sample),来源见 scripts/render-smoke.mjs 的 SOURCES。
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { strict as A } from 'node:assert'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
/** 被测源码的根(缺省本仓)。负对照:把旧源码拷到**本仓内**一个目录(依赖才解析得到 three),
 *  `LIVE3D_SRC_ROOT=<那个目录> node scripts/unit.mjs` —— 新加的用例必须在那边红。同 render-smoke 的口径。 */
const srcRoot = process.env.LIVE3D_SRC_ROOT || root
const tmp = mkdtempSync(join(tmpdir(), 'live3d-unit-'))
const out = join(tmp, 'pure.mjs')
await build({
  stdin: {
    contents: ['contract', 'heuristics', 'profile', 'reactions', 'analysis'].map((m) => `export * from './src/${m}.ts'`)
      .concat([
        "export { resolveModelRef, routeModelRef, embeddedGltfToGlb, gltfRequiredExtensions, gltfBlockingExtensions, LoadError, toMsg } from './src/loaders.ts'",
        "export { frameDelta } from './src/stage.ts'",
        "export * from './src/room/scene.ts'",
        "export * from './src/room/nav.ts'",
        "export * from './src/room/brain.ts'",
        "export { POSE_TABLE, createAnimator } from './src/room/poses.ts'",
        "export { builtinScene } from './src/room/presets.ts'",
      ]).join('\n'),
    resolveDir: srcRoot,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: out,
  logLevel: 'warning',
})
const M = await import(pathToFileURL(out).href)
rmSync(tmp, { recursive: true, force: true })

const fail = []
let total = 0
const t = (name, fn) => {
  total++
  try {
    fn()
    console.log(`PASS  ${name}`)
  } catch (e) {
    fail.push(name)
    console.log(`FAIL  ${name}\n      ${String(e.message).split('\n').slice(0, 4).join('\n      ')}`)
  }
}
const HAN = /[\u3400-\u9fff\u3040-\u30ff]/

// ── contract ─────────────────────────────────────────────────────────────────
t('contract: 路径工具', () => {
  A.equal(M.normRel('\\a\\.\\b//c/'), 'a/b/c')
  A.equal(M.joinRel('Live3D/models/x', 'tex/a.png'), 'Live3D/models/x/tex/a.png')
  A.equal(M.joinRel('a/b', '../c'), 'a/c')
  A.equal(M.dirOf('a/b/c.vrm'), 'a/b')
  A.equal(M.dirOf('c.vrm'), '')
  A.equal(M.baseName('a\\b\\Samba Dancing.fbx'), 'Samba Dancing.fbx')
  A.equal(M.extOf('Hiyori.model3.json'), 'json')
  A.equal(M.stripExt('x/Samba Dancing.fbx'), 'Samba Dancing')
  A.equal(M.modelFolder('Live3D', 'alice'), 'Live3D/models/alice')
})
t('contract: isSafeRel 拒绝绝对路径 / 盘符 / URL / 越界', () => {
  for (const bad of ['/abs/a.vrm', 'C:\\x\\a.vrm', 'c:/a.vrm', 'http://x/a.glb', 'amadeus-asset://v/a.glb', '../a.vrm', 'a/../../b.vrm', '~/a.vrm', '', '  ']) {
    A.equal(M.isSafeRel(bad), false, bad)
  }
  for (const ok of ['a.vrm', 'motions/wave.vrma', 'sub dir/x.fbx', './a.glb']) A.equal(M.isSafeRel(ok), true, ok)
})
t('contract: detectFormat / Live2D 识别', () => {
  A.equal(M.detectFormat('a/b.VRM'), 'vrm')
  A.equal(M.detectFormat('x.gltf'), 'gltf')
  A.equal(M.detectFormat('Hiyori.model3.json'), 'live2d')
  A.equal(M.detectFormat('hiyori.moc3'), 'live2d')
  A.equal(M.detectFormat('a.pmx'), 'pmx')
  A.equal(M.detectFormat('a.PMD'), 'pmd')
  A.equal(M.detectFormat('a.blend'), null)
  A.equal(M.detectFormat('a.json'), null)
})
t('contract: slugify', () => {
  A.equal(M.slugify('Samba Dancing.fbx'), 'samba-dancing')
  A.equal(M.slugify('VRM1_Constraint_Twist_Sample.vrm'), 'vrm1-constraint-twist-sample')
  A.equal(M.slugify('初音ミク.vrm'), 'model')
  A.equal(M.slugify('Café Girl.glb'), 'cafe-girl')
})
t('contract: Live2D 拒绝文案双语且 en 无汉字', () => {
  A.ok(M.LIVE2D_REFUSAL.zh.includes('Live2D'))
  A.ok(!HAN.test(M.LIVE2D_REFUSAL.en))
  A.match(M.LIVE2D_REFUSAL.en, /licen[cs]e/i)
})

// ── heuristics ───────────────────────────────────────────────────────────────
t('heuristics: 片段名清洗(Armature| 前缀、mixamo.com、Take 001、VRMA 空名)', () => {
  A.equal(M.cleanClipName('Armature|Idle'), 'Idle')
  A.equal(M.cleanClipName('CharacterArmature|Walk'), 'Walk')
  A.equal(M.cleanClipName('Armature|mixamo.com|Layer0'), null)
  A.equal(M.cleanClipName('mixamo.com'), null)
  A.equal(M.cleanClipName('Take 001'), null)
  A.equal(M.clipDisplayName('mixamo.com', 'Live3D/models/x/Samba Dancing.fbx'), 'Samba Dancing')
  A.equal(M.clipDisplayName('Take 001', 'motions/Wave Hello.fbx'), 'Wave Hello')
  A.equal(M.clipDisplayName('', 'test.vrma'), 'test')
  A.equal(M.clipDisplayName(undefined, 'test.vrma'), 'test')
  A.equal(M.clipDisplayName('Dance', 'x.glb'), 'Dance')
})
const ROBOT = ['Dance', 'Death', 'Idle', 'Jump', 'No', 'Punch', 'Running', 'Sitting', 'Standing', 'ThumbsUp', 'Walking', 'WalkJump', 'Wave', 'Yes']
const XBOT = ['agree', 'headShake', 'idle', 'run', 'sad_pose', 'sneak_pose', 'walk']
const SOLDIER = ['Idle', 'Run', 'TPose', 'Walk']
t('heuristics: RobotExpressive 片段 → 阶段', () => {
  A.equal(M.pickClip('idle', ROBOT), 'Idle')
  A.equal(M.pickClip('waiting', ROBOT), 'Wave')
  A.equal(M.pickClip('error', ROBOT), 'No')
  A.equal(M.pickClip('done', ROBOT), 'ThumbsUp')
  A.equal(M.pickClip('thinking', ROBOT), undefined)
  A.equal(M.pickClip('tool', ROBOT), undefined)
})
t('heuristics: Xbot / Soldier / Samba 片段 → 阶段(TPose 永不入选)', () => {
  A.equal(M.pickClip('idle', XBOT), 'idle')
  A.equal(M.pickClip('error', XBOT), 'sad_pose')
  A.equal(M.pickClip('done', XBOT), 'agree')
  A.equal(M.pickClip('idle', SOLDIER), 'Idle')
  A.equal(M.pickClip('idle', ['TPose']), undefined)
  A.equal(M.pickClip('done', ['Samba Dancing']), 'Samba Dancing')
  A.equal(M.pickClip('tool', ['Typing', 'Idle']), 'Typing')
  A.equal(M.pickClip('thinking', ['Thinking', 'Idle']), 'Thinking')
  A.equal(M.pickClip('speaking', ['Talking']), 'Talking')
  A.equal(M.onceByDefault('waiting', 'Wave'), true)
  A.equal(M.onceByDefault('error', 'sad_pose'), false)
  A.equal(M.onceByDefault('error', 'No'), true)
  A.equal(M.onceByDefault('idle', 'Idle'), false)
})
const VRM1_EXPR = ['aa', 'angry', 'blink', 'blinkLeft', 'blinkRight', 'ee', 'happy', 'ih', 'lookDown', 'lookLeft', 'lookRight', 'lookUp', 'neutral', 'oh', 'ou', 'relaxed', 'sad', 'surprised']
// three-vrm 把 VRM0 预设映射成 VRM1 名;VRM0 没有 surprised 预设,样例里是自定义组 "Surprised"。
const VRM0_EXPR = ['neutral', 'aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight', 'angry', 'relaxed', 'happy', 'sad', 'Surprised', 'Extra', 'lookUp', 'lookDown', 'lookLeft', 'lookRight']
t('heuristics: pickExpression(预设 / 大小写 / 同义词 / 整词)', () => {
  A.equal(M.pickExpression(['surprised', 'happy'], VRM1_EXPR), 'surprised')
  A.equal(M.pickExpression(['surprised', 'happy'], VRM0_EXPR), 'Surprised')
  A.equal(M.pickExpression(['surprised', 'happy'], ['neutral', 'happy']), 'happy')
  A.equal(M.pickExpression(['sad'], ['Angry', 'Surprised', 'Sad']), 'Sad')
  A.equal(M.pickExpression(['happy'], ['Angry', 'Surprised', 'Sad']), undefined)
  A.equal(M.pickExpression(['happy'], ['Fcl_ALL_Joy', 'Fcl_MTH_A']), 'Fcl_ALL_Joy')
  A.equal(M.pickExpression(['sad'], ['Face.Sorrow']), 'Face.Sorrow')
  A.equal(M.pickExpression(['happy'], []), undefined)
})
t('heuristics: morph 同义词(ARKit / VRChat / MMD / VRoid / 通用)', () => {
  A.deepEqual(M.findMorphs('blink', ['jawOpen', 'eyeBlinkLeft', 'eyeBlinkRight']), ['eyeBlinkLeft', 'eyeBlinkRight'])
  A.deepEqual(M.findMorphs('mouth', ['jawOpen', 'eyeBlinkLeft']), ['jawOpen'])
  A.deepEqual(M.findMorphs('mouth', ['vrc.v_aa', 'vrc.blink']), ['vrc.v_aa'])
  A.deepEqual(M.findMorphs('blink', ['vrc.v_aa', 'vrc.blink']), ['vrc.blink'])
  A.deepEqual(M.findMorphs('mouth', ['あ', 'まばたき', '笑い']), ['あ'])
  A.deepEqual(M.findMorphs('blink', ['あ', 'まばたき', '笑い']), ['まばたき'])
  A.deepEqual(M.findMorphs('smile', ['あ', 'まばたき', '笑い']), ['笑い'])
  A.deepEqual(M.findMorphs('mouth', ['Fcl_MTH_A', 'Fcl_EYE_Close']), ['Fcl_MTH_A'])
  A.deepEqual(M.findMorphs('mouth', ['Mouth_Open']), ['Mouth_Open'])
  A.deepEqual(M.findMorphs('mouth', ['Angry', 'Surprised', 'Sad']), [])
})
t('heuristics: 骨骼部位(sanitize 后的 Mixamo / Blender .L / VRoid / MMD)', () => {
  const mix = M.findRigBones(['mixamorigHips', 'mixamorigSpine', 'mixamorigSpine1', 'mixamorigSpine2', 'mixamorigNeck', 'mixamorigHead', 'mixamorigHeadTop_End', 'mixamorigLeftArm', 'mixamorigLeftForeArm', 'mixamorigRightArm', 'mixamorigLeftHand'])
  A.equal(mix.head, 'mixamorigHead')
  A.equal(mix.neck, 'mixamorigNeck')
  A.equal(mix.spine, 'mixamorigSpine')
  A.equal(mix.chest, 'mixamorigSpine1')
  A.equal(mix.leftUpperArm, 'mixamorigLeftArm')
  A.equal(mix.leftLowerArm, 'mixamorigLeftForeArm')
  A.equal(mix.leftHand, 'mixamorigLeftHand')
  const robot = M.findRigBones(['Bone', 'FootL', 'Body', 'Hips', 'Abdomen', 'Torso', 'Neck', 'Head', 'ShoulderL', 'UpperArmL', 'LowerArmL', 'UpperArmR', 'LowerArmR', 'HandL'])
  A.equal(robot.head, 'Head')
  A.equal(robot.leftUpperArm, 'UpperArmL')
  A.equal(robot.rightLowerArm, 'LowerArmR')
  A.equal(M.findRigBones(['J_Bip_C_Head', 'J_Bip_L_UpperArm']).leftUpperArm, 'J_Bip_L_UpperArm')
  A.equal(M.findRigBones(['センター', '上半身', '首', '頭', '左腕']).head, '頭')
  // Blender mmd_tools 导出:腕.L → GLTFLoader sanitize 成 腕L;捩(twist)骨不能冒充上臂
  const mmdTools = M.findRigBones(['センター', '頭', '腕捩.L', '腕L', '腕R', 'ひじL', 'ひじR', '手首L', '手首.R', '_dummy_腕捩1.L'])
  A.deepEqual([mmdTools.leftUpperArm, mmdTools.rightUpperArm, mmdTools.leftLowerArm, mmdTools.rightLowerArm, mmdTools.leftHand, mmdTools.rightHand], ['腕L', '腕R', 'ひじL', 'ひじR', '手首L', '手首.R'])
  A.equal(M.findRigBones(['HeadTop_End']).head, undefined)
})
t('heuristics: guessRig / guessUpAxis', () => {
  A.equal(M.guessRig(['mixamorigHips']), 'mixamo')
  A.equal(M.guessRig(['J_Bip_C_Hips']), 'vroid')
  A.equal(M.guessRig(['センター', '頭']), 'mmd')
  A.equal(M.guessRig(['Hips'], true), 'vrm')
  A.equal(M.guessRig(['Bone']), 'unknown')
  A.equal(M.guessUpAxis([0.5, 0.3, 1.8]), 'z')
  A.equal(M.guessUpAxis([0.5, 1.8, 0.3]), 'y')
  A.equal(M.guessUpAxis([2, 0.2, 2]), 'y')
})
t('heuristics: suggestStates(RobotExpressive / VRM1 / VRM0)', () => {
  const clips = ROBOT.map((name) => ({ name, duration: 1, source: 'r.glb' }))
  const s = M.suggestStates({ clips, morphs: ['Angry', 'Surprised', 'Sad'] })
  A.deepEqual(s.idle, { clip: 'Idle' })
  A.deepEqual(s.waiting, { clip: 'Wave', once: true, expression: 'Surprised', weight: 0.5 })
  A.deepEqual(s.error, { clip: 'No', once: true, expression: 'Sad', weight: 0.7 })
  A.deepEqual(s.done, { clip: 'ThumbsUp', once: true })
  A.equal(s.thinking, undefined)
  const v1 = M.suggestStates({ clips: [], morphs: [], vrm: { specVersion: '1', expressions: VRM1_EXPR, humanBones: [] } })
  A.deepEqual(v1.speaking, { mouth: 'aa' })
  A.deepEqual(v1.done, { expression: 'happy', weight: 0.8 })
  A.deepEqual(v1.idle, { expression: 'relaxed', weight: 0.3 })
  const v0 = M.suggestStates({ clips: [], morphs: [], vrm: { specVersion: '0', expressions: VRM0_EXPR, humanBones: [] } })
  A.deepEqual(v0.waiting, { expression: 'Surprised', weight: 0.5 })
})

// ── profile ──────────────────────────────────────────────────────────────────
const P = (o) => JSON.stringify(o)
t('profile: 最小 profile 补齐缺省 + 解析出库内路径', () => {
  const r = M.parseProfile(P({ live3d: 1, model: 'alice.vrm' }), 'Live3D/models/alice/')
  A.equal(r.ok, true)
  A.deepEqual(r.warnings, [])
  const v = r.value
  A.equal(v.name, 'alice')
  A.equal(v.dir, 'Live3D/models/alice')
  A.equal(v.modelPath, 'Live3D/models/alice/alice.vrm')
  A.deepEqual(v.motions, [])
  A.deepEqual(v.transform, { scale: 1, rotateY: 0, offsetY: 0 })
  A.equal(v.framing, 'bust')
  A.deepEqual(v.states, {})
})
t('profile: 完整 profile(motions / transform / states)', () => {
  const r = M.parseProfile(P({
    live3d: 1, name: ' Alice ', model: './alice.vrm', motions: ['motions\\wave.vrma', 'Samba Dancing.fbx'],
    transform: { scale: 1.2, rotateY: 180, offsetY: -0.1, upAxis: 'z' }, framing: 'full',
    states: { idle: { clip: 'Idle' }, waiting: { clip: 'wave', once: true, expression: 'surprised', weight: 0.6 }, tool: { clip: null }, error: null },
  }), 'M/a')
  A.equal(r.ok, true, JSON.stringify(r))
  const v = r.value
  A.equal(v.name, 'Alice')
  A.equal(v.model, 'alice.vrm')
  A.deepEqual(v.motionPaths, ['M/a/motions/wave.vrma', 'M/a/Samba Dancing.fbx'])
  A.deepEqual(v.transform, { scale: 1.2, rotateY: 180, offsetY: -0.1, upAxis: 'z' })
  A.equal(v.states.tool.clip, null)
  A.equal(v.states.error, undefined)
  A.deepEqual(v.states.waiting, { clip: 'wave', once: true, expression: 'surprised', weight: 0.6 })
})
t('profile: 不认识的字段只警告(双语)', () => {
  const r = M.parseProfile(P({ live3d: 1, model: 'a.glb', future: 1, transform: { tilt: 2 }, states: { idle: { speed: 2 } } }), 'd')
  A.equal(r.ok, true)
  A.equal(r.warnings.length, 3)
  for (const w of r.warnings) {
    A.ok(w.zh && w.en, 'warning must be bilingual')
    A.ok(!HAN.test(w.en), w.en)
  }
})
const BAD = [
  ['bad JSON', '{"live3d":1,', /JSON/],
  ['top-level array', '[]', /object/],
  ['wrong version', P({ live3d: 2, model: 'a.vrm' }), /version/],
  ['missing model', P({ live3d: 1 }), /model/],
  ['absolute model', P({ live3d: 1, model: '/Users/x/a.vrm' }), /relative/],
  ['windows drive model', P({ live3d: 1, model: 'C:\\x\\a.vrm' }), /relative/],
  ['url model', P({ live3d: 1, model: 'https://x.com/a.glb' }), /relative/],
  ['.. traversal', P({ live3d: 1, model: '../other/a.vrm' }), /relative/],
  ['bad extension', P({ live3d: 1, model: 'a.blend' }), /unsupported/],
  ['live2d model', P({ live3d: 1, model: 'hiyori.model3.json' }), /Live2D/],
  ['unknown phase', P({ live3d: 1, model: 'a.vrm', states: { sleeping: {} } }), /not a phase/],
  ['weight > 1', P({ live3d: 1, model: 'a.vrm', states: { done: { weight: 1.5 } } }), /between 0 and 1/],
  ['weight < 0', P({ live3d: 1, model: 'a.vrm', states: { done: { weight: -0.1 } } }), /between 0 and 1/],
  ['motions not array', P({ live3d: 1, model: 'a.vrm', motions: 'wave.vrma' }), /array/],
  ['motion not string', P({ live3d: 1, model: 'a.vrm', motions: [3] }), /non-empty file path/],
  ['motion bad ext', P({ live3d: 1, model: 'a.vrm', motions: ['clip.mp4'] }), /unsupported/],
  ['motion traversal', P({ live3d: 1, model: 'a.vrm', motions: ['../x.vrma'] }), /relative/],
  ['scale <= 0', P({ live3d: 1, model: 'a.vrm', transform: { scale: 0 } }), /scale/],
  ['bad framing', P({ live3d: 1, model: 'a.vrm', framing: 'wide' }), /framing/],
  ['once not bool', P({ live3d: 1, model: 'a.vrm', states: { done: { once: 'yes' } } }), /true or false/],
  ['clip not string', P({ live3d: 1, model: 'a.vrm', states: { done: { clip: 3 } } }), /clip/],
  ['agents not array', P({ live3d: 1, model: 'a.vrm', agents: 'xyra' }), /array of agent slugs/],
  ['agent slug with space', P({ live3d: 1, model: 'a.vrm', agents: ['Bad Slug'] }), /agent slug/],
  ['agent slug uppercase', P({ live3d: 1, model: 'a.vrm', agents: ['Xyra'] }), /agent slug/],
  ['agent slug leading hyphen', P({ live3d: 1, model: 'a.vrm', agents: ['-x'] }), /agent slug/],
  ['agent slug traversal', P({ live3d: 1, model: 'a.vrm', agents: ['../x'] }), /agent slug/],
  ['pose not object', P({ live3d: 1, model: 'a.vrm', pose: 0.5 }), /pose. must be an object/],
  ['pose out of range', P({ live3d: 1, model: 'a.vrm', pose: { armSpread: 1.5 } }), /pose.armSpread. must be a number between 0 and 1/],
  ['pose negative', P({ live3d: 1, model: 'a.vrm', pose: { elbow: -0.1 } }), /pose.elbow/],
  ['liveliness out of range', P({ live3d: 1, model: 'a.vrm', pose: { liveliness: 2.5 } }), /between 0 and 2/],
  ['pose not finite', P({ live3d: 1, model: 'a.vrm', pose: { elbow: null } }), /pose.elbow/],
]
for (const [name, text, re] of BAD) {
  t(`profile: 拒绝 ${name}(双语、en 无汉字)`, () => {
    const r = M.parseProfile(text, 'd')
    A.equal(r.ok, false)
    A.ok(r.zh && HAN.test(r.zh), `zh should be Chinese: ${r.zh}`)
    A.ok(!HAN.test(r.en), `en has Han chars: ${r.en}`)
    A.match(r.en, re)
  })
}
t('profile: serialize → parse 往返一致(不写 dir / modelPath)', () => {
  const a = M.parseProfile(P({ live3d: 1, model: 'x.fbx', motions: ['m.fbx'], states: { done: { clip: 'm', once: true } }, transform: { rotateY: 90 } }), 'W/models/x').value
  const text = M.serializeProfile(a)
  A.ok(text.endsWith('\n'))
  A.ok(!/modelPath|motionPaths|"dir"/.test(text))
  const b = M.parseProfile(text, 'W/models/x').value
  A.deepEqual(b, a)
})
t('profile: agents / pose 的缺省与规范化', () => {
  const bare = M.parseProfile(P({ live3d: 1, model: 'a.vrm' }), 'd').value
  A.deepEqual(bare.agents, [])
  A.deepEqual(bare.pose, M.DEFAULT_POSE)
  const set = M.parseProfile(P({ live3d: 1, model: 'a.vrm', agents: ['xyra', 'xyra', 'code-reviewer'], pose: { armSpread: 0.5, liveliness: 0 } }), 'd')
  A.equal(set.ok, true, JSON.stringify(set))
  A.deepEqual(set.value.agents, ['xyra', 'code-reviewer'], '重复的 slug 要去重,顺序保持写入顺序')
  A.equal(set.value.pose.armSpread, 0.5)
  A.equal(set.value.pose.liveliness, 0, 'liveliness 0 是合法的「完全不动」,不能被当成缺失')
  A.equal(set.value.pose.elbow, M.DEFAULT_POSE.elbow, '没写的那几项补缺省')
  // null 与缺席同义(agent 清空绑定时最自然的写法)
  const nulled = M.parseProfile(P({ live3d: 1, model: 'a.vrm', agents: null, pose: null }), 'd')
  A.equal(nulled.ok, true)
  A.deepEqual(nulled.value.agents, [])
  A.deepEqual(nulled.value.pose, M.DEFAULT_POSE)
  // pose 里不认识的字段只警告
  const w = M.parseProfile(P({ live3d: 1, model: 'a.vrm', pose: { legSpread: 1 } }), 'd')
  A.equal(w.ok, true)
  A.equal(w.warnings.length, 1)
  A.ok(!HAN.test(w.warnings[0].en), w.warnings[0].en)
})
t('profile: serialize 恒写出 agents 与 pose(Desk 靠它判「配置变没变」)', () => {
  const p = M.parseProfile(P({ live3d: 1, model: 'a.vrm' }), 'd').value
  const text = M.serializeProfile(p)
  A.match(text, /"agents": \[\]/)
  A.match(text, /"pose"/)
  A.match(text, /"armSpread"/)
  // 改一个姿势数就必须让序列化结果变(否则 companion 的 appliedKey 不变 = 改了不重画)
  const moved = M.serializeProfile({ ...p, pose: { ...p.pose, elbow: 0.9 } })
  A.notEqual(moved, text)
  A.deepEqual(M.parseProfile(moved, 'd').value.pose.elbow, 0.9)
})
t('profile: withAgents 去重 / 排序 / 丢掉非法 slug', () => {
  const p = M.parseProfile(P({ live3d: 1, model: 'a.vrm' }), 'd').value
  A.deepEqual(M.withAgents(p, ['zed', 'abe', 'zed', 'Bad Slug', '']).agents, ['abe', 'zed'])
  A.deepEqual(M.withAgents(p, []).agents, [])
})
t('contract: claimFor 按形象 slug 字典序裁决,duplicateClaims 报落选的', () => {
  const list = [
    { slug: 'zeta', agents: ['xyra'] },
    { slug: 'alpha', agents: ['xyra', 'muse'] },
    { slug: 'beta', agents: [] },
  ]
  A.equal(M.claimFor(list, 'xyra').slug, 'alpha', '两家都认领 xyra → 取 slug 小的')
  A.equal(M.claimFor(list, 'muse').slug, 'alpha')
  A.equal(M.claimFor(list, 'nobody'), null)
  A.equal(M.claimFor(list, null), null, '不知道是哪个 Agent → 退回默认形象')
  A.equal(M.claimFor(list, ''), null)
  A.equal(M.claimFor([], 'xyra'), null)
  const dup = M.duplicateClaims(list)
  A.deepEqual([...dup.keys()], ['xyra'])
  A.deepEqual(dup.get('xyra'), ['zeta'])
  // 顺序换一下,裁决结果必须一样(库的显示排序按名字,不能影响绑定)
  A.equal(M.claimFor([...list].reverse(), 'xyra').slug, 'alpha')
})
t('contract: isAgentSlug 与引擎 SLUG_RE 同口径', () => {
  for (const ok of ['xyra', 'a', 'code-reviewer', 'x1', '9lives', 'a'.repeat(64)]) A.equal(M.isAgentSlug(ok), true, ok)
  for (const bad of ['', 'Xyra', '-x', 'x_y', 'x y', 'a'.repeat(65), '../x', 'x/y', null, 3, undefined]) A.equal(M.isAgentSlug(bad), false, String(bad))
})
t('profile: defaultProfileFor(VRM 半身、OBJ 躺倒 → upAxis z、无分析)', () => {
  const vrm = M.buildAnalysis({ format: 'vrm', vrm: { specVersion: '1', title: 'Seed', expressions: VRM1_EXPR, humanBones: ['head'], head: 'J_Bip_C_Head' }, clips: [], morphs: [], boneNames: ['J_Bip_C_Head'], meshes: 3, triangles: 10, textures: 2, size: [0.8, 1.6, 0.3], warnings: [] }, 'seed.vrm', 0)
  const p = M.defaultProfileFor('seed.vrm', vrm)
  A.equal(p.name, 'Seed')
  A.equal(p.framing, 'bust')
  A.deepEqual(p.states.speaking, { mouth: 'aa' })
  A.equal(M.parseProfile(M.serializeProfile(p), 'd').ok, true)
  const obj = M.buildAnalysis({ format: 'obj', clips: [], morphs: [], boneNames: [], meshes: 1, triangles: 10, textures: 0, size: [0.5, 0.4, 1.8], warnings: [] }, 'statue.obj', 0)
  const q = M.defaultProfileFor('statue.obj', obj)
  A.equal(q.transform.upAxis, 'z')
  A.equal(q.framing, 'bust')
  const helmet = M.buildAnalysis({ format: 'gltf', clips: [], morphs: [], boneNames: [], meshes: 1, triangles: 10, textures: 5, size: [1.9, 1.8, 1.9], warnings: [] }, 'helmet.gltf', 0)
  A.equal(M.defaultProfileFor('helmet.gltf', helmet).framing, 'full')
  const bare = M.defaultProfileFor('Samba Dancing.fbx')
  A.equal(bare.name, 'Samba Dancing')
  A.deepEqual(bare.states, {})
})

// ── reactions ────────────────────────────────────────────────────────────────
const CAPS0 = { clips: [], expressions: [] }
t('reactions: 7 个阶段都有计划(无映射、无能力 → 纯程序化)', () => {
  for (const ph of M.PHASES) {
    const p = M.planFor(ph, {}, CAPS0)
    A.equal(p.phase, ph)
    A.equal(p.clip, undefined)
    A.deepEqual(p.expressions, {})
    A.ok(['pointer', 'up', 'down', 'camera'].includes(p.proc.look))
  }
  A.equal(M.planFor('thinking', {}, CAPS0).proc.look, 'up')
  A.equal(M.planFor('tool', {}, CAPS0).proc.look, 'down')
  A.equal(M.planFor('error', {}, CAPS0).proc.droop, 1)
  A.ok(M.planFor('waiting', {}, CAPS0).proc.bounce > 0)
  A.ok(M.planFor('speaking', {}, CAPS0).proc.nod > 0)
})
t('reactions: 没映射的阶段沿用 idle 片段;clip:null 明确不播;模型没有的片段不播', () => {
  const caps = { clips: ['Idle', 'Wave'], expressions: [] }
  const st = { idle: { clip: 'Idle' }, waiting: { clip: 'Wave', once: true }, tool: { clip: null }, done: { clip: 'Missing' } }
  A.deepEqual(M.planFor('thinking', st, caps).clip, { name: 'Idle', once: false, restart: false })
  A.deepEqual(M.planFor('waiting', st, caps, 'thinking').clip, { name: 'Wave', once: true, restart: true })
  A.deepEqual(M.planFor('waiting', st, caps, 'waiting').clip, { name: 'Wave', once: true, restart: false })
  A.equal(M.planFor('tool', st, caps).clip, undefined)
  A.deepEqual(M.planFor('done', st, caps).clip, { name: 'Idle', once: false, restart: false })
  A.equal(M.planFor('idle', { idle: { clip: 'Nope' } }, caps).clip, undefined)
})
t('reactions: 表情与口型(VRM / 非 VRM morph)', () => {
  const vcaps = { clips: [], expressions: VRM1_EXPR, vrm: true }
  A.deepEqual(M.planFor('done', {}, vcaps).expressions, { happy: 0.8 })
  A.deepEqual(M.planFor('error', {}, vcaps).expressions, { sad: 0.7 })
  A.deepEqual(M.planFor('waiting', {}, { clips: [], expressions: VRM0_EXPR, vrm: true }).expressions, { Surprised: 0.5 })
  A.equal(M.planFor('speaking', {}, vcaps).mouth, 'aa')
  A.equal(M.planFor('idle', {}, vcaps).mouth, undefined)
  A.deepEqual(M.planFor('done', { done: { expression: 'relaxed', weight: 0.4 } }, vcaps).expressions, { relaxed: 0.4 })
  A.deepEqual(M.planFor('done', { done: { expression: 'nope' } }, vcaps).expressions, {})
  const mcaps = { clips: [], expressions: ['jawOpen', 'eyeBlinkLeft'], mouthMorph: 'jawOpen' }
  A.equal(M.planFor('speaking', {}, mcaps).mouth, 'jawOpen')
  A.equal(M.planFor('speaking', { speaking: { mouth: 'eyeBlinkLeft' } }, mcaps).mouth, 'eyeBlinkLeft')
})
t('reactions: 口型包络(~80ms 起 / ~150ms 落 / 换气泡归零 / 负增量不张嘴)', () => {
  const env = M.createMouthEnvelope()
  A.equal(env.sample(0, 0, 'm1'), 0)
  let v = 0
  for (let i = 1; i <= 4; i++) v = env.sample(i * 4, i * 0.05, 'm1') // 80 字/秒,持续 200ms
  A.ok(v > 0.7, `attack too slow: ${v}`)
  // 不再长字:120ms 保持,之后 150ms 时间常数回落
  let d = v
  for (let i = 1; i <= 12; i++) d = env.sample(16, 0.2 + i * 0.05, 'm1')
  A.ok(d < 0.1, `release too slow: ${d}`)
  // 换气泡:立刻归零,且新基线不把旧字数算成增量
  A.equal(env.sample(5000, 1.0, 'm2'), 0)
  A.ok(env.sample(5000, 1.05, 'm2') < 0.01)
  // 负增量(done 改写正文变短)不张嘴
  A.ok(env.sample(10, 1.1, 'm2') < 0.01)
  // decay 让包络在非 speaking 阶段自然收口
  env.sample(40, 1.15, 'm2')
  const up = env.sample(80, 1.2, 'm2')
  A.ok(up > 0.3)
  let z = up
  for (let i = 1; i <= 10; i++) z = env.decay(1.2 + i * 0.05)
  A.ok(z < 0.05, `decay: ${z}`)
  env.reset()
  A.equal(env.value, 0)
})
t('reactions: mouthFlap 在 [0,1] 内且包络为 0 时闭嘴', () => {
  A.equal(M.mouthFlap(0, 1.23), 0)
  for (let i = 0; i < 200; i++) {
    const f = M.mouthFlap(1, i / 97)
    A.ok(f >= 0 && f <= 1)
  }
  A.ok(M.mouthFlap(1, 0.1) > M.mouthFlap(0.2, 0.1))
})

// ── analysis(纯半边) ─────────────────────────────────────────────────────────
t('analysis: buildAnalysis(RobotExpressive 形态)', () => {
  const a = M.buildAnalysis({
    format: 'glb', clips: ROBOT.map((name) => ({ name, duration: 1, source: 'robot.glb' })), morphs: ['Angry', 'Surprised', 'Sad'],
    boneNames: ['Bone', 'Hips', 'Abdomen', 'Torso', 'Neck', 'Head', 'UpperArmL'], meshes: 14, triangles: 7000, textures: 0,
    size: [2.1234567, 4.5, 1.2], warnings: [],
  }, 'robot.glb', Date.UTC(2026, 8, 19))
  A.equal(a.live3d, 1)
  A.equal(a.generatedAt, '2026-09-19T00:00:00.000Z')
  A.equal(a.file, 'robot.glb')
  A.equal(a.vrm, undefined)
  A.deepEqual(a.bones, { count: 7, head: 'Head', neck: 'Neck', rig: 'unknown' })
  A.deepEqual(a.size, [2.123, 4.5, 1.2])
  A.equal(a.upAxisGuess, 'y')
  A.equal(a.suggested.waiting.clip, 'Wave')
  A.deepEqual(a.warnings, [])
  A.ok(JSON.parse(JSON.stringify(a)))
})
t('analysis: VRM0 事实 + 无片段 / 高面数 / 躺倒诊断(英文)', () => {
  const a = M.buildAnalysis({
    format: 'vrm', vrm: { specVersion: '0', title: 'three-vrm-girl', expressions: VRM0_EXPR, humanBones: ['hips', 'head'], head: 'J_Bip_C_Head', neck: 'J_Bip_C_Neck' },
    clips: [], morphs: ['Fcl_MTH_A'], boneNames: ['J_Bip_C_Hips', 'J_Bip_C_Head'], meshes: 3, triangles: 400000, textures: 12, size: [0.6, 0.4, 1.7], warnings: ['x'],
  }, 'girl.vrm', 0)
  A.deepEqual(a.vrm, { specVersion: '0', title: 'three-vrm-girl', expressions: VRM0_EXPR, humanBones: ['hips', 'head'] })
  A.equal(a.bones.rig, 'vrm')
  A.equal(a.bones.head, 'J_Bip_C_Head')
  A.equal(a.upAxisGuess, 'z')
  A.equal(a.warnings[0], 'x')
  A.ok(a.warnings.some((w) => /No animation clips/.test(w)))
  A.ok(a.warnings.some((w) => /triangle/.test(w)))
  A.ok(a.warnings.some((w) => /Z-up/.test(w)))
  for (const w of a.warnings) A.ok(!HAN.test(w))
  A.equal(a.suggested.waiting.expression, 'Surprised')
})

// ── loaders(纯函数) ─────────────────────────────────────────────────────────
t('loaders: resolveModelRef(相对 / 反斜杠 / 百分号编码 / 绝对路径与越界只取文件名)', () => {
  A.equal(M.resolveModelRef('tex/a.png', 'Live3D/models/x'), 'Live3D/models/x/tex/a.png')
  A.equal(M.resolveModelRef('textures\\skin.png', 'M/x'), 'M/x/textures/skin.png')
  A.equal(M.resolveModelRef('Default%20albedo.jpg', 'M/x'), 'M/x/Default albedo.jpg')
  A.equal(M.resolveModelRef('C:\\Users\\bob\\Desktop\\skin.png', 'M/x'), 'M/x/skin.png')
  A.equal(M.resolveModelRef('/Users/bob/skin.png', 'M/x'), 'M/x/skin.png')
  A.equal(M.resolveModelRef('../../tex/skin.png', 'M/x'), 'M/x/skin.png')
  A.equal(M.resolveModelRef('./a.bin', ''), 'a.bin')
})
const b64 = (u8) => Buffer.from(u8).toString('base64')
t('loaders: embeddedGltfToGlb(data: buffer → GLB,bufferView 偏移按 4 字节对齐重排)', () => {
  const g = {
    asset: { version: '2.0' },
    buffers: [{ uri: 'data:application/octet-stream;base64,' + b64([1, 2, 3]), byteLength: 3 }, { uri: 'data:application/gltf-buffer;base64,' + b64([9, 8, 7, 6, 5]), byteLength: 5 }],
    bufferViews: [{ buffer: 0, byteLength: 3 }, { buffer: 1, byteOffset: 1, byteLength: 4 }],
  }
  const out = new Uint8Array(M.embeddedGltfToGlb(new TextEncoder().encode(JSON.stringify(g)).buffer))
  const dv = new DataView(out.buffer)
  A.equal(dv.getUint32(0, true), 0x46546c67)
  A.equal(dv.getUint32(8, true), out.length)
  const jl = dv.getUint32(12, true)
  A.equal(jl % 4, 0)
  const json = JSON.parse(new TextDecoder().decode(out.subarray(20, 20 + jl)))
  A.deepEqual(json.buffers, [{ byteLength: 12 }])
  A.deepEqual(json.bufferViews, [{ buffer: 0, byteLength: 3, byteOffset: 0 }, { buffer: 0, byteOffset: 5, byteLength: 4 }])
  const binStart = 20 + jl + 8
  A.equal(dv.getUint32(20 + jl + 4, true), 0x004e4942)
  A.deepEqual([...out.subarray(binStart, binStart + 3)], [1, 2, 3])
  A.deepEqual([...out.subarray(binStart + 4 + 1, binStart + 4 + 5)], [8, 7, 6, 5])
  // 外部 .bin / 已是 GLB / 不是 JSON:原样返回
  const ext = new TextEncoder().encode(JSON.stringify({ buffers: [{ uri: 'a.bin', byteLength: 3 }] })).buffer
  A.equal(M.embeddedGltfToGlb(ext), ext)
  A.equal(M.embeddedGltfToGlb(out.buffer), out.buffer)
  const junk = new Uint8Array([0, 1, 2]).buffer
  A.equal(M.embeddedGltfToGlb(junk), junk)
})
t('loaders: gltfRequiredExtensions 读 GLB / .gltf 头', () => {
  const g = { asset: { version: '2.0' }, extensionsRequired: ['KHR_draco_mesh_compression'] }
  A.deepEqual(M.gltfRequiredExtensions(new TextEncoder().encode(JSON.stringify(g)).buffer), ['KHR_draco_mesh_compression'])
  A.deepEqual(M.gltfRequiredExtensions(new Uint8Array([1, 2]).buffer), [])
})
t('loaders: routeModelRef —— 只放行 blob: / data: / amadeus-asset:;联网 / 未知协议拒绝;file:// 与绝对路径只取文件名', () => {
  for (const u of ['blob:http://x/1', 'data:image/png;base64,AA', 'amadeus-asset://v/Live3D%2Fa.png']) A.deepEqual(M.routeModelRef(u, 'M/x'), { pass: u }, u)
  for (const u of ['https://tracker.example/x.png', 'http://127.0.0.1:9/b.bin', 'HTTPS://X/Y.PNG', 'ftp://h/a.png', 'javascript:alert(1)']) A.deepEqual(M.routeModelRef(u, 'M/x'), { refuse: u }, u)
  A.deepEqual(M.routeModelRef('file:///C:/Users/bob/skin.png', 'M/x'), { rel: 'M/x/skin.png' })
  A.deepEqual(M.routeModelRef('file:///Users/bob/My%20Skin.png', 'M/x'), { rel: 'M/x/My Skin.png' })
  A.deepEqual(M.routeModelRef('C:\\tex\\skin.png', 'M/x'), { rel: 'M/x/skin.png' }) // 盘符不算协议
  A.deepEqual(M.routeModelRef('tex/a.png', 'M/x'), { rel: 'M/x/tex/a.png' })
  A.deepEqual(M.routeModelRef('../../etc/a.png', 'M/x'), { rel: 'M/x/a.png' })
})
t('loaders: gltfBlockingExtensions —— Required 里不支持的 + 只在 Used 里的 Draco;只在 Used 里的 KTX2 不拦(会回落)', () => {
  const j = (o) => new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, ...o })).buffer
  A.deepEqual(M.gltfBlockingExtensions(j({ extensionsUsed: ['KHR_draco_mesh_compression'] })), ['KHR_draco_mesh_compression'])
  A.deepEqual(M.gltfBlockingExtensions(j({ extensionsUsed: ['KHR_draco_mesh_compression'], extensionsRequired: ['KHR_draco_mesh_compression'] })), ['KHR_draco_mesh_compression'])
  A.deepEqual(M.gltfBlockingExtensions(j({ extensionsRequired: ['KHR_texture_basisu'], extensionsUsed: ['KHR_texture_basisu'] })), ['KHR_texture_basisu'])
  A.deepEqual(M.gltfBlockingExtensions(j({ extensionsUsed: ['KHR_texture_basisu', 'KHR_materials_emissive_strength'] })), [])
  A.deepEqual(M.gltfBlockingExtensions(j({ extensionsRequired: ['EXT_meshopt_compression'] })), [])
  A.deepEqual(M.gltfBlockingExtensions(new Uint8Array([1, 2]).buffer), [])
})
t('stage: frameDelta —— 正常帧按真实间隔走(卡片 40ms 帧不被钳成 33ms),只钳长间隔,卡顿按恢复处理', () => {
  A.deepEqual(M.frameDelta(0.04), { dt: 0.04, resume: false }) // 75Hz 屏 + 30fps 封顶的帧距
  A.deepEqual(M.frameDelta(1 / 60), { dt: 1 / 60, resume: false })
  A.deepEqual(M.frameDelta(0.2), { dt: 0.1, resume: false })
  A.deepEqual(M.frameDelta(0.8), { dt: 0, resume: true })
  A.deepEqual(M.frameDelta(Number.NaN), { dt: 0, resume: true })
  A.deepEqual(M.frameDelta(-1), { dt: 0, resume: true })
})
t('loaders: LoadError / toMsg 双语', () => {
  const e = new M.LoadError('not-found', { zh: '找不到', en: 'Not found' })
  A.equal(e.message, 'Not found')
  A.deepEqual(M.toMsg(e), { code: 'not-found', zh: '找不到', en: 'Not found' })
  const m = M.toMsg(new Error('boom'))
  A.equal(m.code, 'parse-failed')
  A.ok(HAN.test(m.zh) && !HAN.test(m.en))
})

// ── 3D 小屋:场景 / 寻路 / 行为 / 姿势 ──────────────────────────────────────────
const SCENE = {
  live3d: 1, name: { zh: '测试间', en: 'Test room' }, character: 'my-avatar', height: 1.25, time: 'night',
  room: { width: 4, depth: 4, height: 2.6, windows: [{ wall: 'right', at: 0.5, width: 1.4, height: 1.2, sill: 0.8 }] },
  props: [
    { type: 'bed', id: 'bed', at: [-1.4, -0.9] },
    { type: 'desk', id: 'desk', at: [0.6, -1.38] },
    { type: 'rug', id: 'rug', at: [0.2, 0.6] },
  ],
  activities: [
    { id: 'nap', at: 'bed', pose: 'sleep', time: [5, 5], weight: 1, emote: 'zzz', then: 'wake' },
    { id: 'wake', at: 'here', pose: 'stretch', time: 1, weight: 0, chained: true },
    { id: 'read', at: 'desk', pose: 'sit-read', time: [5, 5], weight: 1, label: { zh: '看书', en: 'Reading' } },
    { id: 'sun', at: 'rug', pose: 'sunbathe', time: 5, weight: 1, when: 'day' },
  ],
}
const scene = (patch = {}) => M.parseScene(JSON.stringify({ ...SCENE, ...patch }), 'Live3D/scenes/t', 't')
t('scene: 合法场景补齐缺省(内置 Agent 阶段映射、窗户)、name / label 双语对象照收', () => {
  const r = scene()
  A.ok(r.ok, r.zh)
  A.equal(r.value.slug, 't')
  A.equal(r.value.character, 'my-avatar')
  A.equal(r.value.agent.thinking, '@think')
  A.deepEqual(r.value.name, { zh: '测试间', en: 'Test room' })
  A.equal(M.pickLabel(r.value.activities[2].label, 'en'), 'Reading')
  A.equal(M.pickLabel({ zh: '只有中文' }, 'en'), '只有中文')
  A.deepEqual(r.value.activities[1].time, [1, 1])
})
t('scene: 错误给双语、能照着改的人话(姿势名 / then 断链 / 窗比墙宽 / 坐标 / 阶段名 / 版本)', () => {
  const bad = [
    [{ activities: [{ id: 'x', at: 'bed', pose: 'fly' }] }, /pose/],
    [{ activities: [{ id: 'x', at: 'bed', pose: 'sleep', then: 'nope' }] }, /then/],
    [{ room: { width: 3, windows: [{ wall: 'right', width: 3 }] } }, /窗/],
    [{ props: [{ type: 'bed', at: [1] }] }, /\[x, z\]/],
    [{ agent: { idle: 'read' } }, /agent/],
    [{ live3d: 2 }, /live3d/],
    [{ props: [{ type: 'bed', id: 'window', at: [0, 0] }] }, /保留字|reserved/],
  ]
  for (const [patch, re] of bad) {
    const r = scene(patch)
    A.equal(r.ok, false, JSON.stringify(patch))
    A.match(r.zh + r.en, re)
    A.ok(HAN.test(r.zh) && !HAN.test(r.en), r.en)
  }
  const w = scene({ props: [{ type: 'spaceship', at: [0, 0] }] })
  A.ok(w.ok && w.warnings.some((x) => /spaceship/.test(x.en)), '不认识的道具类型应跳过并警告,不是报错')
  // 原型链上的名字不是道具类型(按普通对象查表会拿到 Object.prototype,后面算坐标全是 NaN)
  for (const type of ['__proto__', 'constructor', 'toString']) {
    const r = scene({ props: [{ type, at: [0, 0] }] })
    A.ok(r.ok && r.value.props.length === 0, `道具类型 ${type} 被当真了`)
  }
})
t('scene: 内置小屋过得了自己的校验;每种道具都登记了尺寸 / 锚点;每个姿势都有动作', () => {
  const b = M.builtinScene()
  A.ok(b.props.length > 3 && b.activities.length > 3)
  for (const [type, info] of Object.entries(M.PROP_INFO)) {
    A.ok(Array.isArray(info.half) && info.half.every(Number.isFinite), type)
    for (const a of Object.values(info.anchors)) A.ok([a.x, a.z, a.face].every(Number.isFinite), type)
  }
  for (const p of M.POSES) A.equal(typeof M.POSE_TABLE[p], 'function', `姿势 ${p} 没有动作`)
})
t('scene: isNight —— auto 按本地时间(18:30 起到 6:00 是夜),day / night 固定', () => {
  const at = (h, m = 0) => new Date(2026, 8, 26, h, m)
  A.equal(M.isNight('auto', at(12)), false)
  A.equal(M.isNight('auto', at(18, 29)), false)
  A.equal(M.isNight('auto', at(18, 30)), true)
  A.equal(M.isNight('auto', at(5, 59)), true)
  A.equal(M.isNight('day', at(23)), false)
  A.equal(M.isNight('night', at(12)), true)
})
t('nav: 绕开障碍(路上每一段都走得通)、起点在障碍里先挪出来、围死 → null、旋转的障碍按旋转后的占地挡', () => {
  const g = M.buildGrid(4, 4, [{ x: 0, z: 0, hx: 0.4, hz: 1.4, rot: 0 }], 0.15)
  const p = M.findPath(g, [-1.5, 0], [1.5, 0])
  A.ok(p && p.length >= 3, '直线穿过障碍了')
  for (let i = 1; i < p.length; i++) A.ok(M.lineFree(g, p[i - 1], p[i]), `第 ${i} 段穿墙`)
  const inside = M.findPath(g, [0, 0], [1.5, 1.5])
  A.deepEqual(inside[0], [0, 0])
  A.ok(M.isFree(g, inside[1]), '起点在障碍里时,第二个点应是挪出来的空地')
  const wall = M.buildGrid(4, 4, [{ x: 0, z: 0, hx: 0.3, hz: 2.5, rot: 0 }], 0.15)
  A.equal(M.findPath(wall, [-1.5, 0], [1.5, 0]), null)
  const rot = M.buildGrid(4, 4, [{ x: 0, z: 0, hx: 1.2, hz: 0.2, rot: Math.PI / 2 }], 0.1)
  A.equal(M.isFree(rot, [0, 1]), false, '转 90° 后长边沿 Z,(0,1) 应被挡')
  A.equal(M.isFree(rot, [1, 0]), true)
})

/** 跑大脑直到条件成立(dt = 50ms,最多 maxS 秒);返回用了多少秒。 */
function runUntil(b, cond, maxS = 60, onFrame) {
  for (let s = 0; s < maxS; s += 0.05) {
    const fr = b.update(0.05)
    onFrame?.(fr)
    if (cond(fr)) return s
  }
  return -1
}
const mkBrain = (sc, night = true) => {
  let seed = 7
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const obs = sc.props.filter((p) => M.PROP_INFO[p.type].half[0]).map((p) => ({ x: p.at[0], z: p.at[1], hx: M.PROP_INFO[p.type].half[0], hz: M.PROP_INFO[p.type].half[1], rot: (p.rot * Math.PI) / 180 }))
  const grid = M.buildGrid(sc.room.width, sc.room.depth, obs, 0.17)
  return { b: M.createBrain({ scene: sc, grid, camera: () => [8, 8], night: () => night, rng }), grid }
}
t('brain: 叫去睡觉 → 走过去(不穿家具)→ 躺下(lie、settle=1)→ 睡够接 then(原地伸懒腰,不下床)', () => {
  const sc = scene().value
  const { b, grid } = mkBrain(sc)
  b.force('nap')
  let crossed = 0
  const s = runUntil(b, (fr) => fr.mode === 'do' && b.current() === 'nap', 60, (fr) => {
    if (fr.mode === 'walk' && !M.isFree(grid, [fr.x, fr.z]) && M.nearestFree(grid, [fr.x, fr.z]) && Math.hypot(fr.x - sc.props[0].at[0], fr.z - sc.props[0].at[1]) > 1.2) crossed++
  })
  A.ok(s >= 0, '一分钟内没躺上床')
  A.equal(crossed, 0, '走路途中穿过了家具')
  const fr = b.frame()
  A.equal(fr.stance, 'lie')
  A.equal(fr.settle, 1)
  A.equal(fr.emote, 'zzz')
  A.ok(runUntil(b, () => b.current() === 'wake', 10) >= 0, '睡醒没接 then')
  A.equal(b.frame().stance, 'lie', '「here」活动不该让人下床')
})
t('brain: Agent 阶段插队 —— thinking 起身去书桌;thinking→tool 同一张桌子原地换动作(不起身);回 idle 后回到日常', () => {
  const sc = scene().value
  const { b } = mkBrain(sc)
  b.force('nap')
  runUntil(b, () => b.current() === 'nap', 60)
  b.force(null)
  b.setPhase('thinking')
  A.equal(b.frame().mode, 'exit', '躺着被叫去干活应先起身')
  A.ok(runUntil(b, () => b.current() === '@think', 60) >= 0, '没走到书桌去想事情')
  A.equal(b.frame().stance, 'sit')
  b.setPhase('tool')
  b.update(0.05)
  A.equal(b.current(), '@work', '同一张桌子应原地换成干活')
  A.equal(b.frame().mode, 'do')
  // 阶段不变就一直干(内置活动 4s 一轮,到点只续不走)
  A.equal(runUntil(b, (fr) => fr.mode !== 'do' || b.current() !== '@work', 12), -1, '阶段没变却自己走开了')
  b.setPhase('idle')
  A.ok(runUntil(b, () => !!b.current() && !b.current().startsWith('@'), 30) >= 0, '回 idle 后没回到日常')
})
t('brain: 戳一下 —— 睡着时是被吵醒(@woken,不爽)再打哈欠;醒着是打招呼(@poke)', () => {
  const sc = scene().value
  const { b } = mkBrain(sc)
  b.force('nap')
  runUntil(b, () => b.current() === 'nap', 60)
  b.poke()
  A.equal(b.current(), '@woken')
  A.equal(b.frame().emote, 'anger')
  A.ok(runUntil(b, () => b.current() === '@yawn', 5) >= 0, '被吵醒后没打哈欠')
  const { b: b2 } = mkBrain(sc)
  b2.force('read') // 醒着:坐在书桌前看书
  A.ok(runUntil(b2, () => b2.current() === 'read', 60) >= 0)
  b2.poke()
  A.equal(b2.current(), '@poke')
})
t('brain: at 里的锚点名只认自有键("bed.__proto__" 不是锚点 → 这个活动做不了,不参加抽签,更不会走到 NaN 去)', () => {
  const sc = scene({ activities: [{ id: 'evil', at: 'bed.__proto__', pose: 'sleep', time: 3, weight: 50 }, { id: 'ok', at: 'center', pose: 'stand', time: 3, weight: 1 }] }).value
  const { b } = mkBrain(sc)
  let nan = 0
  const seen = new Set()
  runUntil(b, () => false, 30, (fr) => {
    if (!Number.isFinite(fr.x) || !Number.isFinite(fr.z) || !Number.isFinite(fr.yaw)) nan++
    if (b.current()) seen.add(b.current())
  })
  A.equal(nan, 0, '坐标出现 NaN')
  A.ok(!seen.has('evil'))
})
t('brain: Agent 干活时被戳一下 → 打完招呼回去接着干(钉住的活动要恢复)', () => {
  const sc = scene().value
  const { b } = mkBrain(sc)
  b.setPhase('tool')
  A.ok(runUntil(b, () => b.current() === '@work', 60) >= 0)
  b.poke()
  A.equal(b.current(), '@poke')
  A.ok(runUntil(b, () => b.current() === '@work', 6) >= 0, '戳完没回去干活(阶段还是 tool)')
})
t('brain: 走去书桌的路上阶段回 idle → 改去过日子,不把过期的 agent 活动做完', () => {
  const sc = scene().value
  const { b } = mkBrain(sc)
  runUntil(b, () => !!b.current(), 30)
  b.setPhase('thinking')
  A.ok(runUntil(b, (fr) => fr.mode === 'walk', 10) >= 0, '没开始走')
  b.setPhase('idle')
  let did = false
  runUntil(b, () => false, 20, () => { if (b.current() === '@think') did = true })
  A.ok(!did, '阶段早就回 idle 了,还是走到书桌做了 @think')
})
t('brain: 躺着被叫去干活、起身途中阶段回 idle → 起身完改去过日子,不卡在 exit、不去书桌', () => {
  const sc = scene().value
  const { b } = mkBrain(sc)
  b.force('nap')
  A.ok(runUntil(b, () => b.current() === 'nap', 60) >= 0)
  b.force(null)
  b.setPhase('thinking')
  A.equal(b.frame().mode, 'exit')
  b.setPhase('idle')
  let think = false
  const s = runUntil(b, () => b.frame().mode === 'do' && !!b.current() && b.current() !== 'nap', 20, () => { if (b.current() === '@think') think = true })
  A.ok(s >= 0, '起身后卡住了(一直没挑到新的事)')
  A.ok(!think, '阶段早回 idle 了还去书桌做了 @think')
})
t('brain: 从窗边走去书桌的路上被叫住说话 → 原地说;说完被派回窗边时要真的走回去(旧锚点不算「就在这里」)', () => {
  const sc = scene({ activities: [...SCENE.activities, { id: 'look', at: 'window', pose: 'gaze', time: [6, 6], weight: 0, chained: true }] }).value
  const { b } = mkBrain(sc)
  b.force('look')
  A.ok(runUntil(b, () => b.current() === 'look', 60) >= 0, '没走到窗边')
  const win = { x: b.frame().x, z: b.frame().z }
  b.force('read')
  A.ok(runUntil(b, (fr) => fr.mode === 'walk' && Math.hypot(fr.x - win.x, fr.z - win.z) > 0.6, 30) >= 0, '没走远')
  const mid = { x: b.frame().x, z: b.frame().z }
  b.setPhase('speaking')
  A.equal(b.current(), '@talk')
  A.ok(Math.hypot(b.frame().x - mid.x, b.frame().z - mid.z) < 0.05, '说话时应停在原地')
  b.force('look')
  b.setPhase('idle')
  A.ok(runUntil(b, () => b.current() === 'look', 60) >= 0, '说完没回窗边')
  A.ok(Math.hypot(b.frame().x - win.x, b.frame().z - win.z) < 0.2, `在半路就「看起窗外」了:(${b.frame().x.toFixed(2)}, ${b.frame().z.toFixed(2)}) vs 窗边 (${win.x.toFixed(2)}, ${win.z.toFixed(2)})`)
})
t('brain: 白天才做的活动只在白天抽到;场景里没有的道具 → 那个活动不参加抽签', () => {
  const sc = scene({ activities: [{ id: 'sun', at: 'rug', pose: 'sunbathe', time: 3, weight: 1, when: 'day' }, { id: 'ghost', at: 'piano', pose: 'piano', time: 3, weight: 50 }, { id: 'stand', at: 'center', pose: 'stand', time: 3, weight: 1 }] }).value
  const seen = new Set()
  const { b } = mkBrain(sc, true)
  runUntil(b, () => false, 60, () => b.current() && seen.add(b.current()))
  A.ok(!seen.has('sun'), '夜里抽到了白天的活动')
  A.ok(!seen.has('ghost'), '抽到了场景里没有道具的活动')
  A.ok(seen.has('stand'))
})
t('poses: 坐下时髋落在座面上(Q 版腿短 → 整个人被抬起来);躺平时仰倒 90°、根退半个身长;走路有腿的摆动', () => {
  const an = M.createAnimator({ height: 1.25, hipY: 0.2, back: 0.11 })
  const base = { walk: 0, speed: 0, poseT: 1, activity: null, emote: null, look: null, mode: 'do' }
  const sit = an.step({ ...base, x: 0, z: 0, yaw: 0, stance: 'sit', settle: 1, seatY: 0.36, pose: 'sit' }, 0.016, 1)
  A.ok(Math.abs(sit.root.y - (0.36 - 0.2 + 0.015)) < 1e-6, `坐姿根高 ${sit.root.y}`)
  A.ok(sit.body.legL && sit.body.legL.thigh[0] < -1, '坐着大腿应抬平')
  // 头朝 -Z(face = π)→ 身体偏航 = face + π = 0
  const lie = an.step({ ...base, x: 0, z: 0, yaw: M.bodyYaw(Math.PI, 'lie') % (2 * Math.PI), stance: 'lie', settle: 1, seatY: 0.38, pose: 'sleep' }, 0.016, 1)
  A.ok(Math.abs(lie.root.pitch + Math.PI / 2) < 1e-6)
  A.ok(Math.abs(lie.root.y - (0.38 + 0.11)) < 1e-6, `躺姿根高 ${lie.root.y}`)
  A.ok(Math.abs(lie.root.z - 0.625) < 1e-6, `头朝 -Z 时脚(根)应在 +Z 半个身长:${lie.root.z}`)
  const w1 = an.step({ ...base, x: 0, z: 0, yaw: 0, stance: 'stand', settle: 0, seatY: 0, pose: 'stand', walk: 1, speed: 0.5, mode: 'walk' }, 0.1, 2)
  const w2 = an.step({ ...base, x: 0, z: 0, yaw: 0, stance: 'stand', settle: 0, seatY: 0, pose: 'stand', walk: 1, speed: 0.5, mode: 'walk' }, 0.1, 2.1)
  A.ok(w1.body.legL && w2.body.legL && w1.body.legL.thigh[0] !== w2.body.legL.thigh[0], '走路时腿没摆')
})

console.log(`\n${total - fail.length}/${total} passed`)
if (fail.length) {
  console.log('failed:\n  ' + fail.join('\n  '))
  process.exit(1)
}
