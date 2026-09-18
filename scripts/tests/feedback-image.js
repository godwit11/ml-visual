/*
 * 验证反馈表单的「附图」链路：粘贴 → 压缩 → 渲染缩略图 → 随提交发出去。
 *
 * 为什么必须跑在真浏览器里：整条链路都依赖浏览器专有 API ——
 * ClipboardEvent、File/Blob、canvas.toBlob、toDataURL。在 Node 里一步都测不了，
 * 而它们**每一步失败都是静默的**（图没进来、或者进来了但没发出去，界面照样正常）。
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

/* 打开面板 */
const tabEl = document.querySelector('.fb-tab')
if (!tabEl) throw new Error('找不到反馈入口 .fb-tab')
tabEl.click()
await sleep(200)

/* 造一张"真实尺寸"的图：太小会被服务的下限挡掉，测出来的是别的东西 */
const cv = document.createElement('canvas')
cv.width = 900
cv.height = 640
const cx = cv.getContext('2d')
cx.fillStyle = '#f0f0f0'
cx.fillRect(0, 0, 900, 640)
cx.fillStyle = '#e07a30'
for (let i = 0; i < 60; i++) {
  cx.beginPath()
  cx.arc(100 + Math.random() * 700, 100 + Math.random() * 440, 6, 0, Math.PI * 2)
  cx.fill()
}
cx.fillStyle = '#222'
cx.font = '28px sans-serif'
cx.fillText('这是一张测试截图', 40, 60)

const blob = await new Promise((r) => cv.toBlob((b) => r(b), 'image/png'))
if (!blob) throw new Error('canvas.toBlob 失败')

/* --- 走「粘贴」这条路 --- */
const dt = new DataTransfer()
dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }))
const rootEl = document.querySelector('.fb')
rootEl.dispatchEvent(
  new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
)

for (let i = 0; i < 50; i++) {
  await sleep(100)
  if (document.querySelectorAll('.fb-img-item').length > 0) break
}
const thumbs = document.querySelectorAll('.fb-img-item').length

/* --- 填一句够长的描述再提交（前端拦"太短"，服务端还有一道） --- */
const ta = document.querySelector('.fb-text')
ta.value = '这是一条用来验证附图链路的测试报告，请忽略。'
ta.dispatchEvent(new Event('input', { bubbles: true }))
document.querySelector('.fb-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

for (let i = 0; i < 50 && calls.length === 0; i++) await sleep(100)

const body = calls[0] ?? null
const imgs = body?.images ?? []
const first = imgs[0]?.dataUrl ?? null

return {
  /* 判定要能变红：缩略图没出现、或者图没进请求体，都算失败 */
  ok: thumbs === 1 && imgs.length === 1 && !!first && first.startsWith('data:image/jpeg;base64,'),
  缩略图数: thumbs,
  提交带的图数: imgs.length,
  图前缀: first ? first.slice(0, 30) : null,
  压缩后KB: first ? Math.round((first.length * 3) / 4 / 1024) : 0,
  原始KB: Math.round(blob.size / 1024),
  提示文案: document.querySelector('.fb-img-note')?.textContent ?? null,
  提交时描述: body?.text ?? null,
}
