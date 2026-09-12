/**
 * K-means 聚类（手写实现）。
 *
 * 整个算法只有两步，交替做，直到质心不再动：
 *
 *   1. **分派**：把每个点分给离它最近的质心（这一步把 inertia 降到"给定质心下的最小"）
 *   2. **更新**：把每个质心移到它那一簇的均值位置（这一步把 inertia 降到"给定分派下的最小"）
 *
 * 所以 K-means 是**坐标下降**：每一步都保证 inertia 不增，因此一定收敛——
 * 但只保证收敛到**局部**最优，结果取决于初始质心。这就是它对初始化敏感、
 * 以及实践中要跑多次取最优（n_init）的原因。
 *
 * 空簇的处理：某个簇一个点都没分到时，它的质心无处可移。sklearn 的做法是
 * 把空簇搬到「离其他质心最远」的样本点上——本实现照做，这样两边行为一致、可对拍。
 *
 * 对拍：给**相同的初始质心**，KMeans 是确定性的，
 * 所以 labels / inertia / 质心坐标都能逐项比对（scripts/crosscheck_kmeans.py）。
 */

import { mulberry32 } from '../data/prng'

export type Point = [number, number]

function sqDist(a: Point, b: Point): number {
  const dx = a[0] - b[0]
  const dy = a[1] - b[1]
  return dx * dx + dy * dy
}

/** 每个点到最近质心的距离平方 */
export function nearestCentroid(p: Point, centroids: Point[]): { idx: number; d2: number } {
  let idx = 0
  let best = Infinity
  for (let c = 0; c < centroids.length; c++) {
    const d = sqDist(p, centroids[c])
    if (d < best) {
      best = d
      idx = c
    }
  }
  return { idx, d2: best }
}

/** 分派：每个点归给最近的质心 */
export function assignStep(samples: Point[], centroids: Point[]): number[] {
  return samples.map((p) => nearestCentroid(p, centroids).idx)
}

/** 簇内平方和（inertia）——K-means 真正在最小化的目标函数 */
export function inertiaOf(samples: Point[], centroids: Point[], labels?: number[]): number {
  if (labels) {
    let s = 0
    for (let i = 0; i < samples.length; i++) s += sqDist(samples[i], centroids[labels[i]])
    return s
  }
  let s = 0
  for (const p of samples) s += nearestCentroid(p, centroids).d2
  return s
}

/**
 * 更新：每个质心移到簇内均值。
 * 空簇按 sklearn 的策略重定位——搬到"离最近质心最远"的那个样本点上。
 */
export function updateStep(
  samples: Point[],
  labels: number[],
  k: number,
  prevCentroids: Point[],
): Point[] {
  const sums: [number, number][] = Array.from({ length: k }, () => [0, 0])
  const counts = new Array(k).fill(0)
  for (let i = 0; i < samples.length; i++) {
    const c = labels[i]
    sums[c][0] += samples[i][0]
    sums[c][1] += samples[i][1]
    counts[c]++
  }

  const next: Point[] = []
  const empty: number[] = []
  for (let c = 0; c < k; c++) {
    if (counts[c] === 0) {
      next.push([prevCentroids[c][0], prevCentroids[c][1]])
      empty.push(c)
    } else {
      next.push([sums[c][0] / counts[c], sums[c][1] / counts[c]])
    }
  }

  if (empty.length > 0) {
    // 空簇重定位：把空簇搬到「离最近质心最远」的样本点上。
    // 注意这里的距离要用**更新前**的质心（prevCentroids）来算——sklearn 就是这么做的。
    // 初版用的是更新后的非空质心，选出来的点不一样，两条路径立刻分岔
    // （iris k=3 那组对拍抓到的：我选了 [6.9, 2.3]，sklearn 选了 [3.8, 1.1]）。
    const far = samples
      .map((p, i) => {
        let best = Infinity
        for (const c of prevCentroids) best = Math.min(best, sqDist(p, c))
        return { i, d: best }
      })
      .sort((a, b) => b.d - a.d)
    empty.forEach((c, t) => {
      const pick = far[Math.min(t, far.length - 1)]
      next[c] = [samples[pick.i][0], samples[pick.i][1]]
    })
  }

  return next
}

/** 随机初始化：从样本里不放回地抽 k 个点 */
export function randomInit(samples: Point[], k: number, seed = 1): Point[] {
  const rnd = mulberry32(seed)
  const used = new Set<number>()
  const out: Point[] = []
  while (out.length < k && used.size < samples.length) {
    const i = Math.floor(rnd() * samples.length)
    if (used.has(i)) continue
    used.add(i)
    out.push([samples[i][0], samples[i][1]])
  }
  return out
}

/**
 * k-means++ 初始化：第一个质心随机，之后每个质心按"被选中的概率正比于
 * 它到已有质心距离的平方"来抽。
 *
 * 这一步就是为了治"随机初始化容易撞上坏起点"：离已有质心越远的点越可能被选上，
 * 于是初始质心天然分散开。
 */
export function kmeansppInit(samples: Point[], k: number, seed = 1): Point[] {
  const rnd = mulberry32(seed)
  const n = samples.length
  const first = Math.floor(rnd() * n)
  const out: Point[] = [[samples[first][0], samples[first][1]]]

  const d2 = samples.map((p) => sqDist(p, out[0]))
  while (out.length < k) {
    let total = 0
    for (let i = 0; i < n; i++) total += d2[i]
    if (total <= 0) {
      // 所有点都重合了，随便补一个
      const i = Math.floor(rnd() * n)
      out.push([samples[i][0], samples[i][1]])
      continue
    }
    let r = rnd() * total
    let pick = 0
    for (let i = 0; i < n; i++) {
      r -= d2[i]
      if (r <= 0) {
        pick = i
        break
      }
    }
    out.push([samples[pick][0], samples[pick][1]])
    // 新质心进来，更新每个点的最近距离
    for (let i = 0; i < n; i++) d2[i] = Math.min(d2[i], sqDist(samples[i], out[out.length - 1]))
  }
  return out
}

export interface KMeansStep {
  iter: number
  centroids: Point[]
  labels: number[]
  inertia: number
  /** 这一步做了什么：'init' | 'assign' | 'update' */
  phase: 'init' | 'assign' | 'update'
}

export interface KMeansResult {
  centroids: Point[]
  labels: number[]
  inertia: number
  iters: number
  converged: boolean
  /** 每一步的快照，用于逐步演示 */
  steps: KMeansStep[]
}

/**
 * 跑完整的 Lloyd 迭代。
 *
 * 停止判据对齐 sklearn（`_kmeans_single_lloyd`），它有**两条**，按顺序检查：
 *   ① **标签不再变化** → 严格收敛，直接停（这是 sklearn 的主判据）
 *   ② 否则再看质心位移是否足够小
 *
 * 初版只用了 ②，并且把 tol 取成 sklearn 的 1e-4——结果圈子那个数据集我停在第 5 轮、
 * sklearn 跑到第 6 轮（因为第 6 轮标签才稳定），最终 inertia 差了 0.018。
 * 逐轮对比才发现：**sklearn 的 center_shift 存的是平方距离，判据又是它的平方和**，
 * 量纲和"位移平方和"根本不是一回事，直接套同一个数就会提前停。
 * 所以这里以 ① 为主，② 的 tol 取一个很小的值（1e-8）做兜底。
 */
export function runKMeans(
  samples: Point[],
  init: Point[],
  maxIter = 300,
  tol = 1e-8,
): KMeansResult {
  const k = init.length
  let centroids: Point[] = init.map((c) => [c[0], c[1]])
  const steps: KMeansStep[] = [
    {
      iter: 0,
      centroids: centroids.map((c) => [c[0], c[1]]),
      labels: assignStep(samples, centroids),
      inertia: inertiaOf(samples, centroids),
      phase: 'init',
    },
  ]

  let labels = steps[0].labels
  let converged = false
  let it = 0
  for (; it < maxIter; it++) {
    const prevLabels = labels
    const nextCentroids = updateStep(samples, labels, k, centroids)
    let shiftSq = 0
    for (let c = 0; c < k; c++) {
      const dx = nextCentroids[c][0] - centroids[c][0]
      const dy = nextCentroids[c][1] - centroids[c][1]
      shiftSq += dx * dx + dy * dy
    }
    centroids = nextCentroids
    labels = assignStep(samples, centroids)
    steps.push({
      iter: it + 1,
      centroids: centroids.map((c) => [c[0], c[1]]),
      labels: labels.slice(),
      inertia: inertiaOf(samples, centroids, labels),
      phase: 'update',
    })

    let labelsSame = true
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] !== prevLabels[i]) {
        labelsSame = false
        break
      }
    }
    if (labelsSame || shiftSq <= tol) {
      converged = true
      break
    }
  }

  return {
    centroids,
    labels,
    inertia: inertiaOf(samples, centroids, labels),
    iters: it + 1,
    converged,
    steps,
  }
}

/**
 * 跑 nInit 次取 inertia 最小的（实践中必做的一步）。
 * 返回每次的结果，页面用它演示"换个起点结果就不一样"。
 */
export function runWithRestarts(
  samples: Point[],
  k: number,
  nInit: number,
  useKmeanspp: boolean,
  seedBase = 20240910,
): { best: KMeansResult; all: KMeansResult[] } {
  const all: KMeansResult[] = []
  for (let r = 0; r < nInit; r++) {
    const seed = seedBase + r * 104729
    const init = useKmeanspp ? kmeansppInit(samples, k, seed) : randomInit(samples, k, seed)
    all.push(runKMeans(samples, init))
  }
  let best = all[0]
  for (const r of all) if (r.inertia < best.inertia) best = r
  return { best, all }
}

/** 每个簇的样本数 */
export function clusterSizes(labels: number[], k: number): number[] {
  const out = new Array(k).fill(0)
  for (const l of labels) out[l]++
  return out
}
