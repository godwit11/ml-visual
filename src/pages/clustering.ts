/**
 * 聚类分析演示页（K-means）。
 *
 * 这一页刻意做成**可单步**的：K-means 只有两个动作（分派、更新），
 * 一次走一步才能真正看清"质心是怎么挪过去的"。
 *
 * 主图上还画了质心的移动轨迹（从起点到现在位置的连线）——
 * 这是 K-means 最直观的一张图：几个点像是被数据"吸"过去。
 */
import type { EChartsOption } from 'echarts'
import { mountChrome, round, markVisited, mountPager } from '../bootstrap'
import { createChart, palette } from '../core/chart'
import { mountSlider, type SliderHandle } from '../core/slider'
import { renderMath } from '../core/math'
import {
  runKMeans,
  kmeansppInit,
  randomInit,
  clusterSizes,
  type KMeansResult,
  type Point,
} from '../algorithms/kmeans'
import { buildClusterDatasets, purityOf, type ClusterDataset } from '../data/clusterDatasets'
import iris from '../data/iris.json'

mountChrome()
renderMath(document)
markVisited('clustering')

/* ---------------- 数据与状态 ---------------- */
const DATASETS: ClusterDataset[] = buildClusterDatasets(iris)
let ds: ClusterDataset = DATASETS[0]
let k = 4
let initType: 'kmeans++' | 'random' = 'kmeans++'
let seedOffset = 0

let result: KMeansResult = runKMeans(ds.points, kmeansppInit(ds.points, k, 1))
let stepIdx = 0

const PALETTE = ['#6366f1', '#0d9488', '#f59e0b', '#dc2626', '#8b5cf6', '#0891b2', '#65a30d', '#db2777']
const COL_CENTROID = '#111827'

/* ---------------- 训练辅助 ---------------- */
function initCentroids(): Point[] {
  const seed = 20240910 + k * 131 + seedOffset * 7919
  return initType === 'kmeans++'
    ? kmeansppInit(ds.points, k, seed)
    : randomInit(ds.points, k, seed)
}

function recompute(keepStep = false): void {
  const init = initCentroids()
  result = runKMeans(ds.points, init)
  stepIdx = keepStep ? Math.min(stepIdx, result.steps.length - 1) : result.steps.length - 1
  refresh()
}

function boundsOf(): [number, number, number, number] {
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  for (const p of ds.points) {
    x0 = Math.min(x0, p[0])
    x1 = Math.max(x1, p[0])
    y0 = Math.min(y0, p[1])
    y1 = Math.max(y1, p[1])
  }
  const px = (x1 - x0) * 0.08 || 0.5
  const py = (y1 - y0) * 0.08 || 0.5
  return [x0 - px, x1 + px, y0 - py, y1 + py]
}
let B = boundsOf()

/* ---------------- 主图 ---------------- */
const chartEl = document.getElementById('chart-cluster')
if (!chartEl) throw new Error('#chart-cluster 不存在')

const buildOption = (): EChartsOption => {
  const p = palette()
  const [x0, x1, y0, y1] = B
  const view = result.steps[stepIdx]

  const series: EChartsOption['series'] = []
  for (let c = 0; c < k; c++) {
    const pts: Point[] = []
    ds.points.forEach((pt, i) => {
      if (view.labels[i] === c) pts.push(pt)
    })
    series.push({
      name: `簇 ${c + 1}（${pts.length} 个）`,
      type: 'scatter',
      symbolSize: 7,
      data: pts,
      itemStyle: { color: PALETTE[c % PALETTE.length], opacity: 0.8 },
      z: 3,
    })
  }

  // 质心移动轨迹：每个质心把走过的位置连成一条虚线
  for (let c = 0; c < k; c++) {
    const path: Point[] = []
    for (let s = 0; s <= stepIdx; s++) {
      const cc = result.steps[s].centroids[c]
      path.push([cc[0], cc[1]])
    }
    if (path.length >= 2) {
      series.push({
        name: '质心轨迹',
        type: 'line',
        showSymbol: false,
        silent: true,
        data: path,
        lineStyle: { color: PALETTE[c % PALETTE.length], width: 1.4, type: 'dashed', opacity: 0.75 },
        z: 2,
      })
    }
  }

  series.push({
    name: '质心',
    type: 'scatter',
    symbol: 'diamond',
    symbolSize: 17,
    data: view.centroids.map((c) => [c[0], c[1]]),
    itemStyle: { color: COL_CENTROID, borderColor: p.surface, borderWidth: 2 },
    z: 6,
  })

  const axisStyle = {
    axisLine: { lineStyle: { color: p.axis } },
    axisLabel: { color: p.axis, fontSize: 11 },
    nameTextStyle: { color: p.sub, fontSize: 11 },
    splitLine: { lineStyle: { color: p.split } },
  }

  return {
    grid: { left: 48, right: 16, top: 30, bottom: 40, containLabel: false },
    legend: {
      top: 0,
      right: 0,
      type: 'scroll',
      textStyle: { color: p.sub, fontSize: 11 },
      data: Array.from({ length: k }, (_, c) => `簇 ${c + 1}`),
    },
    tooltip: {
      trigger: 'item',
      backgroundColor: p.surface,
      borderColor: p.split,
      textStyle: { color: p.text, fontSize: 12 },
      formatter: (prm: unknown) => {
        const q = prm as { data: number[]; seriesName: string }
        if (q.seriesName === '质心') return `质心 (${Number(q.data[0]).toFixed(3)}, ${Number(q.data[1]).toFixed(3)})`
        return `(${Number(q.data[0]).toFixed(3)}, ${Number(q.data[1]).toFixed(3)})`
      },
    },
    xAxis: { type: 'value', min: round(x0, 3), max: round(x1, 3), ...axisStyle },
    yAxis: { type: 'value', min: round(y0, 3), max: round(y1, 3), ...axisStyle },
    series,
  }
}
const chart = createChart(chartEl, buildOption)

/* ---------------- inertia 曲线 ---------------- */
const inertiaEl = document.getElementById('chart-inertia')
if (!inertiaEl) throw new Error('#chart-inertia 不存在')

const buildInertiaOption = (): EChartsOption => {
  const p = palette()
  const data: [number, number][] = []
  for (let s = 0; s <= stepIdx; s++) data.push([s, round(result.steps[s].inertia, 6)])
  const axisStyle = {
    axisLine: { lineStyle: { color: p.axis } },
    axisLabel: { color: p.axis, fontSize: 11 },
    nameTextStyle: { color: p.sub, fontSize: 11 },
    splitLine: { lineStyle: { color: p.split } },
  }
  return {
    grid: { left: 58, right: 16, top: 20, bottom: 40, containLabel: false },
    tooltip: {
      trigger: 'axis',
      backgroundColor: p.surface,
      borderColor: p.split,
      textStyle: { color: p.text, fontSize: 12 },
      valueFormatter: (v: unknown) => Number(v).toFixed(4),
    },
    xAxis: {
      type: 'value',
      min: 0,
      max: Math.max(1, result.steps.length - 1),
      name: '迭代轮数',
      nameLocation: 'middle',
      nameGap: 24,
      ...axisStyle,
    },
    yAxis: { type: 'value', name: 'inertia', ...axisStyle },
    series: [
      {
        type: 'line',
        showSymbol: true,
        symbolSize: 6,
        data,
        lineStyle: { width: 2.4, color: '#dc2626' },
        areaStyle: { color: 'rgba(220,38,38,0.08)' },
        // 每一次迭代都比上一次小——曲线永远向下，这是算法收敛的保证
      },
    ],
  }
}
const inertiaChart = createChart(inertiaEl, buildInertiaOption)

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
makeMetric('inertia', 'inertia', '簇内平方和，越小越紧')
makeMetric('step', '迭代进度', '分派 ↔ 更新 的轮次')
makeMetric('sizes', '各簇大小', '有没有空簇')
makeMetric('purity', '纯度', '与真实类别的吻合度（有标签时才有）')

const trainStatus = document.getElementById('train-status')
const clusterHint = document.getElementById('cluster-hint')

/* ---------------- 代码面板 ---------------- */
const codeEl = document.getElementById('code')
const KEYWORDS = ['from', 'import', 'print', 'def', 'return', 'as', 'for', 'in', 'while']
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
  const sizes = clusterSizes(result.labels, k)
  const purity = ds.trueLabels ? purityOf(result.labels, ds.trueLabels, k) : null
  const lines = [
    '# ① 这一页自己做的是这两步（数值是真跑出来的）',
    `k = ${k}`,
    `init = '${initType}'      # 换起点会得到不同的局部最优`,
    '',
    'centroids = init_centroids(X, k)',
    'while True:',
    '    labels = argmin_distances(X, centroids)   # 分派',
    '    new_centroids = [X[labels == c].mean(0) for c in range(k)]   # 更新',
    '    if np.allclose(new_centroids, centroids): break',
    '    centroids = new_centroids',
    '',
    `print(inertia)     # ${result.inertia.toFixed(4)}（跑了 ${result.iters} 轮）`,
    `print(np.bincount(labels))     # 各簇大小 ${sizes}`,
    purity !== null ? `print(purity)      # ${purity.toFixed(4)}（与真实品种的吻合度）` : '',
    '',
    '# ② sklearn 的等价写法',
    'from sklearn.cluster import KMeans',
    '',
    `clf = KMeans(n_clusters=${k}, init='k-means++', n_init=10).fit(X)`,
    'print(clf.labels_, clf.cluster_centers_, clf.inertia_)',
    '',
    '# 实践中 n_init 一定要开大一点：算法只保证局部最优，',
    '# 跑 10 次不同起点取 inertia 最小的，结果会稳得多。',
  ]
  return lines.filter((l) => l !== '').map(highlight).join('\n')
}

/* ---------------- 刷新 ---------------- */
function refresh(): void {
  const view = result.steps[stepIdx]
  const sizes = clusterSizes(view.labels, k)

  metricValues['inertia']!.textContent = view.inertia.toFixed(3)
  metricValues['step']!.textContent = `${stepIdx} / ${result.steps.length - 1}`
  metricValues['sizes']!.textContent = sizes.join(' · ')
  if (ds.trueLabels) {
    metricValues['purity']!.textContent = purityOf(view.labels, ds.trueLabels, k).toFixed(4)
  } else {
    metricValues['purity']!.textContent = '—（无标签）'
  }

  if (trainStatus) {
    trainStatus.innerHTML =
      `跑完全程需要 <strong>${result.steps.length - 1}</strong> 轮，最终 inertia <strong>${result.inertia.toFixed(
        4,
      )}</strong>。<br>` +
      `现在是第 <strong>${stepIdx}</strong> 轮：inertia = ${view.inertia.toFixed(4)}。` +
      (stepIdx < result.steps.length - 1
        ? '<br>点「走一步」继续，注意 inertia 只会往下走。'
        : '<br>已经收敛：质心不再移动。')
  }

  if (clusterHint) {
    const empty = sizes.filter((s) => s === 0).length
    clusterHint.innerHTML =
      `橙色菱形是<strong>质心</strong>，虚线是它从初始位置挪过来的<strong>轨迹</strong>。` +
      `第 ${stepIdx} 轮：${sizes.map((s, i) => `簇 ${i + 1} 有 ${s} 个点`).join('，')}。` +
      (empty > 0 ? `<br><strong>有 ${empty} 个空簇</strong>——质心被搬到了离其他质心最远的点上。` : '') +
      (ds.suited
        ? ''
        : '<br><strong>注意：这一组数据 K-means 本来就不擅长</strong>（簇不是凸的），切错了很正常。')
  }

  if (codeEl) codeEl.innerHTML = renderCode()
  chart.update()
  inertiaChart.update()
}

/* ---------------- 控件 ---------------- */
const host = document.getElementById('controls')
const handles: Record<string, SliderHandle> = {}
if (host) {
  handles['k'] = mountSlider(host, {
    label: '簇数 k',
    min: 1,
    max: 8,
    step: 1,
    value: k,
    hint: '想分成几堆。inertia 会随 k 单调下降，所以不能只看它',
    format: (v) => v.toFixed(0),
    onInput: (v) => {
      k = Math.round(v)
      recompute()
    },
  })
}

const selData = document.getElementById('sel-data') as HTMLSelectElement | null
const selInit = document.getElementById('sel-init') as HTMLSelectElement | null
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
    recompute()
  })
}

if (selInit) {
  selInit.value = initType
  selInit.addEventListener('change', () => {
    initType = selInit.value as 'kmeans++' | 'random'
    recompute()
  })
}

document.getElementById('btn-run')?.addEventListener('click', () => {
  stepIdx = result.steps.length - 1
  refresh()
})
document.getElementById('btn-step')?.addEventListener('click', () => {
  if (stepIdx < result.steps.length - 1) {
    stepIdx++
    refresh()
  }
})
document.getElementById('btn-restart')?.addEventListener('click', () => {
  seedOffset++
  recompute()
})
document.getElementById('btn-reset')?.addEventListener('click', () => {
  // 重置回第一步：能看到质心从初始位置出发的样子
  result = runKMeans(ds.points, initCentroids())
  stepIdx = 0
  refresh()
})

/* ---------------- 上下篇 ---------------- */
mountPager('clustering')

/* ---------------- 首屏 ---------------- */
if (dataDesc) dataDesc.textContent = ds.desc
// 首屏直接给"跑完"的结果（好看），想看过程就点「重置」再一步步走
stepIdx = result.steps.length - 1
refresh()
