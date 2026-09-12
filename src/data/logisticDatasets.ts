/**
 * Logistic 回归演示用的数据集。
 *
 * 两条原则（和决策树页一致）：
 *   1. 可复现 —— 固定种子的 PRNG，绝不用 Math.random
 *   2. 真实数据不手打 —— 乳腺癌数据来自 sklearn.datasets.load_breast_cancer 原样导出
 *
 * 关于标准化：
 *   每个特征各自做 z-score（减均值、除以自己的标准差）。
 *   这里踩过一个坑：最初为了"不让月牙变形"，用**同一个**缩放因子（取两个特征中较大的标准差）。
 *   合成数据看着没问题，但真实数据上两个特征量纲差了 500 倍（周长 33.6 vs 凹点数 0.066），
 *   小量纲那个被压成了 0.005 量级——模型等于只用了一个特征，准确率从 94% 掉到 91.9%，
 *   梯度下降也走不动。是对拍脚本把它揪出来的。
 *   结论：**各自标准化**（这是标准做法），形状那点变形换来的是数值上能训练。
 */
import { mulberry32, gaussian, shuffle } from './prng'

export interface LogiPoint {
  x: [number, number]
  y: 0 | 1
}

export interface LogiDataset {
  id: string
  name: string
  desc: string
  featureNames: [string, string]
  classNames: [string, string]
  points: LogiPoint[]
  /** 图上坐标 → 原始坐标的还原参数：原始值 = 图上值 × std + mean */
  scale: { mean: [number, number]; std: [number, number] }
}

/** 两团高斯：中心距 2d，标准差 sd */
function twoBlobs(n: number, d: number, sd: number, seed: number): LogiPoint[] {
  const rnd = mulberry32(seed)
  const out: LogiPoint[] = []
  for (let i = 0; i < n; i++) {
    out.push({ x: [-d + sd * gaussian(rnd), -d + sd * gaussian(rnd)], y: 0 })
  }
  for (let i = 0; i < n; i++) {
    out.push({ x: [d + sd * gaussian(rnd), d + sd * gaussian(rnd)], y: 1 })
  }
  return shuffle(out, seed + 1)
}

/** 两弯月牙：任何一条直线都切不开，用来展示 Logistic 回归的天花板 */
function moons(n: number, noise: number, seed: number): LogiPoint[] {
  const rnd = mulberry32(seed)
  const half = Math.floor(n / 2)
  const out: LogiPoint[] = []
  for (let i = 0; i < half; i++) {
    const t = (Math.PI * i) / (half - 1)
    out.push({ x: [Math.cos(t) + noise * gaussian(rnd), Math.sin(t) + noise * gaussian(rnd)], y: 0 })
  }
  for (let i = 0; i < n - half; i++) {
    const t = (Math.PI * i) / (n - half - 1)
    out.push({
      x: [1 - Math.cos(t) + noise * gaussian(rnd), 1 - Math.sin(t) - 0.5 + noise * gaussian(rnd)],
      y: 1,
    })
  }
  return shuffle(out, seed + 1)
}

/**
 * 逐特征 z-score。
 * 返回每个特征的 (均值, 标准差)，代码桥里要告诉用户"图上坐标 ≠ 原始值"。
 */
function standardize(
  points: LogiPoint[],
): { points: LogiPoint[]; mean: [number, number]; std: [number, number] } {
  const n = points.length
  const mean: [number, number] = [0, 0]
  for (const p of points) {
    mean[0] += p.x[0]
    mean[1] += p.x[1]
  }
  mean[0] /= n
  mean[1] /= n

  const std: [number, number] = [0, 0]
  for (const p of points) {
    std[0] += (p.x[0] - mean[0]) ** 2
    std[1] += (p.x[1] - mean[1]) ** 2
  }
  std[0] = Math.sqrt(std[0] / n) || 1
  std[1] = Math.sqrt(std[1] / n) || 1

  const out = points.map((p) => ({
    x: [(p.x[0] - mean[0]) / std[0], (p.x[1] - mean[1]) / std[1]] as [number, number],
    y: p.y,
  }))
  return { points: out, mean, std }
}

export function buildLogiDatasets(
  breast: { a: number; b: number; y: number }[],
): LogiDataset[] {
  const mk = (
    id: string,
    name: string,
    desc: string,
    featureNames: [string, string],
    classNames: [string, string],
    raw: LogiPoint[],
  ): LogiDataset => {
    const { points, mean, std } = standardize(raw)
    return { id, name, desc, featureNames, classNames, points, scale: { mean, std } }
  }

  return [
    mk(
      'separable',
      '线性可分',
      '两团分得开的高斯云。Logistic 回归在这里如鱼得水，一条直线就能切开。',
      ['x₁（已标准化）', 'x₂（已标准化）'],
      ['类别 A', '类别 B'],
      twoBlobs(140, 1.1, 0.55, 5),
    ),
    mk(
      'overlap',
      '有重叠',
      '两团叠在一起。这时候没有完美答案，只能找一条"错得最少"的线。',
      ['x₁（已标准化）', 'x₂（已标准化）'],
      ['类别 A', '类别 B'],
      twoBlobs(140, 0.62, 0.95, 9),
    ),
    mk(
      'moons',
      '月牙（线性不可分）',
      '两道交错的月牙。无论怎么调，Logistic 回归只能给出一条直线——这是它的天花板。',
      ['x₁（已标准化）', 'x₂（已标准化）'],
      ['上弦', '下弦'],
      moons(280, 0.14, 13),
    ),
    mk(
      'breast',
      '乳腺癌（真实数据）',
      '569 例乳腺肿块的真实检查数据：最大周长 × 最大凹点数，判断恶性 / 良性。' +
        '取自 sklearn 自带的威斯康星数据集，这两个特征是全部 30 个特征里区分度最高的两个。',
      ['最大周长（标准化）', '最大凹点数（标准化）'],
      ['恶性', '良性'],
      breast.map((d) => ({ x: [d.a, d.b], y: d.y as 0 | 1 })),
    ),
  ]
}
