/**
 * 支持向量机演示页。
 *
 * 这一页手写的是 **SMO**（Platt 的序列最小优化），所以能直接看到对偶变量 α、
 * KKT 的三档状态（0 / 自由 / 上界），以及"支持向量到底是谁"。
 *
 * 两张图分工：
 *   - 决策边界图：底色是 f(x) 的取值（间隔带内 vs 外），带圈的点是支持向量
 *   - α 图：每个样本一根柱子，稀疏性和"被放弃的点"一目了然
 *
 * 性能注意：每次重训要跑一遍 SMO（200 样本约 0.1~0.5 秒），
 * 所以拖滑杆时用 debounce 合并，避免连续拖动卡死界面。
 */
import type { EChartsOption } from 'echarts'
import {
  mountChrome,
  round,
  markVisited,
  mountPager,
  provideNyaStateFromPage,
} from '../bootstrap'
import { createChart, palette } from '../core/chart'
import { mountSlider, type SliderHandle } from '../core/slider'
import { renderMath } from '../core/math'
import {
  trainSvm,
  decisionFunction,
  marginWidth,
  svmAccuracy,
  kktResidual,
  type KernelName,
  type SvmModel,
} from '../algorithms/svm'
import { buildSvmDatasets, type SvmDataset } from '../data/svmDatasets'
import breast from '../data/breast.json'

mountChrome()
renderMath(document)
markVisited('svm')

/* ---------------- 数据与状态 ---------------- */
const DATASETS: SvmDataset[] = buildSvmDatasets(breast)
let ds: SvmDataset = DATASETS[0]

let kernel: KernelName = 'rbf'
/** 滑杆上用的是 log₁₀ 刻度：这样 0.01 到 100 才能既有分辨率又能拖到两头 */
let logC = 0
let logGamma = 0
let degree = 3
let model: SvmModel | null = null
let trainMs = 0

const C = () => 10 ** logC
const gamma = () => 10 ** logGamma

const COL_POS = '#0d9488'
const COL_NEG = '#6366f1'
const COL_BOUND = '#f59e0b'
const GRID_N = 72

/* ---------------- 网格与范围 ---------------- */
let B: [number, number, number, number] = boundsOf()

function boundsOf(): [number, number, number, number] {
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  for (const s of ds.samples) {
    x0 = Math.min(x0, s.x[0])
    x1 = Math.max(x1, s.x[0])
    y0 = Math.min(y0, s.x[1])
    y1 = Math.max(y1, s.x[1])
  }
  const px = (x1 - x0) * 0.08 || 0.5
  const py = (y1 - y0) * 0.08 || 0.5
  return [x0 - px, x1 + px, y0 - py, y1 + py]
}

/* ---------------- 图 1：决策边界 ---------------- */
const boundaryEl = document.getElementById('chart-boundary')
if (!boundaryEl) throw new Error('#chart-boundary 不存在')

/** 把 f(x) 映射成底色：|f|>1 是"确信"，|f|≤1 是间隔带内部 */
function cellColor(f: number): string {
  const inner = Math.abs(f) <= 1
  if (f > 0) return inner ? 'rgba(13,148,136,0.14)' : 'rgba(13,148,136,0.30)'
  return inner ? 'rgba(99,102,241,0.14)' : 'rgba(99,102,241,0.30)'
}

const buildBoundaryOption = (): EChartsOption => {
  const p = palette()
  const [x0, x1, y0, y1] = B
  const cells: number[][] = []
  if (model) {
    for (let i = 0; i < GRID_N; i++) {
      for (let j = 0; j < GRID_N; j++) {
        const cx = x0 + ((x1 - x0) * (i + 0.5)) / GRID_N
        const cy = y0 + ((y1 - y0) * (j + 0.5)) / GRID_N
        cells.push([
          x0 + ((x1 - x0) * i) / GRID_N,
          x0 + ((x1 - x0) * (i + 1)) / GRID_N,
          y0 + ((y1 - y0) * j) / GRID_N,
          y0 + ((y1 - y0) * (j + 1)) / GRID_N,
          decisionFunction(model, [cx, cy]),
        ])
      }
    }
  }

  const sv = new Set(model?.support ?? [])
  const normal: [number, number][][] = [[], []]
  const supportPts: [number, number][][] = [[], []]
  ds.samples.forEach((s, i) => {
    const target = sv.has(i) ? supportPts : normal
    target[s.y === 1 ? 1 : 0].push([s.x[0], s.x[1]])
  })

  const axisStyle = {
    axisLine: { lineStyle: { color: p.axis } },
    axisLabel: { color: p.axis, fontSize: 11 },
    nameTextStyle: { color: p.sub, fontSize: 11 },
    splitLine: { lineStyle: { color: p.split } },
  }

  return {
    grid: { left: 48, right: 16, top: 28, bottom: 40, containLabel: false },
    legend: { top: 0, right: 0, textStyle: { color: p.sub, fontSize: 11 } },
    tooltip: {
      trigger: 'item',
      backgroundColor: p.surface,
      borderColor: p.split,
      textStyle: { color: p.text, fontSize: 12 },
    },
    xAxis: { type: 'value', min: round(x0, 3), max: round(x1, 3), name: ds.featureNames[0], nameLocation: 'middle', nameGap: 26, ...axisStyle },
    yAxis: { type: 'value', min: round(y0, 3), max: round(y1, 3), name: ds.featureNames[1], nameLocation: 'middle', nameGap: 34, ...axisStyle },
    series: [
      {
        name: '决策函数',
        type: 'custom',
        silent: true,
        data: cells,
        renderItem: (_prm, api) => {
          const a = api.coord([api.value(0), api.value(2)])
          const b = api.coord([api.value(1), api.value(3)])
          return {
            type: 'rect',
            shape: {
              x: Math.min(a[0], b[0]),
              y: Math.min(a[1], b[1]),
              width: Math.abs(b[0] - a[0]),
              height: Math.abs(b[1] - a[1]),
            },
            style: { fill: cellColor(Number(api.value(4))) },
          }
        },
        z: 1,
      },
      {
        name: ds.classNames[0],
        type: 'scatter',
        symbolSize: 6,
        data: normal[0],
        itemStyle: { color: COL_NEG, opacity: 0.75 },
        z: 3,
      },
      {
        name: ds.classNames[1],
        type: 'scatter',
        symbolSize: 6,
        data: normal[1],
        itemStyle: { color: COL_POS, opacity: 0.75 },
        z: 3,
      },
      {
        name: '支持向量',
        type: 'scatter',
        symbolSize: 12,
        data: [...supportPts[0], ...supportPts[1]],
        itemStyle: {
          color: 'transparent',
          borderColor: COL_BOUND,
          borderWidth: 2.4,
        },
        z: 5,
      },
    ],
  }
}
const boundaryChart = createChart(boundaryEl, buildBoundaryOption)

/* ---------------- 图 2：α 分布 ---------------- */
const alphaEl = document.getElementById('chart-alpha')
if (!alphaEl) throw new Error('#chart-alpha 不存在')

const buildAlphaOption = (): EChartsOption => {
  const p = palette()
  const Cap = C()
  const data = (model?.alpha ?? []).map((a, i) => {
    const tagged = model!.support.includes(i)
    let color = 'rgba(139,144,160,0.35)' // α = 0
    if (a >= Cap - 1e-8) color = COL_BOUND // 顶到上界：被放弃的点
    else if (a > 1e-8) color = tagged ? COL_POS : COL_NEG // 自由支持向量
    return { value: round(a, 6), itemStyle: { color } }
  })
  const axisStyle = {
    axisLine: { lineStyle: { color: p.axis } },
    axisLabel: { color: p.axis, fontSize: 11 },
    nameTextStyle: { color: p.sub, fontSize: 11 },
    splitLine: { lineStyle: { color: p.split } },
  }
  return {
    grid: { left: 52, right: 16, top: 28, bottom: 40, containLabel: false },
    tooltip: {
      trigger: 'axis',
      backgroundColor: p.surface,
      borderColor: p.split,
      textStyle: { color: p.text, fontSize: 12 },
      formatter: (prms: unknown) => {
        const arr = prms as { name: string; value: number }[]
        const q = arr[0]
        return `样本 #${q.name}　α = ${Number(q.value).toFixed(5)}`
      },
    },
    title: {
      text: `C = ${Cap.toFixed(3)}　（α 触顶即为被放弃的点）`,
      left: 6,
      top: 0,
      textStyle: { color: p.sub, fontSize: 12, fontWeight: 'normal' },
    },
    xAxis: { type: 'category', data: (model?.alpha ?? []).map((_, i) => String(i)), ...axisStyle },
    yAxis: { type: 'value', min: 0, max: Math.max(Cap, 1e-6) * 1.05, name: 'α', ...axisStyle },
    series: [
      {
        type: 'bar',
        data,
        barMaxWidth: 6,
        markLine: {
          silent: true,
          symbol: 'none',
          data: [{ yAxis: round(Cap, 8) }],
          lineStyle: { color: COL_BOUND, width: 1.6, type: 'dashed' },
          label: { formatter: 'C', color: p.sub, fontSize: 11 },
        },
      },
    ],
  }
}
const alphaChart = createChart(alphaEl, buildAlphaOption)

/* ---------------- 指标卡 ---------------- */
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
makeMetric('sv', '支持向量', 'α > 0 的样本个数')
makeMetric('svsplit', '自由 / 上界', '自由 = 压在间隔上，上界 = 已放弃')
makeMetric('margin', '间隔宽度', '2/‖w‖，仅线性核可算')
makeMetric('acc', '训练准确率', '在这批数据上的表现')

const trainStatus = document.getElementById('train-status')

/* ---------------- 代码面板 ---------------- */
const codeEl = document.getElementById('code')
const KEYWORDS = ['from', 'import', 'print', 'def', 'return', 'as']
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
  const m = model
  const ps = m ? m.opts : null
  const kw: string[] = [`C=${(ps?.C ?? C()).toFixed(3)}`, `kernel='${ps?.kernel ?? kernel}'`]
  if (kernel !== 'linear') kw.push(`gamma=${(ps?.gamma ?? gamma()).toFixed(4)}`)
  if (kernel === 'poly') kw.push(`degree=${ps?.degree ?? degree}`)
  const lines = [
    '# ① 现在这组配置（数值是这一页真跑出来的）',
    'from sklearn.svm import SVC',
    '',
    `model = SVC(${kw.join(', ')}, tol=1e-4)`,
    'model.fit(X, y)',
    `print(model.n_support_)        # 支持向量：${m ? m.support.length : '-'} 个（自由 ${m?.nFree ?? '-'} / 上界 ${m?.nBound ?? '-'}）`,
    `print(model.score(X, y))       # 训练准确率 ${m ? svmAccuracy(m, ds.samples).toFixed(4) : '-'}`,
    m?.w ? `print(model.coef_)             # w = ${m.w.map((v) => v.toFixed(4)).join(', ')}` : '# 非线性核没有原始空间的 w，只有对偶系数',
    m?.w ? `print(2 / np.linalg.norm(model.coef_))   # 间隔宽度 ${marginWidth(m)!.toFixed(6)}` : '',
    '',
    '# ② 它内部真正在解的对偶问题',
    '#    max  Σαᵢ − ½ΣΣ αᵢαⱼ yᵢyⱼ K(xᵢ,xⱼ)',
    `#    s.t. 0 ≤ αᵢ ≤ C，Σαᵢyᵢ = 0        # C = ${C().toFixed(3)}`,
    m ? `print(model.dual_coef_)        # αᵢyᵢ，本页自己用 SMO 解出来的对偶目标是 ${m.dualObjective.toFixed(6)}` : '',
    `# 求解用了 ${m?.nIter ?? '-'} 次 α 更新，KKT 残差 ${m ? kktResidual(m, ds.samples).toExponential(2) : '-'}`,
  ]
  return lines.filter((l) => l !== '').map(highlight).join('\n')
}

/* ---------------- 训练与刷新 ---------------- */
function refresh(): void {
  if (trainStatus && model) {
    const m = model
    trainStatus.innerHTML =
      `数据集 <strong>${ds.name}</strong>　核 <strong>${kernel}</strong>　` +
      `C = <strong>${C().toFixed(3)}</strong>` +
      (kernel === 'linear' ? '' : `　γ = <strong>${gamma().toFixed(4)}</strong>`) +
      (kernel === 'poly' ? `　degree = <strong>${degree}</strong>` : '') +
      `<br>对偶目标 <strong>${m.dualObjective.toFixed(4)}</strong>　` +
      `迭代 <strong>${m.nIter}</strong> 次　KKT 残差 <strong>${kktResidual(m, ds.samples).toExponential(2)}</strong>` +
      `　耗时 <strong>${trainMs.toFixed(0)} ms</strong>` +
      (m.converged ? '　✅ 已收敛' : '　⚠️ 达到迭代上限')
  }
  metricValues['sv']!.textContent = model ? String(model.support.length) : '-'
  metricValues['svsplit']!.textContent = model ? `${model.nFree} / ${model.nBound}` : '-'
  const mw = model ? marginWidth(model) : null
  metricValues['margin']!.textContent = mw === null ? '—（非线性核）' : mw.toFixed(4)
  metricValues['acc']!.textContent = model ? `${(svmAccuracy(model, ds.samples) * 100).toFixed(1)}%` : '-'

  if (codeEl) codeEl.innerHTML = renderCode()
  boundaryChart.update()
  alphaChart.update()
}

let training = false
function train(): void {
  if (training) return
  training = true
  const t0 = performance.now()
  model = trainSvm(ds.samples, {
    C: C(),
    kernel,
    gamma: gamma(),
    degree,
    coef0: 0,
    tol: 1e-4,
  })
  trainMs = performance.now() - t0
  training = false
  refresh()
}

let timer: number | null = null
function scheduleTrain(): void {
  if (timer !== null) window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    timer = null
    train()
  }, 220)
}

/* ---------------- 控件 ---------------- */
const host = document.getElementById('controls')
const handles: Record<string, SliderHandle> = {}
if (host) {
  handles['c'] = mountSlider(host, {
    label: 'log₁₀ C（惩罚强度）',
    min: -2,
    max: 2,
    step: 0.05,
    value: logC,
    hint: '当前 C = 10^v。C 大 = 不容忍错分（间隔窄），C 小 = 宽容（间隔宽）',
    format: (v) => v.toFixed(2),
    onInput: (v) => {
      logC = v
      scheduleTrain()
    },
  })
  handles['gamma'] = mountSlider(host, {
    label: 'log₁₀ γ（RBF 视野）',
    min: -2,
    max: 1,
    step: 0.05,
    value: logGamma,
    hint: '当前 γ = 10^v。γ 小 = 视野太广、边界被拉平（欠拟合），γ 大 = 只看眼前、边界跟着单个样本走',
    format: (v) => v.toFixed(2),
    onInput: (v) => {
      logGamma = v
      scheduleTrain()
    },
  })
  handles['degree'] = mountSlider(host, {
    label: '多项式次数 d',
    min: 1,
    max: 5,
    step: 1,
    value: degree,
    hint: '仅多项式核有效：d 阶交叉项',
    format: (v) => v.toFixed(0),
    onInput: (v) => {
      degree = Math.round(v)
      scheduleTrain()
    },
  })
}

/** γ 只在 RBF / 多项式核下有意义，d 只在多项式核下有意义 */
function syncControlVisibility(): void {
  const showGamma = kernel !== 'linear'
  const showDegree = kernel === 'poly'
  if (handles['gamma']) handles['gamma'].el.style.display = showGamma ? '' : 'none'
  if (handles['degree']) handles['degree'].el.style.display = showDegree ? '' : 'none'
}

/* ---------------- 数据集 / 核函数 ---------------- */
const selData = document.getElementById('sel-data') as HTMLSelectElement | null
const selKernel = document.getElementById('sel-kernel') as HTMLSelectElement | null
const dataDesc = document.getElementById('data-desc')

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
    B = boundsOf()
    if (dataDesc) dataDesc.textContent = ds.desc
    train()
  })
}

if (selKernel) {
  selKernel.value = kernel
  selKernel.addEventListener('change', () => {
    kernel = selKernel.value as KernelName
    syncControlVisibility()
    train()
  })
}

/* ---------------- 上下篇 ---------------- */
mountPager('svm')

/* ---------------- 首屏：默认用 RBF 核，先给个好看的 ---------------- */
if (dataDesc) dataDesc.textContent = ds.desc
syncControlVisibility()
train()


/* ---------------- Nya 助教：让她看见这一页 ---------------- */
/*
 * 用通用读取器，不手写这一页有哪些数字。
 * 它读的是「屏幕上已经显示出来的字」——指标卡、滑杆、下拉框 ——
 * 所以拖完滑杆再问她，报的就是新值（每次调用重新读，不缓存）。
 * 键名要和 api/nya.ts 里这一页的 stateKeys 逐字一致，否则会被安静地丢掉。
 */
provideNyaStateFromPage()
