/**
 * 把 TS 的评估指标在 Node 里跑一遍，输出 JSON 供 Python（sklearn）对拍。
 * 用法：node scripts/crosscheck_eval.mjs
 */
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const res = await build({
  entryPoints: ['src/dev/evalEntry.ts'],
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

const TREE_OPTS = { criterion: 'gini', maxDepth: 3, minSamplesSplit: 2 }
const THRESHOLDS = [0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9]
const out = { breastW: M.BREAST_W, datasets: [], metrics: [], curves: [], folds: [], cv: [], cvDatasets: [] }

/* ---------- 0) 交叉验证用的原始特征与标签（Python 侧要用同一份） ---------- */
for (const cv of M.buildCvDatasets()) {
  out.cvDatasets.push({ id: cv.id, n: cv.X.length, X: cv.X, y: cv.y })
}

/* ---------- 1) 三个数据集上的指标 ---------- */
for (const ds of M.buildEvalDatasets()) {
  const scores = ds.points.map((p) => p.score)
  const labels = ds.points.map((p) => p.label)
  out.datasets.push({
    id: ds.id,
    n: scores.length,
    nPos: labels.reduce((a, b) => a + b, 0),
    scores,
    labels,
  })

  for (const t of THRESHOLDS) {
    const c = M.confusionAt(scores, labels, t)
    out.metrics.push({ dataset: ds.id, threshold: t, conf: c, metrics: M.metricsFrom(c) })
  }

  const roc = M.rocCurve(scores, labels)
  const pr = M.prCurve(scores, labels)
  out.curves.push({
    dataset: ds.id,
    roc: { fpr: roc.fpr, tpr: roc.tpr, thresholds: roc.thresholds, auc: roc.auc },
    pr: { precision: pr.precision, recall: pr.recall, thresholds: pr.thresholds, auc: pr.auc },
  })
}

/* ---------- 2) 交叉验证：折划分 + 每折准确率 ---------- */
for (const cv of M.buildCvDatasets()) {
  for (const k of [3, 5, 10]) {
    for (const stratify of [false, true]) {
      const folds = M.kFoldIndices(cv.X.length, { k, stratify, labels: cv.y })
      out.folds.push({
        dataset: cv.id,
        k,
        stratify,
        foldPos: folds.map((f) => f.filter((i) => cv.y[i] === 1).length),
        folds,
      })

      const r = M.crossValidate(folds, cv.y, (trainIdx, testIdx) => {
        const train = trainIdx.map((i) => ({ x: cv.X[i], y: cv.y[i] }))
        const test = testIdx.map((i) => ({ x: cv.X[i], y: cv.y[i] }))
        const tree = M.buildTree(train, 2, TREE_OPTS)
        let correct = 0
        for (const s of test) if (M.predictOne(tree, s.x) === s.y) correct++
        return correct / test.length
      })
      out.cv.push({ dataset: cv.id, k, stratify, scores: r.scores, mean: r.mean, std: r.std })
    }
  }
}

console.log(JSON.stringify(out))
