/**
 * 决策树演示页。
 *
 * 与线性回归页共用同一套范式：图表 + 控件 + 指标 + 代码桥 + 原理 + 思考题。
 * 这里多了两块：
 *   1. Canvas 手绘的树结构（src/core/treeCanvas.ts）
 *   2. 「单步 / 自动构建」——把贪心生长的过程一步一步放出来
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
import { mountSlider } from '../core/slider'
import { renderMath } from '../core/math'
import { createTreeCanvas } from '../core/treeCanvas'
import {
  initGrow,
  growStep,
  growAll,
  treeStats,
  accuracy,
  collectRegions,
  impurityOf,
  type Criterion,
  type GrowState,
  type Sample as TreeSample,
  type TreeNode,
} from '../algorithms/decisionTree'
import { buildDatasets, type TreeDataset } from '../data/treeDatasets'
import iris from '../data/iris.json'

mountChrome()
renderMath(document)
markVisited('decision-tree')

/* ---------------- 数据 ---------------- */
const DATASETS: TreeDataset[] = buildDatasets(iris)
let ds = DATASETS[0]

/** 树算法用的是 Sample[]（x 为数组），数据集里是 [number, number]，这里做一次适配 */
function toSamples(d: TreeDataset): TreeSample[] {
  return d.samples.map((s) => ({ x: [s.x[0], s.x[1]], y: s.y }))
}
let samples: TreeSample[] = toSamples(ds)
const nClasses = ds.classNames.length

/* ---------------- 状态 ---------------- */
let criterion: Criterion = 'gini'
let maxDepth = 3
let minSamplesSplit = 2
let st: GrowState = initGrow(samples, nClasses, { criterion, maxDepth, minSamplesSplit })
let autoTimer: number | null = null

const CLASS_FILL = ['#6366f1', '#0d9488', '#f59e0b', '#ec4899', '#8b5cf6']
const CLASS_SOFT = ['rgba(99,102,241,0.16)', 'rgba(13,148,136,0.16)', 'rgba(245,158,11,0.16)']

/* ---------------- 坐标范围 ---------------- */
function bounds(): [number, number, number, number] {
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
/** 注意：切换数据集后必须重算，否则新数据的点会被画到旧坐标范围之外 */
let B: [number, number, number, number] = bounds()

/* ---------------- 树画布 ---------------- */
const treeHost = document.getElementById('tree-host')
if (!treeHost) throw new Error('#tree-host 不存在')
const treeView = createTreeCanvas(treeHost)

/* ---------------- 决策边界图 ---------------- */
const chartEl = document.getElementById('chart')
if (!chartEl) throw new Error('#chart 不存在')

const buildOption = (): EChartsOption => {
  const p = palette()
  const regions = collectRegions(st.root, B)
  const axisStyle = {
    axisLine: { lineStyle: { color: p.axis } },
    axisLabel: { color: p.axis, fontSize: 11 },
    nameTextStyle: { color: p.sub, fontSize: 11 },
    splitLine: { lineStyle: { color: p.split } },
  }

  // 按类别分桶，让同色的点合成一个 series（图例才有意义）
  const byClass: [number, number][][] = ds.classNames.map(() => [])
  for (const s of ds.samples) byClass[s.y].push([s.x[0], s.x[1]])

  return {
    grid: baseGrid(),
    legend: {
      top: 0,
      right: 0,
      textStyle: { color: p.sub, fontSize: 11 },
      data: ds.classNames,
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
      min: round(B[0], 2),
      max: round(B[1], 2),
      ...axisStyle,
    },
    yAxis: {
      type: 'value',
      name: ds.featureNames[1],
      nameLocation: 'middle',
      nameGap: 38,
      min: round(B[2], 2),
      max: round(B[3], 2),
      ...axisStyle,
    },
    series: [
      {
        name: '决策区域',
        type: 'custom',
        silent: true,
        // 每项：[x0, x1, y0, y1, 类别]
        data: regions.map((r) => [r.x0, r.x1, r.y0, r.y1, r.cls]),
        renderItem: (_params, api) => {
          const a = api.coord([api.value(0), api.value(2)])
          const b = api.coord([api.value(1), api.value(3)])
          const x = Math.min(a[0], b[0])
          const y = Math.min(a[1], b[1])
          const cls = Number(api.value(4))
          return {
            type: 'rect',
            shape: {
              x,
              y,
              width: Math.abs(b[0] - a[0]),
              height: Math.abs(b[1] - a[1]),
            },
            style: { fill: CLASS_SOFT[cls % CLASS_SOFT.length] },
          }
        },
        z: 1,
      },
      ...ds.classNames.map((name, k) => ({
        name,
        type: 'scatter' as const,
        symbolSize: 6,
        data: byClass[k],
        itemStyle: { color: CLASS_FILL[k % CLASS_FILL.length], opacity: 0.85 },
        z: 3,
      })),
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

makeMetric('acc', '训练准确率', '训练集上对的比例')
makeMetric('depth', '树深', '最长路径的层数')
makeMetric('leaves', '叶子数', '最终划分出的区域数')
makeMetric('nodes', '节点数', '内部节点 + 叶子')

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
  const stats = treeStats(st.root)
  const acc = accuracy(st.root, samples)
  const dsNote =
    ds.id === 'iris'
      ? '# 真实数据：sklearn.datasets.load_iris 取花瓣长 / 花瓣宽'
      : `# 合成数据：${ds.name}（固定随机种子，可复现）`
  const lines = [
    dsNote,
    'from sklearn.tree import DecisionTreeClassifier',
    'from sklearn.metrics import accuracy_score',
    '',
    'model = DecisionTreeClassifier(',
    `    criterion="${criterion}",        # ← 页面上的「不纯度准则」`,
    `    max_depth=${maxDepth},             # ← 「最大深度」`,
    `    min_samples_split=${minSamplesSplit},   # ← 「最小分裂样本数」`,
    '    random_state=0,',
    ')',
    'model.fit(X, y)',
    '',
    `# 这棵树：深度 ${stats.depth}、叶子 ${stats.leaves} 个、节点 ${stats.nodes} 个`,
    `print(accuracy_score(y, model.predict(X)))   # ${acc.toFixed(4)}`,
  ]
  return lines.map(highlight).join('\n')
}

/* ---------------- 状态栏 ---------------- */
const statusEl = document.getElementById('build-status')

function setStatus(html: string): void {
  if (statusEl) statusEl.innerHTML = html
}

const STOP_TEXT: Record<string, string> = {
  pure: '已经纯了，不用再切',
  'max-depth': '深度到顶了',
  'min-samples': '样本太少，不够再切',
  'no-split': '找不到更好的切法',
}

function describe(node: TreeNode): string {
  if (node.feature === undefined || node.threshold === undefined) {
    return `节点 #${node.id} → 成为叶子，${node.nSamples} 个样本判为「${
      ds.classNames[node.predicted] ?? node.predicted
    }」（${STOP_TEXT[node.stop ?? 'no-split'] ?? ''}）`
  }
  const fname = ds.featureNames[node.feature] ?? `x${node.feature + 1}`
  return `节点 #${node.id}（n=${node.nSamples}）→ 按 <strong>${fname} ≤ ${node.threshold.toFixed(
    3,
  )}</strong> 切，增益 ${(node.gain ?? 0).toFixed(4)}`
}

/* ---------------- 刷新 ---------------- */
function refresh(highlightId: number | null = null): void {
  const stats = treeStats(st.root)
  const acc = accuracy(st.root, samples)

  metricValues['acc']!.textContent = `${(acc * 100).toFixed(1)}%`
  metricValues['depth']!.textContent = String(stats.depth)
  metricValues['leaves']!.textContent = String(stats.leaves)
  metricValues['nodes']!.textContent = String(stats.nodes)

  if (codeEl) codeEl.innerHTML = renderCode()
  treeView.setTree(st.root, {
    featureNames: ds.featureNames,
    classNames: ds.classNames,
    criterionLabel: criterion === 'gini' ? 'Gini' : '熵',
  })
  treeView.highlight(highlightId)
  chart.update()
}

/* ---------------- 控件 ---------------- */
const host = document.getElementById('controls')

if (host) {
  mountSlider(host, {
    label: '最大深度 max_depth',
    min: 1,
    max: 10,
    step: 1,
    value: maxDepth,
    hint: '树最多能长几层，是最常用的防过拟合旋钮',
    format: (v) => String(v),
    onInput: (v) => {
      maxDepth = v
      rebuild()
    },
  })
  mountSlider(host, {
    label: '最小分裂样本数',
    min: 2,
    max: 40,
    step: 1,
    value: minSamplesSplit,
    hint: '样本少于这个数就不再往下切',
    format: (v) => String(v),
    onInput: (v) => {
      minSamplesSplit = v
      rebuild()
    },
  })
}

/* ---------------- 数据集 / 准则 ---------------- */
const selData = document.getElementById('sel-data') as HTMLSelectElement | null
const selCrit = document.getElementById('sel-criterion') as HTMLSelectElement | null
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
    samples = toSamples(ds)
    B = bounds()
    if (dataDesc) dataDesc.textContent = ds.desc
    rebuild()
  })
}
if (dataDesc) dataDesc.textContent = ds.desc

if (selCrit) {
  selCrit.value = criterion
  selCrit.addEventListener('change', () => {
    criterion = selCrit.value as Criterion
    rebuild()
  })
}

/* ---------------- 构建流程 ---------------- */
function rebuild(): void {
  stopAuto()
  st = initGrow(samples, ds.classNames.length, { criterion, maxDepth, minSamplesSplit })
  growAll(st)
  refresh()
  setStatus(
    `已按当前参数长完：深度 ${treeStats(st.root).depth}、叶子 ${
      treeStats(st.root).leaves
    } 个。想看过程就点「重置」再「单步构建」。`,
  )
}

function reset(): void {
  stopAuto()
  st = initGrow(samples, ds.classNames.length, { criterion, maxDepth, minSamplesSplit })
  const imp = impurityOf(st.root.counts, criterion)
  refresh(st.root.id)
  setStatus(
    `回到根节点：${st.root.nSamples} 个样本，不纯度 ${imp.toFixed(
      4,
    )}。点「单步构建」看它第一刀切在哪。`,
  )
}

function step(): void {
  if (st.queue.length === 0) {
    setStatus('这棵树已经长完了，先点「重置」再看一遍。')
    return
  }
  // 队首就是要处理的节点，先记下 id，处理完再高亮
  const target = st.queue[0]
  growStep(st)
  refresh(target.id)
  const done = st.queue.length === 0
  setStatus(
    `${describe(target)}${done ? '<br><strong>长完了。</strong>' : ''}`,
  )
  if (done) stopAuto()
}

function stopAuto(): void {
  if (autoTimer !== null) {
    window.clearInterval(autoTimer)
    autoTimer = null
    const b = document.getElementById('btn-auto')
    if (b) b.textContent = '自动构建'
  }
}

document.getElementById('btn-build')?.addEventListener('click', rebuild)
document.getElementById('btn-reset')?.addEventListener('click', reset)
document.getElementById('btn-step')?.addEventListener('click', () => {
  stopAuto()
  step()
})
document.getElementById('btn-auto')?.addEventListener('click', (e) => {
  const btn = e.currentTarget as HTMLButtonElement
  if (autoTimer !== null) {
    stopAuto()
    return
  }
  if (st.queue.length === 0) reset()
  btn.textContent = '暂停'
  // 280ms：慢到能看清每一刀，又不至于让深树演示等太久（深度 10 约 12 步 ≈ 3.4s）
  autoTimer = window.setInterval(step, 280)
})

document.getElementById('btn-zoom-in')?.addEventListener('click', () => treeView.zoomIn())
document.getElementById('btn-zoom-out')?.addEventListener('click', () => treeView.zoomOut())
document.getElementById('btn-fit')?.addEventListener('click', () => treeView.fit())

/* 主题切换后 Canvas 的颜色（取自 CSS 变量）要跟着变 */
onThemeChange(() => treeView.render())

/* ---------------- 上下篇 ---------------- */
mountPager('decision-tree')

/* 首屏直接长好一棵，别让用户对着空页面 */
rebuild()


/* ---------------- Nya 助教：让她看见这一页 ---------------- */
/*
 * 用通用读取器，不手写这一页有哪些数字。
 * 它读的是「屏幕上已经显示出来的字」——指标卡、滑杆、下拉框 ——
 * 所以拖完滑杆再问她，报的就是新值（每次调用重新读，不缓存）。
 * 键名要和 api/nya.ts 里这一页的 stateKeys 逐字一致，否则会被安静地丢掉。
 */
provideNyaStateFromPage()
