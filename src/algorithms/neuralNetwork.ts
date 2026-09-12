/**
 * 多层感知机 MLP（手写实现）。
 *
 * 一个神经网络只有两件事：
 *
 *   **前向传播**：把输入逐层拧过去，每层做「线性变换 + 非线性激活」：
 *       z = a·W + b        （线性：把上一层的输出重新加权组合）
 *       a' = f(z)          （非线性：把结果掰弯）
 *
 *   **反向传播**：从损失往回问"每个参数该负多少责任"（梯度），
 *   用链式法则一层层把误差传回去，然后按梯度反方向走一小步。
 *
 * 反向传播本身不是什么新东西——它就是**链式法则 + 一个聪明的计算顺序**。
 * 关键观察：第 l 层的梯度可以由第 (l+1) 层的梯度推出来，所以从输出往输入算一遍即可，
 * 不需要为每个参数单独求导（那是 O(参数量²) 的复杂度，根本算不动）。
 *
 * 与前几页一个重要的差别：**这一页的初始化是随机的**，所以对拍不能直接比模型输出。
 * 对拍的正确做法是「把我的权重塞给 sklearn，只比前向」+「解析梯度对数值梯度」——
 * 见 scripts/crosscheck_nn.py。这也是判断"反向传播到底写对没有"最硬的判据。
 *
 * 与 sklearn 的对应关系（细节都刻意对齐过）：
 *   - 隐层激活：`activation` 参数（'relu' | 'tanh' | 'logistic'）
 *   - 输出层：**二分类用 1 个 logit + sigmoid**（不是 softmax！），
 *     多分类才用 softmax 输出 K 个 logit。这一条是实测确认的，见对拍脚本。
 *   - 损失：交叉熵（多分类）/ 二元交叉熵（二分类）
 *   - 优化：mini-batch SGD
 */

import { mulberry32, gaussian } from '../data/prng'

export type Matrix = number[][]
export type Activation = 'relu' | 'tanh' | 'logistic' | 'identity'

/* ============================ 激活函数 ============================ */

export const ACTIVATIONS: Record<Activation, { f: (z: number) => number; df: (z: number) => number; tex: string; label: string }> = {
  relu: {
    f: (z) => (z > 0 ? z : 0),
    // ReLU 在 0 处不可导，工程上取 0（sklearn 同样处理）
    df: (z) => (z > 0 ? 1 : 0),
    tex: '\\max(0, z)',
    label: 'ReLU',
  },
  tanh: {
    f: (z) => 1 - 2 / (Math.exp(2 * z) + 1),
    df: (z) => 1 - (1 - 2 / (Math.exp(2 * z) + 1)) ** 2,
    tex: '\\tanh(z)',
    label: 'tanh',
  },
  logistic: {
    f: (z) => 1 / (1 + Math.exp(-z)),
    df: (z) => {
      const s = 1 / (1 + Math.exp(-z))
      return s * (1 - s)
    },
    tex: '\\sigma(z)',
    label: 'logistic',
  },
  identity: {
    f: (z) => z,
    df: () => 1,
    tex: 'z',
    label: '线性（无激活）',
  },
}

/** 数值稳定的 sigmoid：分两支算，±800 都不溢出 */
export function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z))
  const e = Math.exp(z)
  return e / (1 + e)
}

/** 逐元素激活 */
function applyAct(m: Matrix, act: Activation): Matrix {
  const f = ACTIVATIONS[act].f
  return m.map((row) => row.map(f))
}

/** 逐元素激活的导数（输入是 z，不是 a） */
function applyActGrad(z: Matrix, act: Activation): Matrix {
  const df = ACTIVATIONS[act].df
  return z.map((row) => row.map(df))
}

/* ============================ 矩阵工具 ============================ */

function matmul(a: Matrix, b: Matrix): Matrix {
  const n = a.length
  const m = b[0].length
  const k = b.length
  const out: Matrix = Array.from({ length: n }, () => new Array(m).fill(0))
  for (let i = 0; i < n; i++) {
    for (let p = 0; p < k; p++) {
      const av = a[i][p]
      if (av === 0) continue
      for (let j = 0; j < m; j++) out[i][j] += av * b[p][j]
    }
  }
  return out
}

/** aᵀ · b */
function matmulT(a: Matrix, b: Matrix): Matrix {
  const k = a.length
  const n = a[0].length
  const m = b[0].length
  const out: Matrix = Array.from({ length: n }, () => new Array(m).fill(0))
  for (let i = 0; i < n; i++) {
    for (let p = 0; p < k; p++) {
      const av = a[p][i]
      if (av === 0) continue
      for (let j = 0; j < m; j++) out[i][j] += av * b[p][j]
    }
  }
  return out
}

function addRowBias(a: Matrix, b: number[]): Matrix {
  return a.map((row) => row.map((v, j) => v + b[j]))
}

/** softmax（按行，减最大值保证数值稳定） */
export function softmaxRows(z: Matrix): Matrix {
  return z.map((row) => {
    const mx = Math.max(...row)
    const e = row.map((v) => Math.exp(v - mx))
    const s = e.reduce((x, y) => x + y, 0) || 1
    return e.map((v) => v / s)
  })
}

/* ============================ 参数结构 ============================ */

export interface NetConfig {
  /** 每层神经元数，含输入与输出。例：[2, 8, 1] 表示 2 维输入 → 8 个隐层 → 1 个输出 */
  sizes: number[]
  /** 隐层激活函数（输出层固定：二分类 sigmoid / 多分类 softmax） */
  activation: Activation
  /** 学习率 */
  lr: number
  /** mini-batch 大小 */
  batchSize: number
  /** 类别数：2 = 二分类（输出 1 个 logit），>2 = 多分类（输出 K 个 logit） */
  nClasses: number
  /** 随机种子 */
  seed: number
}

export interface Net {
  /** 权重：W[l] 的形状是 (sizes[l], sizes[l+1]) */
  W: Matrix[]
  /** 偏置：b[l] 的形状是 (sizes[l+1],) */
  b: number[][]
}

/**
 * 初始化权重。
 *
 * 用 **Xavier/Glorot** 缩放：std = sqrt(2/(fan_in+fan_out))。
 * 为什么不直接用标准正态？因为那样每层的输出方差会随 fan_in 线性放大，
 * 层数一多激活值就爆掉（或全压到 0）——这是"深层网络难训"的第一个坎。
 * sklearn 默认是 uniform(-1,1)*sqrt(6/(fan_in+fan_out))，效果类似。
 */
export function initNet(sizes: number[], seed = 1): Net {
  const rnd = mulberry32(seed)
  const W: Matrix[] = []
  const b: number[][] = []
  for (let l = 0; l < sizes.length - 1; l++) {
    const fanIn = sizes[l]
    const fanOut = sizes[l + 1]
    const std = Math.sqrt(2 / (fanIn + fanOut))
    const w: Matrix = Array.from({ length: fanIn }, () =>
      Array.from({ length: fanOut }, () => gaussian(rnd) * std),
    )
    W.push(w)
    b.push(new Array(fanOut).fill(0))
  }
  return { W, b }
}

/* ============================ 前向 / 反向 ============================ */

export interface ForwardCache {
  /** 每层的线性输出 z[l]（含输出层） */
  z: Matrix[]
  /** 每层的激活输出 a[l]（a[0] = 输入） */
  a: Matrix[]
}

/** 前向传播，顺便缓存中间量（反向要用） */
export function forward(net: Net, X: Matrix, act: Activation): ForwardCache {
  const a: Matrix[] = [X]
  const z: Matrix[] = []
  let cur = X
  for (let l = 0; l < net.W.length; l++) {
    const zl = addRowBias(matmul(cur, net.W[l]), net.b[l])
    z.push(zl)
    const isLast = l === net.W.length - 1
    const aNext = isLast ? zl : applyAct(zl, act)
    a.push(aNext)
    cur = aNext
  }
  return { z, a }
}

/** 输出层概率：二分类 sigmoid，多分类 softmax */
export function predictProba(net: Net, X: Matrix, nClasses: number, act: Activation = 'relu'): Matrix {
  const cache = forward(net, X, act)
  const logits = cache.z[cache.z.length - 1]
  if (nClasses === 2) {
    // 二分类：单个 logit → sigmoid，返回 [P(0), P(1)]
    return logits.map((row) => {
      const p = sigmoid(row[0])
      return [1 - p, p]
    })
  }
  return softmaxRows(logits)
}

/** 预测类别 */
export function predict(net: Net, X: Matrix, nClasses: number, act: Activation = 'relu'): number[] {
  const cache = forward(net, X, act)
  const logits = cache.z[cache.z.length - 1]
  // 二分类阈值取**严格大于** 0.5，与 sklearn 一致。
  // 这个细节不是吹毛求疵：ReLU 网络里若有样本让所有隐层单元都落在负半轴，
  // logit 会精确等于 0、p 精确等于 0.5，此时 `>=` 与 `>` 会给出完全不同的类别
  // （实测一份 144 点的网格上有 36 点平局）。对拍时这一点必须对齐。
  if (nClasses === 2) return logits.map((row) => (sigmoid(row[0]) > 0.5 ? 1 : 0))
  return logits.map((row) => {
    let bi = 0
    for (let j = 1; j < row.length; j++) if (row[j] > row[bi]) bi = j
    return bi
  })
}

export interface GradResult {
  dW: Matrix[]
  db: number[][]
  loss: number
}

/**
 * 反向传播：算出每个参数的梯度与当前损失。
 *
 * 推导（以二分类为例，损失 L = 二元交叉熵）：
 *   输出层  δ_out = (p - y) / n            ← sigmoid + 交叉熵的漂亮结果
 *   隐层    δ_l   = (δ_{l+1} · W_{l+1}ᵀ) ⊙ f'(z_l)
 *   权重梯度 dW_l = a_lᵀ · δ_{l+1}
 *   偏置梯度 db_l = Σ δ_{l+1}
 *
 * 注意 `(p - y)` 这个简洁形式不是巧合：它是 **sigmoid 的导数与交叉熵的
 * 1/p 项互相抵消**的结果。换成交叉熵 + softmax 也是同一个形式。
 * 这也是为什么分类任务几乎总是用交叉熵而不是 MSE。
 */
export function backward(
  net: Net,
  cache: ForwardCache,
  X: Matrix,
  Y: Matrix,
  nClasses: number,
  act: Activation = 'relu',
  l2 = 0,
): GradResult {
  const n = X.length
  const L = net.W.length
  const dW: Matrix[] = new Array(L)
  const db: number[][] = new Array(L)

  // ---- 损失与输出层误差 δ ----
  let loss = 0
  const lastZ = cache.z[L - 1]
  let delta: Matrix

  if (nClasses === 2) {
    // 二分类：1 个 logit，p = sigmoid(z)
    //
    // ⚠️ 这里的 Y 是 **K 列的 one-hot**（oneHot(y, nClasses) 的产物），
    // 但二分类输出层只有 1 个 logit，所以要把 2 列压成 1 个目标值 t。
    // 若直接取 Y[i][0]，当 y=1 时 t 会是 0，网络就被训成"预测反的"
    // （损失照样下降、准确率却是 0%）——这个坑真实踩过，见对拍脚本。
    delta = lastZ.map((row, i) => {
      // 从 one-hot 反推原标签（哪一列是 1 就是哪个类），再当 sigmoid 的目标
      const yi = Y[i][1] >= Y[i][0] ? 1 : 0
      const p = sigmoid(row[0])
      const eps = 1e-15
      const pc = Math.min(1 - eps, Math.max(eps, p))
      loss += -(yi * Math.log(pc) + (1 - yi) * Math.log(1 - pc))
      return [(p - yi) / n]
    })
  } else {
    // 多分类：softmax
    const probs = softmaxRows(lastZ)
    delta = probs.map((row, i) => {
      const eps = 1e-15
      const t = Y[i]
      // 交叉熵（用 one-hot 的哪一位为 1 挑出对应概率）
      let ti = 0
      for (let j = 0; j < t.length; j++) if (t[j] > t[ti]) ti = j
      loss += -Math.log(Math.max(eps, row[ti]))
      return row.map((p, j) => (p - t[j]) / n)
    })
  }
  loss /= n
  if (l2 > 0) {
    let s = 0
    for (const w of net.W) for (const row of w) for (const v of row) s += v * v
    loss += (l2 / 2) * s
  }

  // ---- 从输出层往回逐层算 ----
  for (let l = L - 1; l >= 0; l--) {
    const aPrev = cache.a[l]
    dW[l] = matmulT(aPrev, delta)
    const rowSum = new Array(delta[0].length).fill(0)
    for (const row of delta) for (let j = 0; j < row.length; j++) rowSum[j] += row[j]
    db[l] = rowSum
    if (l2 > 0) {
      for (let i = 0; i < dW[l].length; i++) {
        for (let j = 0; j < dW[l][i].length; j++) dW[l][i][j] += l2 * net.W[l][i][j]
      }
    }

    if (l > 0) {
      // δ_{l-1} = (δ_l · W_lᵀ) ⊙ f'(z_{l-1})
      const back = matmul(delta, transpose(net.W[l]))
      const g = applyActGrad(cache.z[l - 1], act)
      delta = back.map((row, i) => row.map((v, j) => v * g[i][j]))
    }
  }

  return { dW, db, loss }
}

export function transpose(m: Matrix): Matrix {
  const n = m.length
  const p = n > 0 ? m[0].length : 0
  const out: Matrix = Array.from({ length: p }, () => new Array(n).fill(0))
  for (let i = 0; i < n; i++) for (let j = 0; j < p; j++) out[j][i] = m[i][j]
  return out
}

/* ============================ 训练 ============================ */

export interface TrainHistory {
  /** 每个 epoch 的训练损失 */
  loss: number[]
  /** 每个 epoch 的准确率 */
  acc: number[]
}

export interface TrainResult {
  net: Net
  history: TrainHistory
  epochs: number
}

/** one-hot 编码 */
export function oneHot(labels: number[], nClasses: number): Matrix {
  return labels.map((y) => {
    const row = new Array(nClasses).fill(0)
    row[y] = 1
    return row
  })
}

/**
 * 训练（mini-batch SGD）。
 *
 * sklearn 默认用 **Adam**；这一页用最朴素的 SGD，因为它的每一步都最好解释，
 * 而且 Adam 的更新公式会把"梯度准不准"这件事藏起来。
 * 对拍不依赖优化器——我们比的是梯度本身（见 crosscheck_nn.py）。
 */
export function train(
  net: Net,
  X: Matrix,
  y: number[],
  cfg: Omit<NetConfig, 'sizes'> & { sizes?: number[] },
  epochs: number,
  seed = 1,
  /** 每个 epoch 结束时的回调，用于单步演示 */
  onEpoch?: (epoch: number, net: Net, loss: number, acc: number) => void,
): TrainResult {
  const Y = oneHot(y, cfg.nClasses)
  const n = X.length
  const history: TrainHistory = { loss: [], acc: [] }
  const rnd = mulberry32(seed + 999)

  // Fisher-Yates 洗牌（用确定性 PRNG）
  const order = Array.from({ length: n }, (_, i) => i)
  const shuffleInPlace = (arr: number[]) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
    }
  }

  for (let ep = 0; ep < epochs; ep++) {
    shuffleInPlace(order)
    const bs = Math.max(1, Math.min(cfg.batchSize, n))
    for (let s = 0; s < n; s += bs) {
      const idx = order.slice(s, s + bs)
      const Xb = idx.map((i) => X[i])
      const Yb = idx.map((i) => Y[i])
      const cache = forward(net, Xb, cfg.activation)
      const { dW, db } = backward(net, cache, Xb, Yb, cfg.nClasses, cfg.activation)
      // SGD 更新
      for (let l = 0; l < net.W.length; l++) {
        for (let i = 0; i < net.W[l].length; i++) {
          for (let j = 0; j < net.W[l][i].length; j++) {
            net.W[l][i][j] -= cfg.lr * dW[l][i][j]
          }
        }
        for (let j = 0; j < net.b[l].length; j++) {
          net.b[l][j] -= cfg.lr * db[l][j]
        }
      }
    }

    // 每个 epoch 记一次全量损失与准确率
    const cache = forward(net, X, cfg.activation)
    const { loss } = backward(net, cache, X, Y, cfg.nClasses, cfg.activation)
    const pred = predict(net, X, cfg.nClasses, cfg.activation)
    const acc = pred.reduce((a, p, i) => a + (p === y[i] ? 1 : 0), 0) / n
    history.loss.push(loss)
    history.acc.push(acc)
    if (onEpoch) onEpoch(ep, net, loss, acc)
  }

  return { net, history, epochs }
}

/* ============================ 可视化辅助 ============================ */

/**
 * 在平面上算决策函数的值，用于画决策边界。
 * 返回 (h × w) 的二维网格，值 = 模型对"类别 1"的预测概率。
 */
export function decisionGrid(
  net: Net,
  xRange: [number, number],
  yRange: [number, number],
  res: number,
  nClasses: number,
  act: Activation = 'relu',
): { values: number[][]; x: number[]; y: number[] } {
  const xs: number[] = []
  const ys: number[] = []
  for (let i = 0; i < res; i++) {
    xs.push(xRange[0] + ((xRange[1] - xRange[0]) * i) / (res - 1))
    ys.push(yRange[0] + ((yRange[1] - yRange[0]) * i) / (res - 1))
  }
  // 构造网格点（行优先，y 从下往上）
  const pts: Matrix = []
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) pts.push([xs[i], ys[j]])
  const proba = predictProba(net, pts, nClasses, act)
  const values: number[][] = []
  for (let j = 0; j < res; j++) {
    const row: number[] = []
    for (let i = 0; i < res; i++) row.push(proba[j * res + i][1])
    values.push(row)
  }
  return { values, x: xs, y: ys }
}

/** 取出某一层的激活值（给"看神经元在干什么"用） */
export function layerActivations(net: Net, X: Matrix, act: Activation, layer: number): Matrix {
  const cache = forward(net, X, act)
  return cache.a[layer + 1] ?? cache.a[cache.a.length - 1]
}
