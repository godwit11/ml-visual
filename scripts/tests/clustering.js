/* 聚类页端到端断言：真的单步走、改 k、换起点，核对 inertia 的单调性与纯度。 */
const results = []
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra })

const qall = (s) => Array.from(document.querySelectorAll(s))
const text = (el) => (el ? el.textContent.trim() : null)
const metric = (i) => text(qall('#metrics .metric')[i]?.querySelector('.metric-value'))
const inertia = () => parseFloat(metric(0))
const sizes = () => (metric(2) || '').split('·').map((s) => parseInt(s.trim(), 10))
const purity = () => parseFloat(metric(3))
const stepOf = () => {
  const t = metric(1) || '0 / 0'
  const [a, b] = t.split('/').map((s) => parseInt(s.trim(), 10))
  return { cur: a, total: b }
}
const ctrlRange = (i) => qall('#controls .ctrl')[i]?.querySelector('input[type=range]')
/** 画面上簇的个数（scatter 系列里排除质心与轨迹） */
const clusterSeriesCount = () =>
  q('#chart-cluster')
    .__chart.chart.getOption()
    .series.filter((s) => s.name && String(s.name).startsWith('簇 ')).length

/* ---------- 1. 首屏 ---------- */
check('数据集 4 个选项', qall('#sel-data option').length === 4, qall('#sel-data option').length)
check('初始化方式 2 个选项', qall('#sel-init option').length === 2, qall('#sel-init option').length)
check('默认 k-means++', q('#sel-init').value === 'kmeans++', q('#sel-init').value)
check('默认 k=4', sizes().length === 4, sizes())
check('首屏就是跑完的状态', stepOf().cur === stepOf().total, stepOf())
check('画面上有 4 个簇系列', clusterSeriesCount() === 4, clusterSeriesCount())
check('四个簇大小之和 = 300', sizes().reduce((a, b) => a + b, 0) === 300, sizes())
check('高斯团上四个簇大小接近（各约 75）', sizes().every((s) => s > 55 && s < 95), sizes())

/* ---------- 2. 单步：inertia 必须单调不降 ---------- */
click('#btn-reset')
await sleep(300)
const s0 = stepOf()
check('重置后回到第 0 步', s0.cur === 0, s0)
const series = [inertia()]
let guard = 0
while (guard < 40) {
  const before = stepOf().cur
  click('#btn-step')
  await sleep(80)
  const after = stepOf().cur
  if (after === before) break
  series.push(inertia())
  guard++
}
check('单步能一直走到收敛', stepOf().cur === stepOf().total, stepOf())
check('一共走了 2 轮以上', series.length >= 3, series.length)
let monotone = true
for (let i = 1; i < series.length; i++) if (series[i] > series[i - 1] + 1e-9) monotone = false
check('inertia 每一步都在下降（这是算法收敛的保证）', monotone, series.map((v) => v.toFixed(2)))

/* ---------- 3. k 的影响：越大 inertia 越小 ---------- */
setRange(ctrlRange(0), 2)
await sleep(400)
click('#btn-run')
await sleep(200)
const inK2 = inertia()
check('k=2 时两个簇', sizes().length === 2, sizes())
check('k=2 时簇大小之和仍是 300', sizes().reduce((a, b) => a + b, 0) === 300, sizes())

setRange(ctrlRange(0), 8)
await sleep(500)
click('#btn-run')
await sleep(200)
const inK8 = inertia()
check('k 变大后 inertia 变小（但这不是"更好"）', inK8 < inK2, `k=2: ${inK2} → k=8: ${inK8}`)
check('k=8 时有 8 个簇', sizes().length === 8, sizes())

/* ---------- 4. 换起点 ---------- */
setRange(ctrlRange(0), 4)
await sleep(400)
click('#btn-run')
await sleep(200)
const beforeRestart = inertia()
click('#btn-restart')
await sleep(400)
check('换起点后仍能正常收敛', stepOf().cur === stepOf().total, stepOf())
check('换起点后 inertia 仍然合理（不为 0 也不爆炸）', inertia() > 100 && inertia() < 2000, `${beforeRestart} → ${inertia()}`)

/* ---------- 5. 同心圆：K-means 的滑铁卢 ---------- */
setSelect('#sel-data', 'circles')
await sleep(600)
click('#btn-run')
await sleep(300)
const circSizes = sizes()
check('同心圆上能跑出结果（算法不会报错，只是结果没意义）', circSizes.reduce((a, b) => a + b, 0) === 240, circSizes)
check('提示里点明了"这组数据 K-means 本来就不擅长"', /不擅长/.test(text(q('#cluster-hint')) || ''), (text(q('#cluster-hint')) || '').slice(-40))

/* ---------- 6. 鸢尾花：用纯度衡量聚类质量 ---------- */
setSelect('#sel-data', 'iris')
await sleep(600)
setRange(ctrlRange(0), 3)
await sleep(500)
click('#btn-run')
await sleep(300)
const pur = purity()
check('鸢尾花 k=3 的纯度 > 0.85', pur > 0.85, pur)
check('鸢尾花有 150 个点', sizes().reduce((a, b) => a + b, 0) === 150, sizes())
check('setosa 那一簇是完全纯的（簇大小恰好 50）', sizes().includes(50), sizes())

/* ---------- 7. 无标签的数据集上纯度显示为占位 ---------- */
setSelect('#sel-data', 'blobs')
await sleep(600)
click('#btn-run')
await sleep(300)
check('无标签数据集上纯度显示占位符', /无标签/.test(metric(3) || ''), metric(3))

return {
  ok: results.every((r) => r.ok),
  passed: results.filter((r) => r.ok).length,
  total: results.length,
  failed: results.filter((r) => !r.ok),
  all: results,
}
