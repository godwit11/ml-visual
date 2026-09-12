import type { EChartsOption } from 'echarts'
import {
  mountChrome,
  round,
  markVisited,
  mountPager,
} from '../bootstrap'
import { createChart, palette, baseGrid } from '../core/chart'
import { mountSlider, type SliderHandle } from '../core/slider'
import { renderMath } from '../core/math'
import { mae, mse, r2, ols, predict, type Point, type Fit } from '../algorithms/linearRegression'
import housing from '../data/housing.json'

mountChrome()
renderMath(document)
markVisited('linear-regression')

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

refresh()
