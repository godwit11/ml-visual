/**
 * 聚类演示用的数据集。
 *
 * 四套，分工不同：
 *   - **高斯团**：K-means 的主场。簇是圆形的、大小相近，它做得很好。
 *   - **月牙 / 同心圆**：K-means 的滑铁卢。它只会用直线把平面切开，
 *     遇到弯曲的簇结构必然切错——这是"K-means 只能找凸簇"最直观的证据。
 *   - **鸢尾花（真实）**：150 朵真花的花瓣长宽。**有真实品种标签**，
 *     可以拿来算"聚类结果和真实分类有多吻合"（用纯度来衡量）。
 */

import { mulberry32, gaussian } from './prng'
import { makeMoons, makeCircles } from './treeDatasets'

export type Point = [number, number]

export interface ClusterDataset {
  id: string
  name: string
  desc: string
  /** 是否是"K-means 擅长的结构"，页面上据此给提示 */
  suited: boolean
  points: Point[]
  /** 真实标签（只有鸢尾花有），用来算纯度 */
  trueLabels?: number[]
  trueClassNames?: string[]
}

/**
 * k 个高斯团，中心均匀排在一个圆上。
 * spread 越大簇之间越糊（K-means 越难分）。
 */
export function makeBlobs(n: number, k: number, spread: number, seed = 20240910): Point[] {
  const rnd = mulberry32(seed)
  const R = k <= 4 ? 2.2 : 3.0
  const out: Point[] = []
  for (let i = 0; i < n; i++) {
    const c = i % k
    const a = (2 * Math.PI * c) / k + 0.4
    out.push([R * Math.cos(a) + spread * gaussian(rnd), R * Math.sin(a) + spread * gaussian(rnd)])
  }
  return out
}

export function buildClusterDatasets(iris: { pl: number; pw: number; y: number }[]): ClusterDataset[] {
  return [
    {
      id: 'blobs',
      name: '高斯团',
      desc: '几个圆形的高斯团。这是 K-means 的主场——它就是为这种结构设计的。',
      suited: true,
      points: makeBlobs(300, 4, 0.55),
    },
    {
      id: 'moons',
      name: '月牙',
      desc: '两道交错的月牙。K-means 只会用直线把平面切开，必然把弯的那一头切错——它看不见"弯曲"这件事。',
      suited: false,
      points: makeMoons(240, 0.14, 7).map((s) => [s.x[0], s.x[1]] as Point),
    },
    {
      id: 'circles',
      name: '同心圆',
      desc: '内外两个圈。这一组更惨：K-means 会把外圈从中间劈成两半（因为"平分"通常是它更省力的选择）。',
      suited: false,
      points: makeCircles(240, 0.07, 0.5, 11).map((s) => [s.x[0], s.x[1]] as Point),
    },
    {
      id: 'iris',
      name: '鸢尾花（真实 150 朵）',
      desc: '花瓣长 × 花瓣宽，三个真实品种。数据本身没给 K-means 标签，但它聚出来的三团和真实品种有多吻合，可以用"纯度"量出来——这正是无监督聚类的评价方式。',
      suited: true,
      points: iris.map((d) => [d.pl, d.pw] as Point),
      trueLabels: iris.map((d) => d.y),
      trueClassNames: ['setosa', 'versicolor', 'virginica'],
    },
  ]
}

/**
 * 聚类纯度：每个簇取其中出现最多的真实类别，把它们的正确样本数加起来除以总数。
 * 这是无监督结果常用的外部评价指标（不依赖簇的编号）。
 */
export function purityOf(labels: number[], trueLabels: number[], k: number): number {
  const n = labels.length
  // 列联表：簇 × 真实类别
  const table: number[][] = Array.from({ length: k }, () => [])
  for (let i = 0; i < n; i++) {
    const c = labels[i]
    const t = trueLabels[i]
    while (table[c].length <= t) table[c].push(0)
    table[c][t]++
  }
  let correct = 0
  for (const row of table) {
    let best = 0
    for (const v of row) if (v > best) best = v
    correct += best
  }
  return correct / n
}
