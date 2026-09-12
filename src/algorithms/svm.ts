/**
 * 支持向量机（手写 SMO 求解器）。
 *
 * 这一页不调任何库：从最大间隔的原问题出发，转到对偶问题，
 * 再用 **Platt 的 SMO**（序列最小优化）把它解出来。这样才看得见
 * 「支持向量是哪些」「间隔有多宽」「C 到底在惩罚什么」。
 *
 * 与 sklearn 的关系：
 *   sklearn 的 SVC 底层是 libsvm，也是 SMO 家族的算法。两者求解的是**同一个凸二次规划**，
 *   所以最优对偶目标值唯一、决策函数唯一（对偶解在退化时可能不唯一，但 f(x) 唯一）。
 *   scripts/crosscheck_svm.py 就是对这两条做断言。
 *
 * 数值细节：
 *   - 核矩阵预计算（n≈200 时只有 4 万项），换来代码直白 + 迭代快；
 *   - f(x_i) 全程维护，每次 α、b 变动都做 O(n) 增量更新，而不是每步重算 O(n²)；
 *   - 收敛后**用自由支持向量（0 < α < C）重算 b**，比 Platt 原文里 b1/b2 的取值规则稳定。
 */

import type { Sample } from '../data/treeDatasets'

export type KernelName = 'linear' | 'rbf' | 'poly'

export interface SvmOptions {
  C: number
  kernel: KernelName
  /** RBF 与多项式的 γ（多项式里还乘在点积上，与 sklearn 一致） */
  gamma: number
  /** 多项式的次数 */
  degree: number
  /** 多项式的常数项 r（sklearn 里的 coef0） */
  coef0: number
  /** KKT 违背的容忍度 */
  tol: number
  /** 迭代上限（每次成功的 α 更新算一次） */
  maxIter: number
}

export const DEFAULT_SVM_OPTS: SvmOptions = {
  C: 1,
  kernel: 'rbf',
  gamma: 1,
  degree: 3,
  coef0: 0,
  tol: 1e-4,
  maxIter: 200000,
}

const EPS = 1e-8

export function kernelValue(a: number[], b: number[], o: SvmOptions): number {
  if (o.kernel === 'linear') return a[0] * b[0] + a[1] * b[1]
  if (o.kernel === 'rbf') {
    const d0 = a[0] - b[0]
    const d1 = a[1] - b[1]
    return Math.exp(-o.gamma * (d0 * d0 + d1 * d1))
  }
  // 多项式：(γ·⟨x,z⟩ + r)^d
  return (o.gamma * (a[0] * b[0] + a[1] * b[1]) + o.coef0) ** o.degree
}

export interface SvmModel {
  alpha: number[]
  b: number
  /** α > 0 的样本下标（支持向量） */
  support: number[]
  svAlpha: number[]
  svY: number[]
  svX: number[][]
  opts: SvmOptions
  nIter: number
  converged: boolean
  /** 对偶目标值 Σα − ½ΣΣ αᵢαⱼyᵢyⱼK(xᵢ,xⱼ) */
  dualObjective: number
  /** 落在间隔边界上的支持向量个数（0 < α < C） */
  nFree: number
  /** 顶到上界的支持向量个数（α = C，这些点是被"放弃"的错分点） */
  nBound: number
  /** 线性核才有的原始权重 w = Σαᵢyᵢxᵢ */
  w?: number[]
}

/** KKT 条件：α=0 时 yf≥1；0<α<C 时 yf=1；α=C 时 yf≤1 */
function violatesKkt(a: number, yf: number, C: number, tol: number): boolean {
  if (a <= EPS) return yf < 1 - tol
  if (a >= C - EPS) return yf > 1 + tol
  return Math.abs(yf - 1) > tol
}

export function trainSvm(samples: Sample[], options: Partial<SvmOptions> = {}): SvmModel {
  const opts: SvmOptions = { ...DEFAULT_SVM_OPTS, ...options }
  const n = samples.length
  const C = opts.C
  const y = samples.map((s) => (s.y === 1 ? 1 : -1))
  const alpha = new Float64Array(n)
  let b = 0

  /* ---------- 核矩阵（对称，只算一半） ---------- */
  const K = new Float64Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const v = kernelValue(samples[i].x, samples[j].x, opts)
      K[i * n + j] = v
      K[j * n + i] = v
    }
  }
  const kat = (i: number, j: number) => K[i * n + j]

  /* ---------- f(x) 全程维护 ---------- */
  const f = new Float64Array(n)
  const recomputeF = () => {
    for (let i = 0; i < n; i++) {
      let s = b
      for (let j = 0; j < n; j++) {
        const aj = alpha[j]
        if (aj !== 0) s += aj * y[j] * kat(i, j)
      }
      f[i] = s
    }
  }
  recomputeF()

  let iter = 0

  const takeStep = (i: number, j: number): boolean => {
    const aiOld = alpha[i]
    const ajOld = alpha[j]
    const Ei = f[i] - y[i]
    const Ej = f[j] - y[j]

    // αⱼ 的可行区间（对偶约束 Σαᵢyᵢ=0 与 0≤α≤C 夹出来的那条线段）
    let L: number
    let H: number
    if (y[i] !== y[j]) {
      L = Math.max(0, ajOld - aiOld)
      H = Math.min(C, C + ajOld - aiOld)
    } else {
      L = Math.max(0, aiOld + ajOld - C)
      H = Math.min(C, aiOld + ajOld)
    }
    if (L >= H - 1e-12) return false

    const eta = 2 * kat(i, j) - kat(i, i) - kat(j, j)
    if (eta >= -1e-12) return false

    let aj = ajOld - (y[j] * (Ei - Ej)) / eta
    if (aj > H) aj = H
    if (aj < L) aj = L
    if (Math.abs(aj - ajOld) < 1e-10) return false

    const ai = aiOld + y[i] * y[j] * (ajOld - aj)
    const dAi = ai - aiOld
    const dAj = aj - ajOld
    alpha[i] = ai
    alpha[j] = aj

    // 增量更新所有 f：Δf(k) = ΔαᵢyᵢK(k,i) + ΔαⱼyⱼK(k,j)
    for (let k = 0; k < n; k++) f[k] += dAi * y[i] * kat(k, i) + dAj * y[j] * kat(k, j)

    // b 的两个候选，按谁落在自由区间来定
    const b1 = b - Ei - y[i] * dAi * kat(i, i) - y[j] * dAj * kat(i, j)
    const b2 = b - Ej - y[i] * dAi * kat(i, j) - y[j] * dAj * kat(j, j)
    let bNew: number
    if (ai > EPS && ai < C - EPS) bNew = b1
    else if (aj > EPS && aj < C - EPS) bNew = b2
    else bNew = (b1 + b2) / 2
    const db = bNew - b
    if (db !== 0) {
      b = bNew
      for (let k = 0; k < n; k++) f[k] += db
    }
    return true
  }

  /**
   * 挑第二个变量并尝试更新（Platt 的 examineExample）。
   *
   * 这里的 fallback 链不能省——初版就是省了它，结果 C=1 时
   * 「正类的 α 之和 = 负类的 α 之和」这个等式约束很快被顶到边界，
   * 首选的 j 往往给出空可行区间（L == H），于是整轮一个都没更新成功，
   * 算法在 1 步之后就"收敛"了（对拍时 KKT 残差 1.13，只找到 2 个支持向量）。
   */
  const examineExample = (i: number): boolean => {
    const yf = y[i] * f[i]
    if (!violatesKkt(alpha[i], yf, C, opts.tol)) return false

    const Ei = f[i] - y[i]
    // ① 先试让 |Eᵢ − Eⱼ| 最大的那个
    let j = -1
    let best = -1
    for (let k = 0; k < n; k++) {
      if (k === i) continue
      const d = Math.abs(Ei - (f[k] - y[k]))
      if (d > best) {
        best = d
        j = k
      }
    }
    if (j >= 0 && takeStep(i, j)) return true

    // ② 退而求其次：遍历非边界样本（0 < α < C）作 j
    for (let k = 0; k < n; k++) {
      if (k === i) continue
      if (alpha[k] > EPS && alpha[k] < C - EPS && takeStep(i, k)) return true
    }

    // ③ 最后遍历全部样本
    for (let k = 0; k < n; k++) {
      if (k === i) continue
      if (takeStep(i, k)) return true
    }
    return false
  }

  /**
   * Platt 的外层状态机：先扫全部样本，再反复扫非边界样本；
   * 非边界那轮一无所获时回到全扫；全扫也一无所获才算收敛。
   */
  let examineAll = true
  let converged = false
  while (iter < opts.maxIter) {
    let numChanged = 0
    if (examineAll) {
      for (let i = 0; i < n; i++) if (examineExample(i)) {
        numChanged++
        iter++
      }
    } else {
      for (let i = 0; i < n; i++) {
        if (alpha[i] <= EPS || alpha[i] >= C - EPS) continue
        if (examineExample(i)) {
          numChanged++
          iter++
        }
      }
    }
    if (examineAll) {
      examineAll = false
      if (numChanged === 0) {
        converged = true
        break // 全扫无所获 → 收敛
      }
    } else if (numChanged === 0) {
      examineAll = true
    }
  }

  /* ---------- 用自由支持向量重算 b（比 b1/b2 规则稳） ---------- */
  let sum = 0
  let cnt = 0
  for (let i = 0; i < n; i++) {
    if (alpha[i] > EPS && alpha[i] < C - EPS) {
      sum += y[i] - f[i]
      cnt++
    }
  }
  if (cnt > 0) {
    const db = sum / cnt
    b += db
    for (let k = 0; k < n; k++) f[k] += db
  }

  /* ---------- 统计 ---------- */
  const support: number[] = []
  let nFree = 0
  let nBound = 0
  for (let i = 0; i < n; i++) {
    if (alpha[i] > EPS) {
      support.push(i)
      if (alpha[i] >= C - EPS) nBound++
      else nFree++
    }
  }

  let sumA = 0
  let quad = 0
  for (let i = 0; i < n; i++) {
    sumA += alpha[i]
    if (alpha[i] === 0) continue
    for (let j = 0; j < n; j++) {
      if (alpha[j] === 0) continue
      quad += alpha[i] * alpha[j] * y[i] * y[j] * kat(i, j)
    }
  }

  const model: SvmModel = {
    alpha: Array.from(alpha),
    b,
    support,
    svAlpha: support.map((i) => alpha[i]),
    svY: support.map((i) => y[i]),
    svX: support.map((i) => samples[i].x as unknown as number[]),
    opts,
    nIter: iter,
    converged,
    dualObjective: sumA - 0.5 * quad,
    nFree,
    nBound,
  }

  if (opts.kernel === 'linear') {
    const w = [0, 0]
    for (const i of support) {
      w[0] += alpha[i] * y[i] * samples[i].x[0]
      w[1] += alpha[i] * y[i] * samples[i].x[1]
    }
    model.w = w
  }

  return model
}

/** 决策函数 f(x) = Σ αᵢyᵢK(xᵢ,x) + b；符号决定类别，|f| 是到边界的"确信度" */
export function decisionFunction(model: SvmModel, x: number[]): number {
  let s = model.b
  for (let k = 0; k < model.support.length; k++) {
    s += model.svAlpha[k] * model.svY[k] * kernelValue(x, model.svX[k], model.opts)
  }
  return s
}

export function decisionValues(model: SvmModel, points: number[][]): number[] {
  return points.map((p) => decisionFunction(model, p))
}

/** 线性核时 w 唯一，间隔宽度 = 2/‖w‖ */
export function marginWidth(model: SvmModel): number | null {
  if (!model.w) return null
  const norm = Math.hypot(model.w[0], model.w[1])
  return norm === 0 ? null : 2 / norm
}

export function svmAccuracy(model: SvmModel, samples: Sample[]): number {
  if (samples.length === 0) return 0
  let ok = 0
  for (const s of samples) {
    const pred = decisionFunction(model, s.x as unknown as number[]) > 0 ? 1 : 0
    if (pred === (s.y === 1 ? 1 : 0)) ok++
  }
  return ok / samples.length
}

/**
 * KKT 残差的最大值——用来"自证"解是对的，不依赖任何外部库。
 * 一个真正的最优解应当让所有样本都满足 KKT（残差 → 0）。
 */
export function kktResidual(model: SvmModel, samples: Sample[]): number {
  const C = model.opts.C
  let worst = 0
  for (let i = 0; i < samples.length; i++) {
    const yi = samples[i].y === 1 ? 1 : -1
    const yf = yi * decisionFunction(model, samples[i].x as unknown as number[])
    const a = model.alpha[i]
    let r: number
    if (a <= EPS) r = Math.max(0, 1 - yf)
    else if (a >= C - EPS) r = Math.max(0, yf - 1)
    else r = Math.abs(yf - 1)
    if (r > worst) worst = r
  }
  return worst
}
