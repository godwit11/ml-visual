/**
 * 神经网络（MLP）演示页。
 *
 * 这一页的教学切入点：**把"神经网络"拆成两件可玩的事**——
 *   ① 决策边界怎么被"掰弯"（前向传播 + 激活函数的作用）
 *   ② 训练过程中损失怎么降下来（反向传播 + SGD）
 *
 * 与前面几页最大的不同：**这一页有随机性**。
 * 每次重新训练权重都不同、边界也不同，所以页面上所有数字都是"这一次训练"的结果，
 * 而不是固定常数。为了教学可复现，随机种子是固定的（同一数据集 + 同一结构 + 同一种子
 * = 完全一样的边界），点"重新训练"才会换一个种子。
 *
 * 一个刻意的设计：**「无激活」是可选的一个激活函数**。
 * 它让"非线性的来源是激活函数而不是层数"这件事变成一个可以亲手做的实验——
 * 切到「线性（无激活）」，不管把隐层加到多深多宽，异或的准确率都上不去。
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
  ACTIVATIONS,
  initNet,
  train,
  decisionGrid,
  predictProba,
  forward,
  backward,
  oneHot,
  type Activation,
  type Net,
  type Matrix,
} from '../algorithms/neuralNetwork'
import { buildNnDatasets, type NnDataset } from '../data/nnDatasets'
import iris4 from '../data/iris4.json'
import { makeCellRenderItem } from '../dev/zzprobe'

mountChrome()
renderMath(document)
markVisited('neural-network')

/* ---------------- 数据与状态 ---------------- */
const DATASETS: NnDataset[] = buildNnDatasets(iris4)
let ds: NnDataset = DATASETS[0]

/** 隐层结构（不含输入层与输出层） */
let hidden: number[] = ds.suggested.slice(1, -1)
let act: Activation = 'relu'
let lr = ds.suggestedLr
let batchSize = 32
let epochs = 300
let seed = 1
let l2 = 0

/** 当前网络与训练历史 */
let net: Net = initNet([ds.nFeatures, ...hidden, ds.nClasses === 2 ? 1 : ds.nClasses], seed)
let history: { loss: number[]; acc: number[] } = { loss: [], acc: [] }
/** 首层/末层梯度范数比（衡量梯度消失） */
let gradRatio = 0

const PALETTE = ['#6366f1', '#0d9488', '#f59e0b', '#dc2626']
/** 决策边界的分辨率：够画平滑的等高线，又不至于卡 */
const GRID = 72

/** 输出层单元数：二分类 1 个 logit，多分类 K 个 */
function outUnits(nc: number): number {
  return nc === 2 ? 1 : nc
}
function sizes(): number[] {
  return [ds.nFeatures, ...hidden, outUnits(ds.nClasses)]
}

/* ---------------- 训练 ---------------- */
function runTrain(extraEpochs = epochs, newSeed?: number): void {
  if (newSeed !== undefined) seed = newSeed
  net = initNet(sizes(), seed)
  const cfg = { activation: act, lr, batchSize, nClasses: ds.nClasses, seed }
  const res = train(net, ds.data, ds.labels, cfg, extraEpochs, seed)
  net = res.net
  history = res.history
  gradRatio = computeGradRatio()
  refresh()
}

/** 训练结束后，顺带量一下首层与末层梯度范数之比（梯度消失的直观指标） */
function computeGradRatio(): number {
  try {
    const Y = oneHot(ds.labels, ds.nClasses)
    const cache = forward(net, ds.data, act)
    const { dW } = backward(net, cache, ds.data, Y, ds.nClasses, act, l2)
    const norm = (m: Matrix) => Math.sqrt(m.flat().reduce((a, v) => a + v * v, 0))
    const first = norm(dW[0])
    const last = norm(dW[dW.length - 1])
    return last > 1e-300 ? first / last : Infinity
  } catch {
    return NaN
  }
}

/* ---------------- 主图：决策边界 ---------------- */
const spaceEl = document.getElementById('chart-space')
if (!spaceEl) throw new Error('#chart-space 不存在')

/** 数据范围（留一点边） */
function boundsOf(): [number, number, number, number] {
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  for (const p of ds.data) {
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

const buildSpaceOption = (): EChartsOption => {
  const p = palette()
  const [x0, x1, y0, y1] = B

  /*
   * 决策边界用**自定义系列**画：把概率场铺成一格一格的色块。
   *
   * 为什么不用 echarts 的 heatmap？
   *   ① 要额外注册 HeatmapChart 模块；
   *   ② heatmap 要求规整的二维坐标轴刻度，和数据点系列的 value 轴配合起来别扭。
   * 用 custom 系列自己算矩形位置，既省一个模块依赖，也好控制每一格的颜色。
   */
  const grid = decisionGrid(net, [x0, x1], [y0, y1], GRID, ds.nClasses, act)
  const cellW = (x1 - x0) / (GRID - 1)
  const cellH = (y1 - y0) / (GRID - 1)

  // 每个格子：[x 起点, y 起点, 宽度, 高度, 概率]
  const cells: [number, number, number, number, number][] = []
  for (let j = 0; j < grid.y.length; j++) {
    for (let i = 0; i < grid.x.length; i++) {
      // 概率是这一格中心处的值，所以矩形要往左上挪半格
      cells.push([
        grid.x[i] - cellW / 2,
        grid.y[j] - cellH / 2,
        cellW * 1.02,
        cellH * 1.02,
        grid.values[j][i],
      ])
    }
  }

  /*
   * 每个格子用**两个对角点的坐标差**算像素宽高，而不是 api.size()。
   *
   * 为什么不用 api.size？它把参数当作"轴上的数据跨度"，
   * 需要自定义系列显式声明 dimensions / encode 才能正确换算，
   * 配错时矩形会退化成一堆细条（踩过：背景只铺出两条横带）。
   * 直接对左上、右下两个点各调一次 api.coord 相减，不依赖任何元数据，最稳。
   *
   * 渲染器放在 src/dev/zzprobe.ts 里，因为它同时被单元测试直接调用
   * （喂一份假 api，断言算出来的像素矩形），不必依赖浏览器截图比对。
   */
  const renderCell = makeCellRenderItem(cellW, cellH)

  // 按真实标签分组画点
  const groups = new Map<number, [number, number][]>()
  ds.data.forEach((row, i) => {
    const g = ds.labels[i]
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push([row[0], row[1]])
  })
  const series: EChartsOption['series'] = [
    {
      name: '决策概率',
      type: 'custom',
      /*
       * ⚠️ encode 只把**第 0、1 维**绑到 x/y 轴。
       * 不要写成 `{ x: [0, 2], y: [1, 3] }` —— 那样 echarts 会把两个维度
       * 当成"轴上的一个区间"，矩形反而会塌掉（试过，渲染结果和没写 encode 一样）。
       * 宽高（第 2、3 维）在 renderItem 里用 api.value 单独取，再自己换成像素。
       */
      dimensions: ['x', 'y', 'w', 'h', 'p'],
      encode: { x: 0, y: 1 },
      // 自定义系列必须自己实现 renderItem
      renderItem: renderCell,
      data: cells,
      silent: true,
      z: 1,
      /*
       * ⚠️ 关掉渐进渲染，别改成 true。
       *
       * echarts 对自定义系列默认按 `progressive` 分批建元素（默认每批 3000 个）。
       * 分批本身没问题，但**这里必须一次性建完**——原因是我们靠 `z: 1` 让概率场
       * 压在散点(s=4)下面，而分批渲染的元素会被标记 `incremental` 走另一条绘制分支，
       * 实测会出现"只画出最先一批格子"的现象（5184 格只铺出底部一条）。
       *
       * 5184 个纯色矩形一次性建完的开销是可接受的（实测首屏无感），
       * 所以直接 `progressive: false`，行为最确定。
       */
      progressive: false,
    },
  ]

  ;[...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .forEach(([g, pts]) => {
      series.push({
        name: `${ds.classNames[g] ?? `类别 ${g}`}（${pts.length}）`,
        type: 'scatter',
        symbolSize: ds.data.length > 400 ? 5 : 7,
        data: pts,
        itemStyle: {
          color: PALETTE[g % PALETTE.length],
          opacity: 0.82,
          borderColor: p.surface,
          borderWidth: 0.6,
        },
        z: 4,
      })
    })

  const axisStyle = {
    axisLine: { lineStyle: { color: p.axis } },
    axisLabel: { color: p.axis, fontSize: 11 },
    nameTextStyle: { color: p.sub, fontSize: 11 },
    splitLine: { lineStyle: { color: p.split } },
  }

  return {
    grid: { left: 50, right: 18, top: 34, bottom: 42, containLabel: false },
    legend: { top: 0, right: 0, type: 'scroll', textStyle: { color: p.sub, fontSize: 11 } },
    tooltip: {
      trigger: 'item',
      backgroundColor: p.surface,
      borderColor: p.split,
      textStyle: { color: p.text, fontSize: 12 },
      formatter: (prm: unknown) => {
        const q = prm as { data: unknown; seriesName: string }
        // 热力图的点不进 tooltip
        if (q.seriesName === '决策概率') return ''
        const d = q.data as number[]
        return `${q.seriesName}<br/>(${Number(d[0]).toFixed(2)}, ${Number(d[1]).toFixed(2)})`
      },
    },
    xAxis: {
      type: 'value',
      min: round(x0, 3),
      max: round(x1, 3),
      name: ds.featureNames[0],
      nameLocation: 'middle',
      nameGap: 26,
      ...axisStyle,
    },
    yAxis: {
      type: 'value',
      min: round(y0, 3),
      max: round(y1, 3),
      name: ds.featureNames[1],
      nameLocation: 'middle',
      nameGap: 34,
      ...axisStyle,
    },
    series,
  }
}
const spaceChart = createChart(spaceEl, buildSpaceOption)

/* ---------------- 训练曲线 ---------------- */
const lossEl = document.getElementById('chart-loss')
if (!lossEl) throw new Error('#chart-loss 不存在')

const buildLossOption = (): EChartsOption => {
  const p = palette()
  const ep = history.loss.map((_, i) => i + 1)
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
    },
    xAxis: { type: 'category', data: ep, name: 'epoch', nameGap: 24, ...axisStyle },
    yAxis: [
      { type: 'value', name: '损失', ...axisStyle },
      { type: 'value', name: '准确率', max: 1, min: 0, ...axisStyle, splitLine: { show: false } },
    ],
    series: [
      {
        name: '训练损失',
        type: 'line',
        data: history.loss.map((v) => round(v, 5)),
        showSymbol: false,
        lineStyle: { color: '#dc2626', width: 2 },
        itemStyle: { color: '#dc2626' },
      },
      {
        name: '准确率',
        type: 'line',
        yAxisIndex: 1,
        data: history.acc.map((v) => round(v, 5)),
        showSymbol: false,
        lineStyle: { color: '#0d9488', width: 2, type: 'dashed' },
        itemStyle: { color: '#0d9488' },
      },
    ],
  }
}
const lossChart = createChart(lossEl, buildLossOption)

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
makeMetric('acc', '训练准确率', '这一批数据上分对了多少')
makeMetric('loss', '训练损失', '交叉熵。完全没学会时约等于 ln2')
makeMetric('params', '参数个数', '所有权重 + 偏置的总数')
makeMetric('grad', '首层 / 末层梯度', '比值极小 = 梯度消失，前面几层几乎没在学')
makeMetric('struct', '实际结构', '输入 → 隐层 → 输出')

const spaceHint = document.getElementById('space-hint')
const trainStatus = document.getElementById('train-status')

/* ---------------- 统计参数个数 ---------------- */
function countParams(): number {
  let n = 0
  for (let l = 0; l < net.W.length; l++) {
    n += net.W[l].length * net.W[l][0].length
    n += net.b[l].length
  }
  return n
}

/* ---------------- 代码面板 ---------------- */
const codeEl = document.getElementById('code')
const KEYWORDS = ['import', 'from', 'def', 'return', 'for', 'in', 'as']
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
  const s = sizes()
  const isBinary = ds.nClasses === 2
  const outLine = isBinary
    ? '# 输出层 1 个 logit（不是 2 个！用 sigmoid 压成 P(y=1)）'
    : `# 输出层 ${ds.nClasses} 个 logit，用 softmax 归一化`
  const lines = [
    '# ① 这一页自己做的是这些（数字都是"这一次训练"的结果）',
    `sizes = ${JSON.stringify(s)}   # 输入 → 隐层 → 输出`,
    '',
    'def forward(X):',
    '    a, cache = X, []',
    '    for W, b in zip(weights, biases):',
    `        z = a @ W + b                       # 线性变换`,
    `        a = z if last_layer else ${act === 'identity' ? 'z' : `${ACTIVATIONS[act].label}(z)`}`.padEnd(40) + '# 非线性激活',
    '        cache.append((a, z))',
    '    return a, cache',
    '',
    'def backward(cache, y):',
    '    delta = (sigmoid(z_out) - y) / n        # 输出层误差 = (p - y)/n',
    '    for l in reversed(range(L)):',
    '        dW[l] = a[l-1].T @ delta            # 权重梯度',
    '        db[l] = delta.sum(axis=0)           # 偏置梯度',
    '        delta = (delta @ W[l].T) * df(z[l-1])   # 往回流：链式法则',
    '',
    'for epoch in range(epochs):',
    '    W -= lr * dW                            # 按梯度反方向走一小步',
    '',
    `# ② 当前这次训练的实测结果`,
    `# 结构 ${JSON.stringify(s)}　激活 ${ACTIVATIONS[act].label}　lr=${lr}　batch=${batchSize}`,
    `# 准确率 ${(lastAcc() * 100).toFixed(1)}%　损失 ${lastLoss().toFixed(4)}`,
    outLine,
    '',
    '# ③ sklearn 的等价写法',
    'from sklearn.neural_network import MLPClassifier',
    '',
    `clf = MLPClassifier(hidden_layer_sizes=${JSON.stringify(hidden)}, activation=${JSON.stringify(
      act === 'identity' ? 'identity' : act,
    )},`.padEnd(96) + '# identity 对应无激活',
    `                    learning_rate_init=${lr}, batch_size=${batchSize}, max_iter=${epochs})`,
    'clf.fit(X, y)',
    '# 注意：sklearn 默认用 Adam，这一页用朴素 SGD —— 因为 SGD 的每一步最好解释。',
  ]
  return lines.filter((l) => l !== '').map(highlight).join('\n')
}

function lastAcc(): number {
  return history.acc[history.acc.length - 1] ?? 0
}
function lastLoss(): number {
  return history.loss[history.loss.length - 1] ?? Math.log(2)
}

/* ---------------- 刷新 ---------------- */
function refresh(): void {
  spaceChart.update()
  lossChart.update()

  const acc = lastAcc()
  const loss = lastLoss()
  metricValues['acc']!.textContent = `${(acc * 100).toFixed(1)}%`
  metricValues['loss']!.textContent = loss.toFixed(4)
  metricValues['params']!.textContent = String(countParams())
  metricValues['grad']!.textContent = Number.isFinite(gradRatio)
    ? gradRatio < 1e-3
      ? `${gradRatio.toExponential(1)} ⚠️`
      : gradRatio.toExponential(2)
    : '—'
  metricValues['struct']!.textContent = sizes().join(' → ')

  // 主图说明：这一页的重点是"边界长什么样"
  const linear = act === 'identity'
  if (spaceHint) {
    spaceHint.innerHTML = linear
      ? `<strong>当前是「线性（无激活）」——多层网络已经退化成一条直线。</strong>` +
        `数学上：<span class="math" data-tex="a^{(2)} = a^{(0)}W^{(1)}W^{(2)}"></span>，` +
        `再加层也还是同一个矩阵。所以边界永远是一条直线。` +
        (ds.id === 'xor'
          ? ` 异或是线性不可分的，<strong>它学不会</strong>——看损失卡在 ${Math.log(2).toFixed(4)} 附近。`
          : '')
      : `背景颜色是网络对"<strong>${ds.classNames[1] ?? '类别 1'}</strong>"的预测概率，` +
        `颜色交界处就是<strong>决策边界</strong>。` +
        `结构 ${sizes().join('-')}，共 ${countParams()} 个参数。`
  }

  if (trainStatus) {
    const hitEpoch = history.acc.findIndex((v) => v >= 0.95) + 1
    trainStatus.innerHTML =
      `训了 <strong>${history.loss.length}</strong> 轮：` +
      `损失 ${history.loss[0]!.toFixed(4)} → <strong>${loss.toFixed(4)}</strong>，` +
      `准确率 <strong>${(acc * 100).toFixed(1)}%</strong>` +
      (hitEpoch > 0 ? `（第 ${hitEpoch} 轮首次达到 95%）` : `（<strong>没达到 95%</strong>）`) +
      `。<br>` +
      (linear
        ? `激活是「线性」，无论多少层都只是线性模型。`
        : `首层梯度 / 末层梯度 = <strong>${Number.isFinite(gradRatio) ? gradRatio.toExponential(2) : '—'}</strong>` +
          (gradRatio < 1e-3 ? '，<strong>梯度消失明显</strong>：前面几层几乎收不到学习信号。' : '，梯度传得回去。')) +
      `<br>每次点「重新训练」会换一个随机种子，所以边界会略有不同——但大体形状是稳定的。`
  }

  if (codeEl) codeEl.innerHTML = renderCode()
  renderMath(document.getElementById('train-status') ?? document.body)
  renderMath(document.getElementById('space-hint') ?? document.body)
}

/* ---------------- 控件 ---------------- */
const host = document.getElementById('controls')
const handles: Record<string, SliderHandle> = {}

/**
 * 重建隐层滑杆与结构按钮。
 *
 * 结构用"每层神经元数"的滑杆表示，最多 3 个隐层。
 * 这里刻意不做过多的自动调参——让用户自己试出"不够用 / 够用 / 过量"的差别。
 */
function rebuildControls(): void {
  if (!host) return
  host.innerHTML = ''
  for (const k of Object.keys(handles)) delete handles[k]

  const nHidden = hidden.length
  const mkLayer = (idx: number) => {
    handles[`h${idx}`] = mountSlider(host, {
      label: `第 ${idx + 1} 个隐层的神经元数`,
      min: 1,
      max: 32,
      step: 1,
      value: hidden[idx]!,
      hint: idx === 0 ? '太少 → 学不动；够用之后再加，只加快收敛' : undefined,
      format: (v) => v.toFixed(0),
      onInput: (v) => {
        hidden[idx] = Math.round(v)
        scheduleRetrain()
      },
    })
  }
  for (let i = 0; i < nHidden; i++) mkLayer(i)

  handles['lr'] = mountSlider(host, {
    label: '学习率',
    min: 0.01,
    max: 3,
    step: 0.01,
    value: lr,
    precision: 2,
    hint: '太小走得慢；这个数据已归一化，所以大一点也不会炸',
    format: (v) => v.toFixed(2),
    onInput: (v) => {
      lr = v
      scheduleRetrain()
    },
  })
  handles['batch'] = mountSlider(host, {
    label: '批大小 batch',
    min: 1,
    max: Math.max(2, ds.data.length),
    step: 1,
    value: Math.min(batchSize, ds.data.length),
    hint: 'batch = 1 是真随机下降；等于全量就是确定性下降',
    format: (v) => v.toFixed(0),
    onInput: (v) => {
      batchSize = Math.round(v)
      scheduleRetrain()
    },
  })
  handles['epochs'] = mountSlider(host, {
    label: '训练轮数 epochs',
    min: 20,
    max: 1200,
    step: 20,
    value: epochs,
    hint: '轮数太少看不出收敛，太多则训练变慢',
    format: (v) => v.toFixed(0),
    onInput: (v) => {
      epochs = Math.round(v)
      scheduleRetrain()
    },
  })
}

/*
 * 拖滑杆时不要每一帧都重训（一次训练可能上百毫秒）。
 * 用 120ms 的防抖，手感基本是"松手就更新"。
 */
let pending: number | null = null
function scheduleRetrain(): void {
  if (pending !== null) window.clearTimeout(pending)
  pending = window.setTimeout(() => {
    pending = null
    runTrain()
  }, 120)
}

/* ---------------- 数据集 / 激活函数 ---------------- */
const selData = document.getElementById('sel-data') as HTMLSelectElement | null
const selAct = document.getElementById('sel-act') as HTMLSelectElement | null
const dataDesc = document.getElementById('data-desc')

if (selAct) {
  ;(['relu', 'tanh', 'logistic', 'identity'] as Activation[]).forEach((a) => {
    const o = document.createElement('option')
    o.value = a
    o.textContent = ACTIVATIONS[a].label
    selAct.append(o)
  })
  selAct.value = act
  selAct.addEventListener('change', () => {
    act = selAct.value as Activation
    // 隐层神经元太少时，logistic/tanh 在异或上收敛很慢（实测 sigmoid 要 133 轮），
    // 这里不自动改结构，让用户自己体会；只重置种子保证边界稳定。
    runTrain()
  })
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
    // 用数据集建议的结构重置：这些结构是实测"能训好"的，
    // 否则切过去一片糊，用户会以为是页面坏了。
    hidden = ds.suggested.slice(1, -1)
    // 学习率也要一起换：它和**数据尺度**耦合。
    // 二维玩具数据在 [-1,1] 附近，lr=0.3 合适；鸢尾花是原始量纲（差近两个数量级），
    // 同样的 0.3 会让训练卡在"三类各 1/3"（损失停在 ln3≈1.10）。
    // 实测鸢尾花 lr=0.1 → 98%，lr=0.3 → 33%。这不是 bug，是真实规律，页面上能玩出来。
    lr = ds.suggestedLr
    B = boundsOf()
    batchSize = Math.min(32, ds.data.length)
    seed = 1
    rebuildControls()
    if (dataDesc) dataDesc.textContent = ds.desc
    runTrain()
  })
}

/* ---------------- 按钮 ---------------- */
document.getElementById('btn-train')?.addEventListener('click', () => {
  // 换一个种子 → 重新初始化 → 边界会变（体现"随机性"）
  runTrain(epochs, Math.floor(Math.random() * 100000) + 1)
})

document.getElementById('btn-more')?.addEventListener('click', () => {
  // 在当前权重上继续训 200 轮（不重新初始化）
  const cfg = { activation: act, lr, batchSize, nClasses: ds.nClasses, seed }
  const res = train(net, ds.data, ds.labels, cfg, 200, seed)
  net = res.net
  history = {
    loss: [...history.loss, ...res.history.loss],
    acc: [...history.acc, ...res.history.acc],
  }
  gradRatio = computeGradRatio()
  refresh()
})

document.getElementById('btn-reset')?.addEventListener('click', () => {
  hidden = ds.suggested.slice(1, -1)
  act = 'relu'
  lr = ds.suggestedLr
  batchSize = Math.min(32, ds.data.length)
  epochs = 300
  seed = 1
  if (selAct) selAct.value = act
  rebuildControls()
  runTrain()
})

/* ---------------- 上下篇 ---------------- */
mountPager('neural-network')

/* ---------------- 首屏 ---------------- */
batchSize = Math.min(32, ds.data.length)
rebuildControls()
if (dataDesc) dataDesc.textContent = ds.desc
runTrain()

// 暴露给 e2e 的内部状态（调试钩子，不影响页面呈现）
;(window as unknown as { __nn?: unknown }).__nn = {
  get ds() {
    return ds.id
  },
  get act() {
    return act
  },
  get sizes() {
    return sizes()
  },
  get acc() {
    return lastAcc()
  },
  get loss() {
    return lastLoss()
  },
  get params() {
    return countParams()
  },
  get gradRatio() {
    return gradRatio
  },
  get lr() {
    return lr
  },
  get epochs() {
    return history.loss.length
  },
  /** 决策网格上的概率场（e2e 用它验证"没有激活时边界是直线"） */
  grid: (res: number) => decisionGrid(net, [B[0], B[1]], [B[2], B[3]], res, ds.nClasses, act),
  /** 直接读某点的预测概率 */
  probaAt: (x: number, y: number) => predictProba(net, [[x, y]], ds.nClasses, act)[0],
  /** 重新训练（给 e2e 用的确定性入口） */
  retrain: (ep: number, sd: number) => runTrain(ep, sd),
  /**
   * 量的梯度衰减专用探针：**在随机初始化的网络上**测首层/末层梯度范数比。
   *
   * 为什么不复用训练后的 gradRatio？因为训练会把权重调向"好用"的配置，
   * 梯度比值随之变化（logistic 4 层训练后升到 2.7e-2，衰减不再锐利）。
   * 想干净地暴露"饱和激活在深层网络里梯度传不回去"这件事，
   * 要在**未经训练的随机网络**上量，并且层数要够深（8 层时 logistic 掉到 1e-6 量级）。
   */
  gradRatioProbe: (hiddenLayers: number[], a: Activation) => {
    const s = [ds.nFeatures, ...hiddenLayers, outUnits(ds.nClasses)]
    const probe = initNet(s, 3)
    const Y = oneHot(ds.labels, ds.nClasses)
    const cache = forward(probe, ds.data, a)
    const { dW } = backward(probe, cache, ds.data, Y, ds.nClasses, a)
    const norm = (m: Matrix) => Math.sqrt(m.flat().reduce((acc, v) => acc + v * v, 0))
    const first = norm(dW[0])
    const last = norm(dW[dW.length - 1])
    return { ratio: last > 1e-300 ? first / last : Infinity, layers: dW.length, sizes: s }
  },
  /** 设置结构与激活（给 e2e 用）。lr 可选，不传则保持当前值 */
  configure: (h: number[], a: Activation, newLr?: number) => {
    hidden = h.slice()
    act = a
    if (newLr !== undefined) lr = newLr
    rebuildControls()
    if (selAct) selAct.value = a
    runTrain()
  },
}


/* ---------------- Nya 助教：让她看见这一页 ---------------- */
/*
 * 用通用读取器，不手写这一页有哪些数字。
 * 它读的是「屏幕上已经显示出来的字」——指标卡、滑杆、下拉框 ——
 * 所以拖完滑杆再问她，报的就是新值（每次调用重新读，不缓存）。
 * 键名要和 chat/nya.ts 里这一页的 stateKeys 逐字一致，否则会被安静地丢掉。
 */
provideNyaStateFromPage()
