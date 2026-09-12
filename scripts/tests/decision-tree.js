/**
 * 决策树演示页的端到端断言。
 * 由 scripts/e2e.mjs 注入页面执行，可用 sleep / q / qa / click / setSelect / setRange。
 */
const sleepMs = (ms) => sleep(ms)

const metrics = () => {
  const v = qa('.metric-value').map((e) => e.textContent)
  return { acc: v[0], depth: Number(v[1]), leaves: Number(v[2]), nodes: Number(v[3]) }
}
const status = () => q('#build-status').textContent.trim()
const treeSize = () => {
  const c = q('canvas.tree-canvas')
  return c ? { w: parseInt(c.style.width), h: parseInt(c.style.height) } : null
}
const axis = (i) => {
  const opt = q('#chart').__chart.chart.getOption()
  const a = i === 0 ? opt.xAxis[0] : opt.yAxis[0]
  return { min: a.min, max: a.max, name: a.name }
}
const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass, detail })
}

/* ---------- 1. 首屏 ---------- */
await sleepMs(600)
const init = metrics()
check('首屏已长好树', init.depth >= 1 && init.leaves >= 2, init)
check('树画布已渲染', (treeSize()?.w ?? 0) > 100, treeSize())

/* ---------- 2. 重置 ---------- */
click('#btn-reset')
await sleepMs(120)
const afterReset = metrics()
check(
  '重置后只剩根节点',
  afterReset.depth === 0 && afterReset.leaves === 1 && afterReset.nodes === 1,
  afterReset,
)
check('重置后状态栏提示根节点', status().includes('根节点'), status())

/* ---------- 3. 单步构建 ---------- */
click('#btn-step')
await sleepMs(80)
const s1 = metrics()
click('#btn-step')
await sleepMs(80)
const s2 = metrics()
click('#btn-step')
await sleepMs(80)
const s3 = metrics()
check('单步 1 次：深度 1、叶子 2', s1.depth === 1 && s1.leaves === 2, s1)
check('单步 2 次：叶子 3', s2.leaves === 3, s2)
check('单步 3 次：叶子 4（广度优先）', s3.depth === 2 && s3.leaves === 4, s3)
check('单步后状态栏说明了切分', /按.*≤.*切/.test(status()), status())

/* ---------- 4. 单步到底 == 一次性构建 ----------
 * 注意：不能靠"节点数没变"判断结束——有些步只是把某个叶子标记为终止，不新增节点。
 * 真正的结束信号是状态栏出现「长完了」。 */
let guard = 0
let sawDone = false
while (guard < 400) {
  click('#btn-step')
  await sleepMs(8)
  guard++
  if (status().includes('长完了')) {
    sawDone = true
    break
  }
}
check('单步能一直走到长完', sawDone, { 步数: guard, status: status() })
const stepped = metrics()
click('#btn-build')
await sleepMs(200)
const built = metrics()
check(
  '单步走完与一次构建结果相同',
  stepped.depth === built.depth &&
    stepped.leaves === built.leaves &&
    stepped.nodes === built.nodes &&
    stepped.acc === built.acc,
  { stepped, built },
)

/* ---------- 5. 切换数据集（重点：坐标范围要跟着换） ---------- */
setSelect('#sel-data', 'iris')
await sleepMs(400)
const irisAxis = axis(0)
const irisAxisY = axis(1)
check(
  '切到鸢尾花后 X 轴范围跟着变（花瓣长 0~7cm 量级）',
  irisAxis.min < 1.5 && irisAxis.max > 6 && irisAxis.max < 9,
  irisAxis,
)
check(
  '切到鸢尾花后 Y 轴范围跟着变（花瓣宽 0~3cm 量级）',
  irisAxisY.min < 0.5 && irisAxisY.max > 2 && irisAxisY.max < 4,
  irisAxisY,
)
const irisMetrics = metrics()
check(
  '鸢尾花上树能学到东西（准确率 > 90%）',
  parseFloat(irisMetrics.acc) > 90,
  irisMetrics,
)

/* ---------- 6. 最大深度滑杆 ---------- */
const ranges = qa('#controls input[type="range"]')
setRange(ranges[0], 1)
await sleepMs(200)
const d1 = metrics()
check('max_depth=1 时是树桩（深度 1、叶子 2）', d1.depth === 1 && d1.leaves === 2, d1)

setRange(ranges[0], 10)
await sleepMs(300)
const d10 = metrics()
check('max_depth=10 时树更深', d10.depth > d1.depth, { d1: d1.depth, d10: d10.depth })
// 月牙带噪声，有重叠点，即使完全长满也到不了 100%——断言"冲到接近满分"即可
check('深度 10 时训练集准确率接近满分（过拟合）', parseFloat(d10.acc) >= 99, d10.acc)

/* ---------- 7. 最小分裂样本数 ---------- */
setRange(ranges[1], 40)
await sleepMs(300)
const m40 = metrics()
check('min_samples_split=40 时树变浅', m40.leaves < d10.leaves, { m40: m40.leaves, d10: d10.leaves })
setRange(ranges[1], 2)
await sleepMs(200)

/* ---------- 8. 不纯度准则 ---------- */
setSelect('#sel-criterion', 'entropy')
await sleepMs(300)
const ent = metrics()
check('切到熵后仍能正常构建', ent.depth >= 1 && parseFloat(ent.acc) > 80, ent)
const code = q('#code').textContent
check('代码面板同步了 entropy', code.includes('criterion="entropy"'), code.split('\n')[5])

/* ---------- 9. 自动构建 ---------- */
setRange(qa('#controls input[type="range"]')[0], 3) // 先把深度收回来，免得等太久
await sleepMs(200)
click('#btn-reset')
await sleepMs(100)
click('#btn-auto')
await sleepMs(300)
const runningLabel = q('#btn-auto').textContent
await sleepMs(6000)
const autoDone = metrics()
check('自动构建按钮变成暂停', runningLabel === '暂停', runningLabel)
check('自动构建跑完后树已长完', status().includes('长完了') && autoDone.depth === 3, {
  autoDone,
  status: status(),
})
check('跑完后按钮恢复「自动构建」', q('#btn-auto').textContent === '自动构建', q('#btn-auto').textContent)

/* ---------- 10. 缩放 ---------- */
const before = treeSize().w
click('#btn-zoom-in')
await sleepMs(150)
const after = treeSize().w
check('放大后画布变宽', after > before, { before, after })
click('#btn-fit')
await sleepMs(150)
check('适应屏幕后画布回到容器宽度内', treeSize().w <= before + 2, { fit: treeSize().w, before })

/* ---------- 汇总 ---------- */
const failed = results.filter((r) => !r.pass)
return {
  ok: failed.length === 0,
  通过: results.length - failed.length,
  总数: results.length,
  失败: failed.map((f) => ({ name: f.name, detail: f.detail })),
  明细: results,
}
