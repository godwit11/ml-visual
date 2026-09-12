/**
 * 集成学习（手写实现）：Bagging 与 AdaBoost。
 *
 * 两种思路的对照是这一页的核心：
 *
 *   **Bagging**：并行。每棵树上用一份**自助采样**（有放回）的数据训练，
 *   最后投票。目的是**降方差**——单棵树对数据扰动很敏感，平均很多棵就稳了。
 *
 *   **AdaBoost**：串行。每轮训练一个基学习器，然后**给分错的样本加大权重**，
 *   让下一个基学习器专门盯这些硬骨头。最后按每个基学习器的"发言权" α 加权投票。
 *   目的是**降偏差**——每一步都在纠正前面犯的错。
 *
 * 为什么单独写一份带权重的决策树，而不复用 decisionTree.ts：
 *   AdaBoost 需要"样本权重"（错分样本要更重），而已有的决策树没有这个参数。
 *   集成用的基学习器很深也只有 1~3 层，单独写一份精简实现更干净，
 *   也避免改动已经在线上跑的页面（零回归风险）。
 *
 * 与 sklearn 的关系：AdaBoost 用的是 SAMME（sklearn 1.9 的默认算法），
 * 逐轮的加权错误率与发言权 α 在 scripts/crosscheck_ensemble.py 里对拍。
 */

import { mulberry32 } from '../data/prng'
import type { Sample } from '../data/treeDatasets'

export interface WNode {
  feature?: number
  threshold?: number
  left?: WNode
  right?: WNode
  /** 叶子上的类别（加权多数） */
  cls?: number
  /** 这个节点上的加权样本数 */
  weight: number
  /** 是否叶子 */
  leaf: boolean
}

export interface BaseTreeOptions {
  /** 最大深度：1 就是决策桩（stump），只能切一刀 */
  maxDepth: number
  /** 叶子最少多少个样本（加权前的计数） */
  minSamplesLeaf: number
}

export const DEFAULT_TREE_OPTS: BaseTreeOptions = { maxDepth: 1, minSamplesLeaf: 2 }

function weightedCounts(samples: Sample[], weights: number[], idx: number[], nClasses: number): number[] {
  const out = new Array(nClasses).fill(0)
  for (const i of idx) out[samples[i].y] += weights[i]
  return out
}

/** 加权基尼不纯度 */
function giniW(counts: number[], total: number): number {
  if (total <= 0) return 0
  let s = 0
  for (const c of counts) {
    const p = c / total
    s += p * p
  }
  return 1 - s
}

interface Split {
  feature: number
  threshold: number
  gain: number
}

function bestSplit(
  samples: Sample[],
  weights: number[],
  idx: number[],
  nClasses: number,
  minSamplesLeaf: number,
): Split | null {
  const totalW = idx.reduce((a, i) => a + weights[i], 0)
  if (totalW <= 0) return null
  const parentCounts = weightedCounts(samples, weights, idx, nClasses)
  const parentImp = giniW(parentCounts, totalW)

  let best: Split | null = null
  for (let f = 0; f < 2; f++) {
    const sorted = idx.slice().sort((a, b) => samples[a].x[f] - samples[b].x[f])
    // 从左往右累积，逐个候选阈值试
    const leftCounts = new Array(nClasses).fill(0)
    let wl = 0
    for (let k = 0; k < sorted.length - 1; k++) {
      const cur = sorted[k]
      leftCounts[samples[cur].y] += weights[cur]
      wl += weights[cur]
      const next = sorted[k + 1]
      const v1 = samples[cur].x[f]
      const v2 = samples[next].x[f]
      // 阈值只取相邻两个不同取值的中点（与决策树页、sklearn 同一套规则）
      if (v1 === v2) continue
      // 关键：左右两边都必须满足"叶子的最小样本数"，否则这个分裂根本不合法。
      // 初版漏了这一步，深度 ≥2 时会分出只有一个样本的叶子，与 sklearn 分道扬镳
      // （对拍里表现为 depth=1 完全一致、depth≥2 从某一轮起分岔）。
      const nLeft = k + 1
      const nRight = sorted.length - nLeft
      if (nLeft < minSamplesLeaf || nRight < minSamplesLeaf) continue
      const wr = totalW - wl
      if (wl <= 0 || wr <= 0) continue
      const rightCounts = parentCounts.map((c, ci) => c - leftCounts[ci])
      const gain =
        parentImp - (wl / totalW) * giniW(leftCounts, wl) - (wr / totalW) * giniW(rightCounts, wr)
      if (!best || gain > best.gain) {
        best = { feature: f, threshold: (v1 + v2) / 2, gain }
      }
    }
  }
  return best
}

function makeLeaf(samples: Sample[], weights: number[], idx: number[], nClasses: number): WNode {
  const counts = weightedCounts(samples, weights, idx, nClasses)
  let cls = 0
  for (let c = 1; c < nClasses; c++) if (counts[c] > counts[cls]) cls = c
  return { leaf: true, cls, weight: counts.reduce((a, b) => a + b, 0) }
}

/** 训练一棵带样本权重的决策树 */
export function trainWeightedTree(
  samples: Sample[],
  weights: number[],
  idx: number[],
  nClasses: number,
  opts: BaseTreeOptions = DEFAULT_TREE_OPTS,
): WNode {
  const build = (nodeIdx: number[], depth: number): WNode => {
    const totalW = nodeIdx.reduce((a, i) => a + weights[i], 0)
    // 停止条件：纯节点 / 样本太少 / 到深度上限 / 找不到有效分裂
    const counts = weightedCounts(samples, weights, nodeIdx, nClasses)
    const nonZero = counts.filter((c) => c > 0).length
    if (nonZero <= 1 || nodeIdx.length < opts.minSamplesLeaf * 2 || depth >= opts.maxDepth) {
      return makeLeaf(samples, weights, nodeIdx, nClasses)
    }
    const sp = bestSplit(samples, weights, nodeIdx, nClasses, opts.minSamplesLeaf)
    if (!sp || sp.gain <= 1e-12) return makeLeaf(samples, weights, nodeIdx, nClasses)

    const left: number[] = []
    const right: number[] = []
    for (const i of nodeIdx) {
      if (samples[i].x[sp.feature] <= sp.threshold) left.push(i)
      else right.push(i)
    }
    if (left.length === 0 || right.length === 0) return makeLeaf(samples, weights, nodeIdx, nClasses)

    return {
      leaf: false,
      feature: sp.feature,
      threshold: sp.threshold,
      left: build(left, depth + 1),
      right: build(right, depth + 1),
      weight: totalW,
    }
  }
  return build(idx, 0)
}

export function predictTree(node: WNode, x: number[]): number {
  let cur = node
  while (!cur.leaf) {
    cur = x[cur.feature!] <= cur.threshold! ? cur.left! : cur.right!
  }
  return cur.cls!
}

/* ---------------- Bagging ---------------- */

export interface BaggingModel {
  trees: WNode[]
  /** 每棵树的 bootstrap 索引（对拍时 Python 侧要用同一批） */
  bootstrapIdx: number[][]
  nClasses: number
}

/** 有放回抽 n 个索引（用固定种子，保证可复现） */
export function bootstrapIndices(n: number, seed: number): number[] {
  const rnd = mulberry32(seed)
  const out: number[] = new Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.floor(rnd() * n)
  return out
}

export function trainBagging(
  samples: Sample[],
  nClasses: number,
  nEstimators: number,
  opts: BaseTreeOptions = DEFAULT_TREE_OPTS,
  seed = 20240910,
): BaggingModel {
  const trees: WNode[] = []
  const bootstrapIdx: number[][] = []
  const uniform = new Array(samples.length).fill(1)
  for (let t = 0; t < nEstimators; t++) {
    const idx = bootstrapIndices(samples.length, seed + t * 7919)
    bootstrapIdx.push(idx)
    trees.push(trainWeightedTree(samples, uniform, idx, nClasses, opts))
  }
  return { trees, bootstrapIdx, nClasses }
}

/** Bagging 靠投票：每棵树一票，票多的类别胜出 */
export function baggingPredict(m: BaggingModel, x: number[]): number {
  const votes = new Array(m.nClasses).fill(0)
  for (const t of m.trees) votes[predictTree(t, x)]++
  let best = 0
  for (let c = 1; c < m.nClasses; c++) if (votes[c] > votes[best]) best = c
  return best
}

/** 投票的"确信度"：胜出类别的票数占比 */
export function baggingVotes(m: BaggingModel, x: number[]): number[] {
  const votes = new Array(m.nClasses).fill(0)
  for (const t of m.trees) votes[predictTree(t, x)]++
  return votes
}

/* ---------------- AdaBoost（SAMME） ---------------- */

export interface BoostRound {
  tree: WNode
  /** 这一轮的加权错误率 */
  err: number
  /** 这一轮的发言权 α = log((1−err)/err) + log(K−1) */
  alpha: number
  /** 这一轮训练前的样本权重快照（可视化用） */
  weightsBefore: number[]
  /** 这一轮结束后归一化的样本权重（下一轮的起点） */
  weightsAfter: number[]
}

export interface BoostModel {
  rounds: BoostRound[]
  nClasses: number
  /** 当前（未归一化的相对）样本权重，用于画点的大小 */
  weights: number[]
}

/** 加权错误率：Σwᵢ·[预测错] / Σwᵢ */
export function weightedError(
  samples: Sample[],
  weights: number[],
  predict: (x: number[]) => number,
): number {
  let wSum = 0
  let wErr = 0
  for (let i = 0; i < samples.length; i++) {
    wSum += weights[i]
    if (predict(samples[i].x) !== samples[i].y) wErr += weights[i]
  }
  return wSum === 0 ? 0 : wErr / wSum
}

/**
 * 往 Boosting 里再加一轮（可以反复调用来做"单步添加"）。
 * 返回新的模型（不修改传入的对象）。
 */
export function addBoostRound(
  samples: Sample[],
  nClasses: number,
  model: BoostModel,
  opts: BaseTreeOptions = DEFAULT_TREE_OPTS,
): { model: BoostModel; round: BoostRound | null } {
  const n = samples.length
  const w = model.rounds.length === 0 ? new Array(n).fill(1 / n) : model.weights.slice()

  const tree = trainWeightedTree(samples, w, samples.map((_, i) => i), nClasses, opts)
  const err = weightedError(samples, w, (x) => predictTree(tree, x))

  // err = 0 时 α 会发散；err ≥ 1−1/K 时 α ≤ 0（这个基学习器还不如瞎猜），两种情况都不再继续
  const K = nClasses
  if (err <= 0 || err >= 1 - 1 / K) {
    const alpha = err <= 0 ? 1 : 0
    const round: BoostRound = {
      tree,
      err,
      alpha,
      weightsBefore: w.slice(),
      weightsAfter: w.slice(),
    }
    const next: BoostModel = {
      rounds: [...model.rounds, round],
      nClasses,
      weights: w,
    }
    return { model: next, round: err <= 0 ? round : null }
  }

  const alpha = Math.log((1 - err) / err) + Math.log(K - 1)
  const next_w = w.map((wi, i) => (predictTree(tree, samples[i].x) === samples[i].y ? wi : wi * Math.exp(alpha)))
  const sum = next_w.reduce((a, b) => a + b, 0)
  const normalized = next_w.map((v) => v / sum)

  const round: BoostRound = {
    tree,
    err,
    alpha,
    weightsBefore: w.slice(),
    weightsAfter: normalized,
  }
  return {
    model: { rounds: [...model.rounds, round], nClasses, weights: normalized },
    round,
  }
}

export function emptyBoostModel(): BoostModel {
  return { rounds: [], nClasses: 2, weights: [] }
}

/** AdaBoost 的最终预测：按 α 加权投票 */
export function boostPredict(m: BoostModel, x: number[]): number {
  const scores = new Array(m.nClasses).fill(0)
  for (const r of m.rounds) scores[predictTree(r.tree, x)] += r.alpha
  let best = 0
  for (let c = 1; c < m.nClasses; c++) if (scores[c] > scores[best]) best = c
  return best
}

export function boostScores(m: BoostModel, x: number[]): number[] {
  const scores = new Array(m.nClasses).fill(0)
  for (const r of m.rounds) scores[predictTree(r.tree, x)] += r.alpha
  return scores
}

export function accuracyOf(samples: Sample[], predict: (x: number[]) => number): number {
  if (samples.length === 0) return 0
  let ok = 0
  for (const s of samples) if (predict(s.x) === s.y) ok++
  return ok / samples.length
}
