/**
 * Logistic 回归（手写实现）。
 *
 * 与 sklearn 的关系：
 *   sklearn 的 LogisticRegression 默认带 L2 正则且用 lbfgs 求解；这里是**不带正则的批量梯度下降**，
 *   对应 `LogisticRegression(C=np.inf)`（无正则）+ 自己一步步走。
 *   对拍脚本 scripts/crosscheck_logistic.py 验证的是三件事：
 *     1. 同一个参数点上，损失与梯度的数值与 numpy 复算逐位一致（公式没写错）
 *     2. 用 scipy.expit 校验 sigmoid 的数值稳定性
 *     3. 走到收敛后，最终损失与 sklearn 的 lbfgs 解一致（凸问题，最优值唯一）
 *
 * 数值稳定性：
 *   损失不用 -[y log p + (1-y) log(1-p)] 直接算（p 趋近 0/1 时会 log(0)），
 *   改写成 softplus 形式：loss_i = log(1 + exp(-s·z))，s = 2y-1 ∈ {-1, +1}。
 *   这也是 sklearn 内部的算法，所以对拍才能对得上。
 */

export interface LRSample {
  x: [number, number]
  y: 0 | 1
}

export interface LRParams {
  w1: number
  w2: number
  b: number
}

export interface Grad {
  w1: number
  w2: number
  b: number
}

export function sigmoid(z: number): number {
  // z 很负时 exp(-z) 会溢出，分两侧算
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z))
}

/** log(1 + exp(t))，t 很大时直接取 t，避免 exp 溢出 */
export function softplus(t: number): number {
  return t > 0 ? t + Math.log1p(Math.exp(-t)) : Math.log1p(Math.exp(t))
}

/** logit(t) = ln(t / (1 - t))，决策阈值对应的那条等值线就在这里 */
export function logit(t: number): number {
  const c = Math.min(1 - 1e-12, Math.max(1e-12, t))
  return Math.log(c / (1 - c))
}

export function zOf(p: LRParams, x: [number, number]): number {
  return p.w1 * x[0] + p.w2 * x[1] + p.b
}

export function proba(p: LRParams, x: [number, number]): number {
  return sigmoid(zOf(p, x))
}

/** 单个样本的对数损失（交叉熵），softplus 形式 */
export function sampleLoss(y: 0 | 1, z: number): number {
  const s = y === 1 ? 1 : -1
  return softplus(-s * z)
}

/** 平均对数损失 */
export function logLoss(samples: LRSample[], p: LRParams): number {
  if (samples.length === 0) return 0
  let s = 0
  for (const d of samples) s += sampleLoss(d.y, zOf(p, d.x))
  return s / samples.length
}

/** 平均梯度（1/n 求和，与 sklearn 的 loss 尺度一致） */
export function gradient(samples: LRSample[], p: LRParams): Grad {
  const n = samples.length || 1
  let g1 = 0
  let g2 = 0
  let gb = 0
  for (const d of samples) {
    const e = proba(p, d.x) - d.y
    g1 += e * d.x[0]
    g2 += e * d.x[1]
    gb += e
  }
  return { w1: g1 / n, w2: g2 / n, b: gb / n }
}

/** 走一个 epoch（批量梯度下降：一次用全部样本更新一次） */
export function trainStep(samples: LRSample[], p: LRParams, lr: number): LRParams {
  const g = gradient(samples, p)
  return { w1: p.w1 - lr * g.w1, w2: p.w2 - lr * g.w2, b: p.b - lr * g.b }
}

export interface Confusion {
  tp: number
  fp: number
  tn: number
  fn: number
}

export function confusion(samples: LRSample[], p: LRParams, threshold: number): Confusion {
  let tp = 0
  let fp = 0
  let tn = 0
  let fn = 0
  for (const d of samples) {
    const pred = proba(p, d.x) >= threshold ? 1 : 0
    if (pred === 1 && d.y === 1) tp++
    else if (pred === 1 && d.y === 0) fp++
    else if (pred === 0 && d.y === 0) tn++
    else fn++
  }
  return { tp, fp, tn, fn }
}

export function accuracy(samples: LRSample[], p: LRParams, threshold: number): number {
  if (samples.length === 0) return 0
  const c = confusion(samples, p, threshold)
  return (c.tp + c.tn) / samples.length
}

/** 精确率：判为正的那些里，有多少是真的 */
export function precision(c: Confusion): number {
  return c.tp + c.fp === 0 ? 0 : c.tp / (c.tp + c.fp)
}

/** 召回率：真的正例里，抓到了多少 */
export function recall(c: Confusion): number {
  return c.tp + c.fn === 0 ? 0 : c.tp / (c.tp + c.fn)
}

export interface TrainResult {
  params: LRParams
  /** 每一步之后的损失，用来画下降曲线（第 0 项是训练前） */
  losses: number[]
  epochs: number
  converged: boolean
}

/**
 * 一直走到收敛（或到 maxEpoch）。
 * 收敛判据：相邻两步损失的相对变化 < tol。
 */
export function trainUntilConverge(
  samples: LRSample[],
  start: LRParams,
  lr: number,
  maxEpoch = 20000,
  tol = 1e-10,
): TrainResult {
  let p = { ...start }
  let prev = logLoss(samples, p)
  const losses: number[] = [prev]
  let epochs = 0
  let converged = false

  while (epochs < maxEpoch) {
    p = trainStep(samples, p, lr)
    const cur = logLoss(samples, p)
    losses.push(cur)
    epochs++
    if (Math.abs(prev - cur) <= tol * Math.max(1, Math.abs(prev))) {
      converged = true
      break
    }
    prev = cur
  }
  return { params: p, losses, epochs, converged }
}

/** 每个样本的 z = w·x + b，画 S 形投影图时用 */
export function zValues(samples: LRSample[], p: LRParams): number[] {
  return samples.map((d) => zOf(p, d.x))
}
