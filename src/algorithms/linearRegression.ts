export interface Point {
  x: number
  y: number
}

export interface Fit {
  w: number
  b: number
}

export function predict(x: number, fit: Fit): number {
  return fit.w * x + fit.b
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0
  let s = 0
  for (const v of values) s += v
  return s / values.length
}

export function mae(points: Point[], fit: Fit): number {
  if (points.length === 0) return 0
  let s = 0
  for (const p of points) s += Math.abs(p.y - predict(p.x, fit))
  return s / points.length
}

export function mse(points: Point[], fit: Fit): number {
  if (points.length === 0) return 0
  let s = 0
  for (const p of points) {
    const r = p.y - predict(p.x, fit)
    s += r * r
  }
  return s / points.length
}

export function r2(points: Point[], fit: Fit): number {
  if (points.length === 0) return 0
  const yBar = mean(points.map((p) => p.y))
  let ssTot = 0
  for (const p of points) ssTot += (p.y - yBar) ** 2
  if (ssTot === 0) return 0
  return 1 - (mse(points, fit) * points.length) / ssTot
}

/** 一元线性回归的闭式解（最小二乘）。 */
export function ols(points: Point[]): Fit {
  const n = points.length
  if (n === 0) return { w: 0, b: 0 }
  const xBar = mean(points.map((p) => p.x))
  const yBar = mean(points.map((p) => p.y))
  let num = 0
  let den = 0
  for (const p of points) {
    num += (p.x - xBar) * (p.y - yBar)
    den += (p.x - xBar) ** 2
  }
  const w = den === 0 ? 0 : num / den
  return { w, b: yBar - w * xBar }
}
