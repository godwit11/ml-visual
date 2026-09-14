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
import {
  mountChrome,
  DEMOS,
  MODULES,
  getVisited,
  learningPath,
  demoById,
  siteUrl,
  provideNyaStateFromPage,
  type DemoMeta,
} from '../bootstrap'
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
/* 导航栏「演示」的锚点要落在第一个模块区块上（此前 #demos 根本不存在，点了没反应） */
let demosAnchorAssigned = false

for (const m of MODULES) {
  const list = DEMOS.filter((d) => d.module === m.id)
  if (list.length === 0) continue
  const sec = document.createElement('section')
  sec.className = 'section'
  if (!demosAnchorAssigned) {
    sec.id = 'demos'
    demosAnchorAssigned = true
  }
  sec.append(buildSecHead(pad2(secNo++), m.name, m.desc))
  const grid = document.createElement('div')
  grid.className = 'grid'
  list.forEach((d) => grid.append(cardFor(d.id)))
  sec.append(grid)
  sections.push(sec)
}

root.append(...sections)

/* 首页也算访问过，避免路径条全灰 */
if (demoById('linear-regression')?.status === 'live' && visited.size === 0) {
  const hint = document.querySelector<HTMLElement>('[data-first-hint]')
  if (hint) hint.style.display = 'block'
}

/* ---------------- Nya 助教：让她知道学生在首页 ---------------- */
/*
 * 首页是唯一一个**没有指标卡**的页面（没有滑杆、没有数字），所以通用读取器
 * 在这里取不到任何东西 —— 但首页有它自己的事实：学生看过了哪几页。
 * 这里是 `extra` 参数的正当用法：补一个页面上没写出来、但确实存在的量。
 *
 * ⚠️ 不报"访问过几页"以外的推断（比如"他大概想学分类"）——
 *    那是猜，不是读。她该说的是"你已经看过线性回归"，不是"你看起来偏好奇迹"。
 */
provideNyaStateFromPage(() => {
  const seen = getVisited()
  const live = DEMOS.filter((d) => d.status === 'live')
  const titles = seen.map((id) => demoById(id)?.title ?? id)
  return {
    已看过的页数: `${seen.length} / ${live.length}`,
    看过的页: titles.length > 0 ? titles.join('、') : '（一页都还没看）',
  }
})
