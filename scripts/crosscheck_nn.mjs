/**
 * 把 TS 手写的 MLP 在 Node 里跑一遍，输出 JSON 供 Python（sklearn）与数值梯度对拍。
 * 用法：node scripts/crosscheck_nn.mjs
 *
 * 【为什么这一页的对拍要费点脑子】
 *
 * 前几页的模型（线性回归、逻辑回归、SVM、K-means、PCA）要么是确定性的，
 * 要么随机性只体现在初始化上、可以用种子的方式固定下来。MLP 不一样：
 *
 *   1. **权重是随机的**，而且我的 PRNG 和 numpy 的 PRNG 不可能一致。
 *      → 所以不能"两边各训一个再比结果"。
 *      正确做法是 **把同一份权重喂给两边，只比前向输出**。
 *      权重从这里导出，Python 端塞进 MLPClassifier.coefs_ / intercepts_ 再调 predict_proba。
 *
 *   2. **训练过程不可能逐步对齐**（sklearn 默认 Adam + 自己的批划分）。
 *      → 所以不比 loss 曲线，改比 **解析梯度 vs 数值梯度**：
 *        用有限差分近似梯度，和我 backprop 算出来的比。
 *        这是"反向传播到底写对没有"最硬的判据，而且完全不依赖 sklearn。
 *
 *   3. **输出层约定容易搞错**：二分类 sklearn 是 **1 个 logit + sigmoid**（不是 softmax）。
 *      → 显式把两种约定的数值都算出来，让 Python 端确认 sklearn 用的是哪一种。
 */
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const res = await build({
  entryPoints: ['src/dev/nnEntry.ts'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  loader: { '.json': 'json' },
  logLevel: 'silent',
})

const mod = { exports: {} }
new Function('module', 'exports', 'require', res.outputFiles[0].text)(mod, mod.exports, require)
const M = mod.exports

const out = {}

/* ============ 一、前向传播对拍：把我的权重喂给 sklearn ============ */
/*
 * 参数化地覆盖：
 *   - 三种隐层激活：relu / tanh / logistic
 *   - 多种结构：单隐层、双隐层
 *   - 二分类（sigmoid 输出）与多分类（softmax 输出）
 *   - 输出层用 1 个 logit 还是 K 个 logit
 */
function exportForward(id, sizes, act, nClasses, X, seed) {
  const net = M.initNet(sizes, seed)
  const proba = M.predictProba(net, X, nClasses, act)
  const pred = M.predict(net, X, nClasses, act)
  return {
    id,
    sizes,
    activation: act,
    nClasses,
    W: net.W,
    b: net.b,
    X,
    proba,
    pred,
  }
}

// 构造一份两维的小数据（用于二分类）
const X2 = []
for (let i = 0; i < 12; i++) {
  for (let j = 0; j < 12; j++) X2.push([(i - 5.5) / 5.5, (j - 5.5) / 5.5])
}

// 四维小数据（用于多分类）
const X4 = []
for (let i = 0; i < 8; i++) {
  for (let j = 0; j < 8; j++) {
    X4.push([(i - 3.5) / 3.5, (j - 3.5) / 3.5, Math.sin(i + j), Math.cos(i - j)])
  }
}

out.forwards = [
  exportForward('relu-single-binary', [2, 5, 1], 'relu', 2, X2, 11),
  exportForward('tanh-single-binary', [2, 5, 1], 'tanh', 2, X2, 22),
  exportForward('logistic-single-binary', [2, 5, 1], 'logistic', 2, X2, 33),
  exportForward('relu-double-binary', [2, 6, 4, 1], 'relu', 2, X2, 44),
  exportForward('tanh-double-binary', [2, 6, 4, 1], 'tanh', 2, X2, 55),
  exportForward('relu-double-multi', [4, 7, 5, 3], 'relu', 3, X4, 66),
  exportForward('tanh-single-multi', [4, 9, 3], 'tanh', 3, X4, 77),
  exportForward('logistic-double-multi', [4, 6, 4, 3], 'logistic', 3, X4, 88),
]

/* ============ 二、解析梯度 vs 数值梯度（不依赖 sklearn） ============ */
/*
 * 数值梯度：对每个参数 w 做 (L(w+ε) - L(w-ε)) / (2ε)。
 * 中心差分误差 O(ε²)，取 ε=1e-5 时相对误差通常在 1e-8 ~ 1e-10 量级。
 *
 * 直接改参数算出 L 再改回来，所以需要能"读写单个参数"。
 * 我把 net 摊平成 (路径, 当前值) 的列表，逐个扰动。
 */
function numGrad(net, X, Y, nClasses, act, l2, eps) {
  const params = []
  for (let l = 0; l < net.W.length; l++) {
    for (let i = 0; i < net.W[l].length; i++) {
      for (let j = 0; j < net.W[l][i].length; j++) {
        params.push({
          get: () => net.W[l][i][j],
          set: (v) => {
            net.W[l][i][j] = v
          },
        })
      }
    }
    for (let j = 0; j < net.b[l].length; j++) {
      params.push({
        get: () => net.b[l][j],
        set: (v) => {
          net.b[l][j] = v
        },
      })
    }
  }

  const lossAt = () => {
    const cache = M.forward(net, X, act)
    return M.backward(net, cache, X, Y, nClasses, act, l2).loss
  }

  const grad = params.map((p) => {
    const orig = p.get()
    p.set(orig + eps)
    const lp = lossAt()
    p.set(orig - eps)
    const lm = lossAt()
    p.set(orig)
    return (lp - lm) / (2 * eps)
  })

  // 把 grad 摊回去（顺序与 params 一致）
  return grad
}

function gradCheck(id, sizes, act, nClasses, X, y, seed, l2) {
  const net = M.initNet(sizes, seed)
  const Y = M.oneHot(y, nClasses)
  const cache = M.forward(net, X, act)
  const { dW, db, loss } = M.backward(net, cache, X, Y, nClasses, act, l2)

  // 解析梯度摊平（顺序必须和 numGrad 完全一致：先 W 再 b，逐层）
  const ana = []
  for (let l = 0; l < net.W.length; l++) {
    for (const row of dW[l]) for (const v of row) ana.push(v)
    for (const v of db[l]) ana.push(v)
  }

  const num = numGrad(net, X, Y, nClasses, act, l2, 1e-5)

  // 相对误差（分母加 1e-12 防止除零）
  let maxRel = 0
  let maxAbs = 0
  const pairs = []
  for (let i = 0; i < ana.length; i++) {
    const rel = Math.abs(ana[i] - num[i]) / Math.max(1e-12, Math.abs(ana[i]) + Math.abs(num[i]))
    maxRel = Math.max(maxRel, rel)
    maxAbs = Math.max(maxAbs, Math.abs(ana[i] - num[i]))
    pairs.push({ a: ana[i], n: num[i], rel })
  }
  // 挑最差的前几个回报，便于诊断
  pairs.sort((p, q) => q.rel - p.rel)

  return {
    id,
    sizes,
    activation: act,
    nClasses,
    l2: l2 || 0,
    loss,
    nParams: ana.length,
    maxRelError: maxRel,
    maxAbsError: maxAbs,
    // 只回报最差的 5 个，避免 JSON 太大
    worst: pairs.slice(0, 5).map((p) => ({ analytic: p.a, numeric: p.n, rel: p.rel })),
  }
}

{
  const xor = M.makeXor(0.16)
  const rnd = M.makeSpiral(24, 0.05)
  out.gradChecks = [
    gradCheck('xor-relu-2-4-1', [2, 4, 1], 'relu', 2, xor.data, xor.labels, 101),
    gradCheck('xor-tanh-2-4-1', [2, 4, 1], 'tanh', 2, xor.data, xor.labels, 102),
    gradCheck('xor-logistic-2-4-1', [2, 4, 1], 'logistic', 2, xor.data, xor.labels, 103),
    gradCheck('xor-relu-2-5-4-1', [2, 5, 4, 1], 'relu', 2, xor.data, xor.labels, 104),
    gradCheck('xor-relu-2-4-1-l2', [2, 4, 1], 'relu', 2, xor.data, xor.labels, 105, 0.01),
    gradCheck('xor-tanh-2-5-4-1', [2, 5, 4, 1], 'tanh', 2, xor.data, xor.labels, 106),
    gradCheck('xor-identity-2-4-1', [2, 4, 1], 'identity', 2, xor.data, xor.labels, 107),
    // 多分类：softmax + 交叉熵
    gradCheck(
      'spiral-relu-2-8-3',
      [2, 8, 3],
      'relu',
      3,
      rnd.data,
      rnd.labels.map((v, i) => i % 3),
      108,
    ),
    gradCheck(
      'spiral-tanh-2-6-4-3',
      [2, 6, 4, 3],
      'tanh',
      3,
      rnd.data,
      rnd.labels.map((v, i) => i % 3),
      109,
    ),
    gradCheck(
      'spiral-logistic-2-7-3',
      [2, 7, 3],
      'logistic',
      3,
      rnd.data,
      rnd.labels.map((v, i) => i % 3),
      110,
    ),
  ]
}

/* ============ 三、输出层约定：二分类到底是 sigmoid 还是 softmax ============ */
/*
 * sklearn MLPClassifier 的二分类输出层只有 1 个神经元（logit），
 * 走 sigmoid。这里把两种猜测都算出来交给 Python 端核对。
 */
{
  const net = M.initNet([2, 5, 1], 42)
  const logits = M.forward(net, X2, 'relu').z[1]
  const sig = logits.map((r) => M.sigmoid(r[0]))
  // 把同一个 logit 当成"两类各一个 logit"强行 softmax（错误做法）作对照
  const soft = M.softmaxRows(logits.map((r) => [r[0], r[0]]))
  out.outputConvention = {
    X: X2,
    W: net.W,
    b: net.b,
    logits: logits.map((r) => r[0]),
    sigmoid: sig,
    softmaxSameLogit: soft.map((r) => r[1]),
    nOutputUnits: net.W[net.W.length - 1][0].length,
  }
}

/* ============ 四、训练收敛性（不做对拍，只作为"实现能训起来"的证据） ============ */
{
  const xor = M.makeXor(0.16)
  const cfg = { activation: 'relu', lr: 0.3, batchSize: 32, nClasses: 2, seed: 7 }
  const net = M.initNet([2, 4, 1], 7)
  const { history } = M.train(net, xor.data, xor.labels, cfg, 400, 7)
  out.trainXor = {
    sizes: [2, 4, 1],
    activation: 'relu',
    lr: 0.3,
    batchSize: 32,
    epochs: 400,
    firstLoss: history.loss[0],
    lastLoss: history.loss[history.loss.length - 1],
    firstAcc: history.acc[0],
    lastAcc: history.acc[history.acc.length - 1],
    lossEvery50: history.loss.filter((_, i) => i % 50 === 0),
    accEvery50: history.acc.filter((_, i) => i % 50 === 0),
  }
}

/* ============ 五、确定性检查：同种子两次训练必须完全一致 ============ */
{
  const xor = M.makeXor(0.16)
  const cfg = { activation: 'tanh', lr: 0.2, batchSize: 16, nClasses: 2, seed: 5 }
  const a = M.train(M.initNet([2, 3, 1], 5), xor.data, xor.labels, cfg, 30, 5)
  const b = M.train(M.initNet([2, 3, 1], 5), xor.data, xor.labels, cfg, 30, 5)
  const same = JSON.stringify(a.net) === JSON.stringify(b.net) &&
    JSON.stringify(a.history) === JSON.stringify(b.history)
  out.determinism = { same }
}

console.log(JSON.stringify(out))
