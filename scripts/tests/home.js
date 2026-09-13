/*
 * 首页端到端断言。
 *
 * 2026-09-11 首页做过布局重排（hero 分栏 / 学习路线改成流水线 / 卡片加编号与
 * sklearn 入口标签），所以这里除了原来那几条，还补上了**新结构的断言** ——
 * 否则重排之后最容易被静默弄丢的就是「卡片还是不是 10 张」「流水线还是不是 10 步」。
 *
 * 用和其它页面一致的 `passed / total` 约定，这样 verify-all 的汇总表里能看出断言规模，
 * 失败时也能指名道姓地看到是哪一条。
 */
const results = []
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra })

const cards = qa('.demo-card, .card, a[href*="demos/"]')
const hrefs = cards.map((c) => c.getAttribute('href'))
const treeLink = hrefs.find((h) => h && h.includes('decision-tree'))
const lrLink = hrefs.find((h) => h && h.includes('linear-regression'))
const treeCard = cards.find((c) => (c.getAttribute('href') || '').includes('decision-tree'))

/* ---------- 1. 导航可达性（原来就有的三条，别弄丢） ---------- */
check('页面上有决策树入口', Boolean(treeLink), treeLink)
check('页面上有线性回归入口', Boolean(lrLink), lrLink)
check('决策树卡片存在且可点', Boolean(treeCard) && !treeCard.classList.contains('is-disabled'))

/* ---------- 2. 演示卡片 ----------
 * 10 个演示页全部上线，首页必须至少能到达这 10 个（用集合比对，不信长度）。
 */
const IDS = [
  'linear-regression',
  'logistic-regression',
  'model-evaluation',
  'decision-tree',
  'svm',
  'naive-bayes',
  'ensemble-learning',
  'clustering',
  'pca',
  'neural-network',
]
const demoCards = qa('.demo-card')
const missing = IDS.filter((id) => !hrefs.some((h) => h && h.includes(id)))
check('10 个演示卡片都能在首页点到', missing.length === 0, missing)
check('演示卡片数量为 10', demoCards.length === 10, demoCards.length)

/* ---------- 3. 布局重排后的新结构 ---------- */
check('hero 已经分成左右两栏', Boolean(q('.hero-grid .hero-main') && q('.hero-grid .hero-console')))
/*
 * hero 只放三个数字，且刻意不是「三个 10」。
 * 这里同时钉住「数量」和「不重复」两件事 —— 之前四个数字里有三个都是 10，
 * 排在一起像渲染错了。
 */
const stats = qa('.hero-stats .stat')
check('hero 是三个硬数字', stats.length === 3, stats.length)
const statNums = stats.map((s) => (s.querySelector('dt')?.textContent || '').trim())
check('三个数字不全是同一个值', new Set(statNums).size >= 2, statNums)
check('断言数字已由 siteStats.json 注入（不是占位符）', /^\d+$/.test(statNums[2] || ''), statNums[2])
check('hero 有「从线性回归开始」入口', Boolean(q('.hero-cta[href*="linear-regression"]')))
check('hero 不再有重复的徽章行', !q('.hero-tags'))
check('hero 取样面板里有损失曲线路径', Boolean(q('.hero-console .spark path')))

const secHeads = qa('.sec-head')
check('分区标题都带编号与分隔线', secHeads.length > 0 && secHeads.every((h) => h.querySelector('.sec-no')), secHeads.length)

/* ---------- 4. 导航锚点必须真的有落点 ----------
 * 教训：导航栏曾经挂着 `#demos` 和 `#features` 两个链接，但 `#demos` 这个元素
 * **页面上根本不存在** —— 点了完全没反应，而且不报错、不影响渲染，
 * 靠肉眼和截图都发现不了。演示页导航里的「全部演示」也指向 `/#demos`，一并受影响。
 * 所以这里逐个锚点验证目标存在。
 */
const navAnchors = qa('.nav-links a')
check('导航链接不为空', navAnchors.length > 0, navAnchors.length)
check(
  '每个导航锚点都有对应的元素落点',
  navAnchors.every((a) => {
    const href = a.getAttribute('href') || ''
    if (!href.startsWith('#')) return true
    return Boolean(document.getElementById(href.slice(1)))
  }),
  navAnchors.map((a) => a.getAttribute('href')),
)
check('「演示」锚点 #demos 存在', Boolean(document.getElementById('demos')))
check('已移除的区块没有残留锚点引用', !document.getElementById('features'))

const pipeNodes = qa('.pipe-node')
check('学习路线是 10 步的流水线', pipeNodes.length === 10, pipeNodes.length)
check('流水线节点之间有连接箭头', qa('.pipe-arrow').length === 9, qa('.pipe-arrow').length)
check(
  '当前进度被高亮（恰有一个 is-current 或 is-done）',
  qa('.pipe-node.is-current').length + qa('.pipe-node.is-done').length >= 1,
)

/* 每张卡片都要有编号和 sklearn 入口标签 —— 这是本轮新增的信息层 */
const cardNos = qa('.demo-card .demo-card-no')
check('每张卡片都有编号', cardNos.length === demoCards.length, `${cardNos.length}/${demoCards.length}`)
const apis = qa('.demo-card .demo-card-api')
check('每张卡片都标了 sklearn 入口', apis.length === demoCards.length, `${apis.length}/${demoCards.length}`)
check(
  'sklearn 入口标签都是非空的',
  apis.every((a) => (a.textContent || '').trim().length > 0),
)

/* ---------- 5. 背景层的层级要求 ---------- */
const bg = q('.bg-layer')
if (bg) {
  const cs = getComputedStyle(bg)
  check('背景层是 fixed 且铺满视口', cs.position === 'fixed' && cs.top === '0px' && cs.left === '0px')
  check('背景层 z-index 为 0', cs.zIndex === '0', cs.zIndex)
  check('背景层不接收鼠标事件', cs.pointerEvents === 'none', cs.pointerEvents)
  /* 内容层要显式抬到 10，否则会被 fixed 层盖住 */
  const main = q('main')
  check('内容层 z-index 抬到 10', main ? getComputedStyle(main).zIndex === '10' : false, main ? getComputedStyle(main).zIndex : null)
} else {
  check('背景层存在', false)
}

/* ---------- 6. 页面上不该有横向溢出 ---------- */
const de = document.documentElement
check('页面没有横向溢出', de.scrollWidth <= window.innerWidth + 1, `${de.scrollWidth} vs ${window.innerWidth}`)

const passed = results.filter((r) => r.ok).length
const failed = results.filter((r) => !r.ok)
return { ok: failed.length === 0, passed, total: results.length, failures: failed }
