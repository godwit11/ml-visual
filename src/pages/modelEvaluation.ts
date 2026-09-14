/**
 * 模型评估演示页。
 *
 * 范式与前几页一致（图 + 控件 + 指标 + 代码桥 + 原理 + 思考题），
 * 这一页的特点是**同一份分数、换一个场景结论就全变**，所以数据集切换是主角。
 *
 * 三张图分工：
 *   - 分数分布：把"阈值切在哪儿"这件事画出来，两个类别重叠处就是模型的死穴
 *   - ROC / PR：把"所有阈值"一起看，AUC 是模型的排序能力，与阈值无关
 *   - 交叉验证：换一个数据集维度，看"一次划分的成绩有多不可靠"
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
  confusionAt,
  metricsFrom,
  rocCurve,
  prCurve,
  kFoldIndices,
  crossValidate,
  type RocCurve,
  type PrCurve,
} from '../algorithms/evaluation'
import {
  buildEvalDatasets,
  buildCvDatasets,
  synthScores,
  normalCdf,
  type EvalDataset,
  type CvDataset,
} from '../data/evalDatasets'
import { buildTree, predictOne } from '../algorithms/decisionTree'

mountChrome()
renderMath(document)
markVisited('model-evaluation')

/* ---------------- 数据集 ---------------- */
const DATASETS = buildEvalDatasets()
const CV_DATASETS = buildCvDatasets()

let ds: EvalDataset = DATASETS[0]
let scores: number[] = []
let labels: number[] = []
let roc: RocCurve = { fpr: [0, 1], tpr: [0, 1], thresholds: [Infinity], auc: 0.5 }
let pr: PrCurve = { precision: [1, 1], recall: [0, 0], thresholds: [], auc: 0 }

/* ---------------- 状态 ---------------- */
let threshold = 0.5
// 合成数据集的三个旋钮
let synthN = 600
let synthPrev = 0.3
let synthSep = 1.5
// 交叉验证
let cvDs: CvDataset = CV_DATASETS[0]
let kFolds = 5
let stratify = true

const COL_NEG = '#6366f1'
const COL_POS = '#0d9488'
const COL_ACC = '#f59e0b'
const BINS = 30

/* ---------------- 工具 ---------------- */
function loadDataset(d: EvalDataset): void {
  ds = d
  scores = d.points.map((p) => p.score)
  labels = d.points.map((p) => p.label)
  roc = rocCurve(scores, labels)
  pr = prCurve(scores, labels)
}

function rebuildSynth(): void {
  ds = {
    ...ds,
    points: synthScores(synthN, synthPrev, synthSep),
    theoryAuc: normalCdf(synthSep / Math.SQRT2),
  }
  const idx = DATASETS.findIndex((d) => d.id === 'synth')
  if (idx >= 0) DATASETS[idx] = ds
  scores = ds.points.map((p) => p.score)
  labels = ds.points.map((p) => p.label)
  roc = rocCurve(scores, labels)
  pr = prCurve(scores, labels)
}

/** 点所在桶的计数，用来画直方图 */
function histCounts(): { neg: number[]; pos: number[]; max: number } {
  const neg = new Array(BINS).fill(0)
  const pos = new Array(BINS).fill(0)
  for (let i = 0; i < scores.length; i++) {
    const b = Math.min(BINS - 1, Math.max(0, Math.floor(scores[i] * BINS)))
    if (labels[i] === 1) pos[b]++
    else neg[b]++
  }
  return { neg, pos, max: Math.max(1, ...neg, ...pos) }
}

/* ---------------- 图 1：分数分布 ---------------- */
const distEl = document.getElementById('chart-dist')
if (!distEl) throw new Error('#chart-dist 不存在')

const buildDistOption = (): EChartsOption => {
  const p = palette()
  const { neg, pos, max } = histCounts()
  const cells: number[][] = []
  for (let b = 0; b < BINS; b++) {
    const x0 = b / BINS
    const x1 = (b + 1) / BINS
    cells.push([x0, x1, neg[b], 0])
    cells.push([x0, x1, pos[b], 1])
  }
  const axisStyle = {
    axisLine: { lineStyle: { color: p.axis } },
    axisLabel: { color: p.axis, fontSize: 11 },
    nameTextStyle: { color: p.sub, fontSize: 11 },
    splitLine: { lineStyle: { color: p.split } },
  }
  return {
    grid: { left: 48, right: 16, top: 30, bottom: 40, containLabel: false },
    legend: { top: 0, right: 0, textStyle: { color: p.sub, fontSize: 11 } },
    tooltip: {
      trigger: 'item',
      backgroundColor: p.surface,
      borderColor: p.split,
      textStyle: { color: p.text, fontSize: 12 },
    },
    xAxis: { type: 'value', min: 0, max: 1, name: '模型分数', nameLocation: 'middle', nameGap: 24, ...axisStyle },
    yAxis: { type: 'value', min: 0, max: Math.ceil(max * 1.08), name: '样本数', ...axisStyle },
    series: [
      {
        name: '分数分布',
        type: 'custom',
        silent: true,
        data: cells,
        renderItem: (_prm, api) => {
          const cat = Number(api.value(3))
          const a = api.coord([api.value(0), 0])
          const b2 = api.coord([api.value(1), api.value(2)])
          return {
            type: 'rect',
            shape: {
              x: a[0] + 0.5,
              y: b2[1],
              width: Math.max(1, b2[0] - a[0] - 1),
              height: a[1] - b2[1],
            },
            style: {
              fill: cat === 1 ? COL_POS : COL_NEG,
              opacity: 0.72,
            },
          }
        },
        z: 2,
      },
      {
        // 负例 / 正例各放一个空系列，只为图例能显示
        name: ds.negativeName,
        type: 'line',
        data: [],
        itemStyle: { color: COL_NEG },
        lineStyle: { color: COL_NEG, width: 2 },
      },
      {
        name: ds.positiveName,
        type: 'line',
        data: [],
        itemStyle: { color: COL_POS },
        lineStyle: { color: COL_POS, width: 2 },
      },
      {
        name: '当前阈值',
        type: 'line',
        showSymbol: false,
        silent: true,
        data: [
          [threshold, 0],
          [threshold, Math.ceil(max * 1.08)],
        ],
        lineStyle: { color: p.text, width: 2, type: 'dashed' },
        markArea: {
          silent: true,
          itemStyle: { color: 'rgba(13,148,136,0.05)' },
          data: [[{ xAxis: threshold }, { xAxis: 1 }]],
        },
        z: 5,
      },
    ],
  }
}
const distChart = createChart(distEl, buildDistOption)

/* ---------------- 图 2 / 3：ROC 与 PR ---------------- */
const rocEl = document.getElementById('chart-roc')
const prEl = document.getElementById('chart-pr')
if (!rocEl || !prEl) throw new Error('#chart-roc / #chart-pr 不存在')

function pointAt(): { fpr: number; tpr: number; prec: number; rec: number } {
  const c = confusionAt(scores, labels, threshold)
  const m = metricsFrom(c)
  return { fpr: m.fpr, tpr: m.recall, prec: m.precision, rec: m.recall }
}

const buildRocOption = (): EChartsOption => {
  const p = palette()
  const cur = pointAt()
  const axisStyle = {
    axisLine: { lineStyle: { color: p.axis } },
    axisLabel: { color: p.axis, fontSize: 11 },
    nameTextStyle: { color: p.sub, fontSize: 11 },
    splitLine: { lineStyle: { color: p.split } },
  }
  return {
    grid: { left: 48, right: 14, top: 26, bottom: 40, containLabel: false },
    tooltip: {
      trigger: 'item',
      backgroundColor: p.surface,
      borderColor: p.split,
      textStyle: { color: p.text, fontSize: 12 },
      formatter: (prm: unknown) => {
        const q = prm as { data: number[] }
        return `FPR ${Number(q.data[0]).toFixed(3)}<br/>TPR ${Number(q.data[1]).toFixed(3)}`
      },
    },
    title: {
      text: `AUC = ${roc.auc.toFixed(4)}`,
      left: 6,
      top: 0,
      textStyle: { color: p.sub, fontSize: 12, fontWeight: 'normal' },
    },
    xAxis: { type: 'value', min: 0, max: 1, name: '假正率', nameLocation: 'middle', nameGap: 24, ...axisStyle },
    yAxis: { type: 'value', min: 0, max: 1, name: '召回率', ...axisStyle },
    series: [
      {
        name: '瞎猜',
        type: 'line',
        showSymbol: false,
        silent: true,
        data: [
          [0, 0],
          [1, 1],
        ],
        lineStyle: { color: p.axis, width: 1.2, type: 'dashed' },
        z: 2,
      },
      {
        name: 'ROC',
        type: 'line',
        showSymbol: false,
        data: roc.fpr.map((f, i) => [round(f, 6), round(roc.tpr[i], 6)]),
        lineStyle: { color: COL_POS, width: 2.4 },
        areaStyle: { color: 'rgba(13,148,136,0.12)' },
        z: 3,
      },
      {
        name: '当前阈值',
        type: 'scatter',
        symbolSize: 11,
        data: [[round(cur.fpr, 6), round(cur.tpr, 6)]],
        itemStyle: { color: COL_ACC, borderColor: p.surface, borderWidth: 2 },
        z: 5,
      },
    ],
  }
}

const buildPrOption = (): EChartsOption => {
  const p = palette()
  const cur = pointAt()
  const prevalence = labels.reduce((a, b) => a + b, 0) / (labels.length || 1)
  const axisStyle = {
    axisLine: { lineStyle: { color: p.axis } },
    axisLabel: { color: p.axis, fontSize: 11 },
    nameTextStyle: { color: p.sub, fontSize: 11 },
    splitLine: { lineStyle: { color: p.split } },
  }
  return {
    grid: { left: 48, right: 14, top: 26, bottom: 40, containLabel: false },
    tooltip: {
      trigger: 'item',
      backgroundColor: p.surface,
      borderColor: p.split,
      textStyle: { color: p.text, fontSize: 12 },
      formatter: (prm: unknown) => {
        const q = prm as { data: number[] }
        return `召回 ${Number(q.data[0]).toFixed(3)}<br/>精确 ${Number(q.data[1]).toFixed(3)}`
      },
    },
    title: {
      text: `PR-AUC = ${pr.auc.toFixed(4)}`,
      left: 6,
      top: 0,
      textStyle: { color: p.sub, fontSize: 12, fontWeight: 'normal' },
    },
    xAxis: { type: 'value', min: 0, max: 1, name: '召回率', nameLocation: 'middle', nameGap: 24, ...axisStyle },
    yAxis: { type: 'value', min: 0, max: 1, name: '精确率', ...axisStyle },
    series: [
      {
        name: '整体正例占比',
        type: 'line',
        showSymbol: false,
        silent: true,
        data: [
          [0, round(prevalence, 6)],
          [1, round(prevalence, 6)],
        ],
        lineStyle: { color: COL_ACC, width: 1.4, type: 'dashed' },
        z: 2,
      },
      {
        name: 'PR',
        type: 'line',
        showSymbol: false,
        data: pr.recall.map((r, i) => [round(r, 6), round(pr.precision[i], 6)]),
        lineStyle: { color: COL_NEG, width: 2.4 },
        z: 3,
      },
      {
        name: '当前阈值',
        type: 'scatter',
        symbolSize: 11,
        data: [[round(cur.rec, 6), round(cur.prec, 6)]],
        itemStyle: { color: COL_ACC, borderColor: p.surface, borderWidth: 2 },
        z: 5,
      },
    ],
  }
}
const rocChart = createChart(rocEl, buildRocOption)
const prChart = createChart(prEl, buildPrOption)

/* ---------------- 混淆矩阵 ---------------- */
const matrixEl = document.getElementById('matrix')
const matrixNote = document.getElementById('matrix-note')

function renderMatrix(): void {
  if (!matrixEl) return
  const c = confusionAt(scores, labels, threshold)
  const m = metricsFrom(c)
  const total = scores.length
  matrixEl.innerHTML = `
    <div></div>
    <div class="mx-head">预测为「${ds.positiveName}」</div>
    <div class="mx-head">预测为「${ds.negativeName}」</div>
    <div class="mx-head mx-rowhead">实际「${ds.positiveName}」</div>
    <div class="mx-cell mx-ok"><span class="mx-tag">TP</span><span class="mx-num">${c.tp}</span><span class="mx-sub">判对</span></div>
    <div class="mx-cell mx-bad"><span class="mx-tag">FN</span><span class="mx-num">${c.fn}</span><span class="mx-sub">漏报</span></div>
    <div class="mx-head mx-rowhead">实际「${ds.negativeName}」</div>
    <div class="mx-cell mx-bad"><span class="mx-tag">FP</span><span class="mx-num">${c.fp}</span><span class="mx-sub">误报</span></div>
    <div class="mx-cell mx-ok"><span class="mx-tag">TN</span><span class="mx-num">${c.tn}</span><span class="mx-sub">判对</span></div>
  `
  if (matrixNote) {
    const wrong = c.fp + c.fn
    matrixNote.innerHTML =
      `共 <strong>${total}</strong> 个样本，判对 <strong>${c.tp + c.tn}</strong> 个（准确率 ${(
        m.accuracy * 100
      ).toFixed(1)}%），判错 <strong>${wrong}</strong> 个。<br><br>` +
      `<span style="color:var(--text-3)">漏报 ${c.fn} 个（真正例被放过）与误报 ${c.fp} 个（负例被叫去复查）` +
      `——准确率把这两件事当成同一件事，可现实里它们的代价常常差几十倍。</span>`
  }
}

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
makeMetric('acc', '准确率', '判对的比例')
makeMetric('prec', '精确率', '判为正的里有多少是真')
makeMetric('rec', '召回率', '真正的里抓到了多少')
makeMetric('f1', 'F1', '精确与召回的调和平均')
makeMetric('auc', 'ROC-AUC', '排序能力，与阈值无关')
makeMetric('prauc', 'PR-AUC', '类别不平衡时更该看它')
makeMetric('prev', '正例占比', '整个数据集里正例的比例')

function refreshMetrics(): void {
  const m = metricsFrom(confusionAt(scores, labels, threshold))
  metricValues['acc']!.textContent = `${(m.accuracy * 100).toFixed(1)}%`
  metricValues['prec']!.textContent = m.precision.toFixed(3)
  metricValues['rec']!.textContent = m.recall.toFixed(3)
  metricValues['f1']!.textContent = m.f1.toFixed(3)
  metricValues['auc']!.textContent = roc.auc.toFixed(4)
  metricValues['prauc']!.textContent = pr.auc.toFixed(4)
  metricValues['prev']!.textContent = `${(m.prevalence * 100).toFixed(1)}%`
}

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
  const c = confusionAt(scores, labels, threshold)
  const m = metricsFrom(c)
  const cvInfo = lastCv
  const lines = [
    `# ① 你手上这个阈值（数据集：${ds.name}）`,
    `threshold = ${threshold.toFixed(2)}`,
    `y_pred = (y_score >= threshold).astype(int)     # 分数 ≥ 阈值就判为正例`,
    `# TP=${c.tp}  FP=${c.fp}  FN=${c.fn}  TN=${c.tn}`,
    `# 准确率 ${m.accuracy.toFixed(4)}  精确率 ${m.precision.toFixed(4)}  召回率 ${m.recall.toFixed(4)}  F1 ${m.f1.toFixed(4)}`,
    '',
    '# ② 换个阈值，指标全变，但 AUC 一动不动',
    'from sklearn.metrics import (confusion_matrix, classification_report,',
    '                             roc_curve, roc_auc_score, precision_recall_curve)',
    '',
    'print(confusion_matrix(y_true, y_pred))',
    'print(classification_report(y_true, y_pred, digits=4))',
    '',
    '# roc_curve 不需要你给阈值：它把所有阈值都走了一遍',
    'fpr, tpr, _ = roc_curve(y_true, y_score)',
    `print("AUC =", roc_auc_score(y_true, y_score))    # ${roc.auc.toFixed(4)}`,
    'prec, rec, _ = precision_recall_curve(y_true, y_score)',
    '',
    '# ③ 一次划分的成绩不算数，要看 K 折',
    'from sklearn.model_selection import cross_val_score, StratifiedKFold',
    '',
    `cv = StratifiedKFold(n_splits=${kFolds}, shuffle=True, random_state=0)   # 分层，保持类别比例`,
    "scores = cross_val_score(clf, X, y, cv=cv, scoring='accuracy')",
    cvInfo
      ? `print(scores.mean(), scores.std())    # ${cvInfo.mean.toFixed(4)} ± ${cvInfo.std.toFixed(4)}`
      : 'print(scores.mean(), scores.std())',
    '# 标准差比均值更能说明问题：成绩稳不稳，它说了算',
  ]
  return lines.map(highlight).join('\n')
}

/* ---------------- 交叉验证 ---------------- */
let lastCv: { mean: number; std: number; scores: number[] } | null = null

const cvChartEl = document.getElementById('chart-cv')
const cvMetricHost = document.getElementById('cv-metrics')
const cvStatus = document.getElementById('cv-status')
const foldListEl = document.getElementById('fold-list')

const buildCvOption = (): EChartsOption => {
  const p = palette()
  const axisStyle = {
    axisLine: { lineStyle: { color: p.axis } },
    axisLabel: { color: p.axis, fontSize: 11 },
    nameTextStyle: { color: p.sub, fontSize: 11 },
    splitLine: { lineStyle: { color: p.split } },
  }
  const data = lastCv?.scores ?? []
  const mean = lastCv?.mean ?? 0
  return {
    grid: { left: 52, right: 16, top: 30, bottom: 40, containLabel: false },
    tooltip: {
      trigger: 'axis',
      backgroundColor: p.surface,
      borderColor: p.split,
      textStyle: { color: p.text, fontSize: 12 },
      formatter: (prms: unknown) => {
        const arr = prms as { name: string; value: number }[]
        const q = arr[0]
        return `${q.name}：准确率 ${(Number(q.value) * 100).toFixed(2)}%`
      },
    },
    title: {
      text: lastCv ? `均值 ${(mean * 100).toFixed(2)}%　标准差 ${(lastCv.std * 100).toFixed(2)}%` : '',
      left: 6,
      top: 0,
      textStyle: { color: p.sub, fontSize: 12, fontWeight: 'normal' },
    },
    xAxis: {
      type: 'category',
      data: data.map((_, i) => `第 ${i + 1} 折`),
      name: '验证集',
      nameLocation: 'middle',
      nameGap: 24,
      ...axisStyle,
    },
    yAxis: {
      type: 'value',
      ...axisStyle,
      min: (v: { min: number }) => Math.max(0, Math.floor(v.min * 20) / 20 - 0.05),
      max: (v: { max: number }) => Math.min(1, Math.ceil(v.max * 20) / 20 + 0.05),
      name: '准确率',
      axisLabel: { color: p.axis, fontSize: 11, formatter: (v: number) => `${(v * 100).toFixed(0)}%` },
    },
    series: [
      {
        type: 'bar',
        data: data.map((v, i) => ({
          value: round(v, 6),
          itemStyle: { color: i === (lastCv?.scores.length ?? 0) - 1 ? COL_NEG : COL_POS, opacity: 0.85 },
        })),
        barMaxWidth: 44,
        markLine: {
          silent: true,
          symbol: 'none',
          data: [{ yAxis: round(mean, 6) }],
          lineStyle: { color: COL_ACC, width: 2, type: 'dashed' },
          label: { formatter: '均值', color: p.sub, fontSize: 11 },
        },
      },
    ],
  }
}
const cvChart = cvChartEl ? createChart(cvChartEl, buildCvOption) : null

const treeOpts = { criterion: 'gini' as const, maxDepth: 3, minSamplesSplit: 2 }

function runCv(): void {
  const folds = kFoldIndices(cvDs.X.length, { k: kFolds, stratify, labels: cvDs.y })
  const r = crossValidate(folds, cvDs.y, (trainIdx, testIdx) => {
    const train = trainIdx.map((i) => ({ x: cvDs.X[i] as number[], y: cvDs.y[i] }))
    const tree = buildTree(train, 2, treeOpts)
    let ok = 0
    for (const i of testIdx) if (predictOne(tree, cvDs.X[i] as number[]) === cvDs.y[i]) ok++
    return ok / testIdx.length
  })
  lastCv = r

  if (cvMetricHost) {
    const mk = (label: string, value: string, hint: string) => {
      const box = document.createElement('div')
      box.className = 'metric'
      box.innerHTML = `<div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-hint">${hint}</div>`
      return box
    }
    const best = Math.max(...r.scores)
    const worst = Math.min(...r.scores)
    cvMetricHost.innerHTML = ''
    cvMetricHost.append(
      mk('平均准确率', `${(r.mean * 100).toFixed(2)}%`, `${kFolds} 折的平均`),
      mk('标准差', `${(r.std * 100).toFixed(2)}%`, '成绩稳不稳，看这个'),
      mk('最好 / 最差', `${(best * 100).toFixed(1)}% / ${(worst * 100).toFixed(1)}%`, `极差 ${((best - worst) * 100).toFixed(1)}%`),
      mk('正例最少的折', `${Math.min(...r.foldPos)} 个`, stratify ? '分层后依然均摊' : '非分层，可能为 0'),
    )
  }

  if (cvStatus) {
    const minPos = Math.min(...r.foldPos)
    const overall = cvDs.y.filter((v) => v === 1).length / cvDs.y.length
    cvStatus.innerHTML =
      `在 <strong>${cvDs.name}</strong> 上跑 ${kFolds} 折，每折训练一棵 max_depth=3 的决策树。` +
      `整体正例占比 <strong>${(overall * 100).toFixed(1)}%</strong>，` +
      `每折正例数：${r.foldPos.join(' / ')}。` +
      (minPos === 0
        ? `<br><strong style="color:var(--danger,#e5484d)">有一折一个正例都没有</strong>——那一折的准确率等于"全判负例"，完全没有参考价值。打开「分层」试试。`
        : minPos <= 2 && !stratify
          ? `<br>最少的折只有 ${minPos} 个正例，这一折的准确率抖得厉害。打开「分层」看看差别。`
          : '')
  }

  if (foldListEl) {
    foldListEl.innerHTML = ''
    const overall = cvDs.y.filter((v) => v === 1).length / cvDs.y.length
    r.foldPos.forEach((pos, i) => {
      const n = r.foldSizes[i]
      const ratio = n === 0 ? 0 : pos / n
      const row = document.createElement('div')
      row.className = 'fold-row'
      row.innerHTML =
        `<span class="fold-no">第 ${i + 1} 折</span>` +
        `<span class="fold-track"><i class="fold-fill" style="width:${(ratio * 100).toFixed(1)}%"></i>` +
        `<u class="fold-base" style="left:${(overall * 100).toFixed(1)}%"></u></span>` +
        `<span class="fold-text">n=${n}　正例 ${pos}（${(ratio * 100).toFixed(1)}%）</span>`
      foldListEl.append(row)
    })
  }

  cvChart?.update()
  if (codeEl) codeEl.innerHTML = renderCode()
}

let cvTimer: number | null = null
function scheduleCv(): void {
  if (cvTimer !== null) window.clearTimeout(cvTimer)
  cvTimer = window.setTimeout(() => {
    cvTimer = null
    runCv()
  }, 120)
}

/* ---------------- 刷新 ---------------- */
function refresh(): void {
  refreshMetrics()
  renderMatrix()
  if (codeEl) codeEl.innerHTML = renderCode()
  distChart.update()
  rocChart.update()
  prChart.update()
}

/* ---------------- 控件 ---------------- */
const host = document.getElementById('controls')
const handles: Record<string, SliderHandle> = {}
if (host) {
  handles['thr'] = mountSlider(host, {
    label: '判定阈值',
    min: 0.01,
    max: 0.99,
    step: 0.01,
    value: threshold,
    hint: '分数超过多少就判为正例。拖它，看混淆矩阵四个格子此消彼长',
    format: (v) => v.toFixed(2),
    onInput: (v) => {
      threshold = v
      refresh()
    },
  })
  handles['prev'] = mountSlider(host, {
    label: '正例占比',
    min: 0.05,
    max: 0.5,
    step: 0.01,
    value: synthPrev,
    hint: '仅合成数据有效：患病率一低，准确率就开始骗人',
    format: (v) => v.toFixed(2),
    onInput: (v) => {
      synthPrev = v
      rebuildSynth()
      refresh()
    },
  })
  handles['sep'] = mountSlider(host, {
    label: '区分度 d',
    min: 0,
    max: 3.5,
    step: 0.05,
    value: synthSep,
    hint: '仅合成数据有效：两类分数分布的距离，理论 AUC = Φ(d/√2)',
    format: (v) => v.toFixed(2),
    onInput: (v) => {
      synthSep = v
      rebuildSynth()
      refresh()
    },
  })
  handles['n'] = mountSlider(host, {
    label: '样本数',
    min: 100,
    max: 2000,
    step: 50,
    value: synthN,
    hint: '仅合成数据有效',
    format: (v) => v.toFixed(0),
    onInput: (v) => {
      synthN = v
      rebuildSynth()
      refresh()
    },
  })
}

/** 合成数据的旋钮只在选到合成数据集时露出来 */
function syncSynthControls(): void {
  const show = ds.id === 'synth'
  for (const key of ['prev', 'sep', 'n']) {
    const el = handles[key]?.el
    if (el) el.style.display = show ? '' : 'none'
  }
}

/* ---------------- 数据集切换 ---------------- */
const selData = document.getElementById('sel-data') as HTMLSelectElement | null
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
    const next = DATASETS.find((d) => d.id === selData.value) ?? DATASETS[0]
    loadDataset(next)
    if (dataDesc) dataDesc.textContent = next.desc
    syncSynthControls()
    refresh()
  })
}

/* ---------------- 交叉验证控件 ---------------- */
const selCv = document.getElementById('sel-cv') as HTMLSelectElement | null
const cvHost = document.getElementById('cv-controls')

if (selCv) {
  CV_DATASETS.forEach((d) => {
    const o = document.createElement('option')
    o.value = d.id
    o.textContent = d.name
    selCv.append(o)
  })
  selCv.value = cvDs.id
  selCv.addEventListener('change', () => {
    cvDs = CV_DATASETS.find((d) => d.id === selCv.value) ?? CV_DATASETS[0]
    runCv()
  })
}

if (cvHost) {
  mountSlider(cvHost, {
    label: '折数 K',
    min: 2,
    max: 10,
    step: 1,
    value: kFolds,
    hint: '把数据切成几份。K 越大，每折训练集越接近全体，但计算也越贵',
    format: (v) => v.toFixed(0),
    onInput: (v) => {
      kFolds = Math.round(v)
      scheduleCv()
    },
  })

  const wrap = document.createElement('div')
  wrap.className = 'ctrl'
  wrap.innerHTML =
    `<label class="check"><input type="checkbox" id="chk-stratify"${stratify ? ' checked' : ''}/>` +
    `<span>分层切分</span></label>` +
    `<div class="ctrl-hint">每折的正例比例与整体一致。类别不平衡时几乎是必选项</div>`
  cvHost.append(wrap)
  wrap.querySelector('#chk-stratify')?.addEventListener('change', (e) => {
    stratify = (e.currentTarget as HTMLInputElement).checked
    runCv()
  })
}

/* ---------------- 上下篇 ---------------- */
mountPager('model-evaluation')

/* ---------------- 首屏 ---------------- */
loadDataset(ds)
if (dataDesc) dataDesc.textContent = ds.desc
syncSynthControls()
refresh()
runCv()


/* ---------------- Nya 助教：让她看见这一页 ---------------- */
/*
 * 用通用读取器，不手写这一页有哪些数字。
 * 它读的是「屏幕上已经显示出来的字」——指标卡、滑杆、下拉框 ——
 * 所以拖完滑杆再问她，报的就是新值（每次调用重新读，不缓存）。
 * 键名要和 chat/nya.ts 里这一页的 stateKeys 逐字一致，否则会被安静地丢掉。
 */
provideNyaStateFromPage()
