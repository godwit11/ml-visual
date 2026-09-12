/**
 * 把 TS 算法模块在 Node 里跑一遍，输出 JSON 供 Python（sklearn）对拍。
 * 用法：node scripts/crosscheck.mjs <算法模块路径> <数据 json 路径>
 */
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const entry = process.argv[2] ?? 'src/algorithms/linearRegression.ts'
const dataPath = process.argv[3] ?? 'src/data/housing.json'

const res = await build({
  entryPoints: [entry],
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
const alg = mod.exports

const raw = JSON.parse(readFileSync(dataPath, 'utf-8'))
const points = raw.map((p) => ({ x: p.rm, y: p.medv }))

const best = alg.ols(points)
const out = {
  n: points.length,
  best: { w: best.w, b: best.b },
  metrics_at_best: {
    mae: alg.mae(points, best),
    mse: alg.mse(points, best),
    r2: alg.r2(points, best),
  },
  probes: [],
  predictions: [],
}

// 若干探针参数，Python 侧用同一组值复算
const probes = [
  { w: 0, b: 22.5 },
  { w: 9.1, b: -34.67 },
  { w: 5, b: 0 },
  { w: -3.25, b: 40 },
  { w: 15.75, b: -60 },
  { w: 9.1021, b: -34.6706 },
]
for (const f of probes) {
  out.probes.push({
    w: f.w,
    b: f.b,
    mae: alg.mae(points, f),
    mse: alg.mse(points, f),
    r2: alg.r2(points, f),
  })
}

// 单点预测
for (const x of [3.561, 5.0, 6.575, 8.78]) {
  out.predictions.push({ x, y: alg.predict(x, best) })
}

console.log(JSON.stringify(out))
