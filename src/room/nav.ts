// 房间里的寻路(纯函数,无 three):地板切成网格,道具占地(带旋转的矩形)+ 角色半径标成障碍,8 邻接 A*,
// 再按视线拉直。房间只有几平米,0.1m 的格子也就一两千格 —— 每次换活动算一回,开销可以忽略。
// 起点 / 终点落在障碍里(刚从床上起来、锚点贴着家具)时,就近挪到最近的空格再连。

export interface Obstacle {
  /** 中心(米) */
  x: number
  z: number
  /** 半宽(rot 之前的局部 x / z) */
  hx: number
  hz: number
  /** 绕 Y 的角度(弧度) */
  rot: number
}

export interface NavGrid {
  cell: number
  nx: number
  nz: number
  x0: number
  z0: number
  blocked: Uint8Array
}

export type Pt = [number, number]

/** width × depth 的地板(原点在中心),四边各留 radius 不许走(墙、地板边缘),障碍按 radius 外扩。 */
export function buildGrid(width: number, depth: number, obstacles: readonly Obstacle[], radius = 0.18, cell = 0.1): NavGrid {
  const nx = Math.max(2, Math.round(width / cell))
  const nz = Math.max(2, Math.round(depth / cell))
  const x0 = -width / 2
  const z0 = -depth / 2
  const blocked = new Uint8Array(nx * nz)
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = x0 + (i + 0.5) * cell
      const z = z0 + (j + 0.5) * cell
      let b = x < x0 + radius || x > -x0 - radius || z < z0 + radius || z > -z0 - radius
      for (const o of obstacles) {
        if (b) break
        const c = Math.cos(o.rot)
        const s = Math.sin(o.rot)
        const dx = x - o.x
        const dz = z - o.z
        // 世界 → 道具局部(绕 Y 转 -rot):three 的 rotation.y = θ 把局部 (lx, lz) 转到 (lx·c + lz·s, -lx·s + lz·c)
        const lx = dx * c - dz * s
        const lz = dx * s + dz * c
        if (Math.abs(lx) <= o.hx + radius && Math.abs(lz) <= o.hz + radius) b = true
      }
      blocked[j * nx + i] = b ? 1 : 0
    }
  }
  return { cell, nx, nz, x0, z0, blocked }
}

const cellOf = (g: NavGrid, p: Pt): [number, number] => [
  Math.min(g.nx - 1, Math.max(0, Math.floor((p[0] - g.x0) / g.cell))),
  Math.min(g.nz - 1, Math.max(0, Math.floor((p[1] - g.z0) / g.cell))),
]
const centerOf = (g: NavGrid, i: number, j: number): Pt => [g.x0 + (i + 0.5) * g.cell, g.z0 + (j + 0.5) * g.cell]
const free = (g: NavGrid, i: number, j: number): boolean => i >= 0 && j >= 0 && i < g.nx && j < g.nz && !g.blocked[j * g.nx + i]

export function isFree(g: NavGrid, p: Pt): boolean {
  const [i, j] = cellOf(g, p)
  return free(g, i, j) && p[0] >= g.x0 && p[1] >= g.z0 && p[0] <= -g.x0 && p[1] <= -g.z0
}

/** 离 p 最近的空格中心;整张图都堵死 → null。 */
export function nearestFree(g: NavGrid, p: Pt): Pt | null {
  const [si, sj] = cellOf(g, p)
  if (free(g, si, sj)) return p
  const seen = new Uint8Array(g.nx * g.nz)
  const q: number[] = [sj * g.nx + si]
  seen[q[0]] = 1
  for (let h = 0; h < q.length; h++) {
    const i = q[h] % g.nx
    const j = (q[h] - i) / g.nx
    if (free(g, i, j)) return centerOf(g, i, j)
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = i + di
      const b = j + dj
      if (a < 0 || b < 0 || a >= g.nx || b >= g.nz || seen[b * g.nx + a]) continue
      seen[b * g.nx + a] = 1
      q.push(b * g.nx + a)
    }
  }
  return null
}

/** a → b 的直线是否一路都在空格上(按半格步长采样)。 */
export function lineFree(g: NavGrid, a: Pt, b: Pt): boolean {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1])
  const n = Math.max(1, Math.ceil(d / (g.cell * 0.5)))
  for (let k = 0; k <= n; k++) {
    const t = k / n
    const [i, j] = cellOf(g, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    if (!free(g, i, j)) return false
  }
  return true
}

/**
 * from → to 的路径(含首尾,已拉直)。起终点在障碍里时先就近挪到空格(路径首尾仍是原来的点 ——
 * 走出 / 走进家具那一小段由调用方的「坐下 / 起身」过渡负责)。不连通 → null。
 */
export function findPath(g: NavGrid, from: Pt, to: Pt): Pt[] | null {
  const a = nearestFree(g, from)
  const b = nearestFree(g, to)
  if (!a || !b) return null
  const [ai, aj] = cellOf(g, a)
  const [bi, bj] = cellOf(g, b)
  const N = g.nx * g.nz
  const gScore = new Float64Array(N).fill(Infinity)
  const came = new Int32Array(N).fill(-1)
  const closed = new Uint8Array(N)
  const start = aj * g.nx + ai
  const goal = bj * g.nx + bi
  gScore[start] = 0
  // 小房间:开放表用线性扫描的数组就够(最多一两千格)
  const open: number[] = [start]
  const fOf = (k: number): number => {
    const i = k % g.nx
    const j = (k - i) / g.nx
    const dx = Math.abs(i - bi)
    const dz = Math.abs(j - bj)
    return gScore[k] + (dx + dz) + (Math.SQRT2 - 2) * Math.min(dx, dz)
  }
  let found = start === goal
  while (open.length && !found) {
    let best = 0
    for (let h = 1; h < open.length; h++) if (fOf(open[h]) < fOf(open[best])) best = h
    const cur = open[best]
    open[best] = open[open.length - 1]
    open.pop()
    if (closed[cur]) continue
    closed[cur] = 1
    if (cur === goal) {
      found = true
      break
    }
    const ci = cur % g.nx
    const cj = (cur - ci) / g.nx
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue
        const ni = ci + di
        const nj = cj + dj
        if (!free(g, ni, nj)) continue
        if (di && dj && (!free(g, ci + di, cj) || !free(g, ci, cj + dj))) continue // 不许斜着切墙角
        const nk = nj * g.nx + ni
        if (closed[nk]) continue
        const cost = gScore[cur] + (di && dj ? Math.SQRT2 : 1)
        if (cost < gScore[nk]) {
          gScore[nk] = cost
          came[nk] = cur
          open.push(nk)
        }
      }
    }
  }
  if (!found) return null
  const cells: Pt[] = []
  for (let k = goal; k !== -1; k = came[k]) {
    const i = k % g.nx
    cells.push(centerOf(g, i, (k - i) / g.nx))
    if (k === start) break
  }
  cells.reverse()
  // 首尾换成真实的点(被挪过的,先到挪过去的空格)
  const raw: Pt[] = [from]
  if (a !== from) raw.push(a)
  raw.push(...cells.slice(1, -1))
  if (b !== to) raw.push(b)
  raw.push(to)
  return smooth(g, raw)
}

/** 视线拉直:从当前点出发,能直接看到的最远一个点就是下一个拐点。首尾两段(可能在障碍里)原样保留。 */
function smooth(g: NavGrid, pts: Pt[]): Pt[] {
  if (pts.length <= 2) return pts
  const out: Pt[] = [pts[0]]
  let i = 0
  while (i < pts.length - 1) {
    let j = pts.length - 1
    while (j > i + 1 && !(lineFree(g, pts[i], pts[j]) || (i === 0 && j === 1))) j--
    out.push(pts[j])
    i = j
  }
  return out
}

/** 路径总长。 */
export function pathLength(p: readonly Pt[]): number {
  let d = 0
  for (let i = 1; i < p.length; i++) d += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1])
  return d
}
