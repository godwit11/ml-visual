/**
 * 把 TS 的 Bagging / AdaBoost 在 Node 里跑一遍，输出 JSON 供 Python（sklearn）对拍。
 * 用法：node scripts/crosscheck_ensemble.mjs
 */
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const res = await build({
  entryPoints: ['src/dev/ensEntry.ts'],
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

const pack = (arr) => arr.join('')

/**
 * 打破对称性的微扰版本。
 *
 * xor / 月牙这类数据集是**对称**的，深度 ≥2 的树里会出现"两个候选分裂增益完全相同"
 * 的情况，此时选哪个是自由的——TS 和 sklearn 可能各选一个，两条路径就此分岔。
 * 加 1e-6 的确定性微扰打破对称后，如果两边恢复完全一致，
 * 就说明分歧确实来自等距平局，而不是实现错误。这是实验证据，不是猜测。
 */
function jitter(samples, eps = 1e-6) {
  return samples.map((s, i) => ({
    x: [s.x[0] + eps * Math.sin(i * 0.7), s.x[1] + eps * Math.cos(i * 1.3)],
    y: s.y,
  }))
}

const DATASETS = [
  { id: 'moons', samples: M.makeMoons(200, 0.16, 7) },
  { id: 'xor', samples: M.makeXor(200, 0.28, 3) },
  { id: 'moons-jitter', samples: jitter(M.makeMoons(200, 0.16, 7)) },
  { id: 'xor-jitter', samples: jitter(M.makeXor(200, 0.28, 3)) },
]

const out = { datasets: [], bagging: [], boosting: [] }

for (const ds of DATASETS) {
  const X = ds.samples.map((s) => s.x)
  const y = ds.samples.map((s) => s.y)
  out.datasets.push({ id: ds.id, n: ds.samples.length, X, y })

  /* ---------- Bagging：输出 bootstrap 索引，Python 用同一批索引训练 ---------- */
  for (const maxDepth of [1, 3]) {
    const k = 5
    const model = M.trainBagging(ds.samples, 2, k, { maxDepth, minSamplesLeaf: 2 }, 20240910)
    const treePreds = model.trees.map((t) => pack(ds.samples.map((s) => M.predictTree(t, s.x))))
    const ensPreds = pack(ds.samples.map((s) => M.baggingPredict(model, s.x)))
    out.bagging.push({
      dataset: ds.id,
      maxDepth,
      k,
      bootstrapIdx: model.bootstrapIdx,
      treePreds,
      ensPreds,
      treeAcc: model.trees.map((t) => M.accuracyOf(ds.samples, (x) => M.predictTree(t, x))),
      ensAcc: M.accuracyOf(ds.samples, (x) => M.baggingPredict(model, x)),
    })
  }

  /* ---------- AdaBoost（SAMME）：逐步输出每轮的 err / α / 预测 ---------- */
  for (const maxDepth of [1, 2]) {
    const T = 8
    let model = { rounds: [], nClasses: 2, weights: [] }
    const rounds = []
    for (let t = 0; t < T; t++) {
      const r = M.addBoostRound(ds.samples, 2, model, { maxDepth, minSamplesLeaf: 2 })
      if (!r.round) break
      model = r.model
      rounds.push({
        err: r.round.err,
        alpha: r.round.alpha,
        preds: pack(ds.samples.map((s) => M.predictTree(r.round.tree, s.x))),
        weightsBefore: r.round.weightsBefore,
        weightsAfter: r.round.weightsAfter,
      })
    }
    out.boosting.push({
      dataset: ds.id,
      maxDepth,
      rounds,
      weights: model.weights,
      finalPreds: pack(ds.samples.map((s) => M.boostPredict(model, s.x))),
      finalAcc: M.accuracyOf(ds.samples, (x) => M.boostPredict(model, x)),
    })
  }
}

console.log(JSON.stringify(out))
