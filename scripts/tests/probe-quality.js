/*
 * 页面质检探针：补 e2e 断言覆盖不到的三类问题。
 *
 * 为什么需要它 —— 这三类问题的共同点是「页面看起来没事，但其实是坏的」：
 *   ① **资源加载失败**：字体 / 图片 / JS chunk 404。fallback 会顶上，
 *      所以页面照常显示，只是字体回退、图表变丑或某块功能静默失效。
 *   ② **横向溢出**：某个元素撑出视口宽度，小屏上就多出一条横向滚动条 /
 *      内容被截断。桌面端常常看不出来。
 *   ③ **渲染空白**：图表容器在但没画东西（比如 ECharts 初始化时序问题），
 *      或者某个关键区块高度为 0。
 *
 * 用法（跑在目标页面上）：
 *   node scripts/e2e.mjs --url <url> --script scripts/tests/probe-quality.js
 *   node scripts/e2e.mjs --url <url> --script scripts/tests/probe-quality.js --size 420,900
 */
await sleep(1500)

const results = []
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra })

/* ---------- ① 资源加载可达性 ---------- */
const resUrls = new Set()
for (const el of document.querySelectorAll('script[src], link[rel="stylesheet"][href], img[src]')) {
  const raw = el.getAttribute('src') || el.getAttribute('href')
  if (!raw) continue
  let u
  try {
    u = new URL(raw, location.href)
  } catch {
    continue
  }
  if (u.origin !== location.origin) continue
  resUrls.add(u.pathname)
}
/* 字体是 CSS 里引的，DOM 里看不到，单独抓一次（本项目的字体走 assets/） */
for (const sheet of Array.from(document.styleSheets)) {
  let rules
  try {
    rules = sheet.cssRules
  } catch {
    continue // 跨域样式表读不到，跳过
  }
  for (const r of Array.from(rules || [])) {
    const txt = r.cssText || ''
    const m = txt.matchAll(/url\(([^)]+)\)/g)
    for (const g of m) {
      const raw = g[1].replace(/["']/g, '')
      if (raw.startsWith('data:')) continue
      try {
        const u = new URL(raw, sheet.href || location.href)
        if (u.origin === location.origin) resUrls.add(u.pathname)
      } catch {
        /* ignore */
      }
    }
  }
}

const badRes = []
for (const p of resUrls) {
  try {
    const r = await fetch(p, { method: 'GET' })
    if (!r.ok) badRes.push({ path: p, status: r.status })
  } catch (e) {
    badRes.push({ path: p, status: String(e).slice(0, 50) })
  }
}
check('引用的资源全部可加载', badRes.length === 0, badRes.length ? badRes : `${resUrls.size} 个`)

/* ---------- ② 横向溢出 ---------- */
const de = document.documentElement
const vw = window.innerWidth
const overflowPage = de.scrollWidth > vw + 1

/*
 * 找出真正撑破视口的元素，但排除两类「故意的」：
 *   · 在 overflow 容器里的（轮播、横向滚动的流水线）—— 那是设计如此
 *   · 装饰性的全屏背景层（position: fixed）
 */
const offenders = []
for (const el of Array.from(document.body.querySelectorAll('*'))) {
  const r = el.getBoundingClientRect()
  if (r.width === 0 || r.right <= vw + 1) continue
  const cs = getComputedStyle(el)
  if (cs.position === 'fixed') continue
  let p = el.parentElement
  let clipped = false
  while (p && p !== document.body) {
    const pcs = getComputedStyle(p)
    if (pcs.overflowX === 'auto' || pcs.overflowX === 'scroll' || pcs.overflowX === 'hidden') {
      clipped = true
      break
    }
    p = p.parentElement
  }
  if (clipped) continue
  offenders.push({
    tag: el.tagName.toLowerCase(),
    cls: String(el.className).slice(0, 40),
    right: Math.round(r.right),
    over: Math.round(r.right - vw),
  })
}
offenders.sort((a, b) => b.over - a.over)
check('页面没有横向溢出', !overflowPage, { scrollWidth: de.scrollWidth, innerWidth: vw })
check('没有元素撑出视口', offenders.length === 0, offenders.slice(0, 5))

/* ---------- ③ 关键区域不是空白 ---------- */
const chartEls = Array.from(document.querySelectorAll('.chart, [data-chart], .echarts'))
let blankCharts = 0
for (const el of chartEls) {
  const r = el.getBoundingClientRect()
  if (r.width < 2 || r.height < 2) blankCharts++
  else {
    const cv = el.querySelector('canvas')
    if (cv && (cv.width < 2 || cv.height < 2)) blankCharts++
  }
}
check('图表容器都有实际尺寸', blankCharts === 0, `${chartEls.length} 个容器，${blankCharts} 个空白`)

/* 主内容不能是空的 */
const main = document.querySelector('main') || document.body
check('主内容区有实际内容', main.textContent.trim().length > 200, main.textContent.trim().length)

/* 背景 canvas 应该有东西（这个站每页都有装饰背景层） */
const bgCanvas = document.querySelector('.bg-canvas')
if (bgCanvas) {
  const ctx = bgCanvas.getContext('2d')
  let painted = 0
  try {
    const img = ctx.getImageData(0, 0, Math.min(500, bgCanvas.width), Math.min(500, bgCanvas.height)).data
    for (let i = 3; i < img.length; i += 4) if (img[i] > 0) painted++
  } catch {
    painted = -1
  }
  check('背景层已绘制内容', painted !== 0, painted)
}

/* ---------- ④ 每个 h1/h2 都不为空、图片都有 alt ---------- */
const emptyHeads = Array.from(document.querySelectorAll('h1,h2,h3')).filter((h) => !h.textContent.trim())
check('标题都没有空文本', emptyHeads.length === 0, emptyHeads.length)

const imgs = Array.from(document.querySelectorAll('img'))
const noAlt = imgs.filter((i) => !i.hasAttribute('alt'))
check('图片都有 alt', noAlt.length === 0, `${imgs.length} 张，${noAlt.length} 张缺 alt`)

const passed = results.filter((r) => r.ok).length
return {
  ok: passed === results.length,
  passed,
  total: results.length,
  视口: `${vw}x${window.innerHeight}`,
  failures: results.filter((r) => !r.ok),
}
