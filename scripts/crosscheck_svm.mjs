/**
 * 把 TS 的 SMO 在 Node 里跑一遍，输出 JSON 供 Python（sklearn / libsvm）对拍。
 * 用法：node scripts/crosscheck_svm.mjs
 */
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const res = await build({
  entryPoints: ['src/dev/svmEntry.ts'],
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

const TOL = 1e-4

/** 数据包围盒内取 n×n 的网格（与页面画决策边界用的是同一个规则） */
function gridPoints(samples, n = 15) {
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  for (const s of samples) {
    x0 = Math.min(x0, s.x[0])
    x1 = Math.max(x1, s.x[0])
    y0 = Math.min(y0, s.x[1])
    y1 = Math.max(y1, s.x[1])
  }
  const px = (x1 - x0) * 0.08 || 0.5
  const py = (y1 - y0) * 0.08 || 0.5
  x0 -= px
  x1 += px
  y0 -= py
  y1 += py
  const pts = []
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      pts.push([x0 + ((x1 - x0) * i) / (n - 1), y0 + ((y1 - y0) * j) / (n - 1)])
    }
  }
  return pts
}

const datasets = M.buildSvmDatasets(M.breastRaw)

/** 覆盖三种核、几档 C 与 γ，并且刻意挑出"线性核分不开"的月牙 */
const cases = []
for (const ds of datasets) {
  cases.push({ ds, kernel: 'linear', C: 1, gamma: 1, degree: 3 })
  if (ds.id === 'overlap') {
    cases.push({ ds, kernel: 'linear', C: 0.1, gamma: 1, degree: 3 })
    cases.push({ ds, kernel: 'linear', C: 10, gamma: 1, degree: 3 })
    cases.push({ ds, kernel: 'rbf', C: 1, gamma: 1, degree: 3 })
  }
  if (ds.id === 'linear' || ds.id === 'breast') {
    cases.push({ ds, kernel: 'rbf', C: 1, gamma: 1, degree: 3 })
    cases.push({ ds, kernel: 'rbf', C: 10, gamma: 0.5, degree: 3 })
  }
  if (ds.id === 'moons' || ds.id === 'circles') {
    cases.push({ ds, kernel: 'rbf', C: 1, gamma: 1, degree: 3 })
    cases.push({ ds, kernel: 'rbf', C: 10, gamma: 0.5, degree: 3 })
    cases.push({ ds, kernel: 'poly', C: 1, gamma: 1, degree: 2 })
  }
}

const out = { runs: [], datasets: [] }
for (const ds of datasets) {
  out.datasets.push({ id: ds.id, X: ds.samples.map((s) => s.x), y: ds.samples.map((s) => s.y) })
}

for (const c of cases) {
  const { ds } = c
  const opts = { C: c.C, kernel: c.kernel, gamma: c.gamma, degree: c.degree, coef0: 0, tol: TOL }
  const model = M.trainSvm(ds.samples, opts)
  const xs = ds.samples.map((s) => s.x)
  const grid = gridPoints(ds.samples)

  out.runs.push({
    dataset: ds.id,
    kernel: c.kernel,
    C: c.C,
    gamma: c.gamma,
    degree: c.degree,
    n: ds.samples.length,
    alpha: Array.from(model.alpha),
    nSV: model.support.length,
    nFree: model.nFree,
    nBound: model.nBound,
    b: model.b,
    dualObjective: model.dualObjective,
    nIter: model.nIter,
    converged: model.converged,
    kktResidual: M.kktResidual(model, ds.samples),
    acc: M.svmAccuracy(model, ds.samples),
    decValues: M.decisionValues(model, xs),
    grid,
    gridDec: M.decisionValues(model, grid),
    w: model.w ?? null,
    marginWidth: M.marginWidth(model),
  })
}

console.log(JSON.stringify(out))
