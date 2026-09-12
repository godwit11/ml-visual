/**
 * 把 TS 的朴素贝叶斯在 Node 里跑一遍，输出 JSON 供 Python（sklearn）对拍。
 * 用法：node scripts/crosscheck_nb.mjs
 */
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const res = await build({
  entryPoints: ['src/dev/nbEntry.ts'],
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

const corpus = M.loadSmsCorpus()
const { X, y, n, d, vocab } = corpus

const out = {
  meta: { n, d, nSpam: corpus.nSpam, source: corpus.source },
  /** 标签打包成 "0101..."（5574 个字符） */
  y: y.join(''),
  runs: [],
  /* 给 Python 侧复算用的原始数据（稀疏形式，省得 JSON 太大） */
  samples: [],
  demo: null,
}

// 为了让 Python 拿到同一份 X，这里把非零项打出来
for (let i = 0; i < n; i++) {
  const items = []
  for (let j = 0; j < d; j++) {
    const v = X[i * d + j]
    if (v !== 0) items.push(`${j}:${v}`)
  }
  out.samples.push(items.join(' '))
}

/** 预测结果打包成 "0110..." 字符串，5574 个字符比 JSON 数组省得多 */
const pack = (arr) => arr.join('')

const ALPHAS = [0.01, 0.1, 1, 10]
const MODELS = ['bernoulli', 'multinomial']

for (const model of MODELS) {
  for (const alpha of ALPHAS) {
    const m = M.trainNb(X, y, n, d, { model, alpha })
    const preds = new Array(n)
    const logProba = []
    for (let i = 0; i < n; i++) {
      preds[i] = M.nbPredict(m, X, i * d)
      if (i < 300) {
        const lp = M.nbLogProba(m, X, i * d)
        logProba.push([lp[0], lp[1]])
      }
    }
    const ev = M.evaluateNb(m, X, y, n)
    out.runs.push({
      model,
      alpha,
      classLogPrior: m.classLogPrior,
      classCount: m.classCount,
      classTokenTotal: m.classTokenTotal,
      featureLogProb: m.featureLogProb,
      preds: pack(preds),
      logProba,
      eval: ev,
    })
  }
}

/* 单个词的几率比，顺带输出给 Python 校验 */
const m0 = M.trainNb(X, y, n, d, { model: 'bernoulli', alpha: 1 })
out.demo = {
  alpha1Bernoulli: {
    logOdds: Array.from(M.logOddsRatio(m0, 1, 0)),
    topSpam: M.logOddsRatio(m0, 1, 0)
      .map((v, j) => [v, vocab[j]])
      .sort((a, b) => b[0] - a[0])
      .slice(0, 10)
      .map(([v, w]) => [w, v]),
  },
}

console.log(JSON.stringify(out))
