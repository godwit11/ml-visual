/**
 * Logistic 回归演示页。
 *
 * 范式与线性回归 / 决策树一致：图表 + 控件 + 指标 + 代码桥 + 原理 + 思考题。
 * 这一页多两张图：**损失下降曲线**和 **S 形映射图**——前者让人看见"学习"这件事，
 * 后者把"线性分数 → 概率"这一步单独拎出来看。
 */
import type { EChartsOption } from 'echarts'
import {
  mountChrome,
  round,
  markVisited,
  mountPager,
  onThemeChange,
  provideNyaStateFromPage,
} from '../bootstrap'
import { createChart, palette, baseGrid } from '../core/chart'
import { mountSlider, type SliderHandle } from '../core/slider'
import { renderMath } from '../core/math'
import {
  sigmoid,
  logit,
  proba,
  zOf,
  logLoss,
  trainStep,
  trainUntilConverge,
  confusion,
  accuracy,
  precision,
  recall,
  type LRParams,
  type LRSample,
} from '../algorithms/logisticRegression'
import { buildLogiDatasets, type LogiDataset } from '../data/logisticDatasets'
import breast from '../data/breast.json'

mountChrome()
renderMath(document)
markVisited('logistic-regression')

/* ---------------- 数据 ---------------- */
const DATASETS: LogiDataset[] = buildLogiDatasets(breast)
let ds: LogiDataset = DATASETS[0]
let samples: LRSample[] = ds.points.map((p) => ({ x: p.x, y: p.y }))

/* ---------------- 状态 ---------------- */
let params: LRParams = { w1: 0, w2: 0, b: 0 }
let threshold = 0.5
let lr = 0.5
let epochs = 0
let losses: number[] = []
let autoTimer: number | null = null
/** 当前数据集上"训练到收敛"的参考解，画虚线用，也写进代码面板 */
let best: { params: LRParams; loss: number; epochs: number; converged: boolean } = {
  params: { w1: 0, w2: 0, b: 0 },
  loss: 0,
  epochs: 0,
  converged: false,
}

const COL_A = '#6366f1' // 类别 A（负例）
const COL_B = '#0d9488' // 类别 B（正例）
const COL_BEST = '#f59e0b' // 参考最优
const GRID_N = 36 // 概率背景的网格密度

/** 坐标范围（切换数据集后必须重算） */
let B: [number, number, number, number] = boundsOf()

function boundsOf(): [number, number, number, number] {
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  for (const p of ds.points) {
    x0 = Math.min(x0, p.x[0])
    x1 = Math.max(x1, p.x[0])
    y0 = Math.min(y0, p.x[1])
    y1 = Math.max(y1, p.x[1])
  }
  const px = (x1 - x0) * 0.08 || 0.5
  const py = (y1 - y0) * 0.08 || 0.5
  return [x0 - px, x1 + px, y0 - py, y1 + py]
}

/* ---------------- 小工具 ---------------- */
function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
const RGB_A = hexRgb(COL_A)
const RGB_B = hexRgb(COL_B)

/** 概率 → 背景色：在两类颜色之间插值，越确定越浓 */
function probColor(p: number): string {
  const r = Math.round(RGB_A[0] + (RGB_B[0] - RGB_A[0]) * p)
  const g = Math.round(RGB_A[1] + (RGB_B[1] - RGB_A[1]) * p)
  const b = Math.round(RGB_A[2] + (RGB_B[2] - RGB_A[2]) * p)
  const a = 0.06 + 0.3 * Math.abs(2 * p - 1)
  return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`
}

/**
 * 求直线 w1·x + w2·y + b = logit(threshold) 落在图框里的那一段。
 * 做法：跟四条边各求一次交点，去重后取前两个。
 */
function boundarySegment(p: LRParams, thr: number): [number, number][] {
  const c = logit(thr) - p.b
  const [x0, x1, y0, y1] = B
  const pts: [number, number][] = []
  const eps = 1e-9
  if (Math.abs(p.w2) > eps) {
    for (const x of [x0, x1]) {
      const y = (c - p.w1 * x) / p.w2
      if (y >= y0 - eps && y <= y1 + eps) pts.push([x, y])
    }
  }
  if (Math.abs(p.w1) > eps) {
    for (const y of [y0, y1]) {
      const x = (c - p.w2 * y) / p.w1
      if (x >= x0 - eps && x <= x1 + eps) pts.push([x, y])
    }
  }
  const uniq: [number, number][] = []
  for (const q of pts) {
    if (!uniq.some((u) => Math.abs(u[0] - q[0]) < 1e-7 && Math.abs(u[1] - q[1]) < 1e-7)) uniq.push(q)
  }
  return uniq.length >= 2 ? [uniq[0], uniq[1]] : []
}

/** 确定性抖动：同一个 index 每次刷新都得到同一个偏移，图才不会乱跳 */
function jitter(i: number): number {
  const t = Math.sin(i * 12.9898) * 43758.5453
  return (t - Math.floor(t) - 0.5) * 0.16
}

/* ---------------- 图 1：决策边界 ---------------- */
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

  // 概率背景网格
  const cells: number[][] = []
  const [x0, x1, y0, y1] = B
  for (let i = 0; i < GRID_N; i++) {
    for (let j = 0; j < GRID_N; j++) {
      const cx = x0 + ((x1 - x0) * (i + 0.5)) / GRID_N
      const cy = y0 + ((y1 - y0) * (j + 0.5)) / GRID_N
      cells.push([
        x0 + ((x1 - x0) * i) / GRID_N,
        x0 + ((x1 - x0) * (i + 1)) / GRID_N,
        y0 + ((y1 - y0) * j) / GRID_N,
        y0 + ((y1 - y0) * (j + 1)) / GRID_N,
        proba(params, [cx, cy]),
      ])
    }
  }

  const byClass: [number, number][][] = [[], []]
  for (const s of ds.points) byClass[s.y].push([s.x[0], s.x[1]])

  return {
    grid: baseGrid(),
    legend: {
      top: 0,
      right: 0,
      textStyle: { color: p.sub, fontSize: 11 },
      data: [ds.classNames[0], ds.classNames[1], '当前边界', '参考最优'],
    },
    tooltip: {
      trigger: 'item',
      backgroundColor: p.surface,
      borderColor: p.split,
      textStyle: { color: p.text, fontSize: 12 },
    },
    xAxis: {
      type: 'value',
      name: ds.featureNames[0],
      nameLocation: 'middle',
      nameGap: 26,
      min: round(x0, 2),
      max: round(x1, 2),
      ...axisStyle,
    },
    yAxis: {
      type: 'value',
      name: ds.featureNames[1],
      nameLocation: 'middle',
      nameGap: 38,
      min: round(y0, 2),
      max: round(y1, 2),
      ...axisStyle,
    },
    series: [
      {
        name: '概率背景',
        type: 'custom',
        silent: true,
        data: cells,
        renderItem: (_prm, api) => {
          const a = api.coord([api.value(0), api.value(2)])
          const b2 = api.coord([api.value(1), api.value(3)])
          return {
            type: 'rect',
            shape: {
              x: Math.min(a[0], b2[0]),
              y: Math.min(a[1], b2[1]),
              width: Math.abs(b2[0] - a[0]),
              height: Math.abs(b2[1] - a[1]),
            },
            style: { fill: probColor(Number(api.value(4))) },
          }
        },
        z: 1,
      },
      {
        name: ds.classNames[0],
        type: 'scatter',
        symbolSize: 7,
        data: byClass[0],
        itemStyle: { color: COL_A, opacity: 0.9, borderColor: p.surface, borderWidth: 1 },
        z: 3,
      },
      {
        name: ds.classNames[1],
        type: 'scatter',
        symbolSize: 7,
        data: byClass[1],
        itemStyle: { color: COL_B, opacity: 0.9, borderColor: p.surface, borderWidth: 1 },
        z: 3,
      },
      {
        name: '当前边界',
        type: 'line',
        showSymbol: false,
        data: boundarySegment(params, threshold),
        lineStyle: { width: 2.6, color: p.text },
        z: 4,
      },
      {
        name: '参考最优',
        type: 'line',
        showSymbol: false,
        data: boundarySegment(best.params, threshold),
        lineStyle: { width: 2, color: COL_BEST, type: 'dashed' },
        z: 4,
      },
    ],
  }
}
const chart = createChart(chartEl, buildOption)

/* ---------------- 图 2：损失曲线 ---------------- */
const lossEl = document.getElementById('chart-loss')
if (!lossEl) throw new Error('#chart-loss 不存在')
const buildLossOption = (): EChartsOption => {
  const p = palette()
  const axisStyle = {
    axisLine: { lineStyle: { color: p.axis } },
    axisLabel: { color: p.axis, fontSize: 11 },
    nameTextStyle: { color: p.sub, fontSize: 11 },
    splitLine: { lineStyle: { color: p.split } },
  }
  return {
    grid: { left: 52, right: 14, top: 14, bottom: 34, containLabel: false },
    tooltip: {
      trigger: 'axis',
      backgroundColor: p.surface,
      borderColor: p.split,
      textStyle: { color: p.text, fontSize: 12 },
    },
    xAxis: {
      type: 'value',
      name: '训练轮数',
      nameLocation: 'middle',
      nameGap: 22,
      min: 0,
      ...axisStyle,
    },
    yAxis: {
      type: 'value',
      name: '交叉熵',
      min: 0,
      ...axisStyle,
    },
    series: [
      {
        type: 'line',
        showSymbol: false,
        data: losses.map((v, i) => [i, v]),
        lineStyle: { width: 2.2, color: COL_A },
        areaStyle: { color: 'rgba(99,102,241,0.10)' },
      },
    ],
  }
}
const lossChart = createChart(lossEl, buildLossOption)

/* ---------------- 图 3：S 形映射 ---------------- */
const sigEl = document.getElementById('chart-sigmoid')
if (!sigEl) throw new Error('#chart-sigmoid 不存在')
const buildSigOption = (): EChartsOption => {
  const p = palette()
  const axisStyle = {
    axisLine: { lineStyle: { color: p.axis } },
    axisLabel: { color: p.axis, fontSize: 11 },
    nameTextStyle: { color: p.sub, fontSize: 11 },
    splitLine: { lineStyle: { color: p.split } },
  }
  const zs = samples.map((s) => zOf(params, s.x))
  const zPad = Math.max(0.6, (Math.max(...zs) - Math.min(...zs)) * 0.12)
  const z0 = Math.min(...zs) - zPad
  const z1 = Math.max(...zs) + zPad
  const curve: [number, number][] = []
  for (let i = 0; i <= 120; i++) {
    const z = z0 + ((z1 - z0) * i) / 120
    curve.push([round(z, 4), round(sigmoid(z), 5)])
  }
  const negPts: [number, number][] = []
  const posPts: [number, number][] = []
  samples.forEach((s, i) => {
    const z = zOf(params, s.x)
    const y = (s.y === 1 ? 1 : 0) + jitter(i)
    ;(s.y === 1 ? posPts : negPts).push([round(z, 4), round(y, 4)])
  })

  return {
    grid: { left: 46, right: 14, top: 14, bottom: 34, containLabel: false },
    tooltip: { trigger: 'item', backgroundColor: p.surface, borderColor: p.split, textStyle: { color: p.text, fontSize: 12 } },
    xAxis: { type: 'value', name: 'z = w·x + b', nameLocation: 'middle', nameGap: 22, min: round(z0, 2), max: round(z1, 2), ...axisStyle },
    yAxis: { type: 'value', name: '概率', min: -0.15, max: 1.15, ...axisStyle },
    series: [
      {
        name: 'sigmoid',
        type: 'line',
        showSymbol: false,
        data: curve,
        lineStyle: { width: 2.6, color: COL_B },
        z: 4,
      },
      {
        name: ds.classNames[0],
        type: 'scatter',
        symbolSize: 5,
        data: negPts,
        itemStyle: { color: COL_A, opacity: 0.55 },
        markLine: {
          silent: true,
          symbol: 'none',
          label: { fontSize: 10, color: p.sub },
          data: [
            { yAxis: threshold, lineStyle: { color: p.text, type: 'dashed', width: 1.4 }, label: { formatter: '阈值' } },
            { xAxis: round(logit(threshold), 3), lineStyle: { color: p.text, type: 'dashed', width: 1.4 } },
          ],
        },
        z: 3,
      },
      {
        name: ds.classNames[1],
        type: 'scatter',
        symbolSize: 5,
        data: posPts,
        itemStyle: { color: COL_B, opacity: 0.55 },
        z: 3,
      },
    ],
  }
}
const sigChart = createChart(sigEl, buildSigOption)

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
makeMetric('acc', '准确率', '判对的比例')
makeMetric('loss', '交叉熵', '越低越好')
makeMetric('prec', '精确率', '判为 B 的里真 B 的比例')
makeMetric('rec', '召回率', '真 B 里抓到了多少')

/* ---------------- 代码面板 ---------------- */
const codeEl = document.getElementById('code')
const KEYWORDS = ['from', 'import', 'print', 'def', 'return', 'as', 'int']
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
  const c = confusion(samples, params, threshold)
  const accNow = accuracy(samples, params, threshold)
  const lines = [
    `# ① 你现在手动调出来的参数（数据集：${ds.name}）`,
    `w1, w2, b = ${params.w1.toFixed(2)}, ${params.w2.toFixed(2)}, ${params.b.toFixed(2)}`,
    `threshold = ${threshold.toFixed(2)}`,
    '',
    'z = w1 * x1 + w2 * x2 + b',
    'p = 1 / (1 + np.exp(-z))            # 图上那片背景色',
    'y_pred = (p >= threshold).astype(int)',
    '',
    '# ② 同一个模型，用 sklearn 写',
    'from sklearn.linear_model import LogisticRegression',
    'from sklearn.metrics import accuracy_score, log_loss',
    '',
    '# 注意 X 必须是标准化后的，否则量纲差 500 倍时梯度下降走不动',
    'model = LogisticRegression(C=np.inf, solver="lbfgs")   # C=inf = 不加正则',
    'model.fit(X, y)',
    `print(model.coef_, model.intercept_)          # [[${best.params.w1.toFixed(4)} ${best.params.w2.toFixed(4)}]] [${best.params.b.toFixed(4)}]`,
    `print(accuracy_score(y, model.predict(X)))    # ${accuracy(samples, best.params, 0.5).toFixed(4)}`,
    `print(log_loss(y, model.predict_proba(X)))    # ${best.loss.toFixed(4)}`,
    '',
    `# 你手上这组参数的成绩：准确率 ${accNow.toFixed(4)}，判对 ${
      c.tp + c.tn
    } / ${samples.length}`,
  ]
  return lines.map(highlight).join('\n')
}

/* ---------------- 刷新 ---------------- */
const trainStatus = document.getElementById('train-status')

function refresh(): void {
  const c = confusion(samples, params, threshold)
  const accNow = accuracy(samples, params, threshold)
  const loss = logLoss(samples, params)

  metricValues['acc']!.textContent = `${(accNow * 100).toFixed(1)}%`
  metricValues['loss']!.textContent = loss.toFixed(4)
  metricValues['prec']!.textContent = precision(c).toFixed(3)
  metricValues['rec']!.textContent = recall(c).toFixed(3)

  if (codeEl) codeEl.innerHTML = renderCode()
  chart.update()
  lossChart.update()
  sigChart.update()
}

function setStatus(): void {
  if (!trainStatus) return
  const loss = logLoss(samples, params)
  const prev = losses.length > 1 ? losses[losses.length - 2] : null
  const delta = prev === null ? '' : `　Δ ${Math.abs(prev - loss).toExponential(1)}`
  trainStatus.innerHTML =
    `已训练 <strong>${epochs}</strong> 轮　损失 <strong>${loss.toFixed(4)}</strong>${delta}` +
    (best.converged
      ? `<br>参考最优：损失 ${best.loss.toFixed(4)}（${best.epochs} 轮收敛）`
      : `<br>参考最优：损失 ${best.loss.toFixed(4)}（跑了 ${best.epochs} 轮仍未收敛 — 这个数据集线性可分，无正则时最优解在无穷远）`)
}

function pushLoss(v: number): void {
  losses.push(v)
  // 跑太久就抽稀，免得曲线图卡死
  if (losses.length > 20000) losses = losses.filter((_, i) => i % 2 === 0)
}

/* ---------------- 训练 ---------------- */
function stepOnce(): boolean {
  const before = logLoss(samples, params)
  params = trainStep(samples, params, lr)
  pushLoss(logLoss(samples, params))
  epochs++
  const after = losses[losses.length - 1]
  return Math.abs(before - after) > 1e-10 * Math.max(1, Math.abs(before))
}

function stopAuto(): void {
  if (autoTimer !== null) {
    window.clearInterval(autoTimer)
    autoTimer = null
    const b = document.getElementById('btn-auto')
    if (b) b.textContent = '自动训练'
  }
}

function afterTrain(): void {
  syncSliders()
  refresh()
  setStatus()
}

/* ---------------- 控件 ---------------- */
const host = document.getElementById('controls')
const handles: Record<string, SliderHandle> = {}
if (host) {
  const mk = (
    key: string,
    label: string,
    min: number,
    max: number,
    step: number,
    value: number,
    hint: string,
    onChange: (v: number) => void,
  ) => {
    handles[key] = mountSlider(host, {
      label,
      min,
      max,
      step,
      value,
      hint,
      format: (v) => v.toFixed(2),
      onInput: (v) => {
        onChange(v)
        refresh()
        setStatus()
      },
    })
  }
  mk('w1', '权重 w₁', -8, 8, 0.05, params.w1, '第一个特征的权重，可手动调也可让它自己学', (v) => {
    params.w1 = v
  })
  mk('w2', '权重 w₂', -8, 8, 0.05, params.w2, '第二个特征的权重', (v) => {
    params.w2 = v
  })
  mk('b', '截距 b', -5, 5, 0.05, params.b, '整体偏移，决定边界离原点多远', (v) => {
    params.b = v
  })
  mk('thr', '判定阈值', 0.05, 0.95, 0.01, threshold, '概率超过多少就判为正例；默认 0.5', (v) => {
    threshold = v
  })
  handles['lr'] = mountSlider(host, {
    label: '学习率',
    min: 0.01,
    max: 5,
    step: 0.01,
    value: lr,
    hint: '每步沿梯度走多远。太大震荡，太小慢',
    format: (v) => v.toFixed(2),
    onInput: (v) => {
      lr = v
    },
  })
}

function syncSliders(): void {
  handles['w1']?.set(params.w1, true)
  handles['w2']?.set(params.w2, true)
  handles['b']?.set(params.b, true)
}

/* ---------------- 数据集切换 ---------------- */
const selData = document.getElementById('sel-data') as HTMLSelectElement | null
const dataDesc = document.getElementById('data-desc')

function recomputeBest(): void {
  const r = trainUntilConverge(samples, { w1: 0, w2: 0, b: 0 }, 2, 30000, 1e-12)
  best = { params: r.params, loss: logLoss(samples, r.params), epochs: r.epochs, converged: r.converged }
}

function resetAll(): void {
  stopAuto()
  params = { w1: 0, w2: 0, b: 0 }
  epochs = 0
  losses = [logLoss(samples, params)]
  syncSliders()
  refresh()
  setStatus()
}

if (selData) {
  DATASETS.forEach((d) => {
    const o = document.createElement('option')
    o.value = d.id
    o.textContent = d.name
    selData.append(o)
  })
  selData.value = ds.id
  selData.addEventListener('change', () => {
    ds = DATASETS.find((d) => d.id === selData.value) ?? DATASETS[0]
    samples = ds.points.map((p) => ({ x: p.x, y: p.y }))
    B = boundsOf()
    if (dataDesc) dataDesc.textContent = ds.desc
    recomputeBest()
    resetAll()
  })
}
if (dataDesc) dataDesc.textContent = ds.desc

/* ---------------- 按钮 ---------------- */
document.getElementById('btn-step')?.addEventListener('click', () => {
  stopAuto()
  stepOnce()
  afterTrain()
})
document.getElementById('btn-step10')?.addEventListener('click', () => {
  stopAuto()
  for (let i = 0; i < 10; i++) stepOnce()
  afterTrain()
})
document.getElementById('btn-converge')?.addEventListener('click', () => {
  stopAuto()
  const r = trainUntilConverge(samples, params, lr, 30000, 1e-12)
  params = r.params
  epochs += r.epochs
  for (let i = 1; i < r.losses.length; i++) pushLoss(r.losses[i])
  afterTrain()
})
document.getElementById('btn-auto')?.addEventListener('click', (e) => {
  const btn = e.currentTarget as HTMLButtonElement
  if (autoTimer !== null) {
    stopAuto()
    return
  }
  btn.textContent = '暂停'
  autoTimer = window.setInterval(() => {
    const moved = stepOnce()
    afterTrain()
    if (!moved || epochs > 60000) stopAuto()
  }, 100)
})
document.getElementById('btn-reset')?.addEventListener('click', resetAll)

/* 主题切换后三张图都要重画 */
onThemeChange(() => {
  chart.update()
  lossChart.update()
  sigChart.update()
})

/* ---------------- 上下篇 ---------------- */
mountPager('logistic-regression')

/* 首屏：算好参考最优再重置，避免用户对着空结果 */
recomputeBest()
resetAll()


/* ---------------- Nya 助教：让她看见这一页 ---------------- */
/*
 * 用通用读取器，不手写这一页有哪些数字。
 * 它读的是「屏幕上已经显示出来的字」——指标卡、滑杆、下拉框 ——
 * 所以拖完滑杆再问她，报的就是新值（每次调用重新读，不缓存）。
 * 键名要和 api/nya.ts 里这一页的 stateKeys 逐字一致，否则会被安静地丢掉。
 */
provideNyaStateFromPage()
