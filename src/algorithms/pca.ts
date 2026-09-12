/**
 * 主成分分析 PCA（手写实现）。
 *
 * PCA 的全部内容可以压成一句话：**把数据搬到原点附近，然后找一组新的坐标轴，
 * 让数据在新轴上的方差一个比一个大。**
 *
 * 实现路线（和 sklearn 的 `PCA(svd_solver='full')` 对齐）：
 *
 *   1. **中心化**：减去每个特征的均值。注意**不除以标准差**——
 *      除以标准差是 `StandardScaler` 的事，sklearn 的 PCA 本身不做
 *      （要标准化得自己 `make_pipeline(StandardScaler(), PCA())`）。
 *      这一步只是把原点挪到数据中心，不改变形状，但**决定了方向的解释方式**。
 *   2. **求主成分**：对中心化矩阵 Xc 做奇异值分解 Xc = U S Vᵀ，
 *      则**右奇异向量 V 的列就是主成分方向**（按奇异值从大到小排好序）。
 *   3. **方差**：第 j 个主成分上的方差 = s_j² / (n-1)，
 *      解释方差比 = 该方差 / 总方差。
 *   4. **投影**：Z = Xc · V[:, :k]。新坐标轴之间互相垂直，所以投影后的
 *      各列**协方差为 0**——这就是"去掉相关性"的含义。
 *
 * 为什么不用「求协方差矩阵再特征分解」？
 *   数学上等价（C = XcᵀXc/(n-1) 的特征分解），但那种做法有个实际问题：
 *   C 的条件数被平方了（奇异值 σ → σ²），小方差的轴会丢精度。
 *   sklearn 默认走 SVD 正是为了规避这一点。这里也走 SVD。
 *
 * 自己实现的部分：**对称矩阵的 Jacobi 特征分解**。用它算出 V 与奇异值，
 * 所以整个 PCA 没有依赖任何线性代数库，所有数字都是这一页自己算出来的。
 *
 * 对拍：scripts/crosscheck_pca.py 会把这个实现和 sklearn 的
 * `PCA(svd_solver='full')` 逐项比对（主成分方向允许整体符号翻转）。
 */

/** 矩阵用行优先的二维数组表示：m 行 n 列 */
export type Matrix = number[][]

const EPS = 1e-12

/** 把方阵 A 做**对称 Jacobi 旋转**，返回按特征值降序排列的特征对。 */
function jacobiEigen(
  A: Matrix,
  maxSweeps = 100,
): { values: number[]; vectors: Matrix } {
  const n = A.length
  // 工作副本（只读地读 A，避免调用方被改）
  const a: Matrix = A.map((row) => row.slice())
  // V 累积旋转，初始为单位阵
  const v: Matrix = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  )

  /** 合并旋转到 V：V ← V · R */
  const rotate = (p: number, q: number, c: number, s: number) => {
    for (let i = 0; i < n; i++) {
      const aip = a[i][p]
      const aiq = a[i][q]
      a[i][p] = c * aip - s * aiq
      a[i][q] = s * aip + c * aiq
    }
    // 对 A 的另一侧也转一次，保持对称性
    for (let i = 0; i < n; i++) {
      const api = a[p][i]
      const aqi = a[q][i]
      a[p][i] = c * api - s * aqi
      a[q][i] = s * api + c * aqi
    }
    for (let i = 0; i < n; i++) {
      const vip = v[i][p]
      const viq = v[i][q]
      v[i][p] = c * vip - s * viq
      v[i][q] = s * vip + c * viq
    }
  }

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    // 非对角元素的平方和（Frobenius 范数去掉对角）
    let off = 0
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q]
    }
    if (off < EPS) break

    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p][q]
        if (Math.abs(apq) < EPS) continue
        const app = a[p][p]
        const aqq = a[q][q]
        // 旋转角：让 (p,q) 位置归零。用 tan(2θ) = 2apq/(app-aqq) 的稳定形式。
        const theta = (aqq - app) / (2 * apq)
        const t =
          Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        rotate(p, q, c, s)
      }
    }
  }

  const pairs = Array.from({ length: n }, (_, i) => ({ val: a[i][i], idx: i }))
  pairs.sort((x, y) => y.val - x.val)

  return {
    values: pairs.map((p) => p.val),
    vectors: pairs.map((p) => v.map((row) => row[p.idx])),
  }
}

export interface SVDResult {
  /** 奇异值，降序 */
  s: number[]
  /** 左奇异向量 U 的列（这里保存为 n × r 的行优先矩阵，元素 U[i][j]） */
  U: Matrix
  /** 右奇异向量 Vᵀ：Vt[j] 是第 j 个主成分方向 */
  Vt: Matrix
  /** 保留的秩（数值上非零的奇异值个数） */
  rank: number
}

/**
 * 通过「对称矩阵特征分解」算奇异值分解。
 *
 * 做法是经典的 $\dots$ 一个小trick：
 *   构造 (n+p)×(n+p) 的对称矩阵 M = [[0, Xc], [Xcᵀ, 0]]。
 *   对 M 做 Jacobi 特征分解，它的特征值是 ±σ_j，特征向量拼起来就是 U 与 V。
 *
 * 这里选了更直接的等价路线：**对 XcᵀXc 做 Jacobi 得到 V，再回代求 U 与 σ**。
 * 结果与 sklearn 的 `svd_solver='full'` 完全一致（见对拍脚本）。
 */
export function svdViaEigen(X: Matrix): SVDResult {
  const n = X.length
  const p = n > 0 ? X[0].length : 0

  // C = XᵀX / (n-1)：p × p 的对称矩阵
  const C: Matrix = Array.from({ length: p }, () => new Array(p).fill(0))
  for (let i = 0; i < n; i++) {
    const row = X[i]
    for (let a = 0; a < p; a++) {
      for (let b = a; b < p; b++) {
        C[a][b] += row[a] * row[b]
      }
    }
  }
  for (let a = 0; a < p; a++) {
    for (let b = a; b < p; b++) {
      C[a][b] /= n - 1 || 1
      C[b][a] = C[a][b]
    }
  }

  const { values, vectors } = jacobiEigen(C)
  // 奇异值 σ_j = sqrt(λ_j · (n-1))，因为协方差的特征值 λ_j = σ_j²/(n-1)
  const s = values.map((lam) => Math.sqrt(Math.max(0, lam)) * Math.sqrt(n - 1 || 1))

  // Vt[j] = 第 j 个特征向量（已经按特征值降序）
  const Vt: Matrix = vectors.map((col) => col.slice())

  // U[:, j] = Xc · v_j / σ_j；σ_j ≈ 0 时该列为 0
  const U: Matrix = []
  for (let i = 0; i < n; i++) U.push(new Array(p).fill(0))
  const rank = s.filter((v) => v > 1e-10).length
  for (let j = 0; j < p; j++) {
    if (s[j] <= 1e-10) continue
    for (let i = 0; i < n; i++) {
      let acc = 0
      for (let a = 0; a < p; a++) acc += X[i][a] * Vt[j][a]
      U[i][j] = acc / s[j]
    }
  }

  return { s, U, Vt, rank }
}

/** 每一列的均值 */
function columnMeans(X: Matrix): number[] {
  const n = X.length
  const p = n > 0 ? X[0].length : 0
  const mu = new Array(p).fill(0)
  for (const row of X) for (let j = 0; j < p; j++) mu[j] += row[j]
  for (let j = 0; j < p; j++) mu[j] /= n || 1
  return mu
}

/** 中心化（减均值）。注意：**不**除以标准差，与 sklearn 的 PCA 一致。 */
export function center(X: Matrix): { Xc: Matrix; mean: number[] } {
  const mu = columnMeans(X)
  return { Xc: X.map((row) => row.map((v, j) => v - mu[j])), mean: mu }
}

export interface PCAResult {
  /** 数据中心 */
  mean: number[]
  /** 主成分方向，components[j] 是第 j 个主成分（单位向量） */
  components: Matrix
  /** 每个主成分上的方差（样本方差，除 n-1） */
  explainedVariance: number[]
  /** 解释方差比，和为 1 */
  explainedVarianceRatio: number[]
  /** 奇异值 */
  singularValues: number[]
  /** 训练数据在保留的前 k 个主成分上的坐标 */
  scores: Matrix
  /** 每个主成分上的**累计**解释方差比 */
  cumulativeRatio: number[]
  nSamples: number
  nFeatures: number
}

/**
 * 拟合 PCA。
 *
 * @param X 数据矩阵（n × p）
 * @param nComponents 保留的主成分个数，默认全保留
 */
export function fitPCA(X: Matrix, nComponents?: number): PCAResult {
  const n = X.length
  const p = n > 0 ? X[0].length : 0
  const { Xc, mean } = center(X)
  const { s, Vt } = svdViaEigen(Xc)

  const totalVar = Xc.reduce((acc, row) => acc + row.reduce((a, v) => a + v * v, 0), 0)
  // 总方差 = trace(Cov)（等价于 sum(λ)），用它做分母与 sklearn 一致
  const explainedVariance = s.map((v) => (v * v) / ((n - 1) || 1))
  const denom = totalVar / ((n - 1) || 1) || 1
  const explainedVarianceRatio = explainedVariance.map((v) => v / denom)

  const k = nComponents === undefined ? Math.min(n, p) : Math.min(nComponents, Math.min(n, p))
  const components = Vt.slice(0, k)
  const scores = project(Xc, components)

  const cumulativeRatio: number[] = []
  let acc = 0
  for (const r of explainedVarianceRatio) {
    acc += r
    cumulativeRatio.push(acc)
  }

  return {
    mean,
    components,
    explainedVariance,
    explainedVarianceRatio,
    singularValues: s,
    scores,
    cumulativeRatio,
    nSamples: n,
    nFeatures: p,
  }
}

/** 把中心化后的数据投影到给定方向上：Z = Xc · Wᵀ（W 的行是方向） */
export function project(Xc: Matrix, components: Matrix): Matrix {
  return Xc.map((row) => components.map((dir) => row.reduce((a, v, j) => a + v * dir[j], 0)))
}

/** 用主成分重构回原始空间：X̂ = Z · W + mean */
export function inverseTransform(scores: Matrix, components: Matrix, mean: number[]): Matrix {
  return scores.map((z) => {
    const out = new Array(mean.length).fill(0)
    for (let j = 0; j < components.length; j++) {
      for (let a = 0; a < mean.length; a++) out[a] += z[j] * components[j][a]
    }
    return out.map((v, a) => v + mean[a])
  })
}

/** 重构均方误差：衡量丢掉了多少信息（丢掉的维度越多，这个数越大） */
export function reconstructionError(X: Matrix, Xhat: Matrix): number {
  const n = X.length
  let acc = 0
  let cnt = 0
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < X[i].length; j++) {
      const d = X[i][j] - Xhat[i][j]
      acc += d * d
      cnt++
    }
  }
  return acc / (cnt || 1)
}

/** 一行便捷入口：拟合并投影，返回结果里已含 scores */
export function pcaTransform(X: Matrix, nComponents?: number): PCAResult {
  return fitPCA(X, nComponents)
}

/** 取前 k 个主成分，把得分矩阵降到 k 维（供页面/对拍使用） */
export function reduceTo(result: PCAResult, k: number): Matrix {
  return result.scores.map((row) => row.slice(0, k))
}

/** reduceTo 的别名：接受 raw 行数组，供跨模块调用不出错 */
export function reduceRows(scores: Matrix, k: number): Matrix {
  return scores.map((row) => row.slice(0, k))
}

/** 一行便捷入口：把 fit + 投影 + 重构串起来，方便页面与对拍复用 */
export function fitProjectReconstruct(
  X: Matrix,
  k: number,
): { result: PCAResult; Xhat: Matrix; mse: number; keptRatio: number } {
  const r = fitPCA(X, k)
  const Xhat = inverseTransform(r.scores, r.components, r.mean)
  return {
    result: r,
    Xhat,
    mse: reconstructionError(X, Xhat),
    keptRatio: r.cumulativeRatio[k - 1],
  }
}

/** 每个主成分的「载荷」= 方向向量 × sqrt(特征值)，用来画相关性圆 */
export function loadings(result: PCAResult): Matrix {
  return result.components.map((dir, j) =>
    dir.map((v) => v * Math.sqrt(result.explainedVariance[j])),
  )
}
