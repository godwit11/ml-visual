/**
 * 诊断脚本：量化「保留几个主成分」的代价。
 *
 * 动机：页面上要写"降 4→2 保住 97.77% 的方差"，
 * 这类数字必须先量出来，不能凭印象（SVM 那轮在这个坑上栽过）。
 *
 * 用法：node scripts/diagnose_pca.mjs
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

console.log('各数据集：保留 k 个主成分的代价')
console.log('='.repeat(78))

for (const ds of datasets) {
  const p = ds.data[0].length
  console.log(`\n【${ds.id}】${ds.name}   (n=${ds.data.length}, p=${p})`)
  const mean = ds.data.reduce((a, r) => a.map((v, j) => v + r[j] / ds.data.length), new Array(p).fill(0))
  console.log('  均值: ' + mean.map((v) => v.toFixed(4)).join(', '))

  const full = M.fitPCA(ds.data)
  console.log('  主成分:')
  full.components.forEach((dir, j) => {
    const arrow = j < 2 ? ' ← 保留' : ''
    console.log(
      `    PC${j + 1}  ${dir.map((v) => (v >= 0 ? '+' : '') + v.toFixed(4)).join('  ')}` +
        `   方差占比 ${(full.explainedVarianceRatio[j] * 100).toFixed(3)}%${arrow}`,
    )
  })

  for (let k = 1; k <= p; k++) {
    const fp = M.fitProjectReconstruct(ds.data, k)
    console.log(
      `    k=${k}  保住 ${(fp.keptRatio * 100).toFixed(3).padStart(7)}% 的方差` +
        `   重构 MSE ${fp.mse.toFixed(6)}` +
        `   RMSE ${Math.sqrt(fp.mse).toFixed(4)}`,
    )
  }

  // 某个特征尺度放大 100 倍，看主成分会不会跑偏（标准化动机）
  if (ds.id === 'iris') {
    const scaled = ds.data.map((r) => [r[0] * 100, r[1], r[2], r[3]])
    const s = M.fitPCA(scaled)
    console.log(
      '  [实验] 把"萼片长"乘 100（单位从 cm 换成 0.1mm，物理上完全同义）：',
    )
    console.log(
      '    主成分占比变成 ' + s.explainedVarianceRatio.map((v) => (v * 100).toFixed(2) + '%').join(' / '),
    )
    console.log(
      '    PC1 = ' + s.components[0].map((v) => (v >= 0 ? '+' : '') + v.toFixed(4)).join('  '),
    )
    console.log('    → 量纲一变，主成分就换了个人。这就是必须标准化的原因。')
  }
}
