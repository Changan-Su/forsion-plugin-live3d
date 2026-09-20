// 缺省形象「小球」:没导入模型时 Desk 里显示它。全用几何体拼(零资产):亮面球身 + 两只眼 + 嘴 + 一圈环,
// 每个阶段一套一眼能认出来的反应 ——
//   idle      漂浮、眨眼、眼睛跟着指针
//   thinking  眼睛往左上看 + 头顶三颗小点绕圈
//   speaking  嘴随口型包络一张一合
//   tool      环长出齿、变成齿轮飞转,眼睛往下看
//   waiting   蹦跳 + 头顶「!」+ 眼睛睁大
//   error     垂头、八字眉、嘴角向下、球身褪成灰红
//   done      眯眼笑 + 腮红 + 一圈星星炸开,然后回到平常
// 颜色取宿主 --accent(单色主题 / 极亮极暗时换成能在深浅背景上都看得清的颜色);画布透明。

import * as THREE from 'three'
import type { Phase } from './contract'
import type { Anchors, Avatar, FrameInput } from './stage'
import type { ReactionPlan } from './reactions'

const FALLBACK_ACCENT = '#8b7fd6'

/** 宿主强调色 → 球身颜色。只认 #hex / rgb() / hsl()(oklch 之类 three 不认,直接用兜底色);
 *  饱和度太低(单色主题)换兜底色,亮度钳到 [0.45, 0.7],深浅背景上都立得住,深色眼睛也看得清。 */
export function orbColorFromAccent(css: string | null | undefined): THREE.Color {
  const c = new THREE.Color(FALLBACK_ACCENT)
  const v = String(css ?? '').trim()
  if (/^(#([0-9a-f]{3}|[0-9a-f]{6})|rgba?\([^)]*\)|hsla?\([^)]*\))$/i.test(v)) c.setStyle(v)
  const hsl = { h: 0, s: 0, l: 0 }
  c.getHSL(hsl)
  if (hsl.s < 0.12) return new THREE.Color(FALLBACK_ACCENT)
  c.setHSL(hsl.h, Math.max(hsl.s, 0.35), Math.min(0.7, Math.max(0.45, hsl.l)))
  return c
}

export function readAccent(): string {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue('--accent')
  } catch {
    return ''
  }
}

const damp = (cur: number, target: number, rate: number, dt: number): number => cur + (target - cur) * (1 - Math.exp(-rate * dt))
const easeOut = (x: number): number => 1 - Math.pow(1 - x, 3)

const R = 0.5 // 球身半径
const CY = 0.78 // 球心高度(脚下留影子)

/** 把一个部件放到球面上 `dir` 方向、朝外。 */
function onSurface(obj: THREE.Object3D, dir: THREE.Vector3, lift = 0.004): void {
  const d = dir.clone().normalize()
  obj.position.copy(d.multiplyScalar(R + lift))
  obj.lookAt(obj.position.clone().multiplyScalar(2))
}

export interface Orb extends Avatar {
  setAccent(css: string): void
}

export function createOrb(accentCss: string = readAccent()): Orb {
  const root = new THREE.Group()
  root.name = 'live3d-orb'
  const disposables: Array<{ dispose(): void }> = []
  const track = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x)
    return x
  }

  const base = orbColorFromAccent(accentCss)
  const bodyColor = base.clone()
  const sadTint = new THREE.Color('#9b7f80') // 灰里带一点红:「蔫了」而不是「粉了」

  // ── 球身 ──
  const floatG = new THREE.Group() // 漂浮 / 下垂 / 蹦跳都作用在它上
  floatG.position.y = CY
  root.add(floatG)
  const bodyMat = track(new THREE.MeshPhysicalMaterial({
    color: bodyColor, roughness: 0.3, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.12,
    sheen: 0.7, sheenColor: new THREE.Color('#ffffff'), sheenRoughness: 0.45,
  }))
  const body = new THREE.Mesh(track(new THREE.SphereGeometry(R, 64, 48)), bodyMat)
  floatG.add(body)

  // ── 脸(整组绕球心转 = 五官在球面上滑动,看向哪里一目了然) ──
  const face = new THREE.Group()
  floatG.add(face)
  const ink = track(new THREE.MeshStandardMaterial({ color: '#1b2130', roughness: 0.35 }))
  const white = track(new THREE.MeshBasicMaterial({ color: '#ffffff' }))
  const eyeGeo = track(new THREE.SphereGeometry(0.075, 24, 16))
  const hiGeo = track(new THREE.SphereGeometry(0.022, 12, 8))
  const arcGeo = track(new THREE.TorusGeometry(0.058, 0.017, 8, 24, Math.PI))
  const browGeo = track(new THREE.CapsuleGeometry(0.013, 0.085, 4, 8))

  interface Eye { holder: THREE.Group; open: THREE.Mesh; happy: THREE.Mesh; brow: THREE.Mesh; side: number }
  const eyes: Eye[] = [-1, 1].map((side) => {
    const holder = new THREE.Group()
    onSurface(holder, new THREE.Vector3(side * 0.34, 0.17, 0.92))
    const open = new THREE.Mesh(eyeGeo, ink)
    open.scale.set(0.82, 1.18, 0.42)
    const hi = new THREE.Mesh(hiGeo, white)
    hi.position.set(0.022, 0.035, 0.03)
    open.add(hi)
    const happy = new THREE.Mesh(arcGeo, ink) // 「^」:上半圆弧
    happy.visible = false
    const brow = new THREE.Mesh(browGeo, ink)
    brow.rotation.z = Math.PI / 2
    brow.position.set(0, 0.13, 0.005)
    brow.visible = false
    holder.add(open, happy, brow)
    face.add(holder)
    return { holder, open, happy, brow, side }
  })

  const mouthG = new THREE.Group()
  onSurface(mouthG, new THREE.Vector3(0, -0.2, 0.98))
  face.add(mouthG)
  const smile = new THREE.Mesh(arcGeo, ink) // 下半弧「∪」
  smile.rotation.z = Math.PI
  smile.scale.set(1.15, 1, 1)
  const frown = new THREE.Mesh(arcGeo, ink) // 上半弧「∩」
  frown.position.y = -0.05
  frown.visible = false
  const mouthOpen = new THREE.Mesh(track(new THREE.SphereGeometry(0.06, 24, 16)), track(new THREE.MeshStandardMaterial({ color: '#40202a', roughness: 0.6 })))
  mouthOpen.scale.set(1.15, 0.2, 0.35)
  mouthOpen.visible = false
  mouthG.add(smile, frown, mouthOpen)

  const blushMat = track(new THREE.MeshBasicMaterial({ color: '#ff7f9f', transparent: true, opacity: 0, depthWrite: false }))
  const blushGeo = track(new THREE.CircleGeometry(0.055, 24))
  for (const side of [-1, 1]) {
    const b = new THREE.Mesh(blushGeo, blushMat)
    onSurface(b, new THREE.Vector3(side * 0.5, -0.08, 0.86), 0.006)
    b.scale.set(1.3, 0.8, 1)
    face.add(b)
  }

  // ── 环 / 齿轮 ──
  const ringTilt = new THREE.Group()
  ringTilt.rotation.set(Math.PI / 2 - 0.38, 0, 0.22)
  floatG.add(ringTilt)
  const ringMat = track(new THREE.MeshStandardMaterial({
    color: bodyColor.clone().lerp(new THREE.Color('#ffffff'), 0.45), emissive: bodyColor.clone(), emissiveIntensity: 0.35,
    metalness: 0.35, roughness: 0.3,
  }))
  const ring = new THREE.Mesh(track(new THREE.TorusGeometry(0.7, 0.022, 16, 120)), ringMat)
  ringTilt.add(ring)
  const toothGeo = track(new THREE.BoxGeometry(0.07, 0.05, 0.05))
  const teeth: THREE.Mesh[] = []
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2
    const tooth = new THREE.Mesh(toothGeo, ringMat)
    tooth.position.set(Math.cos(a) * 0.73, Math.sin(a) * 0.73, 0)
    tooth.rotation.z = a
    tooth.scale.setScalar(0.001)
    ring.add(tooth)
    teeth.push(tooth)
  }

  // ── 思考的小点 ──
  const dotsG = new THREE.Group()
  dotsG.position.set(-0.46, CY + 0.62, 0.1)
  root.add(dotsG)
  const dotMat = track(new THREE.MeshStandardMaterial({ color: bodyColor.clone().lerp(new THREE.Color('#ffffff'), 0.3), roughness: 0.3, emissive: bodyColor.clone(), emissiveIntensity: 0.25 }))
  const dotGeo = track(new THREE.SphereGeometry(0.062, 16, 12))
  const dots = [0, 1, 2].map(() => {
    const d = new THREE.Mesh(dotGeo, dotMat)
    dotsG.add(d)
    return d
  })

  // ── 「!」 ──
  const bangG = new THREE.Group()
  bangG.position.set(0.02, CY + 0.78, 0.05)
  root.add(bangG)
  const bangMat = track(new THREE.MeshStandardMaterial({ color: '#f5a524', emissive: '#f5a524', emissiveIntensity: 0.45, roughness: 0.35 }))
  const bar = new THREE.Mesh(track(new THREE.CapsuleGeometry(0.05, 0.2, 6, 12)), bangMat)
  bar.position.y = 0.1
  const dot = new THREE.Mesh(track(new THREE.SphereGeometry(0.055, 16, 12)), bangMat)
  dot.position.y = -0.13
  bangG.add(bar, dot)
  bangG.scale.setScalar(0.001)

  // ── 星星(完成时炸开 1.6s) ──
  const sparkGeo = track(new THREE.OctahedronGeometry(0.065, 0))
  const sparkMats = ['#ffd166', '#ffffff', '#7fd7ff'].map((c) => track(new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0, depthWrite: false })))
  const sparks = Array.from({ length: 14 }, (_, i) => {
    const m = new THREE.Mesh(sparkGeo, sparkMats[i % sparkMats.length])
    const a = (i / 14) * Math.PI * 2
    const dir = new THREE.Vector3(Math.cos(a), Math.sin(a) * 0.85 + 0.25, 0.35 * Math.sin(a * 3)).normalize()
    m.visible = false
    root.add(m)
    return { m, dir }
  })
  let sparkT = -1

  // ── 影子(浅色背景上落地感;深色背景上本来就看不见,不碍事) ──
  const shadowMat = track(new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.14, depthWrite: false }))
  const shadow = new THREE.Mesh(track(new THREE.CircleGeometry(0.42, 40)), shadowMat)
  shadow.rotation.x = -Math.PI / 2
  shadow.position.y = 0.005
  root.add(shadow)

  // ── 状态 ──
  let phase: Phase = 'idle'
  let nextBlink = 1.5
  let blinkStart = -1
  const s = { droop: 0, bounce: 0, sad: 0, happy: 0, wide: 0, bang: 0, dots: 0, gear: 0, spin: 0.35, ringAngle: 0, faceYaw: 0, facePitch: 0, speak: 0 }

  const anchors: Anchors = {
    box: new THREE.Box3(new THREE.Vector3(-0.72, 0, -0.55), new THREE.Vector3(0.72, CY + 0.95, 0.55)),
    humanoid: false,
  }

  return {
    root,
    anchors,
    caps: { clips: [], expressions: [] },
    setAccent(css: string) {
      base.copy(orbColorFromAccent(css))
      ringMat.color.copy(base).lerp(new THREE.Color('#ffffff'), 0.45)
      ringMat.emissive.copy(base)
      dotMat.color.copy(base).lerp(new THREE.Color('#ffffff'), 0.3)
      dotMat.emissive.copy(base)
    },
    applyPlan(plan: ReactionPlan) {
      if (plan.phase === 'done' && phase !== 'done') sparkT = 0
      phase = plan.phase
    },
    update(f: FrameInput) {
      const { t, dt } = f
      const k = f.reduced ? 0.35 : 1
      const p = f.proc
      // 目标值
      const want = {
        droop: phase === 'error' ? 1 : 0,
        sad: phase === 'error' ? 1 : 0,
        happy: phase === 'done' ? 1 : 0,
        wide: phase === 'waiting' ? 1 : 0,
        bang: phase === 'waiting' ? 1 : 0,
        dots: phase === 'thinking' ? 1 : 0,
        gear: phase === 'tool' ? 1 : 0,
        speak: phase === 'speaking' ? 1 : 0,
        spin: phase === 'tool' ? 5 : phase === 'done' ? 2.2 : phase === 'thinking' ? 0.8 : phase === 'error' ? 0 : phase === 'waiting' ? 1 : 0.35,
      }
      s.droop = damp(s.droop, want.droop, 5, dt)
      s.sad = damp(s.sad, want.sad, 8, dt)
      s.happy = damp(s.happy, want.happy, 8, dt)
      s.wide = damp(s.wide, want.wide, 10, dt)
      s.bang = damp(s.bang, want.bang, 9, dt)
      s.dots = damp(s.dots, want.dots, 7, dt)
      s.gear = damp(s.gear, want.gear, 7, dt)
      s.speak = damp(s.speak, want.speak, 10, dt)
      s.spin = damp(s.spin, want.spin, 3, dt)
      s.bounce = damp(s.bounce, p.bounce, 6, dt)

      // 漂浮 + 蹦跳 + 下垂
      const float = Math.sin(t * Math.PI * 2 * 0.32) * 0.035 * k * (1 - s.droop)
      const hop = Math.abs(Math.sin(t * Math.PI * 2.2)) * 0.11 * s.bounce * k
      const bob = Math.sin(t * Math.PI * 2 * 3.1) * 0.012 * p.bob * s.speak * k
      floatG.position.y = CY + float + hop + bob - 0.08 * s.droop
      floatG.rotation.z = 0.14 * s.droop + Math.sin(t * 0.9) * 0.02 * p.sway * k
      floatG.rotation.x = 0.22 * s.droop
      const squash = 1 - 0.05 * s.bounce * Math.max(0, Math.cos(t * Math.PI * 4.4)) * k
      body.scale.set(1 / Math.sqrt(squash), squash, 1 / Math.sqrt(squash))

      // 看向:五官在球面上滑,球身也跟着转一点
      s.faceYaw = damp(s.faceYaw, f.look.yaw, 10, dt)
      s.facePitch = damp(s.facePitch, f.look.pitch, 10, dt)
      face.rotation.set(-s.facePitch * 0.75, s.faceYaw * 0.75, 0)
      body.rotation.y = s.faceYaw * 0.2

      // 眨眼(睁大 / 眯眼笑 / 难过时都照眨,只是换形状)
      if (t >= nextBlink && blinkStart < 0) blinkStart = t
      let lid = 1
      if (blinkStart >= 0) {
        const bt = (t - blinkStart) / (phase === 'thinking' ? 0.26 : 0.14)
        if (bt >= 1) {
          blinkStart = -1
          nextBlink = t + 2 + Math.random() * 4
        } else lid = 1 - Math.sin(bt * Math.PI) * 0.92
      }
      const eyeScaleY = 1.18 * (1 + 0.28 * s.wide) * lid * (1 - 0.25 * s.sad)
      for (const e of eyes) {
        e.open.visible = s.happy < 0.5
        e.happy.visible = s.happy >= 0.5
        e.open.scale.set(0.82 * (1 + 0.15 * s.wide), eyeScaleY, 0.42)
        e.brow.visible = s.sad > 0.05
        e.brow.rotation.z = Math.PI / 2 - e.side * 0.42 * s.sad // 内端上挑 = 八字眉(反过来就成了生气)
        e.brow.position.y = 0.12 + 0.02 * s.sad
        e.brow.scale.setScalar(Math.max(0.001, s.sad))
      }

      // 嘴:说话 = 张合;难过 = ∩;等待 = 小「o」;其余 = ∪(完成时笑得更开)
      const open = phase === 'speaking' ? 0.12 + 0.95 * f.mouth : phase === 'waiting' ? 0.4 : 0
      mouthOpen.visible = open > 0.02
      mouthOpen.scale.y = Math.max(0.05, open)
      frown.visible = s.sad >= 0.5
      smile.visible = !mouthOpen.visible && !frown.visible
      smile.scale.set(1.15 * (1 + 0.35 * s.happy), phase === 'tool' ? 0.45 : 1 + 0.3 * s.happy, 1)
      blushMat.opacity = 0.5 * s.happy

      // 颜色:出错褪成灰红
      bodyMat.color.copy(base).lerp(sadTint, 0.8 * s.sad)
      ringMat.emissiveIntensity = 0.35 * (1 - 0.8 * s.sad) + 0.3 * s.gear

      // 环 / 齿轮
      s.ringAngle += s.spin * dt * (f.reduced ? 0.4 : 1)
      ring.rotation.z = s.ringAngle
      // 齿轮:环从「土星环」立成正对镜头的一圈(在球身背后转),齿才看得出来
      ringTilt.rotation.x = Math.PI / 2 - 0.38 - (Math.PI / 2 - 0.5) * s.gear
      ringTilt.rotation.z = 0.22 * (1 - s.gear)
      for (const tooth of teeth) tooth.scale.setScalar(Math.max(0.001, s.gear))

      // 思考的点:绕小圈,依次一亮一暗
      dotsG.scale.setScalar(Math.max(0.001, s.dots))
      dots.forEach((d, i) => {
        const a = t * 2.4 + (i * Math.PI * 2) / 3
        d.position.set(Math.cos(a) * 0.12, Math.sin(a) * 0.07 + i * 0.09, 0)
        d.scale.setScalar(0.65 + 0.35 * (0.5 + 0.5 * Math.sin(t * 5 + i * 1.3)))
      })

      // 「!」
      bangG.scale.setScalar(Math.max(0.001, s.bang))
      bangG.position.y = CY + 0.8 + hop * 1.1 + Math.sin(t * 7) * 0.02 * k
      bangG.rotation.z = Math.sin(t * 5) * 0.12 * s.bang * k

      // 星星爆开(1.6s)
      if (sparkT >= 0) {
        sparkT += dt
        const q = Math.min(1, sparkT / 1.6)
        for (const sp of sparks) {
          sp.m.visible = q < 1
          sp.m.position.set(0, floatG.position.y, 0).addScaledVector(sp.dir, R + 0.08 + 0.5 * easeOut(q))
          sp.m.rotation.set(t * 3, t * 4, 0)
          sp.m.scale.setScalar(0.6 + 0.8 * (1 - q))
          ;(sp.m.material as THREE.MeshBasicMaterial).opacity = 1 - q * q * q
        }
        if (q >= 1) sparkT = -1
      }

      // 影子随高度缩放
      const h = floatG.position.y - CY
      shadow.scale.setScalar(1 - h * 1.2)
      shadowMat.opacity = 0.14 * (1 - h * 2)
    },
    dispose() {
      for (const d of disposables) d.dispose()
      root.removeFromParent()
    },
  }
}
