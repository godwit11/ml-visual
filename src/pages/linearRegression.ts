import type { EChartsOption } from 'echarts'
import {
  mountChrome,
  round,
  markVisited,
  mountPager,
  mountIntro,
  mountTerms,
  mountRecap,
  provideNyaState,
} from '../bootstrap'
import { createChart, palette, baseGrid } from '../core/chart'
import { mountSlider, type SliderHandle } from '../core/slider'
import { renderMath } from '../core/math'
import { mae, mse, r2, ols, predict, type Point, type Fit } from '../algorithms/linearRegression'
import housing from '../data/housing.json'

mountChrome()
renderMath(document)
markVisited('linear-regression')

/* ---------------- 入门引导（A 层） ----------------
 * 放在最前面，因为它决定读者要不要继续往下看。
 *
 * 文案守则（见 core/guide.ts 的注释）：
 *   - 不出现未解释的术语。「最小二乘」「OLS」在开场里一次都不出现。
 *   - 用页面真实存在的操作讲（斜率滑杆真的摆在右上角）。
 *   - 三步都指向页面上真实能做的动作，不编造交互。
 */
const introHost = document.getElementById('intro')
if (introHost) {
  mountIntro({
    host: introHost,
    lead: '你在看一套房子的广告：4 个房间，卖 25 万美元。',
    body: [
      '右边图上每个灰点，就是这样一套真实成交的房子。横着看是它的房间数，竖着看是成交价。',
      '规律是有的：**房间越多，价格越高**。但不太整齐 —— 有的 6 房间反而比 7 房间卖得贵。',
      '这一页要做的事只有一件：**找一条直线，尽量贴近所有这些点**。有了它，再看到「5 个房间」，就能估个价。',
    ],
    steps: [
      { do: '把右上角的「斜率」拖到最右边', see: '线会变得很陡' },
      { do: '再拖到最左边', see: '线变得很平，几乎水平' },
      { do: '凭手感调到你觉得最贴的位置，然后点那个蓝色按钮看答案', see: '它会算出最好的一条线' },
    ],
  })
}

const points: Point[] = housing.map((p) => ({ x: p.rm, y: p.medv }))
const best = ols(points)
const bestMse = mse(points, best)
const bestMae = mae(points, best)
const START: Fit = { w: 0, b: 22.5 }
let fit: Fit = { ...START }

const X_MIN = 3.2
const X_MAX = 9.0

function lineData(f: Fit): [number, number][] {
  return [
    [X_MIN, round(predict(X_MIN, f), 3)],
    [X_MAX, round(predict(X_MAX, f), 3)],
  ]
}

/* ---------------- 图表 ---------------- */
const chartEl = document.getElementById('chart')
if (!chartEl) throw new Error('#chart 不存在')

const buildOption = (): EChartsOption => {
  const p = palette()
  const axisStyle = {
    axisLine: { lineStyle: { color: p.axis } },
    axisLabel: { color: p.axis, fontSize: 11 },
    nameTextStyle: { color: p.sub, fontSize: 11 },
    splitLine: { lineStyle: { color: p.split } },
  }
  return {
    grid: baseGrid(),
    legend: {
      top: 0,
      right: 0,
      textStyle: { color: p.sub, fontSize: 11 },
      data: ['样本', '当前直线', 'OLS 最优'],
    },
    tooltip: {
      trigger: 'item',
      backgroundColor: p.surface,
      borderColor: p.split,
      textStyle: { color: p.text, fontSize: 12 },
    },
    xAxis: {
      type: 'value',
      name: '平均房间数 rm',
      nameLocation: 'middle',
      nameGap: 26,
      min: X_MIN,
      max: X_MAX,
      ...axisStyle,
    },
    yAxis: {
      type: 'value',
      name: '房价 medv（千美元）',
      nameLocation: 'middle',
      nameGap: 38,
      min: 0,
      max: 52,
      ...axisStyle,
    },
    series: [
      {
        name: '样本',
        type: 'scatter',
        symbolSize: 5,
        data: points.map((pt) => [pt.x, pt.y]),
        itemStyle: { color: '#6366f1', opacity: 0.42 },
      },
      {
        name: '当前直线',
        type: 'line',
        showSymbol: false,
        data: lineData(fit),
        lineStyle: { width: 2.6, color: '#0d9488' },
      },
      {
        name: 'OLS 最优',
        type: 'line',
        showSymbol: false,
        data: lineData(best),
        lineStyle: { width: 2, color: '#f59e0b', type: 'dashed' },
      },
    ],
  }
}

const chart = createChart(chartEl, buildOption)

/* ---------------- 指标 ---------------- */
const metricHost = document.getElementById('metrics')
const metricValues: Record<string, HTMLElement> = {}

function makeMetric(key: string, label: string, hint: string): void {
  if (!metricHost) return
  const box = document.createElement('div')
  box.className = 'metric'
  const l = document.createElement('div')
  l.className = 'metric-label'
  l.textContent = label
  const v = document.createElement('div')
  v.className = 'metric-value'
  v.textContent = '-'
  const h = document.createElement('div')
  h.className = 'metric-hint'
  h.textContent = hint
  box.append(l, v, h)
  metricHost.append(box)
  metricValues[key] = v
}

makeMetric('mae', 'MAE', '平均绝对误差')
makeMetric('mse', 'MSE', '均方误差')
makeMetric('r2', 'R²', '越接近 1 越好')
makeMetric('gap', '距最优', 'MSE 相对最优的差距')

/*
 * 入门引导（B 层）：把上面四个术语翻译成人话。
 *
 * 指标格本身不动（e2e 按 .metric-value 定位），解释集中放在它下面 ——
 * 指标格在右栏只有约 100px/格，塞不下解释（见 components.css 的注释）。
 *
 * 每句只回答「这是什么」，不解释「为什么」，「为什么」留给「原理」页。
 * 原来格子里的 hint（「平均绝对误差」）是术语的同义反复，等于没解释，
 * 所以这里给的是「对你的操作意味着什么」。
 */
const termsHost = document.getElementById('terms')
if (termsHost) {
  mountTerms(termsHost, [
    { name: 'MAE', say: '平均下来，你每次估错多少钱（千美元）。**越小越好**。' },
    { name: 'MSE', say: '和 MAE 一个意思，但**大错会被罚得更重** —— 所以一条错得离谱的线会被它狠狠扣分。' },
    { name: 'R²', say: '比起「闭着眼睛猜平均价」，你的线**强多少**。1 是完美，0 等于没进步。' },
    { name: '距最优', say: '离「理论上最好的那条线」还差几倍。**显示 1 倍就是已经最优**。' },
  ])
}

/* ---------------- 代码面板 ---------------- */
const codeEl = document.getElementById('code')
const KEYWORDS = ['from', 'import', 'print', 'def', 'return']

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function highlight(line: string): string {
  const i = line.indexOf('#')
  let codePart = line
  let comment = ''
  if (i >= 0) {
    codePart = line.slice(0, i)
    comment = `<span class="cm">${esc(line.slice(i))}</span>`
  }
  let out = esc(codePart)
  out = out.replace(/\b(\d+\.?\d*)\b/g, '<span class="num">$1</span>')
  KEYWORDS.forEach((kw) => {
    out = out.replace(new RegExp(`\\b${kw}\\b`, 'g'), `<span class="kw">${kw}</span>`)
  })
  return out + comment
}

function renderCode(): string {
  const lines = [
    '# ① 你现在手动调出来的参数',
    `w = ${fit.w.toFixed(2)}`,
    `b = ${fit.b.toFixed(2)}`,
    'y_pred = w * x + b                # 图里那条实线',
    '',
    '# ② 同一个模型，用 sklearn 写',
    'from sklearn.linear_model import LinearRegression',
    'from sklearn.metrics import mean_absolute_error',
    '',
    'model = LinearRegression().fit(X, y)',
    `print(model.coef_, model.intercept_)   # [${best.w.toFixed(4)}] ${best.b.toFixed(4)}`,
    `print(mean_absolute_error(y, model.predict(X)))  # ${bestMae.toFixed(4)}`,
  ]
  return lines.map(highlight).join('\n')
}

/* ---------------- 统一刷新 ---------------- */
const hintEl = document.getElementById('hint')

function refresh(): void {
  const m1 = mae(points, fit)
  const m2 = mse(points, fit)
  const score = r2(points, fit)
  const ratio = bestMse > 0 ? m2 / bestMse : 1

  if (metricValues['mae']) metricValues['mae'].textContent = m1.toFixed(3)
  if (metricValues['mse']) metricValues['mse'].textContent = m2.toFixed(2)
  if (metricValues['r2']) metricValues['r2'].textContent = score.toFixed(4)
  if (metricValues['gap']) {
    metricValues['gap'].textContent = ratio < 1.001 ? '已达最优' : `×${ratio.toFixed(2)}`
  }

  if (codeEl) codeEl.innerHTML = renderCode()

  if (hintEl) {
    if (ratio < 1.001) {
      hintEl.innerHTML =
        '<strong>你已经踩在最优解上了。</strong>OLS 给出的闭式解就是那条虚线，手动很难恰好调到这里——这正是算法的意义。'
    } else if (ratio > 1.5) {
      hintEl.innerHTML = `<strong>还差得远。</strong>当前 MSE 是最优解的 ${ratio.toFixed(
        1,
      )} 倍，试试把斜率往 ${best.w > fit.w ? '大' : '小'}调。`
    } else {
      hintEl.innerHTML = `<strong>接近了。</strong>当前 MSE 是最优解的 ${ratio.toFixed(
        2,
      )} 倍，继续微调斜率和截距，或者直接点「用 OLS 求解」看答案。`
    }
  }

  chart.update()
}

/* ---------------- 控件 ----------------
 * 滑杆用于粗调（范围已收窄到参考值的 0.75 倍，避免一拖就飞），
 * 右侧数字框可直接键入精确值，− / + 按一个 step 微调。
 */
const host = document.getElementById('controls')
const handles: SliderHandle[] = []
if (host) {
  handles.push(
    mountSlider(host, {
      label: '斜率 w',
      min: -22.5,
      max: 22.5,
      step: 0.05,
      value: START.w,
      hint: '房间数每多一间，房价变多少（千美元）；也可直接输入数值',
      format: (v) => v.toFixed(2),
      onInput: (v) => {
        fit.w = v
        refresh()
      },
    }),
  )
  handles.push(
    mountSlider(host, {
      label: '截距 b',
      min: -45,
      max: 45,
      step: 0.05,
      value: START.b,
      hint: '房间数为 0 时的预测值（数学外推，无实际含义）',
      format: (v) => v.toFixed(2),
      onInput: (v) => {
        fit.b = v
        refresh()
      },
    }),
  )
}

/* ---------------- 按钮 ---------------- */
function setFit(next: Fit): void {
  fit = { w: round(next.w, 2), b: round(next.b, 2) }
  handles[0]?.set(fit.w, true)
  handles[1]?.set(fit.b, true)
  refresh()
}

document.getElementById('btn-ols')?.addEventListener('click', () => {
  setFit({ w: round(best.w, 2), b: round(best.b, 2) })
})
document.getElementById('btn-reset')?.addEventListener('click', () => setFit(START))

/* ---------------- 上下篇 ---------------- */
mountPager('linear-regression')

/* ---------------- 入门引导（D 层） ----------------
 * 收尾三行：把刚才玩过的东西翻译成「书上叫什么 / 代码哪一行 / 现实中干嘛」。
 *
 * 为什么放在 pager 之前：
 *   读者的动线应该是「玩 → 总结 → 去下一篇」。总结排在翻页之后，
 *   就成了两个互不相干的收尾动作。
 *
 * ⚠️ 术语对齐周志华《机器学习》第 3 章：书里叫「最小二乘」，
 *   所以这里写「最小二乘」而不是「OLS」—— 让读者去看书时能对上号。
 */
const recapHost = document.getElementById('recap')
if (recapHost) {
  mountRecap(recapHost, [
    {
      label: '书上叫',
      value: '用**最小二乘**拟合一个**线性回归**模型。你手动找直线的过程，就是「参数估计」。',
    },
    {
      label: '代码里',
      value: '`LinearRegression().fit(X, y)` —— 一行，它替你算出最优的斜率和截距。',
    },
    {
      label: '用来做',
      value: '预测房价、销量、评分 —— 所有「给一个数」的问题。',
    },
  ])
}

refresh()

/* ---------------- Nya 助教的上下文（可选） ----------------
 * 把「学生此刻屏幕上的真实数字」交给面板，它会随问题一起上报。
 *
 * 为什么这件事值得做：不问的话，Nya 只能给出通用解释（「MSE 是均方误差，
 * 越小越好」），学生看完还是不知道**自己这一个数**算好还是不好。
 * 报上真实状态后，她能指着屏幕回答。
 *
 * 同时这也是防幻觉手段：这些数字进了提示词，她就没得猜 ——
 * 站点的立站原则是「页面上每个数字都要能追溯到某次真实运行」，
 * 助教说出口的数字也必须是同一套。
 *
 * ⚠️ 键名必须在服务端 `chat/nya.ts` 的 stateKeys 白名单里，
 *    不在白名单的键会被服务端丢弃（那是防提示词注入的第一道闸）。
 * ⚠️ 每次调用都重算，不许缓存 —— 报一个过期的数字比不报更糟。
 */
provideNyaState(() => {
  const m2 = mse(points, fit)
  const ratio = bestMse > 0 ? m2 / bestMse : 1
  return {
    w: fit.w.toFixed(2),
    b: fit.b.toFixed(2),
    mae: mae(points, fit).toFixed(3),
    mse: m2.toFixed(2),
    r2: r2(points, fit).toFixed(4),
    gap: ratio < 1.001 ? '1 倍（已达最优）' : `最优解的 ${ratio.toFixed(2)} 倍`,
  }
})
