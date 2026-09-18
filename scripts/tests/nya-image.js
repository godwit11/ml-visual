/*
 * 验证「Nya 的图能不能抓出来」。
 *
 * 为什么必须跑在真浏览器里：
 *   captureChartImage 干的全是浏览器特有的活 —— 读 ECharts 实例、canvas 缩放、
 *   toDataURL 转 JPEG。这些在 Node 里一行都测不了，而它们**每一步都可能静默失败**
 *   （返回 undefined，然后 she 又变回"我看不到图"）。所以只能在真页面上验。
 *
 * ⚠️ 我们**不发真请求**：进页面第一件事就是把 fetch 换掉，把 /api/chat 的请求体
 *    截住。既省额度，也让断言能直接看到"她到底会收到什么"。
 *    （vite preview 是带真 API 的，不拦就会真花钱 —— 见 vite.config.ts 的说明。）
 *
 * 顺带验两件事：① 抓的图确实是 JPEG 且尺寸合理；② 状态上报没被图挤掉。
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

input.value = '这张图上画的是什么？'
input.dispatchEvent(new Event('input', { bubbles: true }))
form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

/* 抓图 + 压缩是异步的，等它出门 */
for (let i = 0; i < 60 && calls.length === 0; i++) await sleep(100)

const body = calls[0] ?? null
const img = body?.image?.dataUrl ?? null
const state = body?.context?.state ?? {}

/* 顺带量一下页面上一共有几张图 —— 用来确认"只抓最大那张"这个策略真的生效 */
const canvases = Array.from(document.querySelectorAll('canvas')).map((c) => ({
  w: c.clientWidth,
  h: c.clientHeight,
}))

return {
  ok: !!img && img.startsWith('data:image/jpeg;base64,'),
  收到请求: !!body,
  有图字段: !!img,
  图片前缀: img ? img.slice(0, 30) : null,
  图片字符数: img ? img.length : 0,
  估算KB: img ? Math.round((img.length * 3) / 4 / 1024) : 0,
  状态键数: Object.keys(state).length,
  状态样例: Object.keys(state).slice(0, 3),
  页面上canvas数: canvases.length,
  最大canvas: canvases.sort((a, b) => b.w * b.h - a.w * a.h)[0] ?? null,
}
