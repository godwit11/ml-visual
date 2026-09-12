/**
 * Logistic 回归演示页的端到端断言。
 * 重点：训练流程、阈值对精确率/召回率的影响，以及各数据集的收敛结果
 * 要与对拍脚本算出来的值一致（breast 94.02%、moons 86.79%）。
 */
const sleepMs = (ms) => sleep(ms)
const results = []
const check = (name, pass, detail) => results.push({ name, pass, detail })

const mv = () => qa('.metric-value').map((e) => e.textContent)
const num = (s) => parseFloat(s)
const status = () => q('#train-status').textContent.replace(/\s+/g, ' ').trim()
const ranges = qa('#controls input[type="range"]')
const setSlider = (i, v) => {
  const el = ranges[i]
  el.value = String(v)
  el.dispatchEvent(new Event('input'))
}
const code = () => q('#code').textContent

await sleepMs(800)

/* ---------- 1. 首屏 ---------- */
check('三张图都渲染出来了', qa('canvas').length >= 3, { canvas: qa('canvas').length })
check(
  '初始参数全 0，损失 = ln2 ≈ 0.6931',
  Math.abs(num(mv()[1]) - 0.6931) < 0.001,
  mv()[1],
)
check('初始阈值为 0.5', code().includes('threshold = 0.50'), code().split('\n')[2])

/* ---------- 2. 训练到收敛（乳腺癌真实数据） ---------- */
setSelect('#sel-data', 'breast')
await sleepMs(600)
click('#btn-converge')
await sleepMs(1500)
const breastM = mv()
check('乳腺癌上训练到收敛，准确率 ≈ 94.0%', Math.abs(num(breastM[0]) - 94.0) < 0.3, breastM[0])
check('收敛后损失 ≈ 0.1314', Math.abs(num(breastM[1]) - 0.1314) < 0.002, breastM[1])
check('代码面板给出了 sklearn 的等价写法', code().includes('LogisticRegression'), code().split('\n')[9])
check(
  '代码面板里的 sklearn 准确率与页面一致',
  code().includes('0.9402'),
  code().split('\n').find((l) => l.includes('accuracy_score')),
)

/* ---------- 3. 判定阈值：精确率与召回率此消彼长 ---------- */
const rec05 = num(mv()[3])
const pre05 = num(mv()[2])
setSlider(3, 0.2)
await sleepMs(300)
const rec02 = num(mv()[3])
const pre02 = num(mv()[2])
check('阈值降到 0.2 后召回率上升', rec02 > rec05, { '0.5': rec05, '0.2': rec02 })
check('阈值降到 0.2 后精确率下降', pre02 < pre05, { '0.5': pre05, '0.2': pre02 })
check('阈值变化同步到代码面板', code().includes('threshold = 0.20'), code().split('\n')[2])
setSlider(3, 0.5)
await sleepMs(200)

/* ---------- 4. 线性天花板：月牙分不开 ---------- */
setSelect('#sel-data', 'moons')
await sleepMs(600)
click('#btn-converge')
await sleepMs(1200)
const moonM = mv()
check('月牙上准确率 ≈ 86.8%', Math.abs(num(moonM[0]) - 86.8) < 1.0, moonM[0])
check('月牙上准确率明显低于乳腺癌（线性模型的天花板）', num(moonM[0]) < 90, moonM[0])

/* ---------- 5. 线性可分：损失趋近 0 但不收敛 ---------- */
setSelect('#sel-data', 'separable')
await sleepMs(600)
click('#btn-converge')
await sleepMs(2500)
const sepM = mv()
check('线性可分上准确率 100%', Math.abs(num(sepM[0]) - 100) < 0.01, sepM[0])
check('线性可分上损失趋近 0', num(sepM[1]) < 0.01, sepM[1])
check(
  '状态栏诚实说明"未收敛"（无正则 + 可分 = 最优解在无穷远）',
  status().includes('仍未收敛'),
  status(),
)

/* ---------- 6. 手动调参数会改指标 ---------- */
click('#btn-reset')
await sleepMs(300)
const before = num(mv()[1])
setSlider(0, 3) // w1 = 3
await sleepMs(300)
const after = num(mv()[1])
check('手动把 w₁ 调到 3 后损失变了', Math.abs(after - before) > 0.01, { before, after })
check('手动改参数后代码面板同步', code().includes('w1, w2, b = 3.00'), code().split('\n')[1])

/* ---------- 7. 重置 ---------- */
click('#btn-reset')
await sleepMs(300)
check('重置后回到 ln2', Math.abs(num(mv()[1]) - 0.6931) < 0.001, mv()[1])
check('重置后训练轮数归零', status().includes('已训练 0 轮'), status())

/* ---------- 8. 单步与自动 ---------- */
click('#btn-step')
await sleepMs(200)
check('走 1 步后轮数为 1', status().includes('已训练 1 轮'), status())
click('#btn-step10')
await sleepMs(300)
check('再走 10 步后轮数为 11', status().includes('已训练 11 轮'), status())
const loss11 = num(mv()[1])
check('训练让损失下降', loss11 < 0.6931, loss11)

click('#btn-auto')
await sleepMs(400)
const running = q('#btn-auto').textContent
await sleepMs(1500)
click('#btn-auto')
await sleepMs(200)
const stopped = q('#btn-auto').textContent
check('自动训练按钮变「暂停」', running === '暂停', running)
check('再点一次能停住', stopped === '自动训练', stopped)

return {
  ok: results.filter((r) => !r.pass).length === 0,
  通过: results.filter((r) => r.pass).length,
  总数: results.length,
  失败: results.filter((r) => !r.pass).map((f) => ({ name: f.name, detail: f.detail })),
  明细: results,
}
