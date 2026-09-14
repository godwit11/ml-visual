/**
 * 朴素贝叶斯演示页（真实短信语料）。
 *
 * 这一页的"主角"是中间那块输入框：改一句话，就能看到 150 个词各自把票投给了谁，
 * 以及先验和"未出现的词"分别贡献了多少。判决过程被完全摊开，不是黑盒。
 *
 * 三块内容：
 *   1. 词的对数几率比图 —— 哪些词几乎"一票定罪"
 *   2. 亲手试一条 —— 判决分数的逐项分解 + 命中词明细
 *   3. 代码 / 原理 / 思考题（统一范式）
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
  trainNb,
  nbPredict,
  nbLogJoint,
  logOddsRatio,
  evaluateNb,
  type NbModel,
  type NbModelResult,
} from '../algorithms/naiveBayes'
import { loadSmsCorpus, tokenizeSms, SMS_SAMPLES, type SmsCorpus } from '../data/smsData'

mountChrome()
renderMath(document)
markVisited('naive-bayes')

/* ---------------- 语料与状态 ---------------- */
const corpus: SmsCorpus = loadSmsCorpus()
const vocabIndex = new Map<string, number>()
corpus.vocab.forEach((w, i) => vocabIndex.set(w, i))

let modelKind: NbModel = 'bernoulli'
let logAlpha = 0 // α = 10^logAlpha
const alpha = () => 10 ** logAlpha

let model: NbModelResult = trainNb(corpus.X, corpus.y, corpus.n, corpus.d, {
  model: modelKind,
  alpha: alpha(),
})

const COL_HAM = '#6366f1'
const COL_SPAM = '#dc2626'

/* ---------------- 图：词的对数几率比 ---------------- */
const oddsEl = document.getElementById('chart-odds')
if (!oddsEl) throw new Error('#chart-odds 不存在')

const TOP_N = 12

const buildOddsOption = (): EChartsOption => {
  const p = palette()
  const odds = logOddsRatio(model, 1, 0)
  const idx = odds.map((v, j) => [v, j] as [number, number])
  idx.sort((a, b) => b[0] - a[0])
  const picked = [...idx.slice(0, TOP_N), ...idx.slice(-TOP_N)]
  // 从最像 spam 到最像 ham 排好，配合 inverse 轴从上往下显示
  const words = picked.map(([, j]) => corpus.vocab[j])
  const values = picked.map(([v]) => round(v, 4))
  const axisStyle = {
    axisLine: { lineStyle: { color: p.axis } },
    axisLabel: { color: p.axis, fontSize: 11 },
    nameTextStyle: { color: p.sub, fontSize: 11 },
    splitLine: { lineStyle: { color: p.split } },
  }
  return {
    grid: { left: 92, right: 30, top: 16, bottom: 40, containLabel: false },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      backgroundColor: p.surface,
      borderColor: p.split,
      textStyle: { color: p.text, fontSize: 12 },
      formatter: (prms: unknown) => {
        const arr = prms as { name: string; value: number }[]
        const q = arr[0]
        const v = Number(q.value)
        return `<strong>${q.name}</strong><br/>对数几率比 ${v.toFixed(3)}<br/>` +
          `（${v > 0 ? '更像垃圾短信' : '更像正常短信'}）`
      },
    },
    xAxis: {
      type: 'value',
      name: 'ln [ P(w|spam) / P(w|ham) ]',
      nameLocation: 'middle',
      nameGap: 26,
      ...axisStyle,
    },
    yAxis: {
      type: 'category',
      data: words,
      inverse: true,
      axisLine: { lineStyle: { color: p.axis } },
      axisLabel: {
        color: p.text,
        fontSize: 12,
        formatter: (name: string) => name,
      },
      axisTick: { show: false },
    },
    series: [
      {
        type: 'bar',
        data: values.map((v) => ({
          value: v,
          itemStyle: { color: v > 0 ? COL_SPAM : COL_HAM, opacity: 0.85 },
        })),
        barWidth: '62%',
        markLine: {
          silent: true,
          symbol: 'none',
          data: [{ xAxis: 0 }],
          lineStyle: { color: p.axis, width: 1.4 },
          label: { show: false },
        },
        label: {
          show: true,
          position: 'right',
          // ECharts 的 label formatter 参数类型很宽（value 可能是数组/对象），这里只取数值
          formatter: (prm: { value?: unknown }) => Number(prm.value ?? 0).toFixed(2),
          color: p.sub,
          fontSize: 11,
        },
      },
    ],
  }
}
const oddsChart = createChart(oddsEl, buildOddsOption)

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
makeMetric('acc', '准确率', '在全部 5574 条短信上')
makeMetric('prec', '精确率', '判为垃圾的里有多少真是')
makeMetric('rec', '召回率', '真的垃圾里抓到了多少')
makeMetric('f1', 'F1', '精确与召回的调和平均')
makeMetric('prior', 'spam 先验', '语料本身的比例')
makeMetric('vocab', '词表 / 命中', '150 个词，平均每条命中几个')

/* ---------------- 亲手试一条 ---------------- */
const inputEl = document.getElementById('sms-input') as HTMLTextAreaElement | null
const samplesEl = document.getElementById('sms-samples')
const verdictEl = document.getElementById('verdict')
const bdEl = document.getElementById('sms-breakdown')

interface Breakdown {
  tokens: string[]
  hits: { word: string; count: number }[]
  rows: { label: string; ham: number; spam: number }[]
  total: [number, number]
  proba: [number, number]
  pred: number
}

function judge(text: string): Breakdown {
  const tokens = tokenizeSms(text)
  const counts = new Map<number, number>()
  for (const t of tokens) {
    const j = vocabIndex.get(t)
    if (j !== undefined) counts.set(j, (counts.get(j) ?? 0) + 1)
  }
  const hits = [...counts.entries()]
    .map(([j, c]) => ({ word: corpus.vocab[j], count: c }))
    .sort((a, b) => a.word.localeCompare(b.word))

  const d = corpus.d
  const isBern = model.opts.model === 'bernoulli'

  // 逐项分解：先验 / 命中词 / 未出现的词
  const prior: [number, number] = [model.classLogPrior[0], model.classLogPrior[1]]
  const hit: [number, number] = [0, 0]
  const miss: [number, number] = [0, 0]
  for (let c = 0; c < 2; c++) {
    for (const [j, cnt] of counts) {
      hit[c] +=
        isBern
          ? model.featureLogProb[c][j]
          : cnt * model.featureLogProb[c][j]
    }
    if (isBern) {
      for (let j = 0; j < d; j++) {
        if (!counts.has(j)) miss[c] += model.featureLogNeg[c][j]
      }
    }
  }

  // 用整条样本走一遍正规计算路径（避免分解式和实际实现不一致）
  const vec = new Float64Array(d)
  for (const [j, cnt] of counts) vec[j] = cnt
  const joint = nbLogJoint(model, vec)
  const mx = Math.max(...joint)
  const denom = Math.log(Math.exp(joint[0] - mx) + Math.exp(joint[1] - mx)) + mx
  const proba: [number, number] = [Math.exp(joint[0] - denom), Math.exp(joint[1] - denom)]

  return {
    tokens,
    hits,
    rows: [
      { label: '类先验 log P(y)', ham: prior[0], spam: prior[1] },
      { label: `命中的词（${hits.length} 个）的总贡献`, ham: hit[0], spam: hit[1] },
      ...(isBern
        ? [{ label: `未出现的词（${d - hits.length} 个）的总贡献`, ham: miss[0], spam: miss[1] }]
        : []),
    ],
    total: [joint[0], joint[1]],
    proba,
    pred: nbPredict(model, vec),
  }
}

function renderJudge(): void {
  if (!inputEl || !verdictEl || !bdEl) return
  const r = judge(inputEl.value)
  const isSpam = r.pred === 1
  const conf = isSpam ? r.proba[1] : r.proba[0]

  verdictEl.className = `verdict ${isSpam ? 'is-spam' : 'is-ham'}`
  verdictEl.innerHTML =
    `<span class="verdict-label">判定</span>` +
    `<span class="verdict-value">${isSpam ? '垃圾短信' : '正常短信'}</span>` +
    `<span class="verdict-proba">置信度 ${(conf * 100).toFixed(2)}%　（对数几率差 ${(
      r.total[1] - r.total[0]
    ).toFixed(2)}）</span>`

  const rows = r.rows
    .map(
      (row) =>
        `<tr><td>${row.label}</td><td>${row.ham.toFixed(3)}</td><td>${row.spam.toFixed(3)}</td></tr>`,
    )
    .join('')

  const chips = r.hits.length
    ? r.hits
        .map((h) => {
          const dh = model.featureLogProb[0][vocabIndex.get(h.word)!]
          const ds = model.featureLogProb[1][vocabIndex.get(h.word)!]
          const cls = ds - dh > 0 ? 'is-spam' : 'is-ham'
          const mult = model.opts.model === 'multinomial' ? `×${h.count}` : ''
          return `<span class="hit-chip ${cls}"><code>${h.word}${mult}</code><b>${dh.toFixed(
            2,
          )} / ${ds.toFixed(2)}</b></span>`
        })
        .join('')
    : '<span class="ctrl-hint">这句里没有任何一个词命中词表——模型只能靠先验猜</span>'

  bdEl.innerHTML =
    `<table class="bd-table">` +
    `<thead><tr><th>判决分数的构成</th><th>判为「正常」</th><th>判为「垃圾」</th></tr></thead>` +
    `<tbody>${rows}` +
    `<tr class="bd-total"><td>合计（对数联合概率）</td><td>${r.total[0].toFixed(
      3,
    )}</td><td>${r.total[1].toFixed(3)}</td></tr>` +
    `<tr class="bd-proba"><td>归一化后的后验概率</td><td>${(r.proba[0] * 100).toFixed(
      2,
    )}%</td><td>${(r.proba[1] * 100).toFixed(2)}%</td></tr>` +
    `</tbody></table>` +
    `<div class="hit-chips">${chips}</div>` +
    `<div class="ctrl-hint" style="margin-top: 10px">每个词标的是「log P(w|正常) / log P(w|垃圾)」，` +
    `按对数几率比判断偏向哪一边着色。</div>`
}

/* ---------------- 代码面板 ---------------- */
const codeEl = document.getElementById('code')
const KEYWORDS = ['from', 'import', 'print', 'def', 'return', 'as', 'in']
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
  const ev = lastEval
  const cls = modelKind === 'bernoulli' ? 'BernoulliNB' : 'MultinomialNB'
  const lines = [
    '# ① 这一页自己跑出来的结果',
    `model_kind = '${modelKind}'        # 词${modelKind === 'bernoulli' ? '出现与否' : '频'}`,
    `alpha = ${alpha().toFixed(4)}              # 拉普拉斯平滑系数`,
    `vocab_size = ${corpus.d}             # 词表只保留了高频的 ${corpus.d} 个词`,
    `log_prior = [${model.classLogPrior.map((v) => v.toFixed(3)).join(', ')}]   # log P(y)：垃圾短信只占 ${(
      (corpus.nSpam / corpus.n) * 100
    ).toFixed(1)}%`,
    '',
    '# 判决逻辑（和本页表格里那几行一一对应）',
    'score(y) = log P(y) + sum(log P(x_i | y) for i in 全部特征)',
    'y_hat = argmax(score)',
    '',
    '# ② 同一件事，用 sklearn 写',
    'from sklearn.naive_bayes import BernoulliNB, MultinomialNB',
    'from sklearn.feature_extraction.text import CountVectorizer',
    '',
    "vec = CountVectorizer(vocabulary=vocab, binary=True if kind == 'bernoulli' else False)",
    'X = vec.fit_transform(texts)',
    `clf = ${cls}(alpha=${alpha().toFixed(2)})`,
    'clf.fit(X, y)',
    '',
    `print(clf.class_log_prior_)     # ${model.classLogPrior.map((v) => v.toFixed(3)).join(', ')}`,
    `print(clf.score(X, y))          # ${ev ? ev.accuracy.toFixed(4) : '-'}（本页同口径）`,
    `print(clf.predict_log_proba(X[:1]))`,
    '',
    '# 想直观感受"一票定罪"，就去看 feature_log_prob_ 里那一列',
    "# 比如 claim 这个词：它在 ham 里的概率被平滑压到极小，log 值非常大（负得少）",
  ]
  return lines.filter((l) => l !== '').map(highlight).join('\n')
}

/* ---------------- 训练与刷新 ---------------- */
let lastEval: ReturnType<typeof evaluateNb> | null = null
const dataDesc = document.getElementById('data-desc')

function refresh(): void {
  const ev = evaluateNb(model, corpus.X, corpus.y, corpus.n)
  lastEval = ev
  metricValues['acc']!.textContent = `${(ev.accuracy * 100).toFixed(2)}%`
  metricValues['prec']!.textContent = ev.precision.toFixed(4)
  metricValues['rec']!.textContent = ev.recall.toFixed(4)
  metricValues['f1']!.textContent = ev.f1.toFixed(4)
  metricValues['prior']!.textContent = `${((corpus.nSpam / corpus.n) * 100).toFixed(2)}%`
  metricValues['vocab']!.textContent = `${corpus.d}`
  if (dataDesc) {
    const avgHits = corpus.tokensOf.reduce((a, t) => a + t.length, 0) / corpus.n
    dataDesc.innerHTML =
      `<strong>${corpus.n}</strong> 条真实短信（UCI SMS Spam Collection），` +
      `垃圾短信 <strong>${corpus.nSpam}</strong> 条（${((corpus.nSpam / corpus.n) * 100).toFixed(
        1,
      )}%）。` +
      `词表保留最高频的 ${corpus.d} 个词，平均每条短信命中 ${avgHits.toFixed(1)} 个。`
  }
  oddsChart.update()
  renderJudge()
  if (codeEl) codeEl.innerHTML = renderCode()
}

function retrain(): void {
  model = trainNb(corpus.X, corpus.y, corpus.n, corpus.d, { model: modelKind, alpha: alpha() })
  refresh()
}

/* ---------------- 控件 ---------------- */
const host = document.getElementById('controls')
const handles: Record<string, SliderHandle> = {}
if (host) {
  handles['alpha'] = mountSlider(host, {
    label: 'log₁₀ α（平滑）',
    min: -2,
    max: 2,
    step: 0.05,
    value: logAlpha,
    hint: '当前 α = 10^v。α→0 会让没见过某个词的类别概率直接归零；α 太大则词与词失去区分度',
    format: (v) => v.toFixed(2),
    onInput: (v) => {
      logAlpha = v
      retrain()
    },
  })
}

const selModel = document.getElementById('sel-model') as HTMLSelectElement | null
if (selModel) {
  selModel.value = modelKind
  selModel.addEventListener('change', () => {
    modelKind = selModel.value as NbModel
    retrain()
  })
}

/* ---------------- 示例短信 ---------------- */
if (samplesEl && inputEl) {
  SMS_SAMPLES.forEach((s) => {
    const btn = document.createElement('button')
    btn.className = 'btn btn-sm'
    btn.type = 'button'
    btn.textContent = s.label === 1 ? `试一条垃圾短信` : `试一条正常短信`
    btn.title = s.text.slice(0, 60) + '…'
    btn.addEventListener('click', () => {
      inputEl.value = s.text
      renderJudge()
    })
    samplesEl.append(btn)
  })
  inputEl.value = SMS_SAMPLES[0].text
  inputEl.addEventListener('input', renderJudge)
}

/* ---------------- 上下篇 ---------------- */
mountPager('naive-bayes')

/* ---------------- 首屏 ---------------- */
refresh()


/* ---------------- Nya 助教：让她看见这一页 ---------------- */
/*
 * 用通用读取器，不手写这一页有哪些数字。
 * 它读的是「屏幕上已经显示出来的字」——指标卡、滑杆、下拉框 ——
 * 所以拖完滑杆再问她，报的就是新值（每次调用重新读，不缓存）。
 * 键名要和 chat/nya.ts 里这一页的 stateKeys 逐字一致，否则会被安静地丢掉。
 */
provideNyaStateFromPage()
