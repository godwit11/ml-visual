/**
 * 神经网络演示用的数据集。
 *
 * 选数据的原则：**必须让"线性模型做不到"这件事肉眼可见**。
 * 否则加隐层、换激活函数都看不出区别，整页就没有说服力。
 *
 *   - **异或 XOR**：最经典的反例。四个点，任何一条直线都分不开
 *     （这就是 1969 年把神经网络打入冷宫的 Minsky 例子）。
 *     但加一个隐层就秒解——它是"必须非线性"的最干净的证据。
 *   - **同心圆 / 月牙**：弯曲的决策边界。单层（逻辑回归）只能切直线，
 *     多层网络能把它掰弯。
 *   - **螺旋**：三类交错，需要很弯曲的边界。看"深度不够会怎样"。
 *   - **鸢尾花（真实 150 朵 4 维）**：真实数据上的多分类。
 */

import { mulberry32, gaussian } from './prng'
import { makeMoons, makeCircles } from './treeDatasets'

export type Row = number[]

export interface NnDataset {
  id: string
  name: string
  desc: string
  /** 输入维度 */
  nFeatures: number
  /** 类别数 */
  nClasses: number
  /** 特征名 */
  featureNames: string[]
  classNames: string[]
  data: Row[]
  labels: number[]
  /** 页面建议的隐层结构（对这份数据容易训好的） */
  suggested: number[]
  /**
   * 建议的学习率。
   *
   * ⚠️ 为什么每个数据集要带自己的学习率：**学习率和数据尺度是耦合的**。
   * 二维玩具数据都已经落在 [-1, 1] 附近，梯度小，lr=0.3 很合适；
   * 而鸢尾花是**原始量纲**（萼片长 4.3~7.9、花瓣宽 0.1~2.5，差了近两个数量级），
   * 同一个 lr=0.3 会直接让训练卡在"三类概率各 1/3"（损失停在 ln3≈1.10）。
   * 实测：鸢尾花在 lr=0.1 时能到 98%，lr=0.3 只有 33% —— 差别全在这里。
   * 这就是"数据不缩放时，学习率必须调小"的现场证据（页面上可以直接玩出来）。
   */
  suggestedLr: number
}

/** 异或：四个点，直线绝对分不开 */
export function makeXor(noise: number, seed = 20240910): { data: Row[]; labels: number[] } {
  const rnd = mulberry32(seed)
  const data: Row[] = []
  const labels: number[] = []
  const base: [number, number, number][] = [
    [-1, -1, 0],
    [-1, 1, 1],
    [1, -1, 1],
    [1, 1, 0],
  ]
  for (let rep = 0; rep < 40; rep++) {
    for (const [x, y, c] of base) {
      data.push([x + gaussian(rnd) * noise, y + gaussian(rnd) * noise])
      labels.push(c)
    }
  }
  return { data, labels }
}

/** 双螺旋：两类交错缠绕，需要很弯的边界 */
export function makeSpiral(n: number, noise: number, seed = 20240910): { data: Row[]; labels: number[] } {
  const rnd = mulberry32(seed)
  const data: Row[] = []
  const labels: number[] = []
  const nClasses = 2
  for (let c = 0; c < nClasses; c++) {
    for (let i = 0; i < n; i++) {
      const r = (i / n) * 2.2
      const t = ((i / n) * 3.4 + c * Math.PI) + gaussian(rnd) * 0.06
      data.push([r * Math.sin(t) + gaussian(rnd) * noise, r * Math.cos(t) + gaussian(rnd) * noise])
      labels.push(c)
    }
  }
  return { data, labels }
}

export function buildNnDatasets(iris: { sl: number; sw: number; pl: number; pw: number; y: number }[]): NnDataset[] {
  const xor = makeXor(0.16)
  const spiral = makeSpiral(90, 0.07)
  const moons = makeMoons(240, 0.14, 7)
  const circles = makeCircles(240, 0.07, 0.5, 11)

  return [
    {
      id: 'xor',
      name: '异或 XOR',
      desc:
        '四个点，两类在对角线上。**任何一条直线都分不开它**——' +
        '这就是 1969 年让神经网络被打入冷宫的那个例子。' +
        '看页面上的「无激活」对比：没有隐层非线性，它连这个都学不会。',
      nFeatures: 2,
      nClasses: 2,
      featureNames: ['x₁', 'x₂'],
      classNames: ['类别 0', '类别 1'],
      data: xor.data,
      labels: xor.labels,
      suggested: [2, 4, 1],
      suggestedLr: 0.3,
    },
    {
      id: 'moons',
      name: '月牙',
      desc:
        '两道交错的月牙。Logistic 回归只能切一条直线，怎么摆都会错一片；' +
        '加一个隐层，决策边界就能弯过来包住月牙。**这是"深度带来表达能力"最直观的一屏。**',
      nFeatures: 2,
      nClasses: 2,
      featureNames: ['x₁', 'x₂'],
      classNames: ['类别 0', '类别 1'],
      data: moons.map((s) => [s.x[0], s.x[1]] as Row),
      labels: moons.map((s) => s.y),
      suggested: [2, 8, 1],
      suggestedLr: 0.3,
    },
    {
      id: 'circles',
      name: '同心圆',
      desc:
        '内圈外圈。需要一条**闭合**的边界才能分开——单个隐层就有点吃力了，' +
        '把隐层加到两层、每层 8 个神经元，边界会明显更圆滑。',
      nFeatures: 2,
      nClasses: 2,
      featureNames: ['x₁', 'x₂'],
      classNames: ['外圈', '内圈'],
      data: circles.map((s) => [s.x[0], s.x[1]] as Row),
      labels: circles.map((s) => s.y),
      suggested: [2, 8, 8, 1],
      suggestedLr: 0.3,
    },
    {
      id: 'spiral',
      name: '双螺旋',
      desc:
        '两类交错缠绕，是这一页最难的一组。**神经元越少越学不动**——' +
        '把隐层从 2 个加到 16 个，看决策边界怎么从"糊成一片"变成顺着螺旋走。',
      nFeatures: 2,
      nClasses: 2,
      featureNames: ['x₁', 'x₂'],
      classNames: ['类别 0', '类别 1'],
      data: spiral.data,
      labels: spiral.labels,
      suggested: [2, 16, 16, 1],
      suggestedLr: 0.3,
    },
    {
      id: 'iris',
      name: '鸢尾花（真实 150 朵）',
      desc:
        '150 朵真花，四个测量值，三个品种。这里是**三分类**，输出层用 softmax，' +
        '损失用交叉熵——和二分类的 sigmoid 只差一个形式的推广。',
      nFeatures: 4,
      nClasses: 3,
      featureNames: ['萼片长', '萼片宽', '花瓣长', '花瓣宽'],
      classNames: ['setosa', 'versicolor', 'virginica'],
      data: iris.map((d) => [d.sl, d.sw, d.pl, d.pw] as Row),
      labels: iris.map((d) => d.y),
      suggested: [4, 8, 3],
      suggestedLr: 0.1,
    },
  ]
}
