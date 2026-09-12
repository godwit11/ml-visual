/**
 * 把 TS 决策树在 Node 里跑一遍，输出 JSON 供 Python（sklearn）对拍。
 * 用法：node scripts/crosscheck_tree.mjs
 */
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const res = await build({
  entryPoints: ['src/dev/treeEntry.ts'],
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

const datasets = M.buildDatasets(M.irisRaw)
const out = { datasets: [], runs: [] }

const withIdx = process.argv.includes('--with-idx')

for (const ds of datasets) {
  out.datasets.push({
    id: ds.id,
    n: ds.samples.length,
    nClasses: ds.classNames.length,
    X: ds.samples.map((s) => s.x),
    y: ds.samples.map((s) => s.y),
  })

  const samples = ds.samples.map((s) => ({ x: s.x, y: s.y }))
  const nClasses = ds.classNames.length

  for (const criterion of ['gini', 'entropy']) {
    for (const maxDepth of [1, 2, 3, 5, 10]) {
      for (const minSamplesSplit of [2, 20]) {
        const opts = { criterion, maxDepth, minSamplesSplit }
        const tree = M.buildTree(samples, nClasses, opts)
        const stats = M.treeStats(tree)
        // 每个内部节点的候选分裂排行，用于定位对拍分歧的原因
        const nodeInfo = stats.dfs
          .filter((d) => d.feature >= 0)
          .map((d) => {
            const idxList = M.nodeSampleIndices(tree, samples, d.id)
            const top = M.findSplitsRanked(samples, idxList, nClasses, criterion, 8)
            const chosenGain =
              top.find(
                (t) => t.feature === d.feature && Math.abs(t.threshold - d.threshold) < 1e-9,
              )?.gain ?? 0
            const splitAt = (side) =>
              idxList.filter((i) =>
                side === 'l' ? samples[i].x[d.feature] <= d.threshold : samples[i].x[d.feature] > d.threshold,
              )
            return {
              id: d.id,
              depth: d.depth,
              chosen: { feature: d.feature, threshold: d.threshold },
              chosenGain,
              n: idxList.length,
              left: splitAt('l'),
              right: splitAt('r'),
              top,
            }
          })
        out.runs.push({
          dataset: ds.id,
          criterion,
          maxDepth,
          minSamplesSplit,
          depth: stats.depth,
          nodes: stats.nodes,
          leaves: stats.leaves,
          dfs: stats.dfs,
          nodeInfo,
          trainAcc: M.accuracy(tree, samples),
          pred: samples.map((s) => M.predictOne(tree, s.x)),
          // 不纯度函数本身也单独校验一下
          impurityRoot: tree.impurity,
        })
      }
    }
  }
}

console.log(JSON.stringify(out))
