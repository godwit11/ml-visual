/* 朴素贝叶斯页端到端断言：真的改短信内容、切模型、拖 α，核对判决与数字。 */
const results = []
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra })

const qall = (s) => Array.from(document.querySelectorAll(s))
const text = (el) => (el ? el.textContent.trim() : null)
const metric = (i) => text(qall('#metrics .metric')[i]?.querySelector('.metric-value'))
const setText = (s) => {
  const el = q('#sms-input')
  el.value = s
  el.dispatchEvent(new Event('input'))
}
const verdict = () => text(q('#verdict .verdict-value'))
const probaCells = () =>
  qall('#sms-breakdown .bd-proba td').slice(1).map((e) => parseFloat(e.textContent))
const bdRows = () => qall('#sms-breakdown .bd-table tbody tr').map((tr) => text(tr.querySelector('td')))
const hitChips = () => qall('#sms-breakdown .hit-chip').length
const ctrlRange = (i) => qall('#controls .ctrl')[i]?.querySelector('input[type=range]')

/* ---------- 1. 首屏 ---------- */
check('模型下拉有 2 个选项', qall('#sel-model option').length === 2, qall('#sel-model option').length)
check('默认伯努利模型', q('#sel-model').value === 'bernoulli', q('#sel-model').value)
check('指标卡齐全（6 张）', qall('#metrics .metric').length === 6, qall('#metrics .metric').length)
check('伯努利 α=1 准确率 97.24%', metric(0) === '97.24%', metric(0))
check('召回率 0.8648', metric(2) === '0.8648', metric(2))
check('spam 先验 13.40%', metric(4) === '13.40%', metric(4))
check('词表 150 个词', metric(5) === '150', metric(5))
check('几率比图有 24 个条形（12 spam + 12 ham）', q('#chart-odds').__chart.chart.getOption().series[0].data.length === 24, q('#chart-odds').__chart.chart.getOption().series[0].data.length)

/* ---------- 2. 默认那条示例：应该判成垃圾短信 ---------- */
check('默认示例判为垃圾短信', verdict() === '垃圾短信', verdict())
check('判决表格有 3 个构成行 + 合计 + 后验', bdRows().length === 5, bdRows())
check('伯努利模型含「未出现的词」那一行', bdRows().some((r) => /未出现的词/.test(r || '')), bdRows())
check('命中词有明细', hitChips() > 0, hitChips())
const p1 = probaCells()
check('后验概率两列相加 ≈ 100%', Math.abs(p1[0] + p1[1] - 100) < 0.05, p1)
check('判为垃圾时后验给 spam 更高', p1[1] > p1[0], p1)

/* ---------- 3. 换成正常短信：判决应该翻过来 ---------- */
setText('Sorry, I will call you later. I am in a meeting right now.')
await sleep(60)
check('正常短信判为「正常短信」', verdict() === '正常短信', verdict())
const p2 = probaCells()
check('判为正常时后验给 ham 更高', p2[0] > p2[1], p2)

/* ---------- 4. 「一票定罪」：一句普通的话里塞进 claim ---------- */
setText('Hi, I will call you later about the claim.')
await sleep(60)
const p3 = probaCells()
check('普通的话加了 claim 之后，spam 概率明显上升', p3[1] > p2[1], `${p2[1]}% → ${p3[1]}%`)

/* ---------- 5. 示例按钮 ---------- */
click('.sms-samples .btn:nth-child(1)')
await sleep(60)
check('点「垃圾短信」示例 → 判垃圾', verdict() === '垃圾短信', verdict())
click('.sms-samples .btn:nth-child(3)')
await sleep(60)
check('点「正常短信」示例 → 判正常', verdict() === '正常短信', verdict())

/* ---------- 6. 切换到多项式模型：表格结构应变化，准确率下降 ---------- */
const accBern = metric(0)
setSelect('#sel-model', 'multinomial')
await sleep(300)
check('多项式模型下不再有「未出现的词」行', !bdRows().some((r) => /未出现的词/.test(r || '')), bdRows())
const accMulti = metric(0)
check('多项式准确率低于伯努利（这份短文本语料上）', parseFloat(accMulti) < parseFloat(accBern), `${accBern} → ${accMulti}`)

/* ---------- 7. α 的影响 ---------- */
setSelect('#sel-model', 'bernoulli')
await sleep(300)
const aSlider = ctrlRange(0)
setRange(aSlider, 0) // α = 1
await sleep(300)
const accA1 = metric(0)
setRange(aSlider, 2) // α = 100
await sleep(400)
const accA100 = metric(0)
check('α 拉到 100 后准确率下降（区分度被抹平）', parseFloat(accA100) < parseFloat(accA1), `α=1 时 ${accA1}，α=100 时 ${accA100}`)
setRange(aSlider, -2) // α = 0.01
await sleep(400)
const accA001 = metric(0)
check('α 很小时准确率仍然可用（> 96%）', parseFloat(accA001) > 96, `${accA001}%`)

/* ---------- 8. 边界：空输入 / 全是不认识的字 ---------- */
setRange(aSlider, 0)
await sleep(300)
setText('')
await sleep(60)
check('空输入时不给判决（或按先验判正常）', verdict() === '正常短信' || verdict() === '垃圾短信', verdict())
setText('zzz qqq wwwxxx')
await sleep(60)
const p4 = probaCells()
check('全是不认识的词时，判决分数只剩先验（ham 仍占优）', p4[0] > p4[1], p4)

return {
  ok: results.every((r) => r.ok),
  passed: results.filter((r) => r.ok).length,
  total: results.length,
  failed: results.filter((r) => !r.ok),
  all: results,
}
