/**
 * 朴素贝叶斯（手写实现，伯努利与多项式两种）。
 *
 * 这一页的核心是「朴素」两个字：假设**给定类别后，各个词相互独立**。
 * 于是后验概率变成连乘，取对数后变成求和——这是朴素贝叶斯全部的秘密：
 *
 *     log P(y | x) ∝ log P(y) + Σᵢ log P(xᵢ | y)
 *
 * 两种模型对 P(xᵢ|y) 的建模不同：
 *   - **伯努利**：特征是"词有没有出现"（0/1）。**没出现的词也参与计算**
 *     （用 1−p 那一项），所以长短信会因为"很多词都没出现"被连带影响。
 *   - **多项式**：特征是词频，只累加出现过的词（多项式分布的标准形式）。
 *
 * 平滑：所有计数加 α（拉普拉斯平滑）。不解这个问题的话，任何在训练集某类里
 * 从未出现的词都会让整条概率归零。
 *
 * 与 sklearn 的关系：
 *   BernoulliNB / MultinomialNB 的类先验、feature_log_prob_、predict_log_proba
 *   在 scripts/crosscheck_nb.py 里逐元素对拍。
 */

export type NbModel = 'bernoulli' | 'multinomial'

export interface NbOptions {
  model: NbModel
  /** 拉普拉斯平滑系数（sklearn 里也叫 alpha） */
  alpha: number
}

export const DEFAULT_NB_OPTS: NbOptions = { model: 'bernoulli', alpha: 1 }

export interface NbModelResult {
  opts: NbOptions
  nClasses: number
  /** 每个类的对数先验 log P(y) */
  classLogPrior: number[]
  /** [类][词] 的对数条件概率 log P(xᵢ=1 | y) */
  featureLogProb: number[][]
  /** [类][词] 的对数 (1 − P(xᵢ=1 | y))，只有伯努利模型用得上 */
  featureLogNeg: number[][]
  /** 每个类下的文档数 */
  classCount: number[]
  /** 每个类下的词频总数（多项式用） */
  classTokenTotal: number[]
  nFeatures: number
  nSamples: number
}

const LOG_ZERO = -1e300

/**
 * 训练。X 是**扁平**的 n×d 矩阵（第 i 个样本第 j 个特征在 X[i*d+j]）——
 * 5574×150 用嵌套数组太吃内存，扁平 Float64Array 更合适。
 */
export function trainNb(
  X: ArrayLike<number>,
  y: ArrayLike<number>,
  n: number,
  d: number,
  options: Partial<NbOptions> = {},
): NbModelResult {
  const opts: NbOptions = { ...DEFAULT_NB_OPTS, ...options }
  const nClasses = Math.max(...Array.from(y)) + 1
  const alpha = opts.alpha

  const classCount = new Array(nClasses).fill(0)
  const classTokenTotal = new Array(nClasses).fill(0)
  // 每个类每个特征的出现次数（伯努利用"文档出现次数"；多项式用"词频总和"）
  const featCount: number[][] = Array.from({ length: nClasses }, () => new Array(d).fill(0))

  for (let i = 0; i < n; i++) {
    const c = y[i]
    classCount[c]++
    for (let j = 0; j < d; j++) {
      const v = X[i * d + j]
      if (v === 0) continue
      featCount[c][j] += opts.model === 'bernoulli' ? 1 : v
      classTokenTotal[c] += opts.model === 'bernoulli' ? 1 : v
    }
  }

  const classLogPrior = classCount.map((c) => Math.log(c / n))
  const featureLogProb: number[][] = []
  const featureLogNeg: number[][] = []

  for (let c = 0; c < nClasses; c++) {
    const lp: number[] = new Array(d)
    const ln: number[] = new Array(d)
    // 伯努利：分母 n_c + 2α（每个特征都要考虑"出现/不出现"两种结果）
    // 多项式：分母是该类的词频总数 + α·V
    const denom = opts.model === 'bernoulli' ? classCount[c] + 2 * alpha : classTokenTotal[c] + alpha * d
    for (let j = 0; j < d; j++) {
      const p = (featCount[c][j] + alpha) / denom
      lp[j] = p > 0 ? Math.log(p) : LOG_ZERO
      ln[j] = 1 - p > 0 ? Math.log(1 - p) : LOG_ZERO
    }
    featureLogProb.push(lp)
    featureLogNeg.push(ln)
  }

  return {
    opts,
    nClasses,
    classLogPrior,
    featureLogProb,
    featureLogNeg,
    classCount,
    classTokenTotal,
    nFeatures: d,
    nSamples: n,
  }
}

/**
 * 每个类别的联合对数似然（未归一化）：log P(y) + log P(x|y)。
 * 返回长度 = 类别数。
 */
export function nbLogJoint(m: NbModelResult, x: ArrayLike<number>, offset = 0): number[] {
  const out = new Array(m.nClasses)
  for (let c = 0; c < m.nClasses; c++) {
    let s = m.classLogPrior[c]
    const lp = m.featureLogProb[c]
    if (m.opts.model === 'bernoulli') {
      const ln = m.featureLogNeg[c]
      // 关键词：没出现的词也贡献 (1−p) 那一项
      for (let j = 0; j < m.nFeatures; j++) {
        s += x[offset + j] > 0 ? lp[j] : ln[j]
      }
    } else {
      for (let j = 0; j < m.nFeatures; j++) {
        const v = x[offset + j]
        if (v > 0) s += v * lp[j]
      }
    }
    out[c] = s
  }
  return out
}

/** 归一化成对数后验 log P(y|x) */
export function nbLogProba(m: NbModelResult, x: ArrayLike<number>, offset = 0): number[] {
  const joint = nbLogJoint(m, x, offset)
  const mx = Math.max(...joint)
  let sum = 0
  for (const v of joint) sum += Math.exp(v - mx)
  const logSum = mx + Math.log(sum)
  return joint.map((v) => v - logSum)
}

export function nbPredict(m: NbModelResult, x: ArrayLike<number>, offset = 0): number {
  const joint = nbLogJoint(m, x, offset)
  let best = 0
  for (let c = 1; c < joint.length; c++) if (joint[c] > joint[best]) best = c
  return best
}

/** 某个特征对指定类别的对数贡献（就是可视化里那一格的高度） */
export function featureContribution(
  m: NbModelResult,
  cls: number,
  feature: number,
  value: number,
): number {
  if (m.opts.model === 'bernoulli') {
    return value > 0 ? m.featureLogProb[cls][feature] : m.featureLogNeg[cls][feature]
  }
  return value > 0 ? value * m.featureLogProb[cls][feature] : 0
}

export interface NbEval {
  accuracy: number
  precision: number
  recall: number
  f1: number
  confusion: { tp: number; fp: number; tn: number; fn: number }
}

/** 在给定数据上评估（正类固定为 1，也就是"垃圾短信"） */
export function evaluateNb(m: NbModelResult, X: ArrayLike<number>, y: ArrayLike<number>, n = 0): NbEval {
  const count = n || y.length
  let tp = 0
  let fp = 0
  let tn = 0
  let fn = 0
  for (let i = 0; i < count; i++) {
    const pred = nbPredict(m, X, i * m.nFeatures)
    const real = y[i]
    if (pred === 1 && real === 1) tp++
    else if (pred === 1 && real === 0) fp++
    else if (pred === 0 && real === 0) tn++
    else fn++
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn)
  return {
    accuracy: (tp + tn) / count,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    confusion: { tp, fp, tn, fn },
  }
}

/**
 * 每个词的对数几率比 log [P(w|spam) / P(w|ham)]，
 * 用来画"哪些词最像垃圾短信"那张图。取绝对值的 top-k。
 */
export function logOddsRatio(m: NbModelResult, posClass = 1, negClass = 0): number[] {
  const out: number[] = new Array(m.nFeatures)
  for (let j = 0; j < m.nFeatures; j++) {
    out[j] = m.featureLogProb[posClass][j] - m.featureLogProb[negClass][j]
  }
  return out
}
