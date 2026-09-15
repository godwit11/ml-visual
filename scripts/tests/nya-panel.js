/*
 * Nya 助教（猫娘 + 面板）的 e2e 断言。
 *
 * 这个文件只验证**交互和布局**，不验证模型回答得好不好 ——
 * 后者交给 `npm run nya:smoke`（那一步需要密钥、会消耗额度，所以不进 verify:all）。
 *
 * 关键手法：测试期间把 `window.fetch` 换成一个"假后端"。
 * 理由有三条，每条都是踩过或想过的坑：
 *
 *   ① **确定性**：真后端每次回答都不一样，断言必然产生假失败。
 *      假失败会训练人忽略这个脚本 —— 那比没有测试更糟。
 *   ② **不烧额度**：`vite preview` 也会挂上那段中间件、也会读 `.env.local`，
 *      所以这里真发一次请求就是真花一次钱。全站回归要跑很多遍。
 *   ③ **能测到平时测不出的分支**：服务未配置（503）、网络中断（fetch 抛异常）
 *      这两个分支，只有在"后端坏了"的时候才自然出现。假后端可以随时造出来。
 *
 * 用法：
 *   node scripts/e2e.mjs --url <url> --script scripts/tests/nya-panel.js
 *   node scripts/e2e.mjs --url <url> --script scripts/tests/nya-panel.js --size 430,900
 */
await sleep(1600)

/*
 * 先把**真的** fetch 记下来：下面会把它换成假后端，
 * 而有些断言（比如读立绘文件的字节）需要真的去取资源。
 */
const realFetch = window.fetch.bind(window)

const results = []
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra })

const mascot = document.querySelector('.nya-mascot')
const panel = document.querySelector('.nya-panel')

/* ---------- ① 挂载、立绘、层级 ---------- */

check('猫娘已挂载', !!mascot, mascot?.className)
check('面板已挂载', !!panel, panel?.id)

/*
 * 立绘必须真的加载出来。
 * 这条单独立项，是因为它的失败方式特别隐蔽：图片 404 时页面不报错、
 * 布局照常，只是那一块**什么都没有** —— 肉眼看截图才发现"咦，猫呢"。
 */
const img = mascot?.querySelector('.nya-mascot-img')
check(
  '立绘图片加载成功',
  !!img && img.complete && img.naturalWidth > 0,
  img ? `${img.naturalWidth}x${img.naturalHeight} ← ${img.getAttribute('src')}` : '缺 img',
)

/*
 * 面板必须盖在吸顶导航之上。
 * `.nav` 是 z-index 50；面板若低于它，滚动时导航会从面板中间穿过去。
 */
const zRoot = Number(getComputedStyle(mascot.closest('#nya') || mascot).zIndex) || 0
const nav = document.querySelector('.nav')
const zNav = nav ? Number(getComputedStyle(nav).zIndex) || 0 : 0
check('层级高于吸顶导航', zRoot > zNav, `面板 ${zRoot} vs 导航 ${zNav}`)

/* ---------- ② 默认站位 ---------- */

const vw = window.innerWidth
const vh = window.innerHeight

const rectOf = (el) => {
  const r = el.getBoundingClientRect()
  return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }
}

/**
 * 等元素的位置稳定下来再量。
 *
 * ⚠️ 为什么不能用一个固定的 sleep：
 *    `.nya-mascot` 有 460ms 的 left/top 过渡（落座／回位都靠它做动画）。
 *    固定等 450ms 就会踩在过渡的最后一点点上 —— 实测在 1406×1503 视口下，
 *    Esc 之后等 450ms 量到的位置比最终位置**差 6px**，于是断言失败，
 *    而界面其实完全正确。
 *
 *    这类"量在动画中间"的假失败在这个文件里出现过两次
 *    （另一次是落座重叠量 PERCH_OVERLAP），所以不再猜时长，轮询到不动为止。
 *
 *    只对**按钮自己的框**轮询是安全的：她身上那层呼吸动画加在 <img> 上，
 *    不会改变按钮的 getBoundingClientRect（实测两个相位的按钮框完全一致）。
 */
const settle = async (el, maxMs = 1600) => {
  let prev = null
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    const r = rectOf(el)
    const key = `${r.l.toFixed(1)},${r.t.toFixed(1)},${r.w.toFixed(1)},${r.h.toFixed(1)}`
    if (key === prev) return r
    prev = key
    await sleep(80)
  }
  return rectOf(el)
}

let m = rectOf(mascot)
check(
  '默认停在右下角',
  vw - m.r < 90 && vh - m.b < 90,
  { 距右: Math.round(vw - m.r), 距下: Math.round(vh - m.b), 尺寸: `${Math.round(m.w)}x${Math.round(m.h)}` },
)
check('默认面板是关闭的', getComputedStyle(panel).visibility === 'hidden')

/* ---------- ③ 拖拽 ---------- */

/** 造一个和真人一致的指针事件序列 */
const pointer = (type, x, y) =>
  new PointerEvent(type, {
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    bubbles: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
  })

const startBefore = { l: m.l, t: m.t }
const cx = m.l + m.w / 2
const cy = m.t + m.h / 2
const DX = -160
const DY = -120

/*
 * ⚠️ 三次事件之间必须各留一帧。
 *
 * 同一帧内连续派发 pointerdown/move/up，浏览器只会在任务结束时做一次
 * 样式重算，它看到的净变化是「left/top 变了，而 transition 没变」——
 * 于是把一次拖动当成位置变化播成动画，量到的位置是动画中途的。
 * 真人的拖动每帧都有间隔，所以这里也要给帧，否则测的不是真实行为。
 */
mascot.dispatchEvent(pointer('pointerdown', cx, cy))
await sleep(30)
mascot.dispatchEvent(pointer('pointermove', cx + DX, cy + DY))
await sleep(30)
mascot.dispatchEvent(pointer('pointerup', cx + DX, cy + DY))
await sleep(120)

const afterDrag = rectOf(mascot)
check(
  '可以拖动',
  Math.abs(afterDrag.l - (startBefore.l + DX)) < 6 && Math.abs(afterDrag.t - (startBefore.t + DY)) < 6,
  { 期望: `${Math.round(startBefore.l + DX)},${Math.round(startBefore.t + DY)}`, 实际: `${Math.round(afterDrag.l)},${Math.round(afterDrag.t)}` },
)

/* 拖完那一下不该把面板带出来 —— 用户只是想挪个位置 */
check('拖动不会误开对话', getComputedStyle(panel).visibility === 'hidden')

/*
 * 松手后浏览器还会补一次 click。实现里主动吞掉了它（suppressClick），
 * 所以这一下应该仍然不开；再点一次才开。
 */
mascot.click()
await sleep(60)
check('拖动后的那一次点击被吞掉（防误触）', getComputedStyle(panel).visibility === 'hidden')

/* ---------- ④ 点击开启 ---------- */

mascot.click()
/*
 * ⚠️ 等 800ms，不是 500ms。
 *   点开会触发换立绘，新图加载完之后 `layout()` 会按新尺寸再算一次位置，
 *   所以面板顶边在头半秒里还会动 ~10px（实测：60ms 时 961，560ms 才定到 951）。
 *   500ms 正好卡在这中间，量到的是中途值 —— 开发服务器上因为图是本地秒加载
 *   侥幸过了，`verify:all` 跑 dist 就挂。
 */
await sleep(800)

check('再次点击打开面板', getComputedStyle(panel).visibility === 'visible')

/*
 * 换姿势之后：立绘换成"扒在窗口上"那张。
 *
 * ⚠️ 不要用 `/nya\.[a-z]+$/` 这种精确匹配文件名 —— 生产构建会给资源名加哈希
 *    （`nya-b9Ey8dGu.webp`），开发服务器上却是原名。这个断言只在 dev 下过得去，
 *    `verify:all` 跑的是 dist，就会挂。
 *    改成"是她、且不是待机那张"。
 */
const perchSrc = img.getAttribute('src') ?? ''
check('展开后换成了扒窗口的立绘', perchSrc.includes('nya') && !perchSrc.includes('nya-idle'), perchSrc)

/*
 * 耳朵甩动是**烘焙进这张图**的，DOM 里不再有独立的耳朵图层。
 *
 * 为什么改掉旧的"独立图层"做法（这段别删，是踩出来的）：
 *   ① 身体立绘上本来就有耳朵。图层转到一边时，底下那只静止的耳朵露出来
 *      —— 用户看到的是「两对耳朵」。
 *   ② 呼吸动画作用在身体图上，而耳朵图层是兄弟节点、不跟着动，
 *      实测 50% 相位差 9px，同样表现为两对耳朵。
 * 现在改成对整张立绘做局部网格形变（见 scripts/prepare_nya_perch.py），
 * 整幅画只有一只耳朵，不可能再穿模。
 */
check(
  '不再有独立的耳朵图层（耳朵已烘焙进整张图）',
  mascot.querySelectorAll('.nya-ear').length === 0,
  mascot.querySelectorAll('.nya-ear').length,
)
check('扒窗口的立绘已加载', img.complete && img.naturalWidth > 0, `${img.naturalWidth}x${img.naturalHeight}`)

/*
 * 耳朵**真的在动**。
 *
 * 为什么值得单独测：甩动是烘焙进动图的，DOM 里没有任何"会动"的痕迹 ——
 * 万一资源被换成静态图、或者动图帧没编进去，页面看起来完全正常，
 * 只有盯着看才发现她不抖了。
 *
 * ⚠️ 不能用 canvas 的 `drawImage` 来采帧比对 —— 实测它在无头 Chrome 里
 *    **永远画第一帧**（连采 11 次、跨 5 秒，哈希一模一样）。而同一时刻用
 *    `Page.captureScreenshot` 截图，画面之间差异明显（平均差 10~14）——
 *    也就是说"动图在播"是真的，只是 canvas 这条路读不到当前帧。
 *
 * 所以这里改成直接验**文件本身**：WebP 的每一帧都是一个 `ANMF` 块，
 * 数一数就知道这张图是不是真的多帧。确定、便宜、且正好挡住"被换成静态图"
 * 这个真实的回归风险。
 */
const assetUrl = img.currentSrc || img.src
const assetBytes = new Uint8Array(await realFetch(assetUrl).then((r) => r.arrayBuffer()))
let anmfCount = 0
for (let i = 0; i + 3 < assetBytes.length; i++) {
  if (assetBytes[i] === 0x41 && assetBytes[i + 1] === 0x4e && assetBytes[i + 2] === 0x4d && assetBytes[i + 3] === 0x46) {
    anmfCount++
  }
}
check(
  '扒窗口的立绘是多帧动图（耳朵甩动烘焙在里面）',
  anmfCount >= 10,
  `${anmfCount} 帧 / ${(assetBytes.length / 1024).toFixed(0)} KB`,
)

const mRect = mascot.getBoundingClientRect()

/* 等落座过渡走完再量 —— 换立绘会触发两次重排，面板顶边会平移十几个像素 */
const p = await settle(panel)
m = await settle(mascot)

/*
 * 核心观感：她扒在面板上沿。
 * 判据是她和面板在竖直方向**重叠** PERCH_OVERLAP，且水平方向她完整落在
 * 面板范围内（不能悬空在面板边上）、也不压住头部的关闭按钮。
 *
 * ⚠️ 下面这个数必须和 `src/core/nya.ts` 里的 PERCH_OVERLAP 一致。
 *    刻意写成常量而不是"大于某值"：这个数就是观感本身，
 *    改动它就该有人（我）回来看一眼是不是有意的。
 */
const PERCH_OVERLAP = 4

check(
  '她扒在面板上沿（底部压进面板约 4px）',
  Math.abs(m.b - p.t - PERCH_OVERLAP) < 3,
  { 她的底: Math.round(m.b), 面板顶: Math.round(p.t), 重叠: Math.round(m.b - p.t) },
)
check(
  '她站在面板宽度范围内',
  m.l >= p.l - 2 && m.r <= p.r + 2,
  { 她: `${Math.round(m.l)}..${Math.round(m.r)}`, 面板: `${Math.round(p.l)}..${Math.round(p.r)}` },
)

/*
 * 她落在面板的**右上角**（用户 2026-09-14 的要求）。
 *
 * 判据是右边缘离面板右边只差一点点（PERCH_INSET），而不是"在右半边"这种
 * 宽松说法 —— 这条断言的意义就是钉住那个观感，宽松了就守不住。
 * ⚠️ 这个数必须和 `src/core/nya.ts` 的 PERCH_INSET 一致。
 */
const PERCH_INSET = 6
check(
  '她趴在面板右上角',
  Math.abs(p.r - m.r - PERCH_INSET) < 3,
  { 她右边界: Math.round(m.r), 面板右边界: Math.round(p.r), 差: Math.round(p.r - m.r) },
)

/*
 * 趴着时她要**明显小于**待机时（用户反馈"比例不协调"）。
 * 判据用高度比而不是绝对像素 —— 绝对像素会随视口宽度变（height 是 clamp）。
 */
const idleH = 160
check(
  '趴着时比待机时小一圈',
  m.h < idleH * 0.85,
  { 趴着高: Math.round(m.h), 待机上限: idleH },
)

/*
 * 不能压住关闭按钮。
 * 这条是实测踩出来的：一开始沿用她被拖到的横坐标，而默认站位在右下角，
 * 于是落座后被挤到面板最右边，正好盖住 × —— 截图放大才看出来。
 * 后来换成按面板宽度的百分比，又在"她换成半身像变宽 14px"之后再次压上。
 *
 * 判据是她和按钮的**外框**不相交 —— 比"看像素"严，但留白本来就是靠
 * 布局保证的，外框不交才是真的安全。
 */
const closeBtn = panel.querySelector('.nya-close')
const cr = closeBtn.getBoundingClientRect()
const coversClose = m.r > cr.left && m.b > cr.top
check('没有压住关闭按钮', !coversClose, {
  她右边界: Math.round(m.r),
  关闭按钮左边界: Math.round(cr.left),
  水平留白: Math.round(cr.left - m.r),
  她下边界: Math.round(m.b),
  关闭按钮上边界: Math.round(cr.top),
})

const inViewport = (r) => r.l >= -1 && r.t >= -1 && r.r <= vw + 1 && r.b <= vh + 1
check('打开后她在视口内', inViewport(m), `${Math.round(m.l)},${Math.round(m.t)} ${Math.round(m.w)}x${Math.round(m.h)}`)
check(
  '打开后面板在视口内',
  inViewport(p),
  `${Math.round(p.l)},${Math.round(p.t)} ${Math.round(p.w)}x${Math.round(p.h)}  视口 ${vw}x${vh}`,
)

/*
 * 加了固定定位的浮层之后，重新确认页面没有被撑出横向滚动条。
 * 这是 probe-quality.js 已有的检查项，这里复查一次的成本近乎为零。
 */
const de = document.documentElement
check('加浮层后页面仍无横向溢出', de.scrollWidth <= vw + 1, {
  scrollWidth: de.scrollWidth,
  innerWidth: vw,
})

/* ---------- ⑤ 首屏内容 ---------- */

check('问候语非空', (document.querySelector('.nya-hello p')?.textContent?.trim().length ?? 0) > 10)
const chips = document.querySelectorAll('.nya-chip')
check('有示例问题引导', chips.length >= 2, `${chips.length} 条`)
check('输入框存在且可用', !!document.querySelector('.nya-input') && !document.querySelector('.nya-input').disabled)

/* ---------- ⑥ 发送链路（用假后端，不碰真模型） ---------- */

const input = document.querySelector('.nya-input')
const form = document.querySelector('.nya-form')
let captured = null

const fakeFetch = (handler) => {
  window.fetch = async (url, init) => {
    try {
      captured = { url: String(url), body: JSON.parse(init?.body ?? '{}') }
    } catch {
      captured = { url: String(url), body: null }
    }
    return handler(captured)
  }
}

const submit = async (text) => {
  input.value = text
  input.dispatchEvent(new Event('input', { bubbles: true }))
  form.requestSubmit()
  await sleep(350)
}

const lastBubble = () => {
  const all = document.querySelectorAll('.nya-msg')
  return all[all.length - 1]
}

/* --- 正常回答 --- */
fakeFetch(
  async () =>
    new Response(JSON.stringify({ reply: '（假回答）你先看看那条线是斜的还是平的。' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
)
await submit('测试：正常回答')

const okBubble = lastBubble()
check('正常回答渲染成 Nya 气泡', okBubble?.classList.contains('is-nya'), okBubble?.className)
check('气泡文本与后端返回一致', okBubble?.textContent?.includes('假回答'))
check('发问后示例问题已退场', document.querySelectorAll('.nya-chip').length === 0)

/*
 * 请求体必须带上页面上下文。
 * 这条是「指着学生屏幕回答」这个核心能力的地基 —— 断了它，
 * Nya 会退回成通用问答机器人，而页面上看不出任何异常。
 */
check('请求打到了 /api/chat', /\/api\/chat$/.test(captured?.url ?? ''), captured?.url)
check('请求带上了 demoId', captured?.body?.context?.demoId === 'linear-regression', captured?.body?.context?.demoId)
check(
  '请求带上了页面状态（白名单键）',
  !!captured?.body?.context?.state && typeof captured.body.context.state === 'object',
  captured?.body?.context?.state,
)
check('历史只发最近的若干轮', Array.isArray(captured?.body?.messages) && captured.body.messages.length <= 10)

/*
 * 「上一次快照」必须跟着第二轮一起发出去 —— 这是她能不能说出
 * 「你把阈值从 0.50 拖到 0.79」的唯一依据。
 *
 * ⚠️ 这里只测到"前端发了"。服务端有没有把它拷进提示词是另一件事 ——
 *    2026-09-14 正是**服务端静默丢掉**了它，而这条断言照样会绿。
 *    那一段由 `scripts/check-server-path.mjs` 盯着（走完整 handleChat 链路）。
 */
const firstRequestState = captured?.body?.context?.state
const firstRequestPrev = captured?.body?.context?.prev
check('第一次提问不带上一份快照（没有可比的）', firstRequestPrev === undefined, firstRequestPrev)

await submit('测试：第二轮')
const secondPrev = captured?.body?.context?.prev
check(
  '第二次提问带上了上一份快照',
  !!secondPrev && typeof secondPrev === 'object' && Object.keys(secondPrev).length > 0,
  secondPrev,
)
check(
  '上一份快照就是第一次那份状态',
  JSON.stringify(secondPrev) === JSON.stringify(firstRequestState),
  { 第一次: firstRequestState, 第二轮带的: secondPrev },
)

/* --- 服务未配置 / 上游出错：必须显示成"出错"，不能装作是正常回答 --- */
fakeFetch(
  async () =>
    new Response(JSON.stringify({ error: 'NOT_CONFIGURED', message: 'Nya 还没配置好。' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    }),
)
await submit('测试：服务未配置')
const errBubble = lastBubble()
check('服务出错时显示为错误气泡', errBubble?.classList.contains('is-err'), errBubble?.className)
check('错误气泡带上了服务端的中文提示', errBubble?.textContent?.includes('还没配置好'))

/* --- 网络中断 --- */
window.fetch = async () => {
  throw new TypeError('Failed to fetch')
}
await submit('测试：断网')
const netBubble = lastBubble()
check('断网时也有提示', netBubble?.classList.contains('is-err'))
check('断网提示说明页面其余功能正常', netBubble?.textContent?.includes('其他功能'))

/* --- 出错之后面板还必须能用（AI 是增强项，不是地基） --- */
check('出错后输入框仍可用', !input.disabled)
check('出错后没有残留的加载动画', !document.querySelector('.nya-typing'))

/* ---------- ⑦ 关闭与回位 ---------- */

const perched = rectOf(mascot)

/*
 * 必须把事件派发到面板**内部**的元素上。
 * 监听器挂在 `#nya` 上（靠冒泡接住真实按键），而 `document.dispatchEvent`
 * 是往下走不到的 —— 事件只向上冒泡。真实场景里 Esc 的目标是获得焦点的
 * 输入框，所以这里在 input 上派发，行为和真人按键一致。
 */
input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
await sleep(450)

check('Esc 能关闭面板', getComputedStyle(panel).visibility === 'hidden')

/* 等回位过渡走完再量 —— 460ms 的过渡，固定 sleep 会踩在半路上 */
const back = await settle(mascot)
check(
  '关闭后回到拖动时的位置',
  Math.abs(back.l - afterDrag.l) < 3 && Math.abs(back.t - afterDrag.t) < 3,
  { 拖动后: `${Math.round(afterDrag.l)},${Math.round(afterDrag.t)}`, 关闭后: `${Math.round(back.l)},${Math.round(back.t)}` },
)
check('落座位置确实和拖动位置不同（说明它真的动过）', Math.abs(perched.t - back.t) > 2)

/* ---------- ⑨ 对话记录跨页保留 ---------- */
/*
 * 放在拖动测试**之前**做，顺序有讲究：
 *   ⑧ 里那两次拖动会武装"吞掉紧随其后的一次点击"的标志。真实浏览器会在松手后
 *   自动补一次 click 把它消费掉，但测试用的是合成事件 —— 那一次 click 不会来，
 *   于是标志一直挂着，紧接着点「清空」就会被吃掉。
 *   （实现里给标志加了 400ms 超时兜底，但没必要让测试去踩那个边界。）
 */

/*
 * 用户 2026-09-14 反馈：在线性回归问完，点进别的页面，记录就没了。
 * 根因是记录只放在 JS 内存里，而站点是**多页**应用 —— 换页 = 整页加载。
 * 现在存在 sessionStorage（同一个标签页内跨页有效，关掉标签页清空）。
 *
 * 分两半验，因为它有两条独立的通路：
 *   写：发问之后必须真的落了盘；
 *   读：**新打开一页**要能把记录铺回来 —— 这一半只有"另一份文档"能验出来。
 *       用同源 iframe 模拟"下一页"：同源 iframe 会**复制**父页面的 sessionStorage，
 *       正好就是换页时的情形。
 */
const CHAT_KEY = 'nya:chat'
const stored = (() => {
  try {
    return JSON.parse(sessionStorage.getItem(CHAT_KEY) ?? 'null')
  } catch {
    return null
  }
})()
check(
  '发问后对话记录落了盘',
  !!stored && Array.isArray(stored.msgs) && stored.msgs.length >= 2,
  stored ? `${stored.msgs?.length} 条` : '没有存',
)
check(
  '落盘的记录里，学生那一条在、她的回答也在',
  !!stored?.msgs?.some((m) => m.role === 'user') && !!stored?.msgs?.some((m) => m.role === 'assistant'),
  stored?.msgs?.map((m) => m.role).join(','),
)

const clearBtn = panel.querySelector('.nya-clear')
check('有记录时「清空」按钮可见', !!clearBtn && !clearBtn.hidden)

/*
 * ⚠️ 真实点击路径：pointerdown 落在**按钮**上时，不能启动面板拖拽。
 *
 * 为什么这条非加不可：面板拖拽会调 `head.setPointerCapture()`，而**指针捕获
 * 会把随后那次 click 的目标改到标题栏上** —— 按钮自己的 click 监听器就不触发了。
 * 表现是"点清空 / 点关闭没反应"，而且**只有真实鼠标点击才复现**：
 * 合成事件（`el.click()`）不经过 pointerdown，永远测不到这个 bug。
 * （2026-09-15 用户在电脑上点不动「清空」和「×」，就是它。）
 * ⇒ 所以这里派发真实的 pointer 序列，直接查"拖拽有没有被误启动"。
 */
const headForClear = panel.querySelector('.nya-head')
const clearRect = clearBtn.getBoundingClientRect()
clearBtn.dispatchEvent(pointer('pointerdown', clearRect.left + 6, clearRect.top + 6))
await sleep(40)
const clearStartedDrag = headForClear.classList.contains('is-dragging')
clearBtn.dispatchEvent(pointer('pointerup', clearRect.left + 6, clearRect.top + 6))
await sleep(40)
check(
  '点「清空」不会启动面板拖拽（否则指针捕获会吃掉它的 click）',
  !clearStartedDrag,
  clearStartedDrag ? '⚠️ 拖拽被误启动 —— 真实点击时这个按钮会失效' : 'ok',
)

const msgBox = document.querySelector('.nya-body')
const beforeClear = msgBox.querySelectorAll('.nya-msg').length
clearBtn.click()
await sleep(200)
check('点「清空」后消息清空', msgBox.querySelectorAll('.nya-msg').length === 0, { 之前: beforeClear })
check('点「清空」后存储也清掉', sessionStorage.getItem(CHAT_KEY) === null)
check('点「清空」后开场引导回来了', !!msgBox.querySelector('.nya-hello'))
check('清空后按钮自己收起来', clearBtn.hidden)

/*
 * 再验"读"：塞一段记录进 sessionStorage，然后开一个**新页面**，
 * 它应该把这段记录铺出来、而且不再显示开场引导。
 */
sessionStorage.setItem(
  CHAT_KEY,
  JSON.stringify({
    v: 1,
    msgs: [
      { role: 'user', content: '__跨页测试的问题__' },
      { role: 'assistant', content: '__跨页测试的回答__' },
    ],
  }),
)
const frame = document.createElement('iframe')
frame.style.cssText = 'position:fixed;left:-9999px;width:1024px;height:768px;border:0'
/* 故意换一页 —— 验的就是"换页之后还在" */
frame.src = location.pathname.replace(/\/demos\/[^/]+\//, '/demos/pca/')
document.body.append(frame)

let frameOk = false
for (let i = 0; i < 40 && !frameOk; i++) {
  await sleep(250)
  try {
    frameOk = !!frame.contentDocument?.querySelector('#nya')
  } catch {
    /* 还没加载完 */
  }
}

const fdoc = frame.contentDocument
const fmsgs = fdoc ? Array.from(fdoc.querySelectorAll('.nya-msg')) : []
check('换页后新页面里挂上了面板', frameOk)
check(
  '换页后旧的对话记录被铺回来了',
  fmsgs.some((el) => el.textContent === '__跨页测试的问题__') &&
    fmsgs.some((el) => el.textContent === '__跨页测试的回答__'),
  fmsgs.map((el) => el.textContent.slice(0, 12)),
)
check('换页后有记录时不再显示开场引导', !!fdoc && !fdoc.querySelector('.nya-hello'))
check('换页后「清空」按钮是可见的', !!fdoc?.querySelector('.nya-clear') && !fdoc.querySelector('.nya-clear').hidden)
frame.remove()
sessionStorage.removeItem(CHAT_KEY)

/* ---------- ⑧ 拖动面板（抓手是标题栏） ---------- */

/*
 * 要求（用户 2026-09-14）：抓住标题栏拖，整个面板跟着在屏幕上走，她也要跟着 ——
 * 她是"趴在面板上沿"的，面板走了她还留在原地就穿帮了。
 *
 * 放在最后测：它会改掉面板和她的位置，前面那些位置断言
 * （落座几何、关闭回位）不该被它影响。
 */
mascot.click()
await sleep(700)

const headEl = panel.querySelector('.nya-head')
const headRect = headEl.getBoundingClientRect()
const headStart = { x: headRect.left + 40, y: headRect.top + headRect.height / 2 }
const beforePanel = rectOf(panel)
const beforeMascot = rectOf(mascot)
const mhNow = beforeMascot.h

/*
 * ⚠️ 位移不能写死。
 *
 * 面板的位置被 layout() 夹在
 *   横向 [EDGE, vw-pw-EDGE]，纵向 [EDGE+mh-PERCH_OVERLAP, vh-EDGE-ph]
 * 之内 —— 因为她必须完整留在视口里（所以往上顶到某个位置就不动了）。
 * 手机上更极端：面板本来就是整宽，**横向一点余量都没有**。
 * 第一版写死了 (-180,-140)，结果 1440×900 下纵向被夹掉 9px、
 * 430×900 下横向完全动不了 —— 两处都是**测试假设错**，不是界面错。
 * 所以这里先量出可用空间，再挑一个一定动得了的位移。
 */
const EDGE = 12
const roomL = beforePanel.l - EDGE
const roomR = vw - EDGE - beforePanel.w - beforePanel.l
const roomU = beforePanel.t - (EDGE + mhNow - 4)
const roomD = vh - EDGE - beforePanel.h - beforePanel.t
const STEP = 90
const dx = roomL >= STEP ? -STEP : roomR >= STEP ? STEP : 0
const dy = roomU >= STEP ? -STEP : roomD >= STEP ? STEP : 0

check(
  '面板至少有一个方向能移动（否则这条测了个寂寞）',
  dx !== 0 || dy !== 0,
  { 左: Math.round(roomL), 右: Math.round(roomR), 上: Math.round(roomU), 下: Math.round(roomD) },
)

headEl.dispatchEvent(pointer('pointerdown', headStart.x, headStart.y))
headEl.dispatchEvent(pointer('pointermove', headStart.x + dx, headStart.y + dy))
headEl.dispatchEvent(pointer('pointerup', headStart.x + dx, headStart.y + dy))
const afterPanel = await settle(panel)
const afterMascot = await settle(mascot)

check(
  '拖标题栏能搬动面板',
  Math.abs(afterPanel.l - (beforePanel.l + dx)) < 4 && Math.abs(afterPanel.t - (beforePanel.t + dy)) < 4,
  {
    期望: `${Math.round(beforePanel.l + dx)},${Math.round(beforePanel.t + dy)}`,
    实际: `${Math.round(afterPanel.l)},${Math.round(afterPanel.t)}`,
  },
)
check(
  '她被面板带着一起走',
  Math.abs(afterMascot.l - beforeMascot.l - dx) < 4 && Math.abs(afterMascot.t - beforeMascot.t - dy) < 4,
  { 她位移: `${Math.round(afterMascot.l - beforeMascot.l)},${Math.round(afterMascot.t - beforeMascot.t)}` },
)
check(
  '搬完之后她仍在面板右上角',
  Math.abs(afterPanel.r - afterMascot.r - PERCH_INSET) < 3,
  { 差: Math.round(afterPanel.r - afterMascot.r) },
)
check('拖完面板没有被关掉', getComputedStyle(panel).visibility === 'visible')

/*
 * 再往左上狠狠拖一把 —— 这次是**故意越界**，验的是夹紧：
 * 面板和她都必须完整留在视口里（她能被她自己拖出去就再也点不到了）。
 */
headEl.dispatchEvent(pointer('pointerdown', headStart.x, headStart.y))
headEl.dispatchEvent(pointer('pointermove', headStart.x - 4000, headStart.y - 4000))
headEl.dispatchEvent(pointer('pointerup', headStart.x - 4000, headStart.y - 4000))
const clampedPanel = await settle(panel)
const clampedMascot = await settle(mascot)

check('拖出界时面板被夹在视口内', inViewport(clampedPanel), `${Math.round(clampedPanel.l)},${Math.round(clampedPanel.t)}`)
check(
  '拖出界时她也完整留在视口内',
  inViewport(clampedMascot),
  `${Math.round(clampedMascot.l)},${Math.round(clampedMascot.t)} ${Math.round(clampedMascot.w)}x${Math.round(clampedMascot.h)}`,
)
check('拖出界后她仍贴在面板上沿', Math.abs(clampedMascot.b - clampedPanel.t - PERCH_OVERLAP) < 3, {
  她的底: Math.round(clampedMascot.b),
  面板顶: Math.round(clampedPanel.t),
})

const passed = results.filter((r) => r.ok).length
return {
  ok: passed === results.length,
  passed,
  total: results.length,
  视口: `${vw}x${vh}`,
  failures: results.filter((r) => !r.ok),
}
