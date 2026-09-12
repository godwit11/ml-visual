/**
 * 线性回归演示页的端到端断言。
 * 主要守两件事：滑杆/数字框/微调按钮三者同步（上一轮修过 4 个坑），
 * 以及指标与代码面板确实跟着参数走。
 */
const metrics = () => {
  const v = qa('.metric-value').map((e) => e.textContent)
  return { mae: v[0], mse: v[1], r2: v[2], gap: v[3] }
}
const results = []
const check = (name, pass, detail) => results.push({ name, pass, detail })

const ranges = qa('#controls input[type="range"]')
const nums = qa('#controls input[type="number"]')
const wRange = ranges[0]
const bRange = ranges[1]
const wNum = nums[0]

/* ---------- 1. 控件存在 ---------- */
check('两个滑杆 + 两个数字框都在', ranges.length === 2 && nums.length === 2, {
  ranges: ranges.length,
  nums: nums.length,
})
check('滑杆步长已收窄到 0.05', wRange.step === '0.05' && bRange.step === '0.05', {
  w: wRange.step,
  b: bRange.step,
})
check('滑杆范围已收窄到 0.75 倍（-22.5 ~ 22.5）', wRange.min === '-22.5' && wRange.max === '22.5', {
  min: wRange.min,
  max: wRange.max,
})

/* ---------- 2. 数字框输入精确值 ---------- */
wNum.value = '9.1'
wNum.dispatchEvent(new Event('change'))
await sleep(80)
check('数字框输入 9.1 后滑杆同步', Math.abs(Number(wRange.value) - 9.1) < 1e-9, {
  range: wRange.value,
  显示: wNum.value,
})

/* ---------- 3. 数字框输入越界值被夹住 ---------- */
wNum.value = '999'
wNum.dispatchEvent(new Event('change'))
await sleep(80)
check('越界输入被夹到上界 22.5', Number(wRange.value) === 22.5, wRange.value)

wNum.value = '-999'
wNum.dispatchEvent(new Event('change'))
await sleep(80)
check('越界输入被夹到下界 -22.5', Number(wRange.value) === -22.5, wRange.value)

/* ---------- 4. 非法输入回退，不会把参数清零 ---------- */
setRange(wRange, 5)
await sleep(60)
wNum.value = 'abc'
wNum.dispatchEvent(new Event('change'))
await sleep(80)
check('输入 abc 后参数保持不变（不是归零）', Number(wRange.value) === 5, wRange.value)

/* ---------- 5. 微调按钮 ---------- */
const before = Number(wRange.value)
qa('#controls .ctrl-step')[0].click() // −
await sleep(60)
const afterMinus = Number(wRange.value)
qa('#controls .ctrl-step')[1].click() // +
await sleep(60)
const afterPlus = Number(wRange.value)
check('− 按钮减一个 step', Math.abs(afterMinus - (before - 0.05)) < 1e-9, { before, afterMinus })
check('+ 按钮加一个 step', Math.abs(afterPlus - before) < 1e-9, { afterMinus, afterPlus })

/* ---------- 6. OLS 按钮 ---------- */
click('#btn-ols')
await sleep(150)
const ols = metrics()
check('OLS 后距最优显示为已达最优', ols.gap === '已达最优', ols)
check('OLS 后 MSE 与已知最优值一致（43.60）', ols.mse === '43.60', ols.mse)
check('OLS 后 R² = 0.4835', ols.r2 === '0.4835', ols.r2)

/* ---------- 7. 代码面板跟着变 ---------- */
const code = q('#code').textContent
check('代码面板同步了当前斜率', code.includes('w = 9.10'), code.split('\n')[1])

/* ---------- 8. 重置 ---------- */
click('#btn-reset')
await sleep(150)
const reset = metrics()
check('重置后回到初始直线（w=0）', code !== q('#code').textContent, {
  w: q('#code').textContent.split('\n')[1],
  gap: reset.gap,
})

return {
  ok: results.filter((r) => !r.pass).length === 0,
  通过: results.filter((r) => r.pass).length,
  总数: results.length,
  失败: results.filter((r) => !r.pass).map((f) => ({ name: f.name, detail: f.detail })),
  明细: results,
}
