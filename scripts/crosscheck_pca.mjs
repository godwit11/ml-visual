/**
 * 把 TS 的 PCA 在 Node 里跑一遍，输出 JSON 供 Python（sklearn）对拍。
 * 用法：node scripts/crosscheck_pca.mjs
 */
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const res = await build({
  entryPoints: ['src/dev/pcaEntry.ts'],
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

const datasets = M.buildPcaDatasets(M.irisRaw)
const out = { datasets: [], runs: [] }

for (const ds of datasets) {
  out.datasets.push({
    id: ds.id,
    n: ds.data.length,
    p: ds.data[0].length,
    X: ds.data,
    featureNames: ds.featureNames,
  })

  const full = M.fitPCA(ds.data)

  // 全维度结果：主成分方向、方差、比例
  const run = {
    dataset: ds.id,
    mean: full.mean,
    components: full.components,
    explainedVariance: full.explainedVariance,
    explainedVarianceRatio: full.explainedVarianceRatio,
    singularValues: full.singularValues,
    cumulativeRatio: full.cumulativeRatio,
    // 各 k 的重构误差（对拍 TS 实现自身的 inverseTransform 是否和 sklearn 一致）
    reconstructions: [],
  }
  for (let k = 1; k <= ds.data[0].length; k++) {
    const fp = M.fitProjectReconstruct(ds.data, k)
    run.reconstructions.push({
      k,
      scores: fp.result.scores.map((row) => row.slice(0, k)),
      Xhat: fp.Xhat,
      mse: fp.mse,
      keptRatio: fp.keptRatio,
    })
  }
  out.runs.push(run)
}

/* 顺带量一下：降维前后的「近邻保持」情况（供页面文案用）。
 *
 * 注意只对 p ≥ 3 的数据集有意义——二维降到二维当然 100% 保持，
 * 那是废话。所以这里统一降到 2 维，并只在 p > 2 时报出来。
 */
out.knnPreserve = datasets
  .filter((ds) => ds.data[0].length > 2)
  .map((ds) => {
    const k = 2
    const full = M.fitPCA(ds.data, k)
    const X = ds.data
    const n = X.length
    const d2 = (a, b) => a.reduce((acc, v, i) => acc + (v - b[i]) ** 2, 0)
    const neighborsOf = (rows) =>
      rows.map((row, i) =>
        rows
          .map((other, j) => ({ j, d: d2(other, row) }))
          .filter((o) => o.j !== i)
          .sort((a, b) => a.d - b.d)
          .slice(0, 5)
          .map((o) => o.j),
      )
    const before = neighborsOf(X)
    const after = neighborsOf(full.scores)
    let hit = 0
    for (let i = 0; i < n; i++) {
      const set = new Set(after[i])
      for (const j of before[i]) if (set.has(j)) hit++
    }
    return { dataset: ds.id, from: ds.data[0].length, to: k, overlap: hit / (n * 5) }
  })

console.log(JSON.stringify(out))
