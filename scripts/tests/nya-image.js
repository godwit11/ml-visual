/*
 * 验证「Nya 的图能不能抓出来」。
 *
 * 为什么必须跑在真浏览器里：
 *   captureChartImages 干的全是浏览器特有的活 —— 读 ECharts 实例、canvas 缩放、
 *   toDataURL 转 JPEG。这些在 Node 里一行都测不了，而它们**每一步都可能静默失败**
 *   （返回空数组，然后她又变回"我看不到图"）。所以只能在真页面上验。
 *
 * ⚠️ 我们**不发真请求**：进页面第一件事就是把 fetch 换掉，把 /api/chat 的请求体
 *    截住。既省额度，也让断言能直接看到"她到底会收到什么"。
 *    （vite preview 是带真 API 的，不拦就会真花钱 —— 见 vite.config.ts 的说明。）
 *
 * 顺带验三件事：① 抓的图确实是 JPEG 且尺寸合理；② 状态上报没被图挤掉；
 * ③ **多图抓取**：抓到的张数 == 页面上可见图表数（上限 4），主图排在第一位。
 *
 * ⚠️ 这一页（logistic-regression）有 3 个 ECharts 容器，但其中
 *    `#chart-*` 在标签页里、未切换时 clientWidth === 0 ⇒ 会被"可见"过滤掉。
 *    所以断言不能写死数字，只能写"≤ MAX_IMAGES 且 ≥ 1"，
 *    以及**主图必须是面积最大那个**。
 */

const calls = []
const realFetch = window.fetch
window.fetch = async (url, init) => {
  if (String(url).includes('/api/chat')) {
    calls.push(JSON.parse(init.body))
    /* 回一个最小的合法 NDJSON 流，让面板能正常收尾（不然后面会卡在"正在输入"） */
    return new Response('{"t":"（桩）"}\n{"done":true,"finish":"stop"}\n', {
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
    })
  }
  return realFetch(url, init)
}

const input = document.querySelector('.nya-input')
if (!input) throw new Error('找不到输入框 .nya-input')
const form = input.closest('form')
if (!form) throw new Error('找不到输入框所在的 form')

input.value = '这几张图上画的是什么？'
input.dispatchEvent(new Event('input', { bubbles: true }))
form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

/* 抓图 + 压缩是异步的，等它出门 */
for (let i = 0; i < 60 && calls.length === 0; i++) await sleep(100)

const body = calls[0] ?? null
/*
 * ⚠️ `images` 是**裸字符串数组**（`string[]`），不是 `{dataUrl}` 对象数组。
 *    为什么选字符串：每条省下 `{"dataUrl":""}` 十几个字符，4 张就省一条消息的量；
 *    服务端 `normalizeImages()` 两种写法都认（见其注释）。
 *    ⚠️ 但**探针必须按真实形状解** —— 第一版这里写了 `.dataUrl`，
 *       于是 `抓到的张数` 是对的、`第一张前缀` 却永远是 null（测试骗了自己）。
 */
const raw = Array.isArray(body?.images) ? body.images : []
const images = raw.map((x) => (typeof x === 'string' ? x : x?.dataUrl)).filter(Boolean)
const first = images[0] ?? null
/* 旧字段必须和新字段的[0]同源 —— 老服务端 / 老标签页都靠它兜底 */
const legacy = typeof body?.image === 'string' ? body.image : body?.image?.dataUrl ?? null
const state = body?.context?.state ?? {}

/* 页面上**真正可见**的图表容器（和 captureChartImages 的过滤条件保持一致） */
const visible = Array.from(document.querySelectorAll('.chart, .chart-sm')).filter(
  (el) => el.clientWidth > 80 && el.clientHeight > 80,
)

const allJpeg = images.length > 0 && images.every((s) => s.startsWith('data:image/jpeg;base64,'))
const totalKB = Math.round(images.reduce((s, d) => s + d.length, 0) * 0.75 / 1024)

/* ------------------------------------------------------------------ *
 * 排序器的**受控验证**
 * ------------------------------------------------------------------ *
 * 🔴 为什么必须单独造场景（2026-09-20 发现的"绿着但没验"）：
 *    生产代码里有一条"**主图提到最前**"的逻辑（主图 = 面积最大那张）。
 *    可是现成的十页里，面积最大的那张**恰好都排在文档最前** ——
 *    于是那条逻辑**一次都没真正生效过**：把它删掉，上面那些断言照样全绿。
 *    哪天有人把大图挪到下面，它就会**静默地开始送错图**：
 *    她说"第 1 张是 XX"，学生看到的第 1 张却是 YY。
 *
 * 做法：造两个游离的假容器（偏移到屏幕外，但**布局尺寸是真的**），
 *      故意让"小的在前、大的在后"，再复刻前端那段排序，看它选谁当第一张。
 *      ⚠️ 下面那条前提校验不能省 —— 尺寸没量出来的话，
 *        "面积最大"会退化成"取第一个"，恰好让断言**假通过**。
 */
const mkFake = (id, w, h, tag) => {
  const el = document.createElement('div')
  el.id = id
  el.style.cssText =
    'position:absolute;left:-99999px;top:0;pointer-events:none;width:' + w + 'px;height:' + h + 'px'
  el.__chart = { chart: { getDataURL: () => tag } }
  return el
}
const fSmall = mkFake('nya-test-small', 100, 100, 'SMALL')
const fBig = mkFake('nya-test-big', 400, 400, 'BIG')
document.body.append(fSmall, fBig)

const fakeDims = { small: fSmall.clientWidth * fSmall.clientHeight, big: fBig.clientWidth * fBig.clientHeight }
const fakeHosts = [fSmall, fBig]
const fakeOrdered = [...fakeHosts].sort((a, b) =>
  a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
)
const fakeMain = fakeOrdered.reduce((a, b) =>
  a.clientWidth * a.clientHeight >= b.clientWidth * b.clientHeight ? a : b,
)
const fakeGot = [fakeMain, ...fakeOrdered.filter((el) => el !== fakeMain)].map((el) =>
  el.__chart.chart.getDataURL(),
)
fSmall.remove()
fBig.remove()

/* 前提：两个假容器真的量出了尺寸（否则这条验证是空转） */
const sorterPrecondition = fakeDims.small > 0 && fakeDims.big > 0
const sorterPicksBiggestFirst = fakeGot[0] === 'BIG' && fakeGot[1] === 'SMALL'

return {
  ok:
    allJpeg &&
    !!legacy &&
    legacy === first &&
    images.length === Math.min(visible.length, 4) &&
    sorterPrecondition &&
    sorterPicksBiggestFirst,
  收到请求: !!body,
  抓到的张数: images.length,
  页面上可见图表数: visible.length,
  第一张前缀: first ? first.slice(0, 30) : null,
  第一件与旧字段一致: !!legacy && legacy === first,
  总共估算KB: totalKB,
  状态键数: Object.keys(state).length,
  状态样例: Object.keys(state).slice(0, 3),
  /* --- 排序器（受控场景）--- */
  排序器前提成立: sorterPrecondition,
  排序器选的顺序: fakeGot,
  排序器把最大那张放第一: sorterPicksBiggestFirst,
}
