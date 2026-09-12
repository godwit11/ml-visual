/**
 * 分类模型的评估指标（手写实现）。
 *
 * 这一页的算法是整个站里最"标准化"的：混淆矩阵、ROC、AUC、K 折划分都有
 * 业界公认的精确定义，所以实现必须严格对齐 sklearn，否则对拍会立刻报警。
 *
 * 对齐要点（都是踩过或差点踩的坑）：
 *   1. ROC 不是"每隔 0.01 取一个阈值"画出来的，而是**按分数从高到低逐个样本移动**，
 *      并且要合并分数相同的样本（否则曲线会多出竖直/水平的冗余拐点）。
 *   2. thresholds[0] 不是 +∞，sklearn 取"最高分 + 1"，代表"一个都不判为正例"那个点。
 *   3. AUC 用梯形法则（auc 函数），而 PR 的 average_precision 用矩形法则——两者定义不同，
 *      本页的 PR-AUC 用梯形，对拍时 Python 侧也用梯形，不能拿 average_precision_score 来比。
 *   4. 分层 K 折是「类内连续分块」，不是「整体连续分块」，两者在类别不平衡时差别巨大。
 */

export interface Confusion {
  tp: number
  fp: number
  tn: number
  fn: number
}

export interface Metrics {
  accuracy: number
  precision: number
  recall: number
  f1: number
  /** 特异度 = TN / (TN + FP)，真负例里抓对了多少 */
  specificity: number
  /** 假正率 = FP / (FP + TN) */
  fpr: number
  /** 正例占比（患病率） */
  prevalence: number
}

export function confusionAt(scores: number[], labels: number[], threshold: number): Confusion {
  let tp = 0
  let fp = 0
  let tn = 0
  let fn = 0
  for (let i = 0; i < scores.length; i++) {
    const pred = scores[i] >= threshold ? 1 : 0
    const real = labels[i]
    if (pred === 1 && real === 1) tp++
    else if (pred === 1 && real === 0) fp++
    else if (pred === 0 && real === 0) tn++
    else fn++
  }
  return { tp, fp, tn, fn }
}

const safeDiv = (a: number, b: number): number => (b === 0 ? 0 : a / b)

export function metricsFrom(c: Confusion): Metrics {
  const total = c.tp + c.fp + c.tn + c.fn
  const precision = safeDiv(c.tp, c.tp + c.fp)
  const recall = safeDiv(c.tp, c.tp + c.fn)
  const specificity = safeDiv(c.tn, c.tn + c.fp)
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  return {
    accuracy: safeDiv(c.tp + c.tn, total),
    precision,
    recall,
    f1,
    specificity,
    fpr: 1 - specificity,
    prevalence: safeDiv(c.tp + c.fn, total),
  }
}

/** 梯形法则积分。x 必须单调（ROC / PR 都满足） */
export function trapz(x: number[], y: number[]): number {
  let s = 0
  for (let i = 1; i < x.length; i++) s += (x[i] - x[i - 1]) * (y[i] + y[i - 1]) * 0.5
  return s
}

/**
 * sklearn `_binary_clf_curve` 的等价实现。
 * 按分数降序排列，累积 TP / FP，只在分数发生变化的位置留一个点。
 */
function clfCurve(scores: number[], labels: number[]): { fps: number[]; tps: number[]; thresholds: number[] } {
  const n = scores.length
  const idx = Array.from({ length: n }, (_, i) => i)
  // 降序；同分时保持原顺序（mergesort 的稳定性）
  idx.sort((a, b) => (scores[b] - scores[a]) || a - b)

  const fps: number[] = []
  const tps: number[] = []
  const thresholds: number[] = []
  let fp = 0
  let tp = 0
  for (let k = 0; k < n; k++) {
    fp += labels[idx[k]] === 0 ? 1 : 0
    tp += labels[idx[k]] === 1 ? 1 : 0
    // 只在"这一段同分样本走完"时记一个点
    const last = k === n - 1 || scores[idx[k + 1]] !== scores[idx[k]]
    if (last) {
      fps.push(fp)
      tps.push(tp)
      thresholds.push(scores[idx[k]])
    }
  }
  return { fps, tps, thresholds }
}

export interface RocCurve {
  fpr: number[]
  tpr: number[]
  /** 与点一一对应，thresholds[0] = 最高分 + 1 */
  thresholds: number[]
  auc: number
}

export function rocCurve(scores: number[], labels: number[]): RocCurve {
  const { fps, tps, thresholds } = clfCurve(scores, labels)
  const nPos = tps[tps.length - 1]
  const nNeg = fps[fps.length - 1]
  const fpr: number[] = [0, ...fps.map((v) => safeDiv(v, nNeg))]
  const tpr: number[] = [0, ...tps.map((v) => safeDiv(v, nPos))]
  // sklearn 用 +∞ 表示"一个都不判正例"的那个端点（它们源码里就是 np.inf）
  const thrs = [Infinity, ...thresholds]
  return { fpr, tpr, thresholds: thrs, auc: trapz(fpr, tpr) }
}

export interface PrCurve {
  precision: number[]
  recall: number[]
  /** 长度比 precision 少 1（最后一个 (recall=0, precision=1) 是人为补上的端点） */
  thresholds: number[]
  /** 梯形法则下的面积 */
  auc: number
}

export function prCurve(scores: number[], labels: number[]): PrCurve {
  const { fps, tps, thresholds } = clfCurve(scores, labels)
  const nPos = tps[tps.length - 1]
  const m = tps.length
  const precision: number[] = new Array(m)
  const recall: number[] = new Array(m)
  for (let i = 0; i < m; i++) {
    const ps = tps[i] + fps[i]
    // sklearn 新版：分母为 0 时 precision 记 0（不是 1）
    precision[i] = ps === 0 ? 0 : tps[i] / ps
    recall[i] = nPos === 0 ? 1 : tps[i] / nPos
  }
  // 反转成 recall 递减（与 sklearn 的返回顺序一致），末尾补上 (recall=0, precision=1) 这个端点。
  // 注意 recall 是**递减**的，所以梯形积分为负，取绝对值才是面积。
  const pOut = [...precision].reverse()
  const rOut = [...recall].reverse()
  pOut.push(1)
  rOut.push(0)
  return {
    precision: pOut,
    recall: rOut,
    thresholds: [...thresholds].reverse(),
    auc: Math.abs(trapz(rOut, pOut)),
  }
}

/* ---------------- 交叉验证 ---------------- */

export interface FoldOptions {
  k: number
  /** 是否先打乱（默认否，保证可复现、可与 sklearn 对拍） */
  shuffle?: boolean
  /** 是否分层：每折各类别比例与整体一致 */
  stratify?: boolean
  labels?: number[]
  seed?: number
}

/** 把 n 个样本切成 k 份，返回每份的验证集索引（升序） */
export function kFoldIndices(n: number, o: FoldOptions): number[][] {
  const k = Math.max(2, Math.min(n, Math.floor(o.k)))
  const labels = o.labels ?? new Array(n).fill(0)
  let order = Array.from({ length: n }, (_, i) => i)
  if (o.shuffle) {
    // 与 prng.shuffle 同源的 Fisher–Yates
    let a = (o.seed ?? 42) >>> 0
    const rnd = () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      ;[order[i], order[j]] = [order[j], order[i]]
    }
  }

  const folds: number[][] = Array.from({ length: k }, () => [])

  /** 按给定的「每折大小」依次切块 */
  const assignBySizes = (group: number[], sizes: number[]) => {
    let cur = 0
    for (let f = 0; f < k; f++) {
      for (let i = cur; i < cur + sizes[f]; i++) folds[f].push(group[i])
      cur += sizes[f]
    }
  }

  if (o.stratify) {
    // 严格对齐 sklearn 的 StratifiedKFold，细节有两处容易踩：
    //   1. 类别编码按「首次出现顺序」（sklearn 的 y_encoded 就是这么编的），
    //      不是按类别值大小。用错了每折的类别数量就对不上——对拍报过这个错。
    //   2. 每折每类多少样本，用「对按类别排序后的编码序列做 stride-k 采样」求出，
    //      这样余数会自然错开，折大小最多差 1；若自己写「前 r 折各多一个」，
    //      两个类的余数会叠加，折大小能差到 2（同样被对拍抓到过）。
    const enc = new Map<number, number>()
    for (let i = 0; i < n; i++) if (!enc.has(labels[i])) enc.set(labels[i], enc.size)
    const nClasses = enc.size
    const code = (i: number) => enc.get(labels[i])!

    const counts = new Array<number>(nClasses).fill(0)
    for (const i of order) counts[code(i)]++

    const sortedCodes: number[] = []
    for (let c = 0; c < nClasses; c++) for (let j = 0; j < counts[c]; j++) sortedCodes.push(c)

    const alloc: number[][] = Array.from({ length: k }, () => new Array<number>(nClasses).fill(0))
    for (let i = 0; i < k; i++) {
      for (let j = i; j < sortedCodes.length; j += k) alloc[i][sortedCodes[j]]++
    }

    for (let c = 0; c < nClasses; c++) {
      const group = order.filter((i) => code(i) === c)
      assignBySizes(
        group,
        alloc.map((row) => row[c]),
      )
    }
  } else {
    const base = Math.floor(order.length / k)
    const rest = order.length % k
    assignBySizes(
      order,
      Array.from({ length: k }, (_, f) => base + (f < rest ? 1 : 0)),
    )
  }

  return folds.map((f) => f.slice().sort((a, b) => a - b))
}

export interface CvResult {
  scores: number[]
  mean: number
  /** 样本标准差（ddof = 1） */
  std: number
  foldSizes: number[]
  /** 每折验证集里的正例数，用来看分层有没有生效 */
  foldPos: number[]
}

/**
 * 用给定的折跑一遍交叉验证。
 * evaluate 由调用方提供（这一页传的是决策树的训练 + 打分），
 * 这样评估流程本身与具体模型解耦，也方便对拍时换成 sklearn 的模型。
 */
export function crossValidate(
  folds: number[][],
  labels: number[],
  evaluate: (trainIdx: number[], testIdx: number[]) => number,
): CvResult {
  const scores = folds.map((testIdx) => {
    const inTest = new Set(testIdx)
    const trainIdx: number[] = []
    for (let i = 0; i < labels.length; i++) if (!inTest.has(i)) trainIdx.push(i)
    return evaluate(trainIdx, testIdx)
  })
  const mean = scores.reduce((a, b) => a + b, 0) / (scores.length || 1)
  const variance =
    scores.length > 1
      ? scores.reduce((a, b) => a + (b - mean) ** 2, 0) / (scores.length - 1)
      : 0
  return {
    scores,
    mean,
    std: Math.sqrt(variance),
    foldSizes: folds.map((f) => f.length),
    foldPos: folds.map((f) => f.filter((i) => labels[i] === 1).length),
  }
}
