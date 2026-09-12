/* SVM 页端到端断言：真的切核函数、拖 C 与 γ，核对支持向量数、间隔宽度与准确率。 */
const results = []
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra })

const qall = (s) => Array.from(document.querySelectorAll(s))
const text = (el) => (el ? el.textContent.trim() : null)
const metric = (i) => text(qall('#metrics .metric')[i]?.querySelector('.metric-value'))
const acc = () => parseFloat((metric(3) || '').replace('%', ''))
const nSV = () => parseInt(metric(0), 10)
const margin = () => metric(2)
const ctrlRange = (i) => qall('#controls .ctrl')[i]?.querySelector('input[type=range]')
const alphaBars = () => q('#chart-alpha').__chart.chart.getOption().series[0].data.length
const status = () => text(q('#train-status')) || ''

/* ---------- 1. 首屏 ---------- */
check('数据集有 5 个选项', qall('#sel-data option').length === 5, qall('#sel-data option').length)
check('核函数有 3 个选项', qall('#sel-kernel option').length === 3, qall('#sel-kernel option').length)
check('默认 RBF 核', q('#sel-kernel').value === 'rbf', q('#sel-kernel').value)
check('支持向量数 > 0', nSV() > 0, nSV())
check('α 图的柱子数 = 样本数（200）', alphaBars() === 200, alphaBars())
check('状态栏报告了迭代次数与 KKT 残差', /迭代/.test(status()) && /KKT/.test(status()), status().slice(0, 120))
check('非线性核时 γ 滑杆可见', qall('#controls .ctrl')[1].style.display !== 'none', qall('#controls .ctrl')[1].style.display)
check('非线性核时 degree 滑杆隐藏', qall('#controls .ctrl')[2].style.display === 'none', qall('#controls .ctrl')[2].style.display)

/* ---------- 2. 月牙：线性核撞墙，RBF 解开（这一页的核心教学点） ---------- */
setSelect('#sel-data', 'moons')
await sleep(1500)
setSelect('#sel-kernel', 'linear')
await sleep(1500)
const moonsLinear = acc()
check('月牙 + 线性核：准确率上不去（< 95%）', moonsLinear < 95, `${moonsLinear}%`)
check('线性核时 γ 滑杆隐藏', qall('#controls .ctrl')[1].style.display === 'none', qall('#controls .ctrl')[1].style.display)
check('线性核时能算出间隔宽度', /^\d/.test(margin()), margin())

setSelect('#sel-kernel', 'rbf')
await sleep(1500)
const moonsRbf = acc()
check(
  '月牙 + RBF 核：准确率明显提升（> 95%，且高于线性核）',
  moonsRbf > 95 && moonsRbf > moonsLinear,
  `${moonsLinear}% → ${moonsRbf}%`,
)
check('RBF 核时 γ 滑杆重新可见', qall('#controls .ctrl')[1].style.display !== 'none', qall('#controls .ctrl')[1].style.display)
check('非线性核时不显示间隔宽度', /非线性/.test(margin()), margin())

/* ---------- 3. 同心圆 ---------- */
setSelect('#sel-data', 'circles')
await sleep(1500)
const circlesRbf = acc()
setSelect('#sel-kernel', 'linear')
await sleep(1500)
const circlesLinear = acc()
check(
  '同心圆：线性核很糟、RBF 核很好',
  circlesLinear < 80 && circlesRbf > 95,
  `线性 ${circlesLinear}% / RBF ${circlesRbf}%`,
)

/* ---------- 4. C 的作用：线性可分数据上，C 越大间隔越窄 ---------- */
setSelect('#sel-data', 'linear')
await sleep(1500)
const cSlider = ctrlRange(0)
setRange(cSlider, -2)
await sleep(1400)
const smallC = { margin: parseFloat(margin()), sv: nSV() }
setRange(cSlider, 2)
await sleep(1400)
const bigC = { margin: parseFloat(margin()), sv: nSV() }
check(
  'C 越大 → 间隔越窄（线性可分）',
  bigC.margin < smallC.margin,
  `C=0.01 时 ${smallC.margin}，C=100 时 ${bigC.margin}`,
)
check(
  'C 越大 → 支持向量越少（线性可分）',
  bigC.sv < smallC.sv,
  `C=0.01 时 ${smallC.sv} 个，C=100 时 ${bigC.sv} 个`,
)
check('线性可分数据上训练准确率 100%', acc() === 100, `${acc()}%`)

/* ---------- 5. γ 的作用：太小会欠拟合，而且几乎所有点都成了支持向量 ---------- */
setSelect('#sel-data', 'circles')
await sleep(1500)
setSelect('#sel-kernel', 'rbf')
await sleep(1500)
const gSlider = ctrlRange(1)
// 先把 C 拨回 1，否则会带着上一节留下的 C=100 来比较（γ 的效果会被 C 掩盖）
setRange(ctrlRange(0), 0)
await sleep(1400)
setRange(gSlider, -2) // γ = 0.01
await sleep(1500)
const tinyG = { sv: nSV(), acc: acc() }
setRange(gSlider, 0) // γ = 1
await sleep(1500)
const goodG = { sv: nSV(), acc: acc() }
check('γ 太小 → 几乎所有样本都成了支持向量（≥150/200）', tinyG.sv >= 150, `${tinyG.sv} / 200`)
check('γ 太小 → 欠拟合，准确率明显下降（< 85%）', tinyG.acc < 85, `${tinyG.acc}%`)
check('γ 调到 1 → 支持向量大幅减少', goodG.sv < tinyG.sv * 0.6, `${tinyG.sv} → ${goodG.sv}`)
check('γ 调到 1 → 准确率回到 95% 以上', goodG.acc > 95, `${goodG.acc}%`)

/* ---------- 6. 多项式核：同心圆恰好能被二次多项式分开 ---------- */
setSelect('#sel-kernel', 'poly')
await sleep(1800)
check('多项式核时 degree 滑杆可见', qall('#controls .ctrl')[2].style.display !== 'none', qall('#controls .ctrl')[2].style.display)
setRange(ctrlRange(2), 2)
await sleep(1800)
check(
  '同心圆 + 二次多项式核：准确率 > 95%（x²+y² 正好能切开它）',
  acc() > 95,
  `degree=2 时 ${acc()}%`,
)

/* ---------- 7. 乳腺癌真实数据 ---------- */
setSelect('#sel-data', 'breast')
await sleep(1800)
setSelect('#sel-kernel', 'rbf')
await sleep(1800)
check('乳腺癌上 RBF 核准确率 > 90%', acc() > 90, `${acc()}%`)
check('乳腺癌数据 200 例', alphaBars() === 200, alphaBars())

return {
  ok: results.every((r) => r.ok),
  passed: results.filter((r) => r.ok).length,
  total: results.length,
  failed: results.filter((r) => !r.ok),
  all: results,
}
