/**
 * 首页。
 *
 * 这一版的排版思路：**每一屏给一个明确的角色**，而不是重复"标题 + 卡片网格"。
 *
 *   hero      定位一句话 + 四个硬数字 + 「参数↔代码」取样面板
 *   学习路线   一条有方向的横向流（不是一排胶囊）
 *   各模块     两位编号 + 标题 + 描述 + 渐隐分隔线
 *   演示卡片   编号 / 图标 / 描述 / sklearn 入口 各有位置
 *   差异化     带编号的条目，左侧一道竖条
 *
 * 所有数字都来自项目里的真实情况（演示数、算法模块数、对拍套数），
 * 不写估算值 —— 首页是门面，宁可少写一个数字也不要写错的。
 */
import { mountChrome, DEMOS, MODULES, getVisited, learningPath, demoById, siteUrl, type DemoMeta } from '../bootstrap'
import siteStats from '../data/siteStats.json'

mountChrome()

/*
 * 页面断言总数：单一来源在 `src/data/siteStats.json`，
 * 并且被 `npm run verify:all` 校验（实际跑出来的总数对不上就判失败），
 * 所以这个数字不会悄悄过期。
 */
const PAGE_ASSERTIONS = siteStats.pageAssertions

const root = document.getElementById('home-root')
if (!root) throw new Error('#home-root 不存在')

/*
 * hero 里的断言数字由这里注入。
 * 写死在 HTML 里迟早会变成假话（加了断言没人记得改），所以留一个占位放在 HTML、
 * 由 JSON 填。
 */
const assertionsEl = document.getElementById('stat-assertions')
if (assertionsEl) assertionsEl.textContent = String(PAGE_ASSERTIONS)

const visited = new Set(getVisited())

/** 两位编号：1 → "01" */
const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 全局序号：用于卡片右上角，跟 DEMOS 顺序一致 */
const indexOf = new Map(DEMOS.map((d, i) => [d.id, i + 1]))

/* ------------------------------------------------------------------ *
 * Hero 里的迷你损失曲线
 *
 * 复用背景层那条曲线的同一套公式（前期陡降 + 逐渐消失的振荡），
 * 保证首页的"示意"和背景的"氛围"是同一条线，不是随手画的。
 * ------------------------------------------------------------------ */

function buildSpark(): void {
  const svg = document.querySelector<SVGSVGElement>('.hero .spark')
  if (!svg) return
  const W = 240
  const H = 56
  const N = 60

  const pts: [number, number][] = []
  for (let i = 0; i < N; i++) {
    const u = i / (N - 1)
    const v = 0.97 * Math.exp(-4.1 * u) + 0.05 + 0.028 * Math.sin(u * 19) * Math.exp(-2.2 * u)
    pts.push([u * W, H - Math.min(1, Math.max(0, v)) * H])
  }
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')
  const area = `${line} L${W} ${H} L0 ${H} Z`

  const NS = 'http://www.w3.org/2000/svg'
  const defs = document.createElementNS(NS, 'defs')
  defs.innerHTML =
    '<linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0%" stop-color="var(--danger)" stop-opacity="0.22"/>' +
    '<stop offset="100%" stop-color="var(--danger)" stop-opacity="0"/>' +
    '</linearGradient>'

  const areaPath = document.createElementNS(NS, 'path')
  areaPath.setAttribute('d', area)
  areaPath.setAttribute('class', 'spark-area')

  const linePath = document.createElementNS(NS, 'path')
  linePath.setAttribute('d', line)

  svg.append(defs, areaPath, linePath)
}

buildSpark()

/* ------------------------------------------------------------------ *
 * 学习路线：画成一条有方向的流
 * ------------------------------------------------------------------ */

function buildPipeline(): HTMLElement {
  const path = learningPath()
  const wrap = document.createElement('div')
  wrap.className = 'pipeline-wrap'

  const flow = document.createElement('div')
  flow.className = 'pipeline'

  path.forEach((d, i) => {
    if (i > 0) {
      const arrow = document.createElement('span')
      arrow.className = 'pipe-arrow'
      arrow.setAttribute('aria-hidden', 'true')
      flow.append(arrow)
    }

    const item = document.createElement('div')
    item.className = 'pipe-item'

    const live = d.status === 'live'
    const node = document.createElement(live ? 'a' : 'span')
    node.className = 'pipe-node'
    if (visited.has(d.id)) node.classList.add('is-done')
    else if (live && i === firstUnvisited(path)) node.classList.add('is-current')
    /* 走 siteUrl：DEMOS 里的 href 是站点根相对路径，直接赋给 href 只在首页碰巧成立 */
    if (live) (node as HTMLAnchorElement).href = siteUrl(d.href)

    const no = document.createElement('span')
    no.className = 'pipe-no'
    no.textContent = `STEP ${pad2(i + 1)}`

    const name = document.createElement('span')
    name.className = 'pipe-name'
    name.textContent = d.title

    node.append(no, name)

    if (visited.has(d.id)) {
      const tick = document.createElement('span')
      tick.className = 'pipe-done-tick'
      tick.textContent = '✓'
      tick.title = '学过'
      node.append(tick)
    }

    item.append(node)
    flow.append(item)
  })

  wrap.append(flow)
  return wrap
}

/** 第一个"已上线但没学过"的下标；都学过就返回 -1 */
function firstUnvisited(path: DemoMeta[]): number {
  return path.findIndex((d) => d.status === 'live' && !visited.has(d.id))
}

/* ------------------------------------------------------------------ *
 * 分区标题
 * ------------------------------------------------------------------ */

function buildSecHead(no: string, title: string, desc: string): HTMLElement {
  const head = document.createElement('div')
  head.className = 'sec-head'

  const n = document.createElement('span')
  n.className = 'sec-no'
  n.textContent = no

  const t = document.createElement('div')
  t.className = 'sec-title'
  const h2 = document.createElement('h2')
  h2.textContent = title
  const p = document.createElement('p')
  p.textContent = desc
  t.append(h2, p)

  const rule = document.createElement('span')
  rule.className = 'sec-rule'
  rule.setAttribute('aria-hidden', 'true')

  head.append(n, t, rule)
  return head
}

/* ------------------------------------------------------------------ *
 * 演示卡片
 * ------------------------------------------------------------------ */

function cardFor(id: string): HTMLElement {
  const d = demoById(id)!
  const live = d.status === 'live'
  const el = document.createElement(live ? 'a' : 'div')
  el.className = 'demo-card' + (live ? '' : ' is-disabled')
  if (live) (el as HTMLAnchorElement).href = siteUrl(d.href)

  const top = document.createElement('div')
  top.className = 'demo-card-top'
  const icon = document.createElement('span')
  icon.className = 'demo-card-icon'
  icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d.icon}</svg>`
  const no = document.createElement('span')
  no.className = 'demo-card-no'
  no.textContent = pad2(indexOf.get(id) ?? 0)
  top.append(icon, no)

  const title = document.createElement('h3')
  title.textContent = d.title

  const desc = document.createElement('p')
  desc.textContent = d.subtitle

  // sklearn 入口：本站「参数 ↔ 代码」卖点的最小体现
  const api = document.createElement('span')
  api.className = 'demo-card-api'
  api.textContent = d.api
  api.title = `对应 sklearn 入口：${d.api}`

  const foot = document.createElement('div')
  foot.className = 'demo-card-foot'
  const badge = document.createElement('span')
  badge.className = 'badge ' + (live ? 'badge-live' : 'badge-soon')
  badge.textContent = live ? '已上线' : '即将上线'
  foot.append(badge)
  if (visited.has(d.id)) {
    const done = document.createElement('span')
    done.className = 'badge'
    done.textContent = '学过'
    foot.append(done)
  }

  el.append(top, title, desc, api, foot)
  return el
}

/* ------------------------------------------------------------------ *
 * 组装
 * ------------------------------------------------------------------ */

// 编号从 01 开始，按"路线 + 模块"的顺序连排，营造章节感
let secNo = 1

const pathSection = document.createElement('section')
pathSection.className = 'section'
pathSection.append(buildSecHead(pad2(secNo++), '建议学习路线', '按知识依赖排序；学过的会自动打上标记'))
pathSection.append(buildPipeline())

const sections: HTMLElement[] = [pathSection]
for (const m of MODULES) {
  const list = DEMOS.filter((d) => d.module === m.id)
  if (list.length === 0) continue
  const sec = document.createElement('section')
  sec.className = 'section'
  sec.append(buildSecHead(pad2(secNo++), m.name, m.desc))
  const grid = document.createElement('div')
  grid.className = 'grid'
  list.forEach((d) => grid.append(cardFor(d.id)))
  sec.append(grid)
  sections.push(sec)
}

root.append(...sections)

/* ------------------------------------------------------------------ *
 * 差异化说明
 *
 * 这一块原来有 7 条等权条目，其中 5 条 hero 上已经说过（深浅色、响应式、
 * 参数即代码、算法手写、数字有出处都重复出现），而区块编号 07 又和条目的
 * 01–07 撞车。现在只留 3 条真正区别于同类教学站的，各配一句**可验证的事实**，
 * 其余 4 条收成一行小字 —— 信息没丢，但有了权重，也不再和编号冲突。
 * ------------------------------------------------------------------ */

const featuresEl = document.getElementById('features')
if (featuresEl) {
  featuresEl.append(
    buildSecHead(pad2(secNo++), '和别的演示站有什么不一样', '参考过同类的教学站之后，我们补上了这几块'),
  )

  /** 证据里可以夹行内代码，用 { code } 标出来 */
  type Seg = string | { code: string }

  const diffs: { title: string; body: Seg[] }[] = [
    {
      title: '参数即代码',
      body: [
        '滑杆旁边跟着等价的 sklearn 写法，玩完直接带走。每张演示卡片都标着对应入口，例如 ',
        { code: 'LinearRegression' },
        '。',
      ],
    },
    {
      title: '算法全部手写',
      body: [
        '10 个算法模块零第三方数学库，前端的运行时依赖只有 ECharts 和 KaTeX —— ',
        '前者画图、后者排版公式，没有一个在替我们算模型。',
      ],
    },
    {
      title: '每个数字都能复跑',
      body: [
        '页面上每个数字都来自一次真实运行。',
        { code: 'npm run verify:all' },
        ' 一条命令把 ',
        { code: `${PAGE_ASSERTIONS} 项页面断言` },
        ' 和十套 sklearn 对拍全部重跑一遍。',
      ],
    },
  ]

  const grid = document.createElement('div')
  grid.className = 'diff-grid'
  for (const d of diffs) {
    const card = document.createElement('div')
    card.className = 'diff-card'
    const h = document.createElement('h3')
    h.textContent = d.title
    const p = document.createElement('p')
    for (const seg of d.body) {
      if (typeof seg === 'string') {
        p.append(document.createTextNode(seg))
      } else {
        const c = document.createElement('code')
        c.textContent = seg.code
        p.append(c)
      }
    }
    card.append(h, p)
    grid.append(card)
  }

  // 原来那 7 条里剩下的 4 条：不是差异点，但也不该丢，收成一行
  const more = document.createElement('p')
  more.className = 'diff-more'
  more.textContent = '另外还有：学习路径 · 每页思考题 · 深浅色 · 完整响应式'

  featuresEl.append(grid, more)
}

/* 首页也算访问过，避免路径条全灰 */
if (demoById('linear-regression')?.status === 'live' && visited.size === 0) {
  const hint = document.querySelector<HTMLElement>('[data-first-hint]')
  if (hint) hint.style.display = 'block'
}
