/**
 * 把 TS 的 K-means 在 Node 里跑一遍，输出 JSON 供 Python（sklearn）对拍。
 * 用法：node scripts/crosscheck_kmeans.mjs
 */
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const res = await build({
  entryPoints: ['src/dev/kmEntry.ts'],
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

const datasets = M.buildClusterDatasets(M.irisRaw)
const out = { datasets: [], runs: [] }

for (const ds of datasets) {
  out.datasets.push({ id: ds.id, n: ds.points.length, X: ds.points })
}

/**
 * 关键：把初始质心也喂给 Python。
 * k-means++ / 随机初始化都依赖随机数，两边 PRNG 不同源；
 * 传同一组初始质心之后，剩下的迭代过程就是完全确定的，可以逐项比对。
 */
for (const ds of datasets) {
  for (const k of [2, 3, 4]) {
    if (k > ds.points.length) continue
    for (const initType of ['kmeans++', 'random']) {
      const seed = 20240910 + k * 131
      const init =
        initType === 'kmeans++'
          ? M.kmeansppInit(ds.points, k, seed)
          : M.randomInit(ds.points, k, seed)
      const r = M.runKMeans(ds.points, init)
      out.runs.push({
        dataset: ds.id,
        k,
        initType,
        init,
        labels: r.labels,
        centers: r.centroids,
        inertia: r.inertia,
        iters: r.iters,
        converged: r.converged,
        sizes: M.clusterSizes(r.labels, k),
        /** 逐轮快照，诊断用（对比"第几轮开始分岔"） */
        steps: r.steps.map((s) => ({
          iter: s.iter,
          inertia: s.inertia,
          centers: s.centroids,
          sizes: M.clusterSizes(s.labels, k),
        })),
      })
    }
  }
}

/* 顺带给一下"多种初始化取最优"的对比数据（页面用） */
out.restarts = datasets.map((ds) => {
  const { best, all } = M.runWithRestarts(ds.points, 3, 8, true)
  return {
    dataset: ds.id,
    inertias: all.map((r) => r.inertia),
    bestInertia: best.inertia,
    worstInertia: Math.max(...all.map((r) => r.inertia)),
  }
})

console.log(JSON.stringify(out))
