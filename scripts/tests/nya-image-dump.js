/*
 * 把 Nya 抓到的图**全部铺**在页面上，好让 e2e 的 --shot 把它存成文件。
 *
 * 为什么需要这么个东西：验收时她说「橙色点集中在左下角」，而问题问的是右上角 ——
 * 这两种可能必须分清：
 *   · 她看错了  ⇒ 功能有 bug
 *   · 页面此刻本来就是这样（未训练状态的簇划分是随机的）⇒ 她答对了
 * 光看她的文字分不出来。唯一可靠的办法是**亲眼看她收到的那张图**。
 *
 * ⚠️ 2026-09-20 起她一次会收到**多张**（页面上所有可见图表）。
 *    ⇒ 这里要把每一张都铺出来，**按她收到的顺序**，并标出序号 ——
 *      验收时才能对照她说的"第 1 张""标着『XX』那张"到底是哪张。
 *      （只铺第一张的话，"她认错图"这类问题根看不见。）
 *
 * 不花钱：fetch 还是拦掉的。
 */

const calls = []
const realFetch = window.fetch
window.fetch = async (url, init) => {
  if (String(url).includes('/api/chat')) {
    calls.push(JSON.parse(init.body))
    return new Response('{"t":"（桩）"}\n{"done":true,"finish":"stop"}\n', {
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
    })
  }
  return realFetch(url, init)
}

const input = document.querySelector('.nya-input')
if (!input) throw new Error('找不到输入框')
const form = input.closest('form')
input.value = '她能看到什么？'
input.dispatchEvent(new Event('input', { bubbles: true }))
form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

for (let i = 0; i < 60 && calls.length === 0; i++) await sleep(100)

const images = (Array.isArray(calls[0]?.images) ? calls[0].images : []).map((x) => x?.dataUrl).filter(Boolean)
if (images.length) {
  /* 清空页面，只留她收到的那些图 —— 截出来就是「她的视野」 */
  document.body.innerHTML = ''
  document.body.style.cssText = 'margin:0;padding:0;background:#ffffff;font:13px sans-serif'
  images.forEach((src, i) => {
    /* 标出序号：验收时她说"第 2 张"时才对得上 */
    const tag = document.createElement('div')
    tag.textContent = `她收到的第 ${i + 1} 张（共 ${images.length} 张）`
    tag.style.cssText = 'padding:6px 2px;color:#555'
    const el = document.createElement('img')
    el.src = src
    el.style.cssText = 'display:block;width:900px;border:1px solid #eee'
    document.body.append(tag, el)
  })
  await sleep(500)
}

return {
  ok: images.length > 0,
  收到张数: images.length,
  每张字符数: images.map((s) => s.length),
  每张估算KB: images.map((s) => Math.round((s.length * 3) / 4 / 1024)),
}
