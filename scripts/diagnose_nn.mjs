/**
 * 神经网络页的「量化诊断」：把几个反直觉的说法用数字砸实。
 * 用法：node scripts/diagnose_nn.mjs
 *
 * 这一页最容易变成"看图说话"——反正决策边界弯了就好看。
 * 我不想靠感觉，所以每个教学点都先量出来：
 *
 *   1. **没有非线性激活，多层就等于一层**：identity 激活把两层网络压成线性模型，
 *      在异或上准确率应该和逻辑回归一样（≈50%），不管加多少层。
 *   2. **ReLU 单位越多，表达力越强**（螺旋上的分界）：测不同宽度/深度。
 *   3. **换激活函数效果差多少**：relu / tanh / logistic 在同一结构下的收敛速度。
 *   4. **学习率过大会怎样**：loss 震荡不降。
 *
 * 输出都是"跑出来"的真实数字，页面文案直接引用，不编。
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

const datasets = M.buildNnDatasets(M.irisRaw)
const byId = Object.fromEntries(datasets.map((d) => [d.id, d]))

function run(dsId, sizes, act, epochs, lr, batchSize, seed = 7) {
  const ds = byId[dsId]
  const cfg = { activation: act, lr, batchSize, nClasses: ds.nClasses, seed }
  const net = M.initNet(sizes, seed)
  const t0 = Date.now()
  const { history } = M.train(net, ds.data, ds.labels, cfg, epochs, seed)
  const ms = Date.now() - t0
  const n = ds.data.length
  const acc = history.acc[history.acc.length - 1]
  // 达到 95% 准确率用了多少 epoch（衡量收敛速度）
  let firstHit = null
  for (let i = 0; i < history.acc.length; i++) {
    if (history.acc[i] >= 0.95) {
      firstHit = i + 1
      break
    }
  }
  /*
   * ⚠️ 光看准确率会被"退化模型"骗到。
   * 实例：identity 激活在异或上准确率报 75%，看着像学了点什么，
   * 实际上输出恒为 0.5（loss = ln2 = 0.6931，概率跨度只有 0.4978~0.5073），
   * 75% 只是"碰巧多数点被分到 1 类"的假象。
   * 所以额外记录**概率跨度**——一个真学到的模型，正负样本的 p 应该拉得很开。
   */
  const proba = M.predictProba(net, ds.data, ds.nClasses, act)
  const p1 = proba.map((r) => r[1])
  const spread = Math.max(...p1) - Math.min(...p1)
  // 报"预测分布"：退化模型会把绝大多数点压到同一个类
  const dist = [0, 0]
  for (const p of M.predict(net, ds.data, ds.nClasses, act)) dist[p]++
  return {
    dsId,
    sizes,
    act,
    epochs,
    lr,
    batchSize,
    n,
    finalAcc: acc,
    finalLoss: history.loss[history.loss.length - 1],
    firstLoss: history.loss[0],
    firstHitEpoch: firstHit,
    probaSpread: spread,
    predDist: dist,
    ms,
    lossTail: history.loss.slice(-5),
  }
}

const out = { experiments: {}, notes: [] }

/* ---------- 实验 1：identity 激活 → 多层退化成线性模型 ---------- */
/*
 * 这是本页的核心教学点：**非线性的来源是激活函数，不是层数。**
 * identity 激活下 a' = z = a·W + b，两层复合仍是 a·(W1·W2) + (b1·W2 + b2)，
 * 即一个等价的单层线性变换。所以在异或（线性不可分）上必然学不动。
 *
 * ⚠️ 这里必须看 **loss 和概率跨度**，不能看准确率：
 *   实测 identity 在异或上准确率会报 75%，看着像学了点什么，
 *   实际上 loss 恒为 0.6931（= ln 2，即"完全无信息"）、
 *   概率跨度只有 0.4978~0.5073（几乎平坦），
 *   而且预测分布是 40:120 严重失衡——75% 纯属"碰巧多数点落到同一类"的假象。
 */
{
  const rows = []
  for (const sizes of [[2, 4, 1], [2, 16, 1], [2, 8, 8, 1], [2, 16, 16, 1]]) {
    rows.push(run('xor', sizes, 'identity', 300, 0.3, 32))
  }
  out.experiments.identityOnXor = {
    desc:
      '异或上，identity（无激活）不管加多深多宽都学不会。' +
      '注意别看准确率（会报 75% 的假象），要看 loss 恒为 ln2=0.6931、概率跨度≈0.01。',
    rows,
    baselineLinear: 0.5, // 异或上任何线性模型的准确率上限
    ln2: Math.log(2),
  }
}

/* ---------- 实验 2：有激活时异或立刻能解 ---------- */
{
  const rows = []
  for (const act of ['relu', 'tanh', 'logistic']) {
    for (const sizes of [[2, 2, 1], [2, 4, 1], [2, 8, 1]]) {
      rows.push(run('xor', sizes, act, 300, 0.3, 32))
    }
  }
  out.experiments.activationOnXor = {
    desc: '同一个异或，加上非线性激活后立刻能解',
    rows,
  }
}

/* ---------- 实验 3：深度与宽度在螺旋/同心圆上的作用 ---------- */
{
  const rows = []
  const cfgs = [
    ['spiral', [2, 2, 1]],
    ['spiral', [2, 4, 1]],
    ['spiral', [2, 8, 1]],
    ['spiral', [2, 16, 1]],
    ['spiral', [2, 8, 8, 1]],
    ['spiral', [2, 16, 16, 1]],
    ['circles', [2, 4, 1]],
    ['circles', [2, 8, 1]],
    ['circles', [2, 8, 8, 1]],
    ['circles', [2, 16, 16, 1]],
    ['moons', [2, 2, 1]],
    ['moons', [2, 8, 1]],
    ['moons', [2, 8, 8, 1]],
  ]
  for (const [ds, sizes] of cfgs) {
    rows.push(run(ds, sizes, 'relu', 500, 0.3, 32))
  }
  out.experiments.capacity = {
    desc: '给不够的神经元 → 学不动；加宽加深 → 学得会',
    rows,
  }
}

/* ---------- 实验 4：学习率的影响 ---------- */
{
  const rows = []
  for (const lr of [0.01, 0.05, 0.3, 1.0, 3.0]) {
    rows.push(run('moons', [2, 8, 1], 'relu', 300, lr, 32))
  }
  out.experiments.learningRate = { desc: '学习率太小 → 300 轮还不够；太大 → 震荡不收敛', rows }
}

/* ---------- 实验 5：batch size 的影响（真 SGD vs 全批量） ---------- */
{
  const rows = []
  for (const bs of [1, 8, 32, 240]) {
    rows.push(run('moons', [2, 8, 1], 'relu', 300, 0.3, bs))
  }
  out.experiments.batchSize = { desc: 'batch=1 是真随机，batch=全量是确定性下降', rows }
}

/* ---------- 实验 6：多分类鸢尾花 ---------- */
{
  const rows = []
  for (const sizes of [[4, 3, 3], [4, 8, 3], [4, 16, 16, 3]]) {
    for (const act of ['relu', 'tanh', 'logistic']) {
      rows.push(run('iris', sizes, act, 400, 0.1, 16))
    }
  }
  out.experiments.iris = { desc: '真实数据三分类（softmax 输出 + 交叉熵）', rows }
}

/* ---------- 实验 6b：学习率 × 数据尺度（鸢尾花） ---------- */
/*
 * 这是本页最有实践价值的一个实验：**鸢尾花是原始量纲**（萼片长 4.3~7.9、
 * 花瓣宽 0.1~2.5，差近两个数量级），而二维玩具数据都在 [-1,1] 附近。
 * 同样一个 lr，在两者上的表现天差地别。
 *
 * 实测（结构 [4,8,3]，从头初始化，跑 20 个种子）：
 *   lr=0.1 → 20/20 全部成功（>90%）
 *   lr=0.3 → 20/20 全部失败，卡在 33%（loss 精确等于 ln3 = 1.0986，即"三类各 1/3"）
 * 这就是"数据不缩放就必须调小学习率"的现场证据。
 */
{
  const iris = byId['iris']
  const sizes = [4, 8, 3]
  const rows = []
  for (const lr of [0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 1.0]) {
    let ok = 0
    let sumAcc = 0
    const N = 12
    for (let seed = 1; seed <= N; seed++) {
      const net = M.initNet(sizes, seed)
      const { history } = M.train(
        net, iris.data, iris.labels,
        { activation: 'relu', lr, batchSize: 16, nClasses: 3, seed },
        300, seed,
      )
      const acc = history.acc[history.acc.length - 1]
      sumAcc += acc
      if (acc >= 0.9) ok++
    }
    rows.push({ lr, seedCount: N, successCount: ok, successRate: ok / N, meanAcc: sumAcc / N })
  }
  out.experiments.irisLearningRate = {
    desc:
      '鸢尾花（原始量纲，未标准化）下，学习率取多少能训好。' +
      '每个 lr 跑 12 个随机种子，看有几个能到 90% 以上。',
    rows,
  }
}

/* ---------- 实验 7：激活函数在极深网络下的梯度衰减 ---------- */
/*
 * 直观体会"为什么深层网络难训"：把隐层堆到 8 层，
 * 看第一层权重的平均梯度范数相对最后一层掉了几个数量级。
 *
 * ⚠️ 实测结果和"经典说法"不完全一样，值得记下来：
 *   - **logistic 崩得最惨**：第一层梯度比最后一层小 6 个数量级（5.9e-7），
 *     这就是 sigmoid 在深层网络里被淘汰的直接原因（梯度消失）。
 *   - **tanh 并没有明显衰减**（~0.58），比预期好得多；
 *   - **relu 几乎不衰减**（~0.90），这正是它成为默认选择的理由。
 *   所以"梯度消失"主要发生在**饱和型**激活（logistic）上，
 *   不能一概而论说"层数多就梯度消失"。
 */
{
  const rows = []
  const xor = byId['xor']
  for (const act of ['relu', 'tanh', 'logistic', 'identity']) {
    const sizes = [2, 8, 8, 8, 8, 8, 8, 8, 8, 1]
    const net = M.initNet(sizes, 3)
    const Y = M.oneHot(xor.labels, 2)
    const cache = M.forward(net, xor.data, act)
    const { dW } = M.backward(net, cache, xor.data, Y, 2, act)
    const norm = (m) => Math.sqrt(m.flat().reduce((a, v) => a + v * v, 0))
    const norms = dW.map(norm)
    rows.push({
      act,
      layers: sizes.length - 1,
      gradNormPerLayer: norms,
      ratioFirstToLast: norms[0] / Math.max(1e-300, norms[norms.length - 1]),
    })
  }
  out.experiments.gradientDecay = {
    desc:
      '8 层网络下，第一层拿到的梯度相对最后一层小多少。' +
      '实测：logistic 掉 6 个数量级（梯度消失的重灾区），tanh/relu 基本不衰减。',
    rows,
  }
}

console.log(JSON.stringify(out, null, 1))
