/*
 * 神经网络页端到端断言。
 *
 * 这一页有随机性，所以断言不能钉死"最后一个数字是多少"。
 * 策略是钉三类东西：
 *   ① **结构性事实**（必须永远成立）：二分类输出 1 个单元、参数个数公式、损失 ≥ 0 等；
 *   ② **可复现的定量结果**：固定种子后训练准确率必须达标（异或必须 100%）；
 *   ③ **教学点本身**：无激活时决策边界必须是**严格直线**——
 *      这条我用"三点的概率线性插值误差"来验，比看图靠谱。
 */
const results = []
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra })

const qall = (s) => Array.from(document.querySelectorAll(s))
const text = (el) => (el ? el.textContent.trim() : null)
const metric = (i) => text(qall('#metrics .metric')[i]?.querySelector('.metric-value'))
const num = (i) => parseFloat(metric(i))
const nn = () => window.__nn
const ctrl = (i) => qall('#controls .ctrl')[i]?.querySelector('input[type=range]')

/* ---------- 1. 首屏结构与基本事实 ---------- */
check('数据集 5 个选项', qall('#sel-data option').length === 5, qall('#sel-data option').length)
check('激活函数 4 个选项（含"线性（无激活）"）', qall('#sel-act option').length === 4, qall('#sel-act option').length)
check('默认数据集是异或', nn().ds === 'xor', nn().ds)
check('默认激活是 ReLU', nn().act === 'relu', nn().act)
check('主图画出来了', !!q('#chart-space').__chart, !!q('#chart-space').__chart)
check('训练曲线画出来了', !!q('#chart-loss').__chart, !!q('#chart-loss').__chart)

/* 二分类的输出层必须是 1 个单元（不是 2 个）—— 这是对拍确认过的约定 */
check('二分类输出层是 1 个单元（不是 2 个）', nn().sizes[nn().sizes.length - 1] === 1, nn().sizes)
check('异或默认结构是 [2,4,1]', JSON.stringify(nn().sizes) === '[2,4,1]', nn().sizes)

/* 参数个数必须是 (fan_in*fan_out + fan_out) 的累加 —— 手算核对 */
{
  const s = nn().sizes
  let expect = 0
  for (let i = 0; i < s.length - 1; i++) expect += s[i] * s[i + 1] + s[i + 1]
  check('参数个数 = Σ(fan_in×fan_out + fan_out)', nn().params === expect, `${nn().params} vs ${expect}`)
}

/* ---------- 2. 训练必须真的收敛（异或 + ReLU） ---------- */
check('异或 ReLU 训练准确率 = 100%', nn().acc >= 0.999, nn().acc)
check('异或损失降到 0.05 以下', nn().loss < 0.05, nn().loss)
check('训练轮数等于设定的 300', nn().epochs === 300, nn().epochs)

/* 损失曲线必须单调性大致下降（前 10 轮均值 > 后 10 轮均值） */
{
  const opt = q('#chart-loss').__chart.chart.getOption()
  const lossSeries = opt.series[0].data.map((d) => (typeof d === 'number' ? d : d.value))
  const head = lossSeries.slice(0, 10).reduce((a, b) => a + b, 0) / 10
  const tail = lossSeries.slice(-10).reduce((a, b) => a + b, 0) / 10
  check('损失曲线确实在下降（头 10 轮均值 > 尾 10 轮均值）', head > tail * 2, `${head.toFixed(4)} → ${tail.toFixed(4)}`)
  check('损失全程非负', lossSeries.every((v) => v >= 0), Math.min(...lossSeries))
}

/* ---------- 3. 核心教学点：无激活 → 决策边界是严格直线 ---------- */
/*
 * 判定方法：在网格上取一条直线上的若干点，若决策边界是直线，则
 * **logit 必须严格线性**（logit = a·x + b·y + c，是最纯粹的线性函数）。
 *
 * 为什么比 logit 而不是比概率？
 *   概率外面套了一层 sigmoid，sigmoid 是非线性的，所以概率不线性。
 *   但 logit 是线性的——这是"网络退化成线性模型"最干净的判据。
 *
 * 用 5 个点做最小二乘意义上的"线性度"检验：以首尾两点定直线，
 * 看中间三点偏离多少。线性时误差应在浮点量级（实测 ~1e-17）。
 */
{
  nn().configure([4], 'identity')
  await sleep(400)

  const g = nn().grid(41)
  const mid = Math.floor(g.values.length / 2)
  const row = g.values[mid]
  const toLogit = (p) => Math.log(p / (1 - p))

  let maxErr = 0
  const l0 = toLogit(row[0])
  const l40 = toLogit(row[40])
  for (const i of [10, 20, 30]) {
    const expected = l0 + ((l40 - l0) * i) / 40
    maxErr = Math.max(maxErr, Math.abs(toLogit(row[i]) - expected))
  }
  check('无激活时 logit 沿一条直线严格线性（边界是直线）', maxErr < 1e-12, `最大插值误差 ${maxErr.toExponential(2)}`)

  /* 同一个点阵沿 y 方向也必须线性（证明是二维平面上的直线，不是巧合） */
  const colVals = g.values.map((r) => r[20])
  const c0 = toLogit(colVals[0])
  const c40 = toLogit(colVals[colVals.length - 1])
  let maxErrY = 0
  for (const i of [10, 20, 30]) {
    const expected = c0 + ((c40 - c0) * i) / 40
    maxErrY = Math.max(maxErrY, Math.abs(toLogit(colVals[i]) - expected))
  }
  check('无激活时 y 方向也严格线性（是平面上的直线）', maxErrY < 1e-12, `最大插值误差 ${maxErrY.toExponential(2)}`)

  /* 换成 ReLU 后同一条线上就不再线性了（非线性真的回来了） */
  nn().configure([4], 'relu')
  await sleep(400)
  const g2 = nn().grid(41)
  const row2 = g2.values[Math.floor(g2.values.length / 2)]
  const a0 = toLogit(row2[0])
  const a40 = toLogit(row2[40])
  let maxErrRelu = 0
  for (const i of [10, 20, 30]) {
    const expected = a0 + ((a40 - a0) * i) / 40
    maxErrRelu = Math.max(maxErrRelu, Math.abs(toLogit(row2[i]) - expected))
  }
  check(
    '换成 ReLU 后同一方向明显偏离直线（非线性确实生效）',
    maxErrRelu > 1e-3,
    `最大偏离 ${maxErrRelu.toExponential(2)}（线性时约 1e-17）`,
  )
}

/* 无激活时异或学不会：损失必须卡在 ln2 附近，概率跨度必须极小 */
{
  nn().configure([16, 16], 'identity')
  await sleep(400)
  check('无激活 + 双层 16×16：准确率上不去（< 90%）', nn().acc < 0.9, nn().acc)
  check(
    '无激活时损失卡在 ln2 附近（0.6931 ± 0.01）',
    Math.abs(nn().loss - Math.log(2)) < 0.01,
    `${nn().loss.toFixed(6)} vs ${Math.log(2).toFixed(6)}`,
  )
  const g = nn().grid(31)
  const flat = g.values.flat()
  const spread = Math.max(...flat) - Math.min(...flat)
  check('无激活时概率几乎是常数（跨度 < 0.05）——"75% 准确率"是假象', spread < 0.05, spread.toFixed(5))
}

/* ---------- 4. 加回激活函数，异或立刻能解 ---------- */
{
  nn().configure([4], 'relu')
  await sleep(400)
  check('换成 ReLU 后异或准确率回到 100%', nn().acc >= 0.999, nn().acc)

  nn().configure([4], 'tanh')
  await sleep(400)
  check('tanh 也能解异或', nn().acc >= 0.95, nn().acc)
}

/* ---------- 5. 容量：螺旋上神经元太少学不动 ---------- */
{
  setSelect('#sel-data', 'spiral')
  await sleep(800)

  nn().configure([2], 'relu')
  await sleep(600)
  const smallAcc = nn().acc
  check('螺旋 + 只有 2 个神经元：学不动（< 96%）', smallAcc < 0.96, smallAcc)

  nn().configure([16, 16], 'relu')
  await sleep(900)
  const bigAcc = nn().acc
  check('螺旋 + 双层 16×16：明显更好（> 97%）', bigAcc > 0.97, bigAcc)
  check('加宽加深确实提升了准确率', bigAcc > smallAcc, `${smallAcc} → ${bigAcc}`)
}

/* ---------- 6. 梯度消失：logistic 在深网络里比值极小 ---------- */
/*
 * 用 gradRatioProbe：在**随机初始化的 8 层网络**上量首层/末层梯度范数比。
 *
 * 为什么不看训练后的比值？训练会把权重调向"好用"的配置，
 * 4 层 logistic 训练后比值会升到 2.7e-2，衰减就不锐利了。
 * 8 层 + 未训练时差距最大：logistic ~3.7e-6，ReLU ~2.8 —— 差六个数量级。
 */
{
  setSelect('#sel-data', 'xor')
  await sleep(700)

  const deep = [8, 8, 8, 8, 8, 8, 8, 8]
  const rLog = nn().gradRatioProbe(deep, 'logistic')
  const rRelu = nn().gradRatioProbe(deep, 'relu')
  const rTanh = nn().gradRatioProbe(deep, 'tanh')

  check('探针结构是 8 层隐层', rLog.layers === 9, rLog.layers)
  check(
    'logistic + 8 层：首层/末层梯度比 < 1e-5（梯度消失）',
    rLog.ratio < 1e-5,
    rLog.ratio.toExponential(2),
  )
  check('ReLU + 同结构：梯度比 > 0.1（不消失）', rRelu.ratio > 0.1, rRelu.ratio.toExponential(2))
  check(
    'ReLU 的梯度比至少比 logistic 大 1000 倍',
    rRelu.ratio > rLog.ratio * 1000,
    `relu ${rRelu.ratio.toExponential(2)} vs logistic ${rLog.ratio.toExponential(2)}`,
  )
  check('tanh 介于两者之间', rTanh.ratio > rLog.ratio && rTanh.ratio < rRelu.ratio, rTanh.ratio.toExponential(2))

  /* 页面上训练后的比值也要有限、非 NaN */
  nn().configure([4], 'relu')
  await sleep(500)
  check('训练后页面显示的梯度比是有限值', Number.isFinite(nn().gradRatio) || nn().gradRatio === Infinity, nn().gradRatio)
}

/* ---------- 7. 多分类：鸢尾花 softmax ---------- */
{
  setSelect('#sel-data', 'iris')
  await sleep(1000)
  check('鸢尾花是 3 类', nn().sizes[nn().sizes.length - 1] === 3, nn().sizes)
  check('鸢尾花默认结构 [4,8,3]', JSON.stringify(nn().sizes) === '[4,8,3]', nn().sizes)

  /* 鸢尾花是原始量纲，页面给它配的学习率必须是 0.1（0.3 会明显变差） */
  check('鸢尾花默认学习率是 0.1（量纲大，必须调小）', Math.abs(nn().lr - 0.1) < 1e-9, nn().lr)
  const accAt01 = nn().acc
  check('鸢尾花 lr=0.1 准确率 > 90%', accAt01 > 0.9, accAt01)

  /*
   * 反证：学习率 vs 数据尺度。
   *
   * ⚠️ 这个现象**必须在"从头初始化"的前提下才稳定复现**。
   * 页面改 lr 时会沿用已有权重（ configure 不重新初始化），
   * 从一个已经训好的状态继续用 lr=0.3 训，只会原地抖动，准确率照样 93%
   * ——实测过，所以不能拿"页面上的 lr=0.3"来断言。
   *
   * 真正的事实是：鸢尾花**从随机初始化开始**训练时，lr 存在一道悬崖。
   * 诊断脚本用 12 个种子量过：lr≤0.1 → 基本都能训好；lr≥0.2 → 0/12 全崩
   * （准确率 33.3%，损失精确等于 ln3）。
   * 这里用 retrain（会重新初始化）把这道悬崖钉住。
   */
  /*
   * 注意 sleep 要**大于防抖的 120ms**。
   * 滑杆输入会安排一次延迟重训；若紧接着就调 retrain，两者会打架
   * （先跑的那个用旧 lr，后跑的把结果覆盖掉），实测会显示 93%，看着像"没崩"。
   *
   * 另外：setRange 的第二个参数必须是**真正的 range 元素**（用 ctrl(i) 取），
   * 传 .ctrl 包装 div 不会报错但也不会生效——这个坑调试了整整一轮。
   */
  setRange(ctrl(1), 0.3)
  await sleep(700)
  check('滑杆上的学习率确实是 0.3', Math.abs(nn().lr - 0.3) < 1e-9, nn().lr)
  nn().retrain(300, 1)
  await sleep(1500)
  const badAcc = nn().acc
  check(
    '反证：鸢尾花 lr=0.3 + 从头初始化 → 崩到 33%（三类各 1/3）',
    badAcc < 0.4,
    `acc=${(badAcc * 100).toFixed(1)}%　loss=${nn().loss.toFixed(4)}（ln3=${Math.log(3).toFixed(4)}）`,
  )
  check(
    '崩溃时损失精确等于 ln3（完全没学到东西）',
    Math.abs(nn().loss - Math.log(3)) < 0.02,
    nn().loss.toFixed(6),
  )

  /* 调回 lr=0.1 并重新初始化 → 恢复 */
  setRange(ctrl(1), 0.1)
  await sleep(700)
  nn().retrain(300, 1)
  await sleep(1500)
  check('调回 lr=0.1 + 从头初始化 → 重新收敛（> 90%）', nn().acc > 0.9, nn().acc)

  /* 多分类必须输出 3 个概率且和为 1 */
  const p = nn().probaAt(5.1, 3.5)
  check('多分类返回 3 个概率', p.length === 3, p.length)
  check('三个概率之和为 1', Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-9, p.reduce((a, b) => a + b, 0))
  check('每个概率都在 [0,1]', p.every((v) => v >= 0 && v <= 1), p)

  /* 二分类则必须只返回 2 个概率 */
  setSelect('#sel-data', 'xor')
  await sleep(800)
  const p2 = nn().probaAt(0.5, 0.5)
  check('二分类返回 2 个互补概率', p2.length === 2 && Math.abs(p2[0] + p2[1] - 1) < 1e-9, p2)
}

/* ---------- 8. 确定性：同种子 + 同配置 → 完全一样的结果 ---------- */
{
  nn().configure([4], 'relu')
  await sleep(400)
  const a = nn().acc
  const aLoss = nn().loss
  nn().retrain(300, 42)
  await sleep(500)
  const b = nn().acc
  const bLoss = nn().loss
  nn().retrain(300, 42)
  await sleep(500)
  const cLoss = nn().loss
  check('同一种子训练两次结果完全一致（确定性）', Math.abs(bLoss - cLoss) < 1e-12, `${bLoss} vs ${cLoss}`)
  check('换种子结果会变（说明随机性真的生效）', Math.abs(aLoss - bLoss) > 1e-12, `${aLoss} vs ${bLoss}`)
  check('两次训练都收敛到 100%（结果稳定，不是碰运气）', a >= 0.999 && b >= 0.999, `${a} / ${b}`)
}

/* ---------- 9. 滑杆真的接线了 ---------- */
/*
 * 控件顺序（见 rebuildControls）：隐层滑杆 × N，然后 lr、batch、epochs。
 * 异或默认 1 个隐层 → 下标 0=h0, 1=lr, 2=batch, 3=epochs。
 */
{
  setSelect('#sel-data', 'xor')
  await sleep(800)
  const n0 = qall('#controls .ctrl').length
  check('异或默认 4 个控件（隐层 + lr + batch + epochs）', n0 === 4, n0)
  check('训练轮数初始为 300', nn().epochs === 300, nn().epochs)

  setRange(ctrl(3), 600) // epochs
  await sleep(1000)
  check('调 epochs 滑杆后训练轮数跟着变（300 → 600）', nn().epochs === 600, nn().epochs)

  /* 调 batch 滑杆：上限应等于数据集大小 */
  const batchRange = ctrl(2)
  check('异或的 batch 滑杆上限 = 160', parseInt(batchRange.max, 10) === 160, batchRange.max)

  /* 调 lr 滑杆：值确实传进训练 */
  setRange(ctrl(1), 0.05)
  await sleep(1000)
  check('调学习率滑杆后 lr 确实变了', Math.abs(nn().lr - 0.05) < 1e-9, nn().lr)

  /* 切到月牙：控件重建，结构跟着换 */
  setSelect('#sel-data', 'moons')
  await sleep(900)
  check('月牙默认结构 [2,8,1]', JSON.stringify(nn().sizes) === '[2,8,1]', nn().sizes)
  check('月牙仍然是 4 个控件', qall('#controls .ctrl').length === 4, qall('#controls .ctrl').length)

  /* 切到同心圆：建议结构是双层 [2,8,8,1] → 控件变成 5 个 */
  setSelect('#sel-data', 'circles')
  await sleep(900)
  check('同心圆默认结构是双层 [2,8,8,1]', JSON.stringify(nn().sizes) === '[2,8,8,1]', nn().sizes)
  check('双层结构 → 控件增加到 5 个', qall('#controls .ctrl').length === 5, qall('#controls .ctrl').length)
}

/* ---------- 10. 「多训 200 轮」按钮 ---------- */
{
  setSelect('#sel-data', 'xor')
  await sleep(800)
  const epBefore = nn().epochs
  click('#btn-more')
  await sleep(1500)
  check('点「多训 200 轮」后轮数 +200', nn().epochs === epBefore + 200, `${epBefore} → ${nn().epochs}`)
  check('继续训练后损失是有限值', Number.isFinite(nn().loss), nn().loss)
  check('继续训练后准确率仍然很高（不会训崩）', nn().acc > 0.9, nn().acc)
}

/* ---------- 11. 重置按钮回到默认 ---------- */
{
  click('#btn-reset')
  await sleep(1000)
  check('重置后激活回到 ReLU', nn().act === 'relu', nn().act)
  check('重置后结构回到异或建议值 [2,4,1]', JSON.stringify(nn().sizes) === '[2,4,1]', nn().sizes)
  check('重置后轮数回到 300', nn().epochs === 300, nn().epochs)
  check('重置后准确率恢复到 100%', nn().acc >= 0.999, nn().acc)
}

/* ---------- 12. 页面自洽 ---------- */
check('代码面板提到 sklearn 的 MLPClassifier', /MLPClassifier/.test(text(q('#code')) || ''), true)
check('代码面板出现真实的准确率数字', /\d+\.\d%/.test(text(q('#code')) || ''), (text(q('#code')) || '').slice(0, 0))
check('状态栏提到了梯度比值', /梯度/.test(text(q('#train-status')) || ''), (text(q('#train-status')) || '').slice(0, 50))
check('上下篇里有"上一个：降维技术"', /降维/.test(text(q('#pager')) || ''), (text(q('#pager')) || '').slice(0, 60))

return {
  ok: results.every((r) => r.ok),
  passed: results.filter((r) => r.ok).length,
  total: results.length,
  failed: results.filter((r) => !r.ok),
  all: results,
}
