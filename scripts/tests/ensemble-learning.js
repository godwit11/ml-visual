/* 集成学习页端到端断言：真的切换算法、逐个加基学习器、拖深度，核对数字与可视化。 */
const results = []
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra })

const qall = (s) => Array.from(document.querySelectorAll(s))
const text = (el) => (el ? el.textContent.trim() : null)
const metric = (i) => text(qall('#metrics .metric')[i]?.querySelector('.metric-value'))
const acc = () => parseFloat((metric(0) || '').replace('%', ''))
const single = () => parseFloat((metric(1) || '').replace('%', ''))
const count = () => parseInt(metric(3), 10)
const ctrlRange = (i) => qall('#controls .ctrl')[i]?.querySelector('input[type=range]')
const curvePts = () => q('#chart-curve').__chart.chart.getOption().series[0].data.length
const pointSizes = () => q('#chart-boundary').__chart.chart.getOption().series[1].data.map((d) => d[2])
const uniqSizes = () => new Set(pointSizes().map((v) => Number(v).toFixed(3))).size

/* ---------- 1. 首屏 ---------- */
check('数据集 3 个选项', qall('#sel-data option').length === 3, qall('#sel-data option').length)
check('算法 2 个选项', qall('#sel-algo option').length === 2, qall('#sel-algo option').length)
check('默认 Bagging', q('#sel-algo').value === 'bagging', q('#sel-algo').value)
check('默认 10 个基学习器', count() === 10, count())
check('曲线点数 = 基学习器数', curvePts() === 10, curvePts())
check('集成比单棵树更好', acc() > single(), `集成 ${acc()}% vs 单棵 ${single()}%`)
check('Bagging 下所有点大小一致（一视同仁）', uniqSizes() === 1, uniqSizes())

/* ---------- 2. 逐个添加基学习器 ---------- */
const accBefore = acc()
click('#btn-add')
await sleep(500)
check('点「加一个」后数量 +1', count() === 11, count())
check('曲线也跟着变长', curvePts() === 11, curvePts())
click('#btn-add')
await sleep(500)
check('再加一个 → 12', count() === 12, count())
check('准确率不会倒退到离谱（≥ 原来 - 1pp）', acc() >= accBefore - 1, `${accBefore}% → ${acc()}%`)

/* ---------- 3. 深度的影响（Bagging 偏爱深树） ---------- */
const depthSlider = ctrlRange(1)
setRange(depthSlider, 1)
await sleep(600)
const bagDepth1 = acc()
setRange(depthSlider, 4)
await sleep(900)
const bagDepth4 = acc()
check('Bagging：加深基学习器后准确率上升', bagDepth4 > bagDepth1, `depth=1: ${bagDepth1}% → depth=4: ${bagDepth4}%`)

/* ---------- 4. 切到 AdaBoost ---------- */
setRange(depthSlider, 1)
await sleep(600)
setSelect('#sel-algo', 'boosting')
await sleep(900)
check('AdaBoost 下点数（权重）不再一致', uniqSizes() > 1, uniqSizes())
check(
  'AdaBoost 的基学习器在整体数据上反而更差（专攻难点，是"偏科生"）',
  single() < bagDepth1 - 5,
  `AdaBoost 单棵 ${single()}% < Bagging 单棵 ${bagDepth1}%`,
)
const boostAcc = acc()
check(
  '月牙上 AdaBoost（决策桩）明显优于 Bagging（决策桩）——纠错比平均更有效',
  boostAcc > bagDepth1 + 5,
  `Bagging ${bagDepth1}% < AdaBoost ${boostAcc}%`,
)
check('状态栏报告了 ε 与 α', /ε/.test(text(q('#train-status')) || '') && /α/.test(text(q('#train-status')) || ''), text(q('#train-status')))

/* ---------- 5. AdaBoost 的轮数曲线 ---------- */
setRange(ctrlRange(0), 30)
await sleep(1200)
check('30 轮时曲线 30 个点', curvePts() === 30, curvePts())
const boost30 = acc()
check('AdaBoost 加到 30 轮仍然不差于早期（≥ 10 轮水平 - 2pp）', boost30 >= boostAcc - 2, `10 轮 ${boostAcc}% → 30 轮 ${boost30}%`)

/* ---------- 6. 异或数据集：浅模型的天花板很低 ---------- */
setSelect('#sel-data', 'xor')
await sleep(1200)
const xorSingle = single()
const xorEns = acc()
check('异或上单个决策桩很差（< 70%）', xorSingle < 70, `${xorSingle}%`)
check('集成把异或拉上来（提升 > 10pp）', xorEns - xorSingle > 10, `${xorSingle}% → ${xorEns}%`)

/* ---------- 7. 同心圆 + 重置 ---------- */
setSelect('#sel-data', 'circles')
await sleep(1200)
click('#btn-reset')
await sleep(900)
check('重置后 AdaBoost 回到 1 个基学习器', count() === 1, count())
check('只有 1 个基学习器时，集成准确率 = 单棵准确率', Math.abs(acc() - single()) < 0.01, `${acc()}% / ${single()}%`)

setSelect('#sel-algo', 'bagging')
await sleep(900)
click('#btn-reset')
await sleep(900)
check('Bagging 重置回到 10 个', count() === 10, count())

return {
  ok: results.every((r) => r.ok),
  passed: results.filter((r) => r.ok).length,
  total: results.length,
  failed: results.filter((r) => !r.ok),
  all: results,
}
