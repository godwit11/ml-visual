/**
 * PCA 演示用的数据集。
 *
 * 四套，分工不同：
 *   - **鸢尾花（4 维真实数据）**：主菜。四个特征（萼片长/宽、花瓣长/宽）。
 *     第 1 主成分独占 92.5% 的方差——这不是"算法很神"，
 *     而是因为四个特征都主要在描述**同一件事：花的大小**。
 *   - **相关二维数据**：两个特征高度相关，一眼能看出"斜着的那条线"。
 *     最直观的一组——二维降到一维，数据几乎没丢。
 *   - **不相关二维数据**：两个特征独立（团是正的），
 *     此时 PCA 救不了你——两个方向方差差不多，降维必然丢一半。
 *   - **标准化后的鸢尾花**：同一份数据，先 z-score 再 PCA，
 *     第 1 主成分从 92.5% 掉到 73.0%。**量纲会决定"主成分"是谁**，
 *     这是实践中最容易踩的坑。
 *
 * 所有数据都可用固定种子复现（mulberry32）。
 */

import { mulberry32, gaussian } from './prng'

export type Row = number[]

export interface PcaDataset {
  id: string
  name: string
  desc: string
  /** 特征名，图上要标 */
  featureNames: string[]
  data: Row[]
  /** 是否已经标准化过（页面据此提示） */
  standardized: boolean
  /** 真实标签（只有鸢尾花有），上色用 */
  labels?: number[]
  classNames?: string[]
}

/** 两个特征高度相关：y ≈ 0.8x + 噪声。斜着的长条 */
export function makeCorrelated(n: number, noise: number, seed = 20240910): Row[] {
  const rnd = mulberry32(seed)
  const out: Row[] = []
  for (let i = 0; i < n; i++) {
    const x = gaussian(rnd) * 2 + 5
    out.push([x, 0.8 * x + gaussian(rnd) * noise + 1])
  }
  return out
}

/** 两个特征独立：方差差不多，方向无法压缩 */
export function makeUncorrelated(n: number, seed = 20240910): Row[] {
  const rnd = mulberry32(seed)
  const out: Row[] = []
  for (let i = 0; i < n; i++) {
    out.push([gaussian(rnd) * 1.6, gaussian(rnd) * 1.4])
  }
  return out
}

/**
 * 手工铺一组「明显有主方向」的三维数据（可以不加真实标签），
 * 让页面在 3 维上也能演示：降 3→2 几乎无损。
 */
export function makeCloud3D(n: number, seed = 20240910): Row[] {
  const rnd = mulberry32(seed)
  const out: Row[] = []
  for (let i = 0; i < n; i++) {
    // 沿一条斜轴的强变化 + 两个方向的弱变化
    const t = gaussian(rnd) * 3.0
    out.push([
      t * 0.8 + gaussian(rnd) * 0.28,
      t * 0.5 + gaussian(rnd) * 0.26,
      -t * 0.35 + gaussian(rnd) * 0.22,
    ])
  }
  return out
}

/** 逐列标准化（z-score）——页面与对拍共用，避免两处算法不一致 */
export function standardize(data: Row[]): Row[] {
  const n = data.length
  const p = n > 0 ? data[0].length : 0
  const mu = new Array(p).fill(0)
  for (const r of data) for (let j = 0; j < p; j++) mu[j] += r[j]
  for (let j = 0; j < p; j++) mu[j] /= n || 1

  const sd = new Array(p).fill(0)
  for (const r of data) for (let j = 0; j < p; j++) sd[j] += (r[j] - mu[j]) ** 2
  for (let j = 0; j < p; j++) sd[j] = Math.sqrt(sd[j] / ((n - 1) || 1)) || 1

  return data.map((r) => r.map((v, j) => (v - mu[j]) / sd[j]))
}

export function buildPcaDatasets(iris: { sl: number; sw: number; pl: number; pw: number; y: number }[]): PcaDataset[] {
  const irisData: Row[] = iris.map((d) => [d.sl, d.sw, d.pl, d.pw])
  const irisLabels = iris.map((d) => d.y)

  return [
    {
      id: 'iris',
      name: '鸢尾花（4 维真实数据）',
      desc:
        '150 朵真花的四个测量值。第 1 主成分一个人吃掉了 92.5% 的方差——' +
        '因为"萼片长、花瓣长、花瓣宽"基本都在描述同一件事：这朵花有多大。',
      featureNames: ['萼片长', '萼片宽', '花瓣长', '花瓣宽'],
      data: irisData,
      standardized: false,
      labels: irisLabels,
      classNames: ['setosa', 'versicolor', 'virginica'],
    },
    {
      id: 'iris-std',
      name: '鸢尾花（标准化后）',
      desc:
        '同一份数据，先把每个特征 z-score 再算 PCA。第 1 主成分从 92.5% 掉到 73.0%——' +
        '因为标准化之后，"萼片宽"这个原本被大数特征压住的方向终于能说话了。' +
        '**要不要标准化，决定了你算出来的是"哪个主成分"**。',
      featureNames: ['萼片长', '萼片宽', '花瓣长', '花瓣宽'],
      data: standardize(irisData),
      standardized: true,
      labels: irisLabels,
      classNames: ['setosa', 'versicolor', 'virginica'],
    },
    {
      id: 'corr',
      name: '相关二维数据（降维有用）',
      desc:
        '两个高度相关的特征，点云是一条斜长条。第 1 主成分顺着长条方向，' +
        '降成一维只丢掉不到 1% 的信息——**特征冗余的时候，降维几乎是白送的**。',
      featureNames: ['特征 1', '特征 2'],
      data: makeCorrelated(300, 0.45),
      standardized: false,
    },
    {
      id: 'uncorr',
      name: '不相关二维数据（降维没用）',
      desc:
        '两个独立的高斯特征，点云是一个正着的圆团。两个方向方差差不多（约 55% : 45%），' +
        '降成一维必然丢掉近一半信息——**没有冗余，就没有可压缩的空间**。',
      featureNames: ['特征 1', '特征 2'],
      data: makeUncorrelated(300),
      standardized: false,
    },
    {
      id: 'cloud3d',
      name: '三维点云（3 维降 2 维）',
      desc:
        '一个被压扁的三维点云：沿某条斜轴的方差远大于其余两个方向。' +
        '降 3→2 能保住 99% 以上的方差，这正是"用二维图讲三维数据"的底气。',
      featureNames: ['x', 'y', 'z'],
      data: makeCloud3D(400),
      standardized: false,
    },
  ]
}
