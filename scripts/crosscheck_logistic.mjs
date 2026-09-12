/**
 * 把 TS 的 Logistic 回归在 Node 里跑一遍，输出 JSON 供 Python（numpy / sklearn）对拍。
 * 用法：node scripts/crosscheck_logistic.mjs
 */
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const res = await build({
  entryPoints: ['src/dev/logisticEntry.ts'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  loader: { '.json': 'json' },
  logLevel: 'silent',
})

const mod = { exports: {} }
// eslint-disable-next-line no-new-func
new Function('module', 'exports', 'require', res.outputFiles[0].text)(mod, mod.exports, require)
const M = mod.exports

const datasets = M.buildLogiDatasets(M.breastRaw)
const out = { datasets: [], probes: [], runs: [] }

/* ---------- 1) sigmoid / softplus 的极端值 ---------- */
out.sigmoid = [-800, -50, -10, -1, 0, 1, 10, 50, 800].map((z) => ({
  z,
  sigmoid: M.sigmoid(z),
  softplus: M.softplus(z),
}))

for (const ds of datasets) {
  out.datasets.push({
    id: ds.id,
    n: ds.points.length,
    X: ds.points.map((p) => p.x),
    y: ds.points.map((p) => p.y),
  })

  const samples = ds.points.map((p) => ({ x: p.x, y: p.y }))

  /* ---------- 2) 在若干固定参数点上比对损失与梯度 ---------- */
  const probeParams = [
    { w1: 0, w2: 0, b: 0 },
    { w1: 1.5, w2: -0.8, b: 0.3 },
    { w1: -3.2, w2: 2.1, b: -0.7 },
    { w1: 0.4, w2: 0.4, b: 2.5 },
    { w1: 8, w2: -6, b: 1.2 },
  ]
  for (const p of probeParams) {
    const g = M.gradient(samples, p)
    out.probes.push({
      dataset: ds.id,
      params: p,
      loss: M.logLoss(samples, p),
      grad: g,
      acc05: M.accuracy(samples, p, 0.5),
      proba: samples.slice(0, 20).map((s) => M.proba(p, s.x)),
    })
  }

  /* ---------- 3) 固定 200 epoch：与 Python 独立实现的 GD 逐步对拍 ----------
   * 这是"实现正确性"的主判据：同样的起点、同样的学习率、同样的步数，
   * 两边每一步的结果必须逐位一致。 */
  for (const lr of [0.05, 0.5, 2]) {
    let p = { w1: 0.4, w2: -0.3, b: 0.1 }
    for (let i = 0; i < 200; i++) p = M.trainStep(samples, p, lr)
    out.runs.push({
      dataset: ds.id,
      lr,
      mode: 'gd200',
      params: p,
      loss: M.logLoss(samples, p),
      grad: M.gradient(samples, p),
      acc05: M.accuracy(samples, p, 0.5),
    })
  }

  /* ---------- 4) 长时间训练：与 sklearn 的最优损失对拍 ----------
   * 注意：线性可分 + 无正则时，最优解在无穷远处（损失趋近 0 但取不到），
   * 这种情形下"最终损失"没有意义，Python 侧会跳过 separable 这一项。 */
  for (const lr of [0.5, 2]) {
    const r = M.trainUntilConverge(samples, { w1: 0, w2: 0, b: 0 }, lr, 200000, 1e-12)
    out.runs.push({
      dataset: ds.id,
      lr,
      mode: 'long',
      epochs: r.epochs,
      converged: r.converged,
      params: r.params,
      loss: M.logLoss(samples, r.params),
      acc05: M.accuracy(samples, r.params, 0.5),
      conf: M.confusion(samples, r.params, 0.5),
      curve: r.losses.length <= 200 ? r.losses : sampleCurve(r.losses),
    })
  }
}

/** 等比抽 200 个点，但一定保留首尾 */
function sampleCurve(arr) {
  const out = []
  const k = 200
  for (let i = 0; i < k; i++) {
    out.push(arr[Math.round((i * (arr.length - 1)) / (k - 1))])
  }
  return out
}

console.log(JSON.stringify(out))
