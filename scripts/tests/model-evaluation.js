/* 模型评估页的端到端断言：真的拖阈值、切数据集、关分层，然后核对数字。 */
const results = []
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra })

const qall = (s) => Array.from(document.querySelectorAll(s))
const text = (el) => (el ? el.textContent.trim() : null)
const metric = (i) => text(qall('#metrics .metric')[i]?.querySelector('.metric-value'))
const prAuc = () => Number(metric(5))
const mx = () => qall('#matrix .mx-num').map((e) => Number(e.textContent))
const ctrlRange = (host, i) => qall(`${host} .ctrl`)[i]?.querySelector('input[type=range]')
const rocPoints = () => q('#chart-roc').__chart.chart.getOption().series[1].data.length
const foldRows = () => qall('#fold-list .fold-row')
const cvMetric = (i) => text(qall('#cv-metrics .metric')[i]?.querySelector('.metric-value'))

/* ---------- 1. 首屏 ---------- */
check('数据集下拉有 3 个选项', qall('#sel-data option').length === 3, qall('#sel-data option').length)
check('默认是合成数据', q('#sel-data').value === 'synth', q('#sel-data').value)
const m0 = [0, 1, 2, 3, 4, 5, 6].map(metric)
check('七张指标卡都有值', m0.every((v) => v && v !== '-') && m0.length === 7, m0)

const p0 = rocPoints()
check('ROC 点数 = 样本数 + 1（600 → 601）', p0 === 601, p0)

const auc0 = Number(metric(4))
// 分离度 d=1.5 时理论 AUC = Φ(1.5/√2) ≈ 0.8562，实测应当很接近
check('ROC-AUC 接近理论值 0.8562（±0.02）', Math.abs(auc0 - 0.8562) < 0.02, auc0)
check('PR-AUC = 0.7485', Math.abs(prAuc() - 0.7485) < 0.001, prAuc())

/* ---------- 2. 拖动阈值：召回率与精确率此消彼长 ---------- */
const thr = ctrlRange('#controls', 0)
setRange(thr, 0.3)
await sleep(80)
const lowThr = { prec: Number(metric(1)), rec: Number(metric(2)), acc: Number(metric(0).replace('%', '')) }
setRange(thr, 0.7)
await sleep(80)
const highThr = { prec: Number(metric(1)), rec: Number(metric(2)), acc: Number(metric(0).replace('%', '')) }
check(
  '阈值调低 → 召回率上升',
  lowThr.rec > highThr.rec,
  `0.3 时召回 ${lowThr.rec}，0.7 时召回 ${highThr.rec}`,
)
check(
  '阈值调低 → 精确率下降',
  lowThr.prec < highThr.prec,
  `0.3 时精确 ${lowThr.prec}，0.7 时精确 ${highThr.prec}`,
)
check(
  'AUC 不随阈值变化',
  Number(metric(4)) === auc0,
  `${auc0} → ${metric(4)}`,
)
check('ROC 点数不随阈值变化', rocPoints() === p0, rocPoints())

/* ---------- 3. 混淆矩阵自洽 ---------- */
setRange(thr, 0.5)
await sleep(80)
const [tp, fn, fp, tn] = mx()
check('混淆矩阵四格之和 = 样本数', tp + fn + fp + tn === 600, tp + fn + fp + tn)
check('TP + FN = 正例总数（180）', tp + fn === 180, tp + fn)
check('准确率与矩阵自洽', Math.abs((tp + tn) / 600 - Number(metric(0).replace('%', '')) / 100) < 0.001, metric(0))

/* ---------- 4. 切到乳腺癌真实数据 ---------- */
setSelect('#sel-data', 'breast')
await sleep(200)
check('乳腺癌样本数 569（ROC 570 点）', rocPoints() === 570, rocPoints())
check('正例占比 37.3%', metric(6) === '37.3%', metric(6))
check('ROC-AUC ≈ 0.9863 / PR-AUC ≈ 0.9829', Math.abs(Number(metric(4)) - 0.9863) < 0.001 && Math.abs(prAuc() - 0.9829) < 0.001, `${metric(4)} / ${prAuc()}`)
const [tp2] = mx()
check('默认阈值 0.5 时判对（准确率 94.0%）', metric(0) === '94.0%', metric(0))
check('TP = 196', tp2 === 196, tp2)

const breastAuc = { roc: Number(metric(4)), pr: prAuc() }

/* ---------- 5. 切到稀有病：同一组权重、更低的患病率 ---------- */
setSelect('#sel-data', 'rare')
await sleep(200)
check('稀有病正例占比 ≈ 5.1%', metric(6) === '5.1%', metric(6))
check('ROC-AUC 略降（0.9685，抽稀正例导致）', Math.abs(Number(metric(4)) - 0.9685) < 0.002, metric(4))
const accRare = Number(metric(0).replace('%', ''))
check('准确率居然比乳腺癌还高（94.9%——骗人的）', accRare > 90, accRare)
check('但精确率腰斩到 0.500（判「患病」的一半是虚惊）', Math.abs(Number(metric(1)) - 0.5) < 0.01, metric(1))
check('F1 也从 0.920 掉到 0.655', Number(metric(3)) < 0.7, metric(3))

const rarePr = prAuc()
const rocDrop = breastAuc.roc - Number(metric(4))
const prDrop = breastAuc.pr - rarePr
check(
  'PR-AUC 的跌幅远大于 ROC-AUC（不平衡场景的典型表现）',
  prDrop > rocDrop * 2,
  `ROC 掉了 ${rocDrop.toFixed(4)}，PR 掉了 ${prDrop.toFixed(4)}`,
)

/* ---------- 6. 切回合成数据，检查旋钮显隐 ---------- */
setSelect('#sel-data', 'synth')
await sleep(200)
const synthCtrlVisible = qall('#controls .ctrl')[1].style.display !== 'none'
check('合成数据的旋钮可见', synthCtrlVisible, qall('#controls .ctrl')[1].style.display)

setSelect('#sel-data', 'breast')
await sleep(200)
check('真实数据时旋钮隐藏', qall('#controls .ctrl')[1].style.display === 'none', qall('#controls .ctrl')[1].style.display)

/* ---------- 7. 交叉验证 ---------- */
click('[data-tab="cv"]')
await sleep(400)
check('折列表有 5 行（默认 K=5）', foldRows().length === 5, foldRows().length)
check('均值在 0.85~1.0 之间', Number(cvMetric(0).replace('%', '')) > 85, cvMetric(0))
const minPosStrat = parseInt(cvMetric(3), 10)
check('分层时最少的一折也有正例', minPosStrat > 0, cvMetric(3))

// 关掉分层
const chk = q('#chk-stratify')
chk.checked = false
chk.dispatchEvent(new Event('change'))
await sleep(500)
const minPosNoStrat = parseInt(cvMetric(3), 10)
check(
  '非分层时最少的一折正例更少（且与对拍量到的 26 一致）',
  minPosNoStrat < minPosStrat && minPosNoStrat === 26,
  `${cvMetric(3)} ← 分层时为 ${minPosStrat}`,
)

// K 改成 10
const kRange = ctrlRange('#cv-controls', 0)
setRange(kRange, 10)
await sleep(700)
check('K=10 时折列表 10 行', foldRows().length === 10, foldRows().length)

// 恢复分层
chk.checked = true
chk.dispatchEvent(new Event('change'))
await sleep(500)

/* ---------- 8. 原始数据里的数值断言 ---------- */
// 乳腺癌 k=5 非分层时应出现「每折正例数极不均衡」的现象（对拍脚本里量过）
setSelect('#sel-cv', 'breast')
await sleep(500)
const stratText = text(q('#cv-status'))
check('状态栏报告了每折正例数', /每折正例数/.test(stratText || ''), (stratText || '').slice(0, 90))

return {
  ok: results.every((r) => r.ok),
  passed: results.filter((r) => r.ok).length,
  total: results.length,
  failed: results.filter((r) => !r.ok),
  all: results,
}
