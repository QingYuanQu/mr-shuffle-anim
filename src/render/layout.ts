/**
 * 布局几何：SVG 拓扑层与 Canvas 数据流层共用同一套坐标，
 * 保证两层严格对齐（数据块飞向的正是拓扑图上的那个 reducer）。
 */

export const VIEW_W = 1180
export const VIEW_H = 660

/** 画布安全区 */
export const PAD = 40

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface MapBox extends Box {
  id: number
}

export interface ReducerBox extends Box {
  id: number
}

/** Map 端列（左），Reduce 端列（右） */
export const MAP_X = 76
export const MAP_W = 168
export const RED_X = VIEW_W - 76 - 184
export const RED_W = 184

/** Map 端内部：缓冲区 / 溢写文件 / 合并文件 三段 */
export const BUF_X = MAP_X + MAP_W + 18
export const BUF_W = 150
export const SPILL_X = BUF_X + BUF_W + 16
export const SPILL_W = 146
export const FILE_X = SPILL_X + SPILL_W + 16
export const FILE_W = 150

/** 上下留白给标题 */
export const TOP_Y = 96
export const BOT_Y = VIEW_H - 74

export function mapBoxY(i: number, n: number): number {
  const usable = BOT_Y - TOP_Y
  const h = mapBoxH(n)
  const gap = (usable - h * n) / Math.max(n - 1, 1)
  return TOP_Y + i * (h + gap)
}

export function mapBoxH(n: number): number {
  const usable = BOT_Y - TOP_Y
  return Math.min(84, usable / Math.max(n, 1) - 14)
}

export function reducerBoxY(i: number, n: number): number {
  const usable = BOT_Y - TOP_Y
  const h = Math.min(96, usable / Math.max(n, 1) - 20)
  const gap = (usable - h * n) / Math.max(n - 1, 1)
  return TOP_Y + i * (h + gap)
}

export function reducerBoxH(n: number): number {
  const usable = BOT_Y - TOP_Y
  return Math.min(96, usable / Math.max(n, 1) - 20)
}

/** 数据块尺寸 */
export const CHIP_W = 34
export const CHIP_H = 19
export const CHIP_GAP = 5

/** 网络传输区（两条分流带） */
export const NET_X0 = MAP_X + MAP_W + 34
export const NET_X1 = RED_X - 34

/** 传输起点：留出间隙，避免飞行块压住 Map 框内的文字 */
export const FLOW_X0 = MAP_X + MAP_W + 22
export const FLOW_X1 = RED_X - 22

/** 特写视图的栏位（占满画布宽度） */
export const FOCUS_Y = 104
export const FOCUS_H = 420

export const FOCUS_COLS = {
  map: [
    { x: 40, w: 336 },
    { x: 404, w: 336 },
    { x: 768, w: 372 },
  ],
  reduce: [
    { x: 40, w: 336 },
    { x: 404, w: 336 },
    { x: 768, w: 372 },
  ],
} as const

/** 传输路径：从 map 框右边到 reducer 框左边，二次贝塞尔的控制点（取中点） */
export function flowPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
): { x: number; y: number } {
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
}

export function quadPoint(
  p0: { x: number; y: number },
  c: { x: number; y: number },
  p1: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  const mt = 1 - t
  return {
    x: mt * mt * p0.x + 2 * mt * t * c.x + t * t * p1.x,
    y: mt * mt * p0.y + 2 * mt * t * c.y + t * t * p1.y,
  }
}

/** 缓动 */
export function easeInOut(t: number): number {
  const c = Math.max(0, Math.min(1, t))
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2
}

export function easeOut(t: number): number {
  const c = Math.max(0, Math.min(1, t))
  return 1 - Math.pow(1 - c, 3)
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** 把时间映射到 [0,1] 的进度 */
export function progress(t: number, t0: number, t1: number): number {
  if (t1 <= t0) return t >= t1 ? 1 : 0
  return clamp01((t - t0) / (t1 - t0))
}
