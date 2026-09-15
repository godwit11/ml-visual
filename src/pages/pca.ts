/**
 * 降维技术（PCA）演示页。
 *
 * 这一页的教学切入点：**把"主成分是什么"变成"转轴找最散的方向"**。
 *
 * 主图上是数据的原始空间（任选两个维度），上面画着一根可以拖动的轴
 * （旋转角滑杆控制）。滑杆旁边实时显示"当前投影方差"，
 * 而 PCA 给出的 PC1 方差就画在旁边做参照——
 * 拖到对齐的那一刻，两个数字重合成一个，这就是 PCA 的定义。
 *
 * 这一页的所有数字都是现算的（PCA 没有随机性，也不需要预训练参数）；
 * 落到页面上的每一个值都能在对拍输出里找到出处。
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
import { fitPCA, loadings, reconstructionError, type PCAResult, type Matrix } from '../algorithms/pca'
import { buildPcaDatasets, type PcaDataset } from '../data/pcaDatasets'
import iris4 from '../data/iris4.json'

mountChrome()
renderMath(document)
markVisited('pca')

/* ---------------- 数据与状态 ---------------- */
const DATASETS: PcaDataset[] = buildPcaDatasets(iris4)
let ds: PcaDataset = DATASETS[0]
/** 主图看的两个维度下标 */
let pair: [number, number] = [2, 3]
let k = 2
/** 手动旋转角（度）：只影响主图上的那根轴与投影方差 */
let theta = 0

const PALETTE = ['#6366f1', '#0d9488', '#f59e0b', '#dc2626', '#8b5cf6', '#0891b2']
const COL_PC = ['#dc2626', '#0891b2', '#f59e0b', '#8b5cf6', '#0d9488', '#65a30d']

/** 全维度拟合结果：主成分、方差谱都在这里 */
let full: PCAResult = fitPCA(ds.data)
/** 与当前 k 对应的结果 */
let reduced: PCAResult = fitPCA(ds.data, k)

function recompute(): void {
  full = fitPCA(ds.data)
  reduced = fitPCA(ds.data, k)
  refresh()
}

/* ---------------- 工具 ---------------- */
const deg2rad = (d: number) => (d * Math.PI) / 180

/** 归一化一个二维向量 */
function unit(v: [number, number]): [number, number] {
  const n = Math.hypot(v[0], v[1]) || 1
  return [v[0] / n, v[1] / n]
}

/** 当前手动轴在两个所选维度上的方向（角度制） */
function manualDir(): [number, number] {
  return [Math.cos(deg2rad(theta)), Math.sin(deg2rad(theta))]
}

/** 把一列数据“减去均值” */
function centeredCol(j: number): number[] {
  const col = ds.data.map((r) => r[j])
  const mu = col.reduce((a, b) => a + b, 0) / (col.length || 1)
  return col.map((v) => v - mu)
}

/**
 * 当前手动轴上的投影方差（只用主图所看的两个维度）。
 *
 * 注意：这是**二维子空间内**的方差，作为拖动时的即时反馈；
 * 与 Pane 里"全维度的 PC1 方差"不是同一个数，所以文案要说清楚。
 */
function manualVariance(): number {
  const a = centeredCol(pair[0])
  const b = centeredCol(pair[1])
  const [wx, wy] = manualDir()
  const n = a.length || 1
  let s = 0
  for (let i = 0; i < n; i++) {
    const t = a[i] * wx + b[i] * wy
    s += t * t
  }
  return s / ((n - 1) || 1)
}

/** PC1 在二维子空间内的方差（投影长度取其在两维上的分量，再归一化） */
function pcVarianceInPlane(): number {
  const d = unit([full.components[0][pair[0]], full.components[0][pair[1]]])
  const a = centeredCol(pair[0])
  const b = centeredCol(pair[1])
  const n = a.length || 1
  let s = 0
  for (let i = 0; i < n; i++) {
    const t = a[i] * d[0] + b[i] * d[1]
    s += t * t
  }
  return s / ((n - 1) || 1)
}

/** PC1 在这个二维平面上的角度（0-180 度） */
function pcAngleInPlane(): number {
  const x = full.components[0][pair[0]]
  const y = full.components[0][pair[1]]
  let deg = (Math.atan2(y, x) * 180) / Math.PI
  if (deg < 0) deg += 180
  return deg
}

/** 把旋转角对准当前 PC1（在所选二维平面里的角度），取整到滑杆的 1° 步长 */
function snapAngle(): number {
  return Math.round(pcAngleInPlane()) % 180
}

function boundsOf(): [number, number, number, number] {
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  for (const p of ds.data) {
    x0 = Math.min(x0, p[pair[0]])
    x1 = Math.max(x1, p[pair[0]])
    y0 = Math.min(y0, p[pair[1]])
    y1 = Math.max(y1, p[pair[1]])
  }
  const px = (x1 - x0) * 0.1 || 0.5
  const py = (y1 - y0) * 0.1 || 0.5
  return [x0 - px, x1 + px, y0 - py, y1 + py]
}
let B = boundsOf()

/* ---------------- 主图 ---------------- */
const spaceEl = document.getElementById('chart-space')
if (!spaceEl) throw new Error('#chart-space 不存在')

const buildSpaceOption = (): EChartsOption => {
  const p = palette()
  const [x0, x1, y0, y1] = B
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  // 轴的半长：够画到图边即可
  const reach = Math.max(x1 - x0, y1 - y0) * 0.62

  // 按真实标签或主成分分组上色
  const groups = new Map<number, [number, number][]>()
  ds.data.forEach((row, i) => {
    // 有标签按标签分组；没标签就全放一组
    const g = ds.labels ? ds.labels[i] : 0
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push([row[pair[0]], row[pair[1]]])
  })

  const series: EChartsOption['series'] = []
  ;[...groups.entries()].forEach(([g, pts]) => {
    const name = ds.classNames ? ds.classNames[g] : '样本'
    series.push({
      name: `${name}（${pts.length}）`,
      type: 'scatter',
      symbolSize: 7,
      data: pts,
      itemStyle: { color: PALETTE[g % PALETTE.length], opacity: 0.75 },
      z: 3,
    })
  })

  // 手动旋转轴（粗虚线），以及每点到它的垂足连线
  const [wx, wy] = manualDir()
  const axisEnd: [number, number] = [cx + wx * reach, cy + wy * reach]
  const axisStart: [number, number] = [cx - wx * reach, cy - wy * reach]
  series.push({
    name: '你转的轴',
    type: 'line',
    showSymbol: false,
    silent: true,
    data: [axisStart, axisEnd],
    lineStyle: { color: p.text, width: 2, type: 'dashed', opacity: 0.85 },
    z: 4,
  })

  // PC1 / PC2 的真实方向：实线
  ;[0, 1].forEach((j) => {
    if (j >= full.components.length) return
    // 在二维子空间里重新归一化，才能画在这张图上
    const dx = full.components[j][pair[0]]
    const dy = full.components[j][pair[1]]
    const [ux, uy] = unit([dx, dy])
    if (Math.hypot(dx, dy) < 1e-6) return
    series.push({
      name: `PC${j + 1}`,
      type: 'line',
      showSymbol: false,
      silent: true,
      data: [
        [cx - ux * reach, cy - uy * reach],
        [cx + ux * reach, cy + uy * reach],
      ],
      lineStyle: { color: COL_PC[j], width: 2.2, opacity: 0.9 },
      z: 5,
    })
  })

  const axisStyle = {
    axisLine: { lineStyle: { color: p.axis } },
    axisLabel: { color: p.axis, fontSize: 11 },
    nameTextStyle: { color: p.sub, fontSize: 11 },
    splitLine: { lineStyle: { color: p.split } },
  }

  return {
    grid: { left: 52, right: 18, top: 34, bottom: 42, containLabel: false },
    legend: { top: 0, right: 0, type: 'scroll', textStyle: { color: p.sub, fontSize: 11 } },
    tooltip: {
      trigger: 'item',
      backgroundColor: p.surface,
      borderColor: p.split,
      textStyle: { color: p.text, fontSize: 12 },
      formatter: (prm: unknown) => {
        const q = prm as { data: number[]; seriesName: string }
        return `${q.seriesName}<br/>(${Number(q.data[0]).toFixed(2)}, ${Number(q.data[1]).toFixed(2)})`
      },
    },
    xAxis: {
      type: 'value',
      min: round(x0, 3),
      max: round(x1, 3),
      name: ds.featureNames[pair[0]],
      nameLocation: 'middle',
      nameGap: 26,
      ...axisStyle,
    },
    yAxis: {
      type: 'value',
      min: round(y0, 3),
      max: round(y1, 3),
      name: ds.featureNames[pair[1]],
      nameLocation: 'middle',
      nameGap: 34,
      ...axisStyle,
    },
    series,
  }
}
const spaceChart = createChart(spaceEl, buildSpaceOption)

/* ---------------- 方差谱（碎石图） ---------------- */
const screeEl = document.getElementById('chart-scree')
if (!screeEl) throw new Error('#chart-scree 不存在')

const buildScreeOption = (): EChartsOption => {
  const p = palette()
  const names = full.explainedVarianceRatio.map((_, j) => `PC${j + 1}`)
  const ratios = full.explainedVarianceRatio.map((v) => round(v * 100, 3))
  const cum = full.cumulativeRatio.map((v) => round(v * 100, 3))
  const axisStyle = {
    axisLine: { lineStyle: { color: p.axis } },
    axisLabel: { color: p.axis, fontSize: 11 },
    nameTextStyle: { color: p.sub, fontSize: 11 },
    splitLine: { lineStyle: { color: p.split } },
  }
  return {
    grid: { left: 52, right: 46, top: 38, bottom: 40, containLabel: false },
    legend: { top: 0, textStyle: { color: p.sub, fontSize: 11 } },
    tooltip: {
      trigger: 'axis',
      backgroundColor: p.surface,
      borderColor: p.split,
      textStyle: { color: p.text, fontSize: 12 },
      valueFormatter: (v: unknown) => `${Number(v).toFixed(3)}%`,
    },
    xAxis: { type: 'category', data: names, ...axisStyle },
    yAxis: [
      { type: 'value', name: '占比 %', max: 100, ...axisStyle },
      { type: 'value', name: '累计 %', max: 100, ...axisStyle, splitLine: { show: false } },
    ],
    series: [
      {
        name: '单个主成分占比',
        type: 'bar',
        data: ratios.map((v, j) => ({
          value: v,
          itemStyle: {
            // 前 k 个高亮：这就是"保留"的部分
            color: j < k ? COL_PC[0] : p.split,
            opacity: j < k ? 0.9 : 0.65,
          },
        })),
        barMaxWidth: 44,
        label: {
          show: true,
          position: 'top',
          fontSize: 11,
          color: p.sub,
          formatter: (prm: unknown) => `${(prm as { value: number }).value.toFixed(1)}%`,
        },
      },
      {
        name: '累计占比',
        type: 'line',
        yAxisIndex: 1,
        data: cum,
        symbol: 'circle',
        symbolSize: 6,
        lineStyle: { color: COL_PC[1], width: 2.2 },
        itemStyle: { color: COL_PC[1] },
      },
    ],
  }
}
const screeChart = createChart(screeEl, buildScreeOption)

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
makeMetric('cur', '当前投影方差', '你转的这根轴上，数据散得多开')
makeMetric('best', 'PC1 的方差', 'PCA 选出的最优方向，方差最大')
makeMetric('kept', '累计解释方差', `保留前 ${k} 个主成分保住了多少`)
makeMetric('ratio', '当前 / 最优', '拖到 100.00% 就说明你找到 PC1 了')
makeMetric('knn', '近邻保持率', '降维后原来挨着的点还挨着吗')

const spaceHint = document.getElementById('space-hint')
const trainStatus = document.getElementById('train-status')

/* ---------------- 近邻保持率（现算） ---------------- */
function knnKeep(kKeep: number): number | null {
  if (ds.data[0].length <= kKeep) return null
  const n = ds.data.length
  if (n > 600) return null
  const d2 = (a: number[], b: number[]) => {
    let s = 0
    for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2
    return s
  }
  const nb = (rows: number[][], i: number) =>
    rows
      .map((row, j) => ({ j, d: d2(row, rows[i]) }))
      .filter((o) => o.j !== i)
      .sort((a, b) => a.d - b.d)
      .slice(0, 5)
      .map((o) => o.j)
  const low: number[][] = reduced.scores.map((row) => row.slice(0, kKeep))
  let hit = 0
  for (let i = 0; i < n; i++) {
    const before = new Set(nb(ds.data, i))
    for (const j of nb(low, i)) if (before.has(j)) hit++
  }
  return hit / (n * 5)
}

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
  const kept = full.cumulativeRatio[k - 1]
  const rmse = Math.sqrt(reconMse)
  const lines = [
    '# ① 这一页自己做的是这些（数字都是现算的）',
    'Xc = X - X.mean(axis=0)                       # 中心化（不除标准差）',
    'U, S, Vt = svd(Xc)                            # 手写 Jacobi 特征分解得到',
    'components = Vt[:k]                           # 前 k 个主成分方向',
    'Z = Xc @ components.T                         # 投影到新坐标',
    `print(S**2 / (n-1))          # 方差谱 ${full.explainedVarianceRatio.map((v) => (v * 100).toFixed(2) + '%').join(' / ')}`,
    `print(np.cumsum(...)[${k - 1}])      # 累计解释方差 ${(kept * 100).toFixed(3)}%`,
    `print(Xhat)                  # 重构回原空间，RMSE ${rmse.toFixed(4)}`,
    '',
    '# ② sklearn 的等价写法',
    'from sklearn.decomposition import PCA',
    '',
    `pca = PCA(n_components=${k}).fit(X)`,
    'Z = pca.transform(X)',
    'print(pca.components_, pca.explained_variance_ratio_)',
    '',
    '# ③ 量纲不统一时，先标准化再降维',
    'from sklearn.pipeline import make_pipeline',
    'from sklearn.preprocessing import StandardScaler',
    '',
    `pca2 = make_pipeline(StandardScaler(), PCA(n_components=${k})).fit(X)`,
    '# 注意：sklearn 的 PCA 自己不做标准化，这一步必须手动加。',
  ]
  return lines.filter((l) => l !== '').map(highlight).join('\n')
}

let reconMse = 0

/* ---------------- 刷新 ---------------- */
function refresh(): void {
  // 主图
  spaceChart.update()
  screeChart.update()

  // 指标
  const cur = manualVariance()
  const best = pcVarianceInPlane()
  const kept = full.cumulativeRatio[k - 1]
  const ratio = best > 0 ? Math.min(1, cur / best) : 0

  metricValues['cur']!.textContent = cur.toFixed(3)
  metricValues['best']!.textContent = best.toFixed(3)
  metricValues['kept']!.textContent = `${(kept * 100).toFixed(2)}%`
  metricValues['ratio']!.textContent = `${(ratio * 100).toFixed(2)}%`

  const keep = knnKeep(k)
  metricValues['knn']!.textContent = keep === null ? `—（${ds.data[0].length} 维降到 ${k} 维）` : `${(keep * 100).toFixed(1)}%`

  // 重构误差（现算）
  const Xc = ds.data.map((row) => row.map((v, j) => v - full.mean[j]))
  const comp = full.components.slice(0, k)
  const Z: Matrix = Xc.map((row) => comp.map((d) => row.reduce((a, v, j) => a + v * d[j], 0)))
  const Xhat: Matrix = Z.map((z) => {
    const out = new Array(full.mean.length).fill(0)
    for (let j = 0; j < comp.length; j++) for (let a = 0; a < out.length; a++) out[a] += z[j] * comp[j][a]
    return out.map((v, a) => v + full.mean[a])
  })
  reconMse = reconstructionError(ds.data, Xhat)

  const angleDiff = Math.abs(((theta % 180) + 180) % 180 - pcAngleInPlane())
  const aligned = Math.min(angleDiff, 180 - angleDiff) < 1.5

  if (spaceHint) {
    spaceHint.innerHTML =
      `黑色虚线是<strong>你正在转的轴</strong>（角度 ${theta.toFixed(0)}°），` +
      `红色实线是 PCA 给出的 <strong>PC1</strong>（角度 ${pcAngleInPlane().toFixed(1)}°）。` +
      `把这根轴转到红色线上，投影方差就从 ${cur.toFixed(3)} 爬到最大的 ${best.toFixed(3)}。` +
      (aligned ? '<br><strong>对齐了！</strong>你手动找到的就是 PC1 的方向。' : '')
  }

  if (trainStatus) {
    trainStatus.innerHTML =
      `保留 <strong>${k}</strong> 个主成分：` +
      `保住 <strong>${(kept * 100).toFixed(2)}%</strong> 的方差，` +
      `丢掉的 ${(100 - kept * 100).toFixed(2)}% 找不回来。<br>` +
      `重构回原空间的 RMSE = <strong>${Math.sqrt(reconMse).toFixed(4)}</strong>` +
      `（k = ${full.nFeatures} 时为 0）。` +
      `<br>近邻保持率衡量的是"结构有没有散架"：${keep === null ? '当前 k 已等于原维度。' : `${(keep * 100).toFixed(1)}%（原始空间最近 5 个邻居，投影后还剩几个）`}`
  }

  if (codeEl) codeEl.innerHTML = renderCode()
}

/* ---------------- 控件 ---------------- */
const host = document.getElementById('controls')
const handles: Record<string, SliderHandle> = {}
if (host) {
  handles['theta'] = mountSlider(host, {
    label: '旋转角（度）',
    min: 0,
    max: 180,
    step: 1,
    value: theta,
    hint: '只影响主图那根虚线的朝向，不改变数据本身',
    format: (v) => v.toFixed(0),
    onInput: (v) => {
      theta = v
      refresh()
    },
  })
  handles['k'] = mountSlider(host, {
    label: '保留主成分个数 k',
    min: 1,
    max: ds.data[0].length,
    step: 1,
    value: k,
    hint: '保留前 k 根轴。k 越大信息越多，但也越没"降"',
    format: (v) => v.toFixed(0),
    onInput: (v) => {
      k = Math.round(v)
      recompute()
    },
  })
}

const selData = document.getElementById('sel-data') as HTMLSelectElement | null
const selPair = document.getElementById('sel-pair') as HTMLSelectElement | null
const dataDesc = document.getElementById('data-desc')

/** 主图上可选的维度对：优先给"最有意思"的两对 */
function pairChoices(): [number, number][] {
  const p = ds.data[0].length
  const out: [number, number][] = []
  const cands: [number, number][] = []
  for (let i = 0; i < p; i++) for (let j = i + 1; j < p; j++) cands.push([i, j])
  // 优先 (p-2, p-1) 与 (0,1)，其余按序补上
  const prefer: [number, number][] = [[p - 2, p - 1]]
  if (p > 2) prefer.push([0, 1])
  for (const c of prefer) if (c[0] >= 0 && c[1] < p) out.push(c)
  for (const c of cands) if (!out.some((o) => o[0] === c[0] && o[1] === c[1])) out.push(c)
  return out
}

function rebuildPairOptions(): void {
  if (!selPair) return
  selPair.innerHTML = ''
  const choices = pairChoices()
  choices.forEach(([a, b]) => {
    const o = document.createElement('option')
    o.value = `${a},${b}`
    o.textContent = `${ds.featureNames[a]} × ${ds.featureNames[b]}`
    selPair.append(o)
  })
  pair = choices[0]
  selPair.value = `${pair[0]},${pair[1]}`
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
    // 默认 k：2 维数据降到 1 维，3 维以上降到 2 维。
    // 注意不能写成 min(2, p)——那样 2 维数据会默认 k=2，等于没降维，
    // 页面上"保住 100%"会让"降维"这件事整个失去演示意义（e2e 抓到的）。
    k = Math.max(1, Math.min(2, ds.data[0].length - 1))
    theta = 0
    handles['k']?.set(k, true)
    handles['theta']?.set(0, true)
    // 重建 k 滑杆的上限（不同数据集的维数不同）
    if (host && handles['k']) {
      const wrap = handles['k'].el
      const range = wrap.querySelector('input[type=range]') as HTMLInputElement | null
      const num = wrap.querySelector('input[type=number]') as HTMLInputElement | null
      if (range) range.max = String(ds.data[0].length)
      if (num) num.max = String(ds.data[0].length)
    }
    rebuildPairOptions()
    full = fitPCA(ds.data)
    B = boundsOf()
    // 让轴默认对准新的 PC1（和首屏一致的"已对齐"状态）。
    // 否则切数据集后 theta 还是上一组的 0°，指标卡会显示一个突兀的 50%，
    // 让人误以为坏了 —— 想看"没对齐"的状态自己拖滑杆即可。
    theta = snapAngle()
    handles['theta']?.set(theta, true)
    if (dataDesc) dataDesc.textContent = ds.desc
    recompute()
  })
}

if (selPair) {
  selPair.addEventListener('change', () => {
    const [a, b] = selPair.value.split(',').map((s) => parseInt(s, 10))
    pair = [a, b]
    B = boundsOf()
    refresh()
  })
}

document.getElementById('btn-snap')?.addEventListener('click', () => {
  theta = snapAngle()
  handles['theta']?.set(theta, true)
  refresh()
})
document.getElementById('btn-optimal')?.addEventListener('click', () => {
  // 累计解释方差达到 95% 所需的最小 k
  let kk = 1
  while (kk < full.cumulativeRatio.length && full.cumulativeRatio[kk - 1] < 0.95) kk++
  k = kk
  handles['k']?.set(k, true)
  recompute()
})
document.getElementById('btn-reset')?.addEventListener('click', () => {
  k = Math.max(1, Math.min(2, ds.data[0].length - 1))
  theta = snapAngle()
  handles['theta']?.set(theta, true)
  handles['k']?.set(k, true)
  recompute()
})

/* ---------------- 上下篇 ---------------- */
mountPager('pca')

/* ---------------- 首屏 ---------------- */
rebuildPairOptions()
if (dataDesc) dataDesc.textContent = ds.desc
// 首屏给出"已经对齐 PC1"的状态：让"当前方差 = 最优方差"这件事一进来就可见，
// 用户想体验"转轴找方向"，拖滑杆离开即可。
theta = snapAngle()
handles['theta']?.set(theta, true)
refresh()

// 暴露给 e2e 的内部状态（调试钩子，不影响页面呈现）
;(window as unknown as { __pca?: unknown }).__pca = {
  get ds() {
    return ds.id
  },
  get k() {
    return k
  },
  get theta() {
    return theta
  },
  get components() {
    return full.components
  },
  get ratios() {
    return full.explainedVarianceRatio
  },
  get cumulative() {
    return full.cumulativeRatio
  },
  get curVar() {
    return manualVariance()
  },
  get bestVar() {
    return pcVarianceInPlane()
  },
  get reconMse() {
    return reconMse
  },
  get loadings() {
    return loadings(full)
  },
  scores: (kk: number) => reduced.scores.map((r) => r.slice(0, kk)),
}


/* ---------------- Nya 助教：让她看见这一页 ---------------- */
/*
 * 用通用读取器，不手写这一页有哪些数字。
 * 它读的是「屏幕上已经显示出来的字」——指标卡、滑杆、下拉框 ——
 * 所以拖完滑杆再问她，报的就是新值（每次调用重新读，不缓存）。
 * 键名要和 api/nya.ts 里这一页的 stateKeys 逐字一致，否则会被安静地丢掉。
 */
provideNyaStateFromPage()
