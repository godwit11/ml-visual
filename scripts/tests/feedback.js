/*
 * 「报告问题」的前端行为断言（跑在 dist 上）。
 *
 * 这个文件盯的是三件容易悄悄坏掉的事：
 *
 * ① **位置**：它必须贴在右边缘，而且**不能和 Nya 叠在一起** ——
 *    这正是当初放弃"右下角"那个方案的全部理由。Nya 可以被拖到任何地方、
 *    尺寸还会随姿势变，所以这条断言必须有。
 *
 * ② **现场信息真的接上了页面状态**：靠的是复用 Nya 的状态读取器。
 *    那条链路一旦断开，表单不会报错、提交也照样成功 ——
 *    只是你收到的邮件里**少了最关键的那几个数字**。
 *    （"静默少一个字段"是这个项目的老毛病，见 check-server-path.mjs 的由来。）
 *
 * ③ **采集范围可取消**：用户取消勾选的那一项，绝不能出现在请求体里。
 *
 * 用假后端，不碰真邮件服务。
 */

const results = []
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra })

const sleepFor = sleep
const vw = innerWidth
const vh = innerHeight

/**
 * 等某个计算样式变成期望值。
 *
 * ⚠️ 别用固定 `sleep` 量过渡 —— 这个项目在这上面栽过（面板 460ms 的过渡里
 *    量位置，实测差 6px）。过渡什么时候结束由浏览器决定，轮询才作数。
 */
const waitStyle = async (el, prop, want, budget = 1500) => {
  const t0 = Date.now()
  for (;;) {
    if (getComputedStyle(el)[prop] === want) return true
    if (Date.now() - t0 > budget) return false
    await sleepFor(40)
  }
}

/* 等布局稳定：Nya 的立绘要先加载完才量得到尺寸 */
await sleepFor(1200)

/* ---------- ① 挂载与位置 ---------- */

const tab = q('.fb-tab')
const panel = q('.fb-panel')
const root = q('.fb')

check('竖标签已挂载', !!tab, tab?.className)
check('面板已挂载', !!panel, panel?.className)

const tr = tab.getBoundingClientRect()
/*
 * ⚠️ 用 `documentElement.clientWidth` 而不是 `innerWidth`。
 *    `innerWidth` **包含滚动条**，而 `position: fixed; right: 0` 贴的是
 *    可用视口的内边缘 —— 拿 innerWidth 去比会得到一个假的"距右 10px"。
 */
const viewportRight = document.documentElement.clientWidth
check('贴住右边缘', viewportRight - tr.right <= 1, `距右 ${Math.round(viewportRight - tr.right)}px（已排除滚动条）`)
check(
  '竖直居中',
  Math.abs((tr.top + tr.bottom) / 2 - vh / 2) <= 3,
  `中心 ${Math.round((tr.top + tr.bottom) / 2)} / 视口中心 ${Math.round(vh / 2)}`,
)
check('是竖着的（竖排文字）', tr.height > tr.width, `${Math.round(tr.width)}×${Math.round(tr.height)}`)

/*
 * 🔴 这条是"选竖标签而不是右下角"的核心保证。
 *    Nya 的落点可以拖、尺寸随姿势变，所以不能靠"当初算过一次"。
 */
const mascot = q('.nya-mascot')
const mr = mascot.getBoundingClientRect()
const overlapX = Math.min(tr.right, mr.right) - Math.max(tr.left, mr.left)
const overlapY = Math.min(tr.bottom, mr.bottom) - Math.max(tr.top, mr.top)
check(
  '和 Nya 不重叠',
  overlapX <= 0 || overlapY <= 0,
  `重叠 ${Math.round(Math.max(0, overlapX))}×${Math.round(Math.max(0, overlapY))}px`,
)
check(
  '层级高于 Nya 面板（低了会被它盖住 —— 理由见 ⑪）',
  Number(getComputedStyle(root).zIndex) > 60,
  getComputedStyle(root).zIndex,
)

/* ---------- ② 开关 ---------- */

check('初始是收起的', root.dataset.open !== 'true')
check('收起时面板不可见（不是只压了透明度）', getComputedStyle(panel).visibility === 'hidden')

tab.click()
await sleepFor(280)
check('点一下打开', root.dataset.open === 'true', root.dataset.open)
check('展开后真的可见', await waitStyle(panel, 'visibility', 'visible'))
check('标签上报了展开状态（读屏软件要知道）', tab.getAttribute('aria-expanded') === 'true')

/* ---------- ③ 表单字段 ---------- */

const kinds = document.querySelectorAll('.fb-type')
check('有可选的问题类型', kinds.length >= 4, `${kinds.length} 个`)
check('默认选中了第一个', document.querySelectorAll('.fb-type.is-on').length === 1)
check('有描述框', !!q('.fb-text'))
check('有选填的邮箱框', !!q('.fb-mail'))
check('有现场信息的折叠区', !!q('.fb-ctx'))

const trap = q('.fb-trap')
check('蜜罐字段在 DOM 里但不在视野内', !!trap && trap.getBoundingClientRect().right < 0, trap?.getBoundingClientRect().right)

/* ---------- ④ 🔴 现场信息真的接上了页面状态 ---------- */

const ctxKeys = Array.from(document.querySelectorAll('.fb-ctx-key')).map((e) => e.textContent ?? '')
check('有可勾选的现场信息项', ctxKeys.length >= 4, `${ctxKeys.length} 项`)
check(
  '带了页面状态（复用 Nya 的状态读取器，断链是静默的）',
  ctxKeys.some((k) => k.includes('页面状态')),
  ctxKeys.slice(0, 6),
)
check('带了页面地址与视口', ctxKeys.some((k) => k.includes('页面')) && ctxKeys.some((k) => k.includes('视口')))
check(
  '每一项都有对应的勾选框',
  document.querySelectorAll('.fb-ctx-list input[type=checkbox]').length === ctxKeys.length,
)
check(
  '默认全选 —— 但用户可以逐项取消',
  Array.from(document.querySelectorAll('.fb-ctx-list input')).every((i) => i.checked),
)

/* ---------- ⑤ 提交链路（假后端） ---------- */

const realFetch = window.fetch.bind(window)
let captured = null
const fakeOk = async (url, init) => {
  captured = { url: String(url), body: JSON.parse(init?.body ?? '{}') }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
window.fetch = fakeOk

const form = q('.fb-form')
const desc = q('.fb-text')
const status = q('.fb-status')
const pathBefore = location.pathname

const fill = (text) => {
  desc.value = text
  desc.dispatchEvent(new Event('input', { bubbles: true }))
}

const submit = async (text) => {
  captured = null
  fill(text)
  form.requestSubmit()
  await sleepFor(320)
}

await submit('把阈值拖到 0.79 以后，准确率反而变低了。')

check('提交打到了 /api/report', /\/api\/report$/.test(captured?.url ?? ''), captured?.url)
check('带上了选中的问题类型', captured?.body?.kind === kinds[0].textContent, captured?.body?.kind)
check('带上了描述原文', captured?.body?.text === '把阈值拖到 0.79 以后，准确率反而变低了。', captured?.body?.text)
check('带上了现场信息（数组）', Array.isArray(captured?.body?.context) && captured.body.context.length > 0)
check('现场信息是 {group,key,value} 形状', captured?.body?.context?.[0]?.key !== undefined && captured.body.context[0].value !== undefined)
check('带上了控制台报错列表', Array.isArray(captured?.body?.errors))
check('蜜罐是空的（真人不会填）', captured?.body?.trap === '', JSON.stringify(captured?.body?.trap))
check('带上了"打开到提交"的耗时（服务端据此判脚本）', (captured?.body?.elapsedMs ?? 0) > 0, captured?.body?.elapsedMs)
check('提交没有让页面跳走', location.pathname === pathBefore)
check('成功后给出反馈', status.classList.contains('is-ok') && status.textContent.includes('收到'), status.textContent)

/* ---------- ⑥ 取消勾选的那一项不能出现在请求里 ---------- */

const boxes = document.querySelectorAll('.fb-ctx-list input[type=checkbox]')
const droppedKey = boxes[0].dataset.key
boxes[0].click()
check('点击能取消勾选', boxes[0].checked === false)

await submit('第二条：我把某一项取消勾选了。')
check(
  '取消勾选的那项没进请求',
  !(captured?.body?.context ?? []).some((c) => c.key === droppedKey),
  `少了「${droppedKey}」`,
)
check('其余项照常带上', (captured?.body?.context ?? []).length > 0)

/* ---------- ⑦ 描述太短：不发请求，只提示 ---------- */

captured = null
fill('嗯')
form.requestSubmit()
await sleepFor(220)
check('描述太短 ⇒ 不发请求', captured === null)
check('并且当面提示他', status.textContent.includes('具体'), status.textContent)

/* ---------- ⑧ 服务端拒绝时照实显示 ---------- */

window.fetch = async () =>
  new Response(JSON.stringify({ error: 'RATE_LIMITED', message: '已经收到你的报告了，歇一分钟再发下一份。' }), {
    status: 429,
    headers: { 'Content-Type': 'application/json' },
  })
await submit('这一条会被服务端拦下来。')
check('显示的是服务端那句中文，而不是错误码', status.textContent.includes('已经收到'), status.textContent)
check('错误态有专门的样式', status.classList.contains('is-err'), status.className)

/* ---------- ⑨ 网络断了 ---------- */

window.fetch = async () => {
  throw new TypeError('Failed to fetch')
}
await submit('这一条会连不上。')
check('断网时也有提示', status.textContent.includes('连不上'), status.textContent)
check('断网后按钮恢复可用（不能卡死）', !q('.fb-send').disabled)

window.fetch = realFetch

/* ---------- ⑩ 关闭 ---------- */

desc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
check('Esc 能关闭', await waitStyle(panel, 'visibility', 'hidden'), root.dataset.open)
check('关闭后真的不可见（不是只改了 data 属性）', getComputedStyle(panel).visibility === 'hidden')

/*
 * 🔴 先把待触发的"自动关闭"定时器排干。
 *
 * 提交成功后 2.2 秒面板会自动收起（`setTimeout(() => setOpen(false), 2200)`）。
 * 前面几条用例提交过，那些定时器还挂着 —— 如果它们在下面这次 `tab.click()`
 * 之后才到点，就会把刚打开的面板又关掉，看起来像"点不开"。
 *
 * 踩过的形状特别有欺骗性：只加了一行无关的同步读，时序刚好错开，测试就绿了。
 * **那种"偶发通过"比稳定的失败更危险** —— 它会让一条其实不可靠的断言长期留着。
 * 所以这里显式把时间推过去，让它变成确定的行为。
 */
await sleepFor(2400)

const beforeClick = root.dataset.open
tab.click()
check(
  '再点一下能重新打开',
  root.dataset.open === 'true',
  `click 前=${beforeClick} 之后=${root.dataset.open}`,
)
check('打开后确实可见', await waitStyle(panel, 'visibility', 'visible'))
document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
check('点面板外面也能关掉', await waitStyle(panel, 'visibility', 'hidden'), root.dataset.open)

/* ---------- ⑪ 🔴 和 Nya 面板共存 ---------- */

/*
 * Nya 的面板默认宽 380px，落在视口右侧约 x 1014~1394，
 * 而竖标签在 1372~1406 —— **重叠**。
 * 第一版把 `.fb` 的 z-index 设成 50（低于 Nya 的 60），
 * 结果标签有一半被压住、点不到，而且**只在 Nya 面板打开时**才发生。
 *
 * 判据用 `elementFromPoint`：拿标签的中心点问浏览器"这里是哪个元素" ——
 * 这比量矩形可靠，它直接回答"点下去会点到谁"。
 */
const mascotBtn = q('.nya-mascot')
if (mascotBtn) {
  mascotBtn.click()
  await sleepFor(900)

  const tt = tab.getBoundingClientRect()
  const hit = document.elementFromPoint(tt.left + tt.width / 2, tt.top + tt.height / 2)
  check(
    'Nya 面板打开时，反馈标签没被盖住（点下去还能点到它）',
    hit === tab || tab.contains(hit),
    hit?.className || hit?.tagName,
  )

  tab.click()
  check('Nya 面板开着时依然能打开反馈表单', await waitStyle(panel, 'visibility', 'visible'))
  check(
    '反馈表单盖在 Nya 面板之上（填表的人该在上层）',
    Number(getComputedStyle(root).zIndex) > Number(getComputedStyle(q('#nya')).zIndex),
    `${getComputedStyle(root).zIndex} vs ${getComputedStyle(q('#nya')).zIndex}`,
  )

  /* 收拾干净：关掉两个面板 */
  tab.click()
  await sleepFor(200)
  mascotBtn.click()
  await sleepFor(600)
}

const passed = results.filter((r) => r.ok).length
return {
  ok: passed === results.length,
  passed,
  total: results.length,
  视口: `${vw}x${vh}`,
  failures: results.filter((r) => !r.ok),
}
