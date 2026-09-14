/*
 * 读出「Nya 实际收到了什么状态」。
 *
 * 做法：把 `window.fetch` 换掉，**截下真实发出的那个请求体**，
 * 而不是在页面里重新读一遍 DOM —— 重新读等于把生产代码抄一遍，
 * 抄错了测试反而会通过（那就白测了）。
 *
 * 顺带这也是最省的做法：请求被截住，所以不会真的花钱。
 *
 * 输出（给 `scripts/check-nya-state.mjs` 解析）：
 *   demoId   —— 前端认出的页面 id
 *   keys     —— 服务端白名单会看到的状态键
 *   state    —— 键值对，用来核对数字是不是页面上真实显示的那些
 */
await sleep(1500)

let captured = null
window.fetch = async (url, init) => {
  if (String(url).includes('/api/chat')) {
    try {
      captured = JSON.parse(init.body)
    } catch {
      captured = null
    }
  }
  return new Response(JSON.stringify({ reply: '（探针）' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const mascotEl = document.querySelector('.nya-mascot')
if (!mascotEl) return { error: '没有挂上猫娘' }
mascotEl.click()
await sleep(700)

const inputEl = document.querySelector('.nya-input')
const formEl = document.querySelector('.nya-form')
if (!inputEl || !formEl) return { error: '没有面板输入框' }

inputEl.value = '这一页现在是什么状态？'
formEl.requestSubmit()

/* 等假后端回完 —— 收到回答就说明请求已经发出去了 */
const deadline = Date.now() + 4000
while (!captured && Date.now() < deadline) await sleep(120)

if (!captured) return { error: '没截到请求（面板可能没发出去）' }

return {
  demoId: captured.context?.demoId ?? null,
  keys: Object.keys(captured.context?.state ?? {}),
  state: captured.context?.state ?? {},
}
