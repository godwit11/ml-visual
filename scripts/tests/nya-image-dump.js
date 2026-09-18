/*
 * 把 Nya 抓到的那张图「铺」在页面上，好让 e2e 的 --shot 把它存成文件。
 *
 * 为什么需要这么个东西：验收时她说「橙色点集中在左下角」，而问题问的是右上角 ——
 * 这两种可能必须分清：
 *   · 她看错了  ⇒ 功能有 bug
 *   · 页面此刻本来就是这样（未训练状态的簇划分是随机的）⇒ 她答对了
 * 光看她的文字分不出来。唯一可靠的办法是**亲眼看她收到的那张图**。
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

const img = calls[0]?.image?.dataUrl
if (img) {
  /* 清空页面，只留她收到的那张图 —— 截出来就是「她的视野」 */
  document.body.innerHTML = ''
  document.body.style.cssText = 'margin:0;padding:0;background:#ffffff'
  const el = document.createElement('img')
  el.src = img
  el.style.cssText = 'display:block;width:900px'
  document.body.append(el)
  await sleep(500)
}

return {
  ok: !!img,
  图片长度: img ? img.length : 0,
  估算KB: img ? Math.round((img.length * 3) / 4 / 1024) : 0,
}
