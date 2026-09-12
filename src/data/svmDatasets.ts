/**
 * SVM 演示用的数据集。
 *
 * 复用决策树那套合成数据生成器（月牙 / 同心圆），另外补三种：
 *   - 线性可分：专门用来看"最大间隔"到底长什么样（间隔带里一个点都没有）
 *   - 重叠噪声：两类明显交叠，专门用来看软间隔 C 的作用
 *   - 乳腺癌真实子集：真实数据上线性核与 RBF 核的差别
 *
 * 样本数控制在 200 左右：这一页手写的是 SMO，核矩阵是 O(n²)，
 * 样本再多浏览器里会明显卡（真实场景该用 libsvm / 随机傅里叶特征）。
 *
 * 关于量纲：乳腺癌两个特征差 500 倍（周长 251 vs 凹点数 0.29），
 * 不标准化的话 RBF 核会被大量纲特征完全支配。这里做了逐特征 z-score，
 * 并**在页面上说明这是教学简化**（严谨做法应当只用训练集统计量）。
 */

import { mulberry32, gaussian } from './prng'
import { makeMoons, makeCircles, type Sample } from './treeDatasets'

export interface SvmDataset {
  id: string
  name: string
  desc: string
  featureNames: [string, string]
  classNames: [string, string]
  samples: Sample[]
}

/** 两类沿 x 轴分开，间隔明显——最大间隔超平面在这里最直观 */
export function makeLinearSeparable(n = 200, gap = 2.8, spread = 0.5, seed = 21): Sample[] {
  const rnd = mulberry32(seed)
  const half = Math.floor(n / 2)
  const out: Sample[] = []
  for (let i = 0; i < n; i++) {
    const pos = i < half
    const cx = pos ? gap / 2 : -gap / 2
    out.push({ x: [cx + spread * gaussian(rnd), 1.25 * gaussian(rnd)], y: pos ? 1 : 0 })
  }
  return out
}

/** 两团重叠的高斯：硬间隔在这里无解，C 直接决定"容忍多少错分" */
export function makeOverlap(n = 200, sep = 1.5, spread = 1.05, seed = 33): Sample[] {
  const rnd = mulberry32(seed)
  const half = Math.floor(n / 2)
  const out: Sample[] = []
  for (let i = 0; i < n; i++) {
    const pos = i < half
    out.push({
      x: [(pos ? sep / 2 : -sep / 2) + spread * gaussian(rnd), spread * gaussian(rnd)],
      y: pos ? 1 : 0,
    })
  }
  return out
}

/** 等间隔抽 n 个，保持原顺序（可复现） */
function subsample<T>(arr: T[], n: number): T[] {
  const out: T[] = []
  for (let i = 0; i < n; i++) out.push(arr[Math.floor((i * arr.length) / n)])
  return out
}

/** 逐特征 z-score（总体标准差），返回变换后的点和统计量 */
function standardize(samples: Sample[]): Sample[] {
  const n = samples.length
  const mx = [0, 0]
  for (const s of samples) {
    mx[0] += s.x[0]
    mx[1] += s.x[1]
  }
  mx[0] /= n
  mx[1] /= n
  const sd = [0, 0]
  for (const s of samples) {
    sd[0] += (s.x[0] - mx[0]) ** 2
    sd[1] += (s.x[1] - mx[1]) ** 2
  }
  sd[0] = Math.sqrt(sd[0] / n) || 1
  sd[1] = Math.sqrt(sd[1] / n) || 1
  return samples.map((s) => ({
    x: [(s.x[0] - mx[0]) / sd[0], (s.x[1] - mx[1]) / sd[1]] as [number, number],
    y: s.y,
  }))
}

export function buildSvmDatasets(breast: { a: number; b: number; y: number }[]): SvmDataset[] {
  const real = subsample(breast, 200).map((r) => ({
    x: [r.a, r.b] as [number, number],
    y: r.y === 0 ? 1 : 0, // 1 = 恶性
  }))
  const realStd = standardize(real)
  const nPos = realStd.filter((s) => s.y === 1).length

  return [
    {
      id: 'linear',
      name: '线性可分',
      desc: '两类沿一条线分开。看间隔带有多宽——里面一个点都没有，间隔边界上的点就是支持向量。',
      featureNames: ['x₁', 'x₂'],
      classNames: ['负类', '正类'],
      samples: makeLinearSeparable(),
    },
    {
      id: 'overlap',
      name: '重叠噪声（看 C）',
      desc: '两类明显交叠，硬间隔无解。把 C 从小调到大，看它怎么从"容忍错误"变成"死磕每个点"，也看支持向量怎么随之变少。',
      featureNames: ['x₁', 'x₂'],
      classNames: ['负类', '正类'],
      samples: makeOverlap(),
    },
    {
      id: 'moons',
      name: '月牙',
      desc: '线性核怎么调都分不开（准确率卡在 87%）；换成 RBF 核立刻解决。这就是核技巧的意义。',
      featureNames: ['x₁', 'x₂'],
      classNames: ['上弦', '下弦'],
      samples: makeMoons(200, 0.16, 7),
    },
    {
      id: 'circles',
      name: '同心圆',
      desc: '内圈与外圈。RBF 核只需一个高斯就能圈出内圈，而线性核完全没辙。',
      featureNames: ['x₁', 'x₂'],
      classNames: ['外圈', '内圈'],
      samples: makeCircles(200, 0.09, 0.55, 11),
    },
    {
      id: 'breast',
      name: '乳腺癌（真实 200 例）',
      desc: `最大周长 × 最大凹点数的真实数据，恶性 ${nPos} 例（${((nPos / 200) * 100).toFixed(
        0,
      )}%）。已逐特征标准化——不标准化的话量纲差 500 倍，RBF 核会被大的那个特征完全支配。`,
      featureNames: ['最大周长 (标准化)', '最大凹点数 (标准化)'],
      classNames: ['良性', '恶性'],
      samples: realStd,
    },
  ]
}
