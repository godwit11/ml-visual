/*
 * 验证反馈浮层的「**附上页面图表**」按钮：一次应该附上**页面上所有可见图表**。
 *
 * ⚠️ 为什么和 feedback-image.js 分开：
 *    那条走的是**粘贴**路径（用户自己截的图），验的是"浏览器专有 API 通不通"。
 *    这条走的是**点按钮**路径，验的是"它到底抓了几张、顺序对不对"——
 *    2026-09-20 之前它只抓面积最大那一张，现在改成抓全部。
 *    这个改动**天生就不会报错**：抓 1 张和抓 3 张，界面都正常，
 *    只是学生按了按钮却发现自己想问的那张没附上。
 *
 * ⚠️ 请求拦掉了，不花钱。
 */

const calls = []
const realFetch = window.fetch
window.fetch = async (url, init) => {
  if (String(url).includes('/api/report')) {
    calls.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return realFetch(url, init)
}

/* 进页面前先数清楚：这一页**可见**的图表有几个
 * （和 captureChartImages 的过滤条件一致 —— 标签页里没露出来的不算） */
const visible = Array.from(document.querySelectorAll('.chart, .chart-sm')).filter(
  (el) => el.clientWidth > 80 && el.clientHeight > 80,
)

const tabEl = document.querySelector('.fb-tab')
if (!tabEl) throw new Error('找不到反馈入口 .fb-tab')
tabEl.click()
await sleep(200)

/* 找到「附上页面图表」那个按钮 —— 按文案找，不按位置找 */
const shotBtn = Array.from(document.querySelectorAll('.fb button')).find((b) =>
  /附上页面图表|附上当前图表/.test(b.textContent || ''),
)
if (!shotBtn) throw new Error('找不到「附上页面图表」按钮')

shotBtn.click()

for (let i = 0; i < 60; i++) {
  await sleep(100)
  if (document.querySelectorAll('.fb-img-item').length > 0) break
}
const thumbs = document.querySelectorAll('.fb-img-item').length
const note = document.querySelector('.fb-img-note')?.textContent ?? null

/* 填描述再提交 —— 前端拦"太短" */
const ta = document.querySelector('.fb-text')
ta.value = '验证「附上页面图表」一次附了几张，请忽略这条报告。'
ta.dispatchEvent(new Event('input', { bubbles: true }))
document.querySelector('.fb-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

for (let i = 0; i < 50 && calls.length === 0; i++) await sleep(100)

const imgs = (calls[0]?.images ?? []).map((x) => x?.dataUrl).filter(Boolean)

/* 期望张数：可见图表数，但不超过浮层的上限（3 张） */
const expected = Math.min(visible.length, 3)

return {
  /*
   * 判定要能变红：只附 1 张（旧行为）、或者图没进请求体，都算失败。
   * ⚠️ 这里刻意**按"可见图表数"算期望**，而不是写死 3 ——
   *    写死的话换个页跑就会假红。
   */
  ok: expected >= 2 && thumbs === expected && imgs.length === expected && imgs.every((s) => s.startsWith('data:image/jpeg')),
  页面上可见图表数: visible.length,
  期望附上的张数: expected,
  缩略图数: thumbs,
  提交带的图数: imgs.length,
  提示文案: note,
  /* 每张大小，确认没有把一张撑爆 */
  每张KB: imgs.map((s) => Math.round((s.length * 3) / 4 / 1024)),
}
