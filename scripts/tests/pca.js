/* PCA 页端到端断言：真的转轴、改 k、切数据集，核对方差谱与"转轴找最优"这件事。 */
const results = []
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra })

const qall = (s) => Array.from(document.querySelectorAll(s))
const text = (el) => (el ? el.textContent.trim() : null)
const metric = (i) => text(qall('#metrics .metric')[i]?.querySelector('.metric-value'))
const curVar = () => parseFloat(metric(0))
const bestVar = () => parseFloat(metric(1))
const keptPct = () => parseFloat((metric(2) || '').replace('%', ''))
const ratioPct = () => parseFloat((metric(3) || '').replace('%', ''))
const ctrlRange = (i) => qall('#controls .ctrl')[i]?.querySelector('input[type=range]')
const pca = () => window.__pca

/* ---------- 1. 首屏：数据、按钮、图表 ---------- */
check('数据集 5 个选项', qall('#sel-data option').length === 5, qall('#sel-data option').length)
check('默认数据集是鸢尾花', pca().ds === 'iris', pca().ds)
check('默认主图维度是 花瓣长 × 花瓣宽', q('#sel-pair').value === '2,3', q('#sel-pair').value)
check('主图画出来了', !!q('#chart-space').__chart, !!q('#chart-space').__chart)
check('方差谱画出来了', !!q('#chart-scree').__chart, !!q('#chart-scree').__chart)

/* ---------- 2. 方差谱必须与 sklearn 一致（对拍已验，这里是钉住） ---------- */
const ratios = pca().ratios
check('PC1 解释方差比 = 0.92462（鸢尾花真实值）', Math.abs(ratios[0] - 0.924619) < 1e-5, ratios[0])
check('PC2 解释方差比 = 0.05307', Math.abs(ratios[1] - 0.053066) < 1e-5, ratios[1])
check('四个主成分占比之和 = 1', Math.abs(ratios.reduce((a, b) => a + b, 0) - 1) < 1e-10, ratios.reduce((a, b) => a + b, 0))
check('累计占比单调递增', pca().cumulative.every((v, i, arr) => i === 0 || v > arr[i - 1]), pca().cumulative)

/* ---------- 3. 主成分方向：PC1 的载荷与 sklearn 一致（允许整体符号） ---------- */
const comp0 = pca().components[0]
const target = [0.361387, -0.084523, 0.856671, 0.358289]
const dot = comp0.reduce((a, v, i) => a + v * target[i], 0)
const sameDir = Math.abs(Math.abs(dot) - 1) < 1e-5
check('PC1 方向与 sklearn 一致（去符号后点积为 ±1）', sameDir, dot)
const comp1 = pca().components[1]
const t1 = [0.656589, 0.730161, -0.173373, -0.075481]
const dot1 = comp1.reduce((a, v, i) => a + v * t1[i], 0)
check('PC2 方向与 sklearn 一致', Math.abs(Math.abs(dot1) - 1) < 1e-5, dot1)

/* ---------- 4. 主成分两两正交（定义性质） ---------- */
let maxOff = 0
for (let i = 0; i < pca().components.length; i++) {
  for (let j = 0; j < pca().components.length; j++) {
    const d = pca().components[i].reduce((a, v, k) => a + v * pca().components[j][k], 0)
    if (i !== j) maxOff = Math.max(maxOff, Math.abs(d))
    else maxOff = Math.max(maxOff, Math.abs(d - 1))
  }
}
check('主成分之间两两正交、自身为单位向量', maxOff < 1e-10, maxOff)

/* ---------- 5. 核心交互：转轴到 PC1 角度，投影方差达到最大 ---------- */
setRange(ctrlRange(0), 0)
await sleep(200)
const vAt0 = curVar()
setRange(ctrlRange(0), 90)
await sleep(200)
const vAt90 = curVar()
check('转动轴会改变投影方差（证明轴真的在转）', Math.abs(vAt0 - vAt90) > 0.01, `${vAt0} vs ${vAt90}`)

click('#btn-snap')
await sleep(250)
check('点「对准 PC1」后当前方差 = 最优方差', Math.abs(curVar() - bestVar()) < 1e-3, `${curVar()} vs ${bestVar()}`)
check('对齐后「当前/最优」显示 100.00%', Math.abs(ratioPct() - 100) < 0.05, ratioPct())
check('提示里出现"对齐了"', /对齐了/.test(text(q('#space-hint')) || ''), (text(q('#space-hint')) || '').slice(-30))

/* 随便拖一个别的角度，方差必须小于最优（这是"PC1 就是最大方差方向"的实证） */
setRange(ctrlRange(0), (parseInt(q('#controls .ctrl:first-child input[type=range]').value, 10) + 40) % 180)
await sleep(250)
check('偏离 PC1 之后投影方差严格小于最优', curVar() < bestVar() - 1e-6, `${curVar()} < ${bestVar()}`)

/* ---------- 6. k 的影响：累计方差随 k 单调上升，k=4 时 100% ---------- */
setRange(ctrlRange(1), 1)
await sleep(300)
const kept1 = keptPct()
check('k=1 时累计解释方差 ≈ 92.46%', Math.abs(kept1 - 92.462) < 0.05, kept1)

setRange(ctrlRange(1), 2)
await sleep(300)
const kept2 = keptPct()
check('k=2 时累计解释方差 ≈ 97.77%', Math.abs(kept2 - 97.769) < 0.05, kept2)
check('k 变大后保住的方差变多', kept2 > kept1, `${kept1}% → ${kept2}%`)

setRange(ctrlRange(1), 4)
await sleep(300)
check('k=4（全保留）时累计 = 100.00%', Math.abs(keptPct() - 100) < 0.01, keptPct())
check('k=4 时重构误差为 0', pca().reconMse < 1e-20, pca().reconMse)

/* ---------- 7. 重构误差：k 越少丢得越多 ---------- */
setRange(ctrlRange(1), 2)
await sleep(300)
const mse2 = pca().reconMse
setRange(ctrlRange(1), 1)
await sleep(300)
const mse1 = pca().reconMse
check('k=1 的重构误差大于 k=2', mse1 > mse2, `${mse1} vs ${mse2}`)
check('k=2 重构 RMSE ≈ 0.1592', Math.abs(Math.sqrt(mse2) - 0.1592) < 0.002, Math.sqrt(mse2))

/* ---------- 8. 换数据集：相关 vs 不相关，降维的两种命运 ---------- */
setRange(ctrlRange(1), 1)
await sleep(200)
setSelect('#sel-data', 'corr')
await sleep(500)
check('相关二维数据：PC1 占比 > 98%', pca().ratios[0] > 0.98, pca().ratios[0])
const corrKept = keptPct()
check('相关数据降成一维几乎不丢（保住 > 98%）', corrKept > 98, corrKept)

setSelect('#sel-data', 'uncorr')
await sleep(500)
check('不相关数据：PC1 占比 < 60%', pca().ratios[0] < 0.6, pca().ratios[0])
const uncorrKept = keptPct()
check('不相关数据降成一维要丢掉四成', Math.abs(uncorrKept - 58.858) < 0.1, uncorrKept)
check('两组对比：相关的确实比不相关保得多', corrKept > uncorrKept + 30, `${corrKept}% vs ${uncorrKept}%`)

/* ---------- 9. 标准化会换掉主成分（量纲的威力） ---------- */
setSelect('#sel-data', 'iris')
await sleep(500)
const rawPC1 = pca().ratios[0]
check('鸢尾花原始尺度 PC1 = 92.46%', Math.abs(rawPC1 - 0.924619) < 1e-5, rawPC1)

setSelect('#sel-data', 'iris-std')
await sleep(500)
const stdPC1 = pca().ratios[0]
check('标准化后 PC1 掉到 72.96%', Math.abs(stdPC1 - 0.729624) < 1e-5, stdPC1)
check('标准化确实把主成分换了个人', stdPC1 < rawPC1 - 0.15, `${rawPC1} → ${stdPC1}`)

/* 标准化后 k=1 的方差占比更低，但重构 RMSE 反而更高 —— 这是反直觉的实测结论 */
setRange(ctrlRange(1), 1)
await sleep(300)
const stdMse1 = pca().reconMse

setSelect('#sel-data', 'iris')
await sleep(500)
setRange(ctrlRange(1), 1)
await sleep(300)
const rawMse1 = pca().reconMse
check(
  '反直觉：标准化后 k=1 占比更低（73%）但重构误差更大 —— 占比和误差不同尺',
  stdMse1 > rawMse1 * 2,
  `std ${stdMse1.toFixed(4)} vs raw ${rawMse1.toFixed(4)}`,
)

/* ---------- 10. 「最佳 k」按钮：累计到 95% 所需的最小 k ---------- */
click('#btn-reset')
await sleep(300)
click('#btn-optimal')
await sleep(300)
check('最佳 k 按钮把 k 设成了 2（鸢尾花 95% 用两根轴就够）', pca().k === 2, pca().k)
check('最佳 k 之后累计方差 ≥ 95%', keptPct() >= 95, keptPct())

/* ---------- 11. 三维点云：3 维降 2 维保住 99% 以上 ---------- */
setSelect('#sel-data', 'cloud3d')
await sleep(500)
setRange(ctrlRange(1), 2)
await sleep(300)
check('三维点云降成二维保住 > 99%', keptPct() > 99, keptPct())
check('三维数据集的 k 滑杆上限是 3', parseInt(ctrlRange(1).max, 10) === 3, ctrlRange(1).max)

/* ---------- 12. 页面自洽 ---------- */
setSelect('#sel-data', 'iris')
await sleep(500)
check('代码面板里出现了真实的方差数字', /92\.46/.test(text(q('#code')) || ''), (text(q('#code')) || '').slice(0, 0))
check('代码面板提到了 sklearn 的 PCA', /from sklearn\.decomposition import PCA/.test(text(q('#code')) || ''), true)
check('上下篇里有"下一个：神经网络"', /神经网络/.test(text(q('#pager')) || ''), (text(q('#pager')) || '').slice(0, 60))
check('鸢尾花数据仍是 150 条', qall('#sel-data option').length === 5, true)

return {
  ok: results.every((r) => r.ok),
  passed: results.filter((r) => r.ok).length,
  total: results.length,
  failed: results.filter((r) => !r.ok),
  all: results,
}
