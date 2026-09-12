/**
 * 集成学习演示页（Bagging 与 AdaBoost）。
 *
 * 这一页的看点全在**边界怎么被一笔一笔修出来**，以及 AdaBoost 里**圆点的大小**
 * （样本权重）怎么一轮轮把错分的点撑大。
 *
 * 交互上刻意保留「加一个基学习器」按钮：一次加一个，才能看清每一步在干什么，
 * 而不是滑杆一拖就出来一个成品。
 */
import type { EChartsOption } from 'echarts'
import { mountChrome, round, markVisited, mountPager } from '../bootstrap'
import { createChart, palette } from '../core/chart'
import { mountSlider, type SliderHandle } from '../core/slider'
import { renderMath } from '../core/math'
import {
  trainBagging,
  baggingPredict,
  addBoostRound,
  boostPredict,
  emptyBoostModel,
  accuracyOf,
  predictTree,
  type BaseTreeOptions,
  type BaggingModel,
  type BoostModel,
} from '../algorithms/ensemble'
import { makeMoons, makeCircles, makeXor, type Sample } from '../data/treeDatasets'

mountChrome()
renderMath(document)
markVisited('ensemble-learning')

/* ---------------- 数据集 ---------------- */
interface EnsDataset {
  id: string
  name: string
  desc: string
  classNames: [string, string]
  samples: Sample[]
}

const DATASETS: EnsDataset[] = [
  {
    id: 'moons',
    name: '月牙',
    desc: '两道交错的月牙。单个决策桩（只能横切或竖切）上限约 88%，靠集成才能把弯的边界凑出来。',
    classNames: ['上弦', '下弦'],
    samples: makeMoons(200, 0.16, 7),
  },
  {
    id: 'circles',
    name: '同心圆',
    desc: '内外两个圈。轴平行的切分需要很多刀才能围出中间的圆——正好用来看集成的边际收益。',
    classNames: ['外圈', '内圈'],
    samples: makeCircles(200, 0.09, 0.55, 11),
  },
  {
    id: 'xor',
    name: '异或',
    desc: '对角线同类。这是最"欺负"浅模型的结构：单个桩最多只能达到 60% 多。',
    classNames: ['同为小/同为大', '一小一大'],
    samples: makeXor(200, 0.28, 3),
  },
]

let ds: EnsDataset = DATASETS[0]

/* ---------------- 状态 ---------------- */
type Algo = 'bagging' | 'boosting'
let algo: Algo = 'bagging'
let nEstimators = 10
let maxDepth = 1

let bagging: BaggingModel | null = null
let boosting: BoostModel = emptyBoostModel()
/** 每个前缀长度的集成准确率，用来画曲线 */
let curve: number[] = []
let singleAccs: number[] = []
let trainMs = 0

const COL_A = '#6366f1'
const COL_B = '#0d9488'
const COL_LINE = '#f59e0b'
const GRID_N = 68

/* ---------------- 坐标范围 ---------------- */
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

const treeOpts = (): BaseTreeOptions => ({ maxDepth, minSamplesLeaf: 2 })

/* ---------------- 预测入口（两种算法统一） ---------------- */
function predict(x: number[]): number {
  if (algo === 'bagging') return bagging ? baggingPredict(bagging, x) : 0
  return boosting.rounds.length ? boostPredict(boosting, x) : 0
}

/** 只用前 k 个基学习器预测（画曲线用） */
function predictPrefix(k: number, x: number[]): number {
  if (algo === 'bagging') {
    if (!bagging || k <= 0) return 0
    const votes = [0, 0]
    for (let i = 0; i < k && i < bagging.trees.length; i++) votes[predictTree(bagging.trees[i], x)]++
    return votes[1] > votes[0] ? 1 : 0
  }
  if (!boosting.rounds.length || k <= 0) return 0
  const scores = [0, 0]
  for (let i = 0; i < k && i < boosting.rounds.length; i++) {
    scores[predictTree(boosting.rounds[i].tree, x)] += boosting.rounds[i].alpha
  }
  return scores[1] > scores[0] ? 1 : 0
}

/* ---------------- 训练 ---------------- */
function retrain(): void {
  const t0 = performance.now()
  if (algo === 'bagging') {
    bagging = trainBagging(ds.samples, 2, nEstimators, treeOpts(), 20240910)
    singleAccs = bagging.trees.map((t) => accuracyOf(ds.samples, (x) => predictTree(t, x)))
  } else {
    boosting = emptyBoostModel()
    singleAccs = []
    for (let t = 0; t < nEstimators; t++) {
      const r = addBoostRound(ds.samples, 2, boosting, treeOpts())
      if (!r.round) break
      boosting = r.model
      singleAccs.push(accuracyOf(ds.samples, (x) => predictTree(r.round!.tree, x)))
    }
  }
  // 逐前缀的集成准确率
  curve = []
  const total = algo === 'bagging' ? (bagging?.trees.length ?? 0) : boosting.rounds.length
  for (let k = 1; k <= total; k++) {
    curve.push(accuracyOf(ds.samples, (x) => predictPrefix(k, x)))
  }
  trainMs = performance.now() - t0
  refresh()
}

/* ---------------- 图 1：决策边界 ---------------- */
const boundaryEl = document.getElementById('chart-boundary')
if (!boundaryEl) throw new Error('#chart-boundary 不存在')

const buildBoundaryOption = (): EChartsOption => {
  const p = palette()
  const [x0, x1, y0, y1] = B
  const cells: number[][] = []
  const total = algo === 'bagging' ? (bagging?.trees.length ?? 0) : boosting.rounds.length
  if (total > 0) {
    for (let i = 0; i < GRID_N; i++) {
      for (let j = 0; j < GRID_N; j++) {
        const cx = x0 + ((x1 - x0) * (i + 0.5)) / GRID_N
        const cy = y0 + ((y1 - y0) * (j + 0.5)) / GRID_N
        cells.push([
          x0 + ((x1 - x0) * i) / GRID_N,
          x0 + ((x1 - x0) * (i + 1)) / GRID_N,
          y0 + ((y1 - y0) * j) / GRID_N,
          y0 + ((y1 - y0) * (j + 1)) / GRID_N,
          predict([cx, cy]),
        ])
      }
    }
  }

  /* 点的大小：AdaBoost 下画样本权重，Bagging 下统一大小 */
  const n = ds.samples.length
  const weights = algo === 'boosting' && boosting.weights.length === n ? boosting.weights : null
  const wMin = weights ? Math.min(...weights) : 0
  const wMax = weights ? Math.max(...weights) : 1
  const sizeOf = (i: number) => {
    if (!weights || wMax - wMin < 1e-12) return 7
    return 4 + 10 * ((weights[i] - wMin) / (wMax - wMin))
  }

  const byClass: [number, number, number][][] = [[], []]
  ds.samples.forEach((s, i) => {
    byClass[s.y === 1 ? 1 : 0].push([s.x[0], s.x[1], round(sizeOf(i), 2)])
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
      formatter: (prm: unknown) => {
        const q = prm as { data: number[] }
        return `(${Number(q.data[0]).toFixed(2)}, ${Number(q.data[1]).toFixed(2)})`
      },
    },
    xAxis: { type: 'value', min: round(x0, 3), max: round(x1, 3), ...axisStyle },
    yAxis: { type: 'value', min: round(y0, 3), max: round(y1, 3), ...axisStyle },
    series: [
      {
        name: '决策区域',
        type: 'custom',
        silent: true,
        data: cells,
        renderItem: (_prm, api) => {
          const a = api.coord([api.value(0), api.value(2)])
          const b = api.coord([api.value(1), api.value(3)])
          const cls = Number(api.value(4))
          return {
            type: 'rect',
            shape: {
              x: Math.min(a[0], b[0]),
              y: Math.min(a[1], b[1]),
              width: Math.abs(b[0] - a[0]),
              height: Math.abs(b[1] - a[1]),
            },
            style: {
              fill: cls === 1 ? 'rgba(13,148,136,0.28)' : 'rgba(99,102,241,0.28)',
            },
          }
        },
        z: 1,
      },
      {
        name: ds.classNames[0],
        type: 'scatter',
        data: byClass[0],
        symbolSize: (v: number[]) => Number(v[2]),
        itemStyle: { color: COL_A, borderColor: p.surface, borderWidth: 1 },
        z: 3,
      },
      {
        name: ds.classNames[1],
        type: 'scatter',
        data: byClass[1],
        symbolSize: (v: number[]) => Number(v[2]),
        itemStyle: { color: COL_B, borderColor: p.surface, borderWidth: 1 },
        z: 3,
      },
    ],
  }
}
const boundaryChart = createChart(boundaryEl, buildBoundaryOption)

/* ---------------- 图 2：准确率曲线 ---------------- */
const curveEl = document.getElementById('chart-curve')
if (!curveEl) throw new Error('#chart-curve 不存在')

const buildCurveOption = (): EChartsOption => {
  const p = palette()
  const axisStyle = {
    axisLine: { lineStyle: { color: p.axis } },
    axisLabel: { color: p.axis, fontSize: 11 },
    nameTextStyle: { color: p.sub, fontSize: 11 },
    splitLine: { lineStyle: { color: p.split } },
  }
  const baseAcc = singleAccs.length ? singleAccs.reduce((a, b) => a + b, 0) / singleAccs.length : 0
  return {
    grid: { left: 52, right: 16, top: 28, bottom: 40, containLabel: false },
    tooltip: {
      trigger: 'axis',
      backgroundColor: p.surface,
      borderColor: p.split,
      textStyle: { color: p.text, fontSize: 12 },
      valueFormatter: (v: unknown) => `${(Number(v) * 100).toFixed(2)}%`,
    },
    xAxis: {
      type: 'value',
      min: 1,
      max: Math.max(2, curve.length),
      name: '基学习器数量',
      nameLocation: 'middle',
      nameGap: 24,
      ...axisStyle,
    },
    yAxis: {
      type: 'value',
      ...axisStyle,
      name: '准确率',
      axisLabel: { color: p.axis, fontSize: 11, formatter: (v: number) => `${(v * 100).toFixed(0)}%` },
    },
    series: [
      {
        name: '集成',
        type: 'line',
        showSymbol: curve.length <= 40,
        symbolSize: 5,
        data: curve.map((v, i) => [i + 1, round(v, 6)]),
        lineStyle: { width: 2.6, color: COL_LINE },
        areaStyle: { color: 'rgba(245,158,11,0.10)' },
        z: 4,
      },
      {
        name: '单个基学习器（平均）',
        type: 'line',
        showSymbol: false,
        data: [
          [1, round(baseAcc, 6)],
          [Math.max(2, curve.length), round(baseAcc, 6)],
        ],
        lineStyle: { color: p.axis, width: 1.6, type: 'dashed' },
        z: 3,
      },
    ],
  }
}
const curveChart = createChart(curveEl, buildCurveOption)

/* ---------------- 指标卡 ---------------- */
const metricHost = document.getElementById('metrics')
const metricValues: Record<string, HTMLElement> = {}
const metricHints: Record<string, HTMLElement> = {}
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
  metricHints[key] = h
}
makeMetric('ens', '集成准确率', '当前全部基学习器一起')
makeMetric('single', '单棵树平均', '单独一个基学习器的水平')
makeMetric('gain', '提升', '集成比单棵树高多少')
makeMetric('count', '基学习器数', '')

const trainStatus = document.getElementById('train-status')
const boundaryTitle = document.getElementById('boundary-title')
const boundaryHint = document.getElementById('boundary-hint')

/* ---------------- 代码面板 ---------------- */
const codeEl = document.getElementById('code')
const KEYWORDS = ['from', 'import', 'print', 'def', 'return', 'as', 'for', 'in']
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
  const total = algo === 'bagging' ? (bagging?.trees.length ?? 0) : boosting.rounds.length
  const ensAcc = curve.length ? curve[curve.length - 1] : 0
  const baseAcc = singleAccs.length ? singleAccs.reduce((a, b) => a + b, 0) / singleAccs.length : 0
  const lines =
    algo === 'bagging'
      ? [
          '# ① 这一页自己做的是这些事（数值是真跑出来的）',
          `n_estimators = ${total}          # 基学习器个数`,
          `max_depth    = ${maxDepth}          # 每棵树的最大深度（1 = 只能切一刀）`,
          '',
          'for m in range(n_estimators):',
          '    idx = bootstrap_sample(n)      # 有放回抽 n 个样本',
          '    trees.append(DecisionTree(max_depth).fit(X[idx], y[idx]))',
          '',
          'def predict(x):                    # 投票：票多的类别胜出',
          '    votes = [sum(t.predict(x) == c for t in trees) for c in range(2)]',
          '    return argmax(votes)',
          '',
          `# 单棵树平均 ${(baseAcc * 100).toFixed(2)}% → 集成 ${(ensAcc * 100).toFixed(2)}%`,
          '',
          '# ② sklearn 的等价写法',
          'from sklearn.ensemble import BaggingClassifier',
          'from sklearn.tree import DecisionTreeClassifier',
          '',
          `clf = BaggingClassifier(DecisionTreeClassifier(max_depth=${maxDepth}),`,
          `                        n_estimators=${total}, random_state=0).fit(X, y)`,
          `print(clf.score(X, y))    # ${(ensAcc * 100).toFixed(2)}%（口径一致）`,
        ]
      : [
          '# ① 这一页自己实现的 AdaBoost（SAMME）',
          `n_estimators = ${total}          # 已经跑了多少轮`,
          `max_depth    = ${maxDepth}          # 基学习器深度（1 = 决策桩）`,
          'w = np.ones(n) / n                 # 样本权重，初始均匀',
          '',
          'for t in range(n_estimators):',
          '    h = DecisionTree(max_depth).fit(X, y, sample_weight=w)',
          '    err = np.average(h.predict(X) != y, weights=w)',
          '    alpha = np.log((1 - err) / err) + np.log(K - 1)',
          '    w = w * np.exp(alpha * (h.predict(X) != y))',
          '    w = w / w.sum()                # 归一化，进入下一轮',
          '',
          `# 单轮准确率记录：${singleAccs
            .slice(0, 6)
            .map((v) => (v * 100).toFixed(1) + '%')
            .join(' ')} …`,
          `# 集成准确率 ${(ensAcc * 100).toFixed(2)}%（单棵树平均 ${(baseAcc * 100).toFixed(2)}%）`,
          '',
          '# ② sklearn 的等价写法',
          'from sklearn.ensemble import AdaBoostClassifier',
          'from sklearn.tree import DecisionTreeClassifier',
          '',
          `clf = AdaBoostClassifier(DecisionTreeClassifier(max_depth=${maxDepth}),`,
          `                         n_estimators=${total}).fit(X, y)`,
          `print(clf.estimator_errors_)     # 每轮的加权错误率 ε`,
          `print(clf.estimator_weights_)    # 每轮的发言权 α`,
        ]
  return lines.map(highlight).join('\n')
}

/* ---------------- 刷新 ---------------- */
function refresh(): void {
  const total = algo === 'bagging' ? (bagging?.trees.length ?? 0) : boosting.rounds.length
  const ensAcc = curve.length ? curve[curve.length - 1] : 0
  const baseAcc = singleAccs.length ? singleAccs.reduce((a, b) => a + b, 0) / singleAccs.length : 0

  metricValues['ens']!.textContent = `${(ensAcc * 100).toFixed(2)}%`
  metricValues['single']!.textContent = `${(baseAcc * 100).toFixed(2)}%`
  metricValues['gain']!.textContent = `+${((ensAcc - baseAcc) * 100).toFixed(2)} pp`
  metricValues['count']!.textContent = String(total)

  // AdaBoost 的基学习器是"偏科生"：专攻前面几轮没分对的点，在整体数据上反而更差。
  // 不说清楚的话，这个数字看起来像是实现有问题。
  const sh = metricHints['single']
  if (sh) {
    sh.textContent =
      algo === 'bagging'
        ? '单独一个基学习器的水平'
        : '偏科生：专攻被放大的难点，整体数据上反而更低'
  }

  if (boundaryTitle) boundaryTitle.textContent = algo === 'bagging' ? 'Bagging（投票）' : 'AdaBoost（加权投票）'
  if (boundaryHint) {
    boundaryHint.innerHTML =
      algo === 'bagging'
        ? `底色是 <strong>${total}</strong> 棵树投票的结果。圆点大小一致——Bagging 对每个样本一视同仁，` +
          `随机性体现在<strong>每棵树看到的数据不同</strong>。`
        : `底色是 <strong>${total}</strong> 个桩按发言权 α 加权投票的结果。` +
          `<strong>圆点大小就是样本权重</strong>：被前面几轮判错的点会一轮轮变大，` +
          `下一个桩专门去照顾它们。`
  }
  if (trainStatus) {
    if (algo === 'bagging') {
      trainStatus.innerHTML =
        `训练 <strong>${total}</strong> 棵树，用时 ${trainMs.toFixed(0)} ms。<br>` +
        `每棵树各自看一份自助采样数据，互不相干，最后简单多数投票。`
    } else {
      const last = boosting.rounds[boosting.rounds.length - 1]
      trainStatus.innerHTML =
        last
          ? `跑了 <strong>${total}</strong> 轮，用时 ${trainMs.toFixed(0)} ms。<br>` +
            `最近一轮：加权错误率 ε = <strong>${last.err.toFixed(4)}</strong>，` +
            `发言权 α = <strong>${last.alpha.toFixed(4)}</strong>`
          : '还没有基学习器'
    }
  }

  if (codeEl) codeEl.innerHTML = renderCode()
  boundaryChart.update()
  curveChart.update()
}

/* ---------------- 控件 ---------------- */
const host = document.getElementById('controls')
const handles: Record<string, SliderHandle> = {}
if (host) {
  handles['n'] = mountSlider(host, {
    label: '基学习器数量',
    min: 1,
    max: 30,
    step: 1,
    value: nEstimators,
    hint: 'Bagging 要很多棵才见效；AdaBoost 常常几轮就够了',
    format: (v) => v.toFixed(0),
    onInput: (v) => {
      nEstimators = Math.round(v)
      retrain()
    },
  })
  handles['depth'] = mountSlider(host, {
    label: '基学习器深度',
    min: 1,
    max: 4,
    step: 1,
    value: maxDepth,
    hint: '1 = 决策桩（只能切一刀）。Bagging 偏爱深树，Boosting 偏爱浅树',
    format: (v) => v.toFixed(0),
    onInput: (v) => {
      maxDepth = Math.round(v)
      retrain()
    },
  })
}

const selData = document.getElementById('sel-data') as HTMLSelectElement | null
const selAlgo = document.getElementById('sel-algo') as HTMLSelectElement | null
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
    retrain()
  })
}

if (selAlgo) {
  selAlgo.value = algo
  selAlgo.addEventListener('change', () => {
    algo = selAlgo.value as Algo
    retrain()
  })
}

document.getElementById('btn-add')?.addEventListener('click', () => {
  nEstimators = Math.min(30, nEstimators + 1)
  handles['n']?.set(nEstimators, true)
  retrain()
})

document.getElementById('btn-reset')?.addEventListener('click', () => {
  nEstimators = algo === 'boosting' ? 1 : 10
  maxDepth = 1
  handles['n']?.set(nEstimators, true)
  handles['depth']?.set(maxDepth, true)
  retrain()
})

/* ---------------- 上下篇 ---------------- */
mountPager('ensemble-learning')

/* ---------------- 首屏 ---------------- */
if (dataDesc) dataDesc.textContent = ds.desc
retrain()
