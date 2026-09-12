/** 扫描核参数对支持向量数 / 准确率的影响（用来把页面上的说法写准） */
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
const D = M.buildSvmDatasets(M.breastRaw)

console.log('=== RBF：γ 与支持向量数 / 准确率（C=1）===')
for (const id of ['circles', 'moons', 'overlap']) {
  const ds = D.find((d) => d.id === id)
  const row = []
  for (const g of [0.01, 0.03, 0.1, 0.3, 1, 3, 10]) {
    const m = M.trainSvm(ds.samples, { C: 1, kernel: 'rbf', gamma: g, tol: 1e-4 })
    row.push(`γ=${g}: ${m.support.length}SV/${(M.svmAccuracy(m, ds.samples) * 100).toFixed(0)}%`)
  }
  console.log(id.padEnd(9), row.join('  '))
}

console.log('')
console.log('=== 线性核：C 与支持向量数 / 准确率 ===')
for (const id of ['linear', 'overlap']) {
  const ds = D.find((d) => d.id === id)
  const row = []
  for (const c of [0.01, 0.1, 1, 10, 100]) {
    const m = M.trainSvm(ds.samples, { C: c, kernel: 'linear', tol: 1e-4 })
    row.push(`C=${c}: ${m.support.length}SV/${(M.svmAccuracy(m, ds.samples) * 100).toFixed(0)}%`)
  }
  console.log(id.padEnd(9), row.join('  '))
}

console.log('')
console.log('=== RBF：C 与支持向量数 / 准确率（γ=1）===')
for (const id of ['overlap', 'circles']) {
  const ds = D.find((d) => d.id === id)
  const row = []
  for (const c of [0.01, 0.1, 1, 10, 100]) {
    const m = M.trainSvm(ds.samples, { C: c, kernel: 'rbf', gamma: 1, tol: 1e-4 })
    row.push(`C=${c}: ${m.support.length}SV/${(M.svmAccuracy(m, ds.samples) * 100).toFixed(0)}%`)
  }
  console.log(id.padEnd(9), row.join('  '))
}

console.log('')
console.log('=== 多项式核：d 与准确率（γ=1, C=1）===')
for (const id of ['moons', 'circles', 'overlap']) {
  const ds = D.find((d) => d.id === id)
  const row = []
  for (const d of [1, 2, 3, 4, 5]) {
    const m = M.trainSvm(ds.samples, { C: 1, kernel: 'poly', gamma: 1, degree: d, coef0: 0, tol: 1e-4 })
    row.push(`d=${d}: ${m.support.length}SV/${(M.svmAccuracy(m, ds.samples) * 100).toFixed(0)}%`)
  }
  console.log(id.padEnd(9), row.join('  '))
}
