/**
 * CART 决策树（手写实现）。
 *
 * 为什么要手写：教学需要看到每个节点"为什么这么切"。
 * 但手写容易出错，所以规则刻意与 sklearn 的 DecisionTreeClassifier 对齐，
 * 由 scripts/crosscheck_tree.py 做对拍验证：
 *   - 候选阈值 = 排序后相邻不同取值的中点
 *   - 选加权不纯度最小的分裂；完全打平时取最先遇到的那个（sklearn 同样是"严格更优才更新"）
 *   - 停止条件：达到 max_depth / 样本数 < min_samples_split / 已纯 / 找不到合法分裂
 *   - min_samples_leaf 固定为 1
 *
 * 已知差异（不是 bug，是环境差别）：sklearn 内部把特征转 float32 再算阈值，
 * 这里是 float64，所以阈值末位可能有 ~1e-7 的差，对拍时按容差比较。
 */

export type Criterion = 'gini' | 'entropy'

export interface Sample {
  x: number[]
  y: number
}

export interface TreeOptions {
  criterion: Criterion
  maxDepth: number
  minSamplesSplit: number
}

export interface TreeNode {
  id: number
  depth: number
  nSamples: number
  /** 每个类别的样本数，索引即类别编号 */
  counts: number[]
  impurity: number
  /** 该节点的预测类别（多数类；平票取编号小的） */
  predicted: number
  /** 内部节点才有 */
  feature?: number
  threshold?: number
  gain?: number
  left?: TreeNode
  right?: TreeNode
  /** 停止原因，叶节点才有，用于教学展示 */
  stop?: 'pure' | 'max-depth' | 'min-samples' | 'no-split'
}

export interface Region {
  x0: number
  x1: number
  y0: number
  y1: number
  cls: number
}

/* ---------------- 不纯度 ---------------- */

export function gini(counts: number[]): number {
  const n = counts.reduce((a, b) => a + b, 0)
  if (n === 0) return 0
  let s = 0
  for (const c of counts) s += (c / n) ** 2
  return 1 - s
}

export function entropy(counts: number[]): number {
  const n = counts.reduce((a, b) => a + b, 0)
  if (n === 0) return 0
  let s = 0
  for (const c of counts) {
    if (c === 0) continue
    const p = c / n
    s -= p * Math.log2(p)
  }
  return s
}

export function impurityOf(counts: number[], criterion: Criterion): number {
  return criterion === 'gini' ? gini(counts) : entropy(counts)
}

function countsOf(samples: Sample[], idx: number[], nClasses: number): number[] {
  const c = new Array<number>(nClasses).fill(0)
  for (const i of idx) c[samples[i].y] += 1
  return c
}

function majority(counts: number[]): number {
  let best = 0
  for (let k = 1; k < counts.length; k++) if (counts[k] > counts[best]) best = k
  return best
}

/* ---------------- 找最优分裂 ---------------- */

export interface SplitResult {
  feature: number
  threshold: number
  gain: number
  leftIdx: number[]
  rightIdx: number[]
}

/**
 * 在 idx 这批样本上找最优分裂。找不到合法分裂返回 null。
 * 合法 = 左右两边都至少有 1 个样本（min_samples_leaf = 1）。
 */
export function findBestSplit(
  samples: Sample[],
  idx: number[],
  nClasses: number,
  criterion: Criterion,
): SplitResult | null {
  const parent = impurityOf(countsOf(samples, idx, nClasses), criterion)
  const total = idx.length
  let best: SplitResult | null = null

  const nFeat = samples[0]?.x.length ?? 0
  for (let f = 0; f < nFeat; f++) {
    // 按该特征排序，只考虑相邻取值不同的位置
    const order = idx.slice().sort((a, b) => samples[a].x[f] - samples[b].x[f])
    for (let p = 0; p < order.length - 1; p++) {
      const va = samples[order[p]].x[f]
      const vb = samples[order[p + 1]].x[f]
      if (va === vb) continue

      const threshold = (va + vb) / 2
      const leftIdx: number[] = []
      const rightIdx: number[] = []
      for (const i of order) {
        if (samples[i].x[f] <= threshold) leftIdx.push(i)
        else rightIdx.push(i)
      }
      if (leftIdx.length === 0 || rightIdx.length === 0) continue

      const wl = leftIdx.length / total
      const wr = rightIdx.length / total
      const weighted =
        wl * impurityOf(countsOf(samples, leftIdx, nClasses), criterion) +
        wr * impurityOf(countsOf(samples, rightIdx, nClasses), criterion)
      const gain = parent - weighted

      // 严格更优才替换：打平时保留先遇到的，与 sklearn 一致
      if (best === null || gain > best.gain) {
        best = { feature: f, threshold, gain, leftIdx, rightIdx }
      }
    }
  }
  return best
}

/* ---------------- 生长 ---------------- */

export interface GrowState {
  samples: Sample[]
  nClasses: number
  opts: TreeOptions
  root: TreeNode
  /** 待处理的节点队列（广度优先），空了就长完了 */
  queue: TreeNode[]
  nextId: number
}

function makeLeaf(
  id: number,
  depth: number,
  samples: Sample[],
  idx: number[],
  nClasses: number,
  criterion: Criterion,
  stop: TreeNode['stop'],
): TreeNode {
  const counts = countsOf(samples, idx, nClasses)
  return {
    id,
    depth,
    nSamples: idx.length,
    counts,
    impurity: impurityOf(counts, criterion),
    predicted: majority(counts),
    stop,
  }
}

export function initGrow(samples: Sample[], nClasses: number, opts: TreeOptions): GrowState {
  const idx = samples.map((_, i) => i)
  const root = makeLeaf(0, 0, samples, idx, nClasses, opts.criterion, 'no-split')
  return { samples, nClasses, opts, root, queue: [root], nextId: 1 }
}

/**
 * 生长一步：从队列取一个节点，能分就分，不能分就标记停止原因。
 * 返回 false 表示整棵树已经长完。
 */
export function growStep(st: GrowState): boolean {
  const node = st.queue.shift()
  if (!node) return false

  // 重建该节点的样本索引：从根一路走下来
  const idx = indicesOf(st, node)
  node.nSamples = idx.length
  node.counts = countsOf(st.samples, idx, st.nClasses)
  node.impurity = impurityOf(node.counts, st.opts.criterion)
  node.predicted = majority(node.counts)

  // 停止条件（顺序与 sklearn 一致）
  if (node.impurity === 0) {
    node.stop = 'pure'
    return st.queue.length > 0
  }
  if (node.depth >= st.opts.maxDepth) {
    node.stop = 'max-depth'
    return st.queue.length > 0
  }
  if (idx.length < st.opts.minSamplesSplit) {
    node.stop = 'min-samples'
    return st.queue.length > 0
  }

  const split = findBestSplit(st.samples, idx, st.nClasses, st.opts.criterion)
  if (!split) {
    node.stop = 'no-split'
    return st.queue.length > 0
  }

  node.feature = split.feature
  node.threshold = split.threshold
  node.gain = split.gain
  node.stop = undefined

  node.left = makeLeaf(st.nextId++, node.depth + 1, st.samples, split.leftIdx, st.nClasses, st.opts.criterion, 'no-split')
  node.right = makeLeaf(st.nextId++, node.depth + 1, st.samples, split.rightIdx, st.nClasses, st.opts.criterion, 'no-split')
  st.queue.push(node.left, node.right)

  return st.queue.length > 0
}

export function growAll(st: GrowState): void {
  let guard = 0
  while (st.queue.length > 0 && guard < 20000) {
    growStep(st)
    guard++
  }
}

export function buildTree(samples: Sample[], nClasses: number, opts: TreeOptions): TreeNode {
  const st = initGrow(samples, nClasses, opts)
  growAll(st)
  return st.root
}

/** 从根走到 node，收集落在该节点的样本索引（节点数量小，直接遍历全量） */
function indicesOf(st: GrowState, target: TreeNode): number[] {
  const out: number[] = []
  const walk = (node: TreeNode, idx: number[]): void => {
    if (node === target) {
      out.push(...idx)
      return
    }
    if (node.feature === undefined || node.threshold === undefined) return
    const l: number[] = []
    const r: number[] = []
    for (const i of idx) {
      if (st.samples[i].x[node.feature] <= node.threshold) l.push(i)
      else r.push(i)
    }
    if (node.left) walk(node.left, l)
    if (node.right) walk(node.right, r)
  }
  walk(st.root, st.samples.map((_, i) => i))
  return out
}

/* ---------------- 预测与统计 ---------------- */

export function predictOne(tree: TreeNode, x: number[]): number {
  let node: TreeNode | undefined = tree
  while (node && node.feature !== undefined && node.threshold !== undefined) {
    node = x[node.feature] <= node.threshold ? node.left : node.right
  }
  return node ? node.predicted : 0
}

export function accuracy(tree: TreeNode, samples: Sample[]): number {
  if (samples.length === 0) return 0
  let ok = 0
  for (const s of samples) if (predictOne(tree, s.x) === s.y) ok++
  return ok / samples.length
}

export interface TreeStats {
  depth: number
  nodes: number
  leaves: number
  /** 深度优先前序，用于对拍：(深度, 特征, 阈值)，叶子特征为 -1 */
  dfs: { id: number; depth: number; feature: number; threshold: number }[]
}

export function treeStats(tree: TreeNode): TreeStats {
  let depth = 0
  let nodes = 0
  let leaves = 0
  const dfs: TreeStats['dfs'] = []

  const walk = (n: TreeNode | undefined): void => {
    if (!n) return
    nodes++
    depth = Math.max(depth, n.depth)
    if (n.feature === undefined || n.threshold === undefined) {
      leaves++
      dfs.push({ id: n.id, depth: n.depth, feature: -1, threshold: 0 })
    } else {
      dfs.push({ id: n.id, depth: n.depth, feature: n.feature, threshold: n.threshold })
      walk(n.left)
      walk(n.right)
    }
  }
  walk(tree)
  return { depth, nodes, leaves, dfs }
}

/* ---------------- 调试/对拍辅助 ---------------- */

/** 按节点 id 取回落在它上面的样本索引 */
export function nodeSampleIndices(root: TreeNode, samples: Sample[], id: number): number[] {
  const found: number[] = []
  const walk = (n: TreeNode | undefined, idx: number[]): void => {
    if (!n || found.length > 0) return
    if (n.id === id) {
      found.push(...idx)
      return
    }
    if (n.feature === undefined || n.threshold === undefined) return
    const l: number[] = []
    const r: number[] = []
    for (const i of idx) {
      if (samples[i].x[n.feature] <= n.threshold) l.push(i)
      else r.push(i)
    }
    walk(n.left, l)
    walk(n.right, r)
  }
  walk(root, samples.map((_, i) => i))
  return found
}

/**
 * 列出该节点上增益最高的 k 个候选分裂（对拍时用：
 * 判断两个实现的分歧是"算错了"还是"两个候选几乎打平"）。
 */
export function findSplitsRanked(
  samples: Sample[],
  idx: number[],
  nClasses: number,
  criterion: Criterion,
  k = 3,
): { feature: number; threshold: number; gain: number }[] {
  const parent = impurityOf(countsOf(samples, idx, nClasses), criterion)
  const total = idx.length
  const all: { feature: number; threshold: number; gain: number }[] = []
  const nFeat = samples[0]?.x.length ?? 0

  for (let f = 0; f < nFeat; f++) {
    const order = idx.slice().sort((a, b) => samples[a].x[f] - samples[b].x[f])
    for (let p = 0; p < order.length - 1; p++) {
      const va = samples[order[p]].x[f]
      const vb = samples[order[p + 1]].x[f]
      if (va === vb) continue
      const threshold = (va + vb) / 2
      const leftIdx: number[] = []
      const rightIdx: number[] = []
      for (const i of order) {
        if (samples[i].x[f] <= threshold) leftIdx.push(i)
        else rightIdx.push(i)
      }
      if (leftIdx.length === 0 || rightIdx.length === 0) continue
      const weighted =
        (leftIdx.length / total) * impurityOf(countsOf(samples, leftIdx, nClasses), criterion) +
        (rightIdx.length / total) * impurityOf(countsOf(samples, rightIdx, nClasses), criterion)
      all.push({ feature: f, threshold, gain: parent - weighted })
    }
  }
  all.sort((a, b) => b.gain - a.gain)
  return all.slice(0, k)
}

/** 每个叶子的矩形区域（特征数固定为 2 时用得着） */
export function collectRegions(
  tree: TreeNode,
  bounds: [number, number, number, number],
): Region[] {
  const out: Region[] = []
  const walk = (n: TreeNode | undefined, b: [number, number, number, number]): void => {
    if (!n) return
    if (n.feature === undefined || n.threshold === undefined) {
      out.push({ x0: b[0], x1: b[1], y0: b[2], y1: b[3], cls: n.predicted })
      return
    }
    const t = n.threshold
    if (n.feature === 0) {
      walk(n.left, [b[0], Math.min(b[1], t), b[2], b[3]])
      walk(n.right, [Math.max(b[0], t), b[1], b[2], b[3]])
    } else {
      walk(n.left, [b[0], b[1], b[2], Math.min(b[3], t)])
      walk(n.right, [b[0], b[1], Math.max(b[2], t), b[3]])
    }
  }
  walk(tree, bounds)
  return out
}
