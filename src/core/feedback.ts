/**
 * 「报告问题」——贴右边缘的竖标签，点开是一个不跳页的表单。
 *
 * 三件事在设计上想清楚了，写在这里免得以后改回去：
 *
 * ① **为什么不占右下角**：右下角是 Nya 的（她默认落点在距右 24 / 距下 20，
 *    待机时占 200 多像素宽）。反馈入口本来也不该抢眼，所以贴右边缘、竖直居中
 *    —— 既不挡内容，也不和她打架，将来她怎么拖都不影响这里。
 *
 * ② **现场信息比用户描述值钱**。
 *    用户说「这个数字不对」——可这一页有十来个数字、几十种参数组合。
 *    让他描述的成本很高，而附带的成本是零。所以表单自动带上：
 *      · 页面参数与指标（**复用 Nya 的状态读取器**，见 `samplePageState`）
 *      · 浏览器、视口、当前主题
 *      · 最近几条控制台报错
 *    并且**逐项可见、可取消勾选** —— 采集这件事必须让人看得见。
 *
 * ③ **失败不能白报**。
 *    邮件发失败时，报告仍然会写进服务端日志；前端如实告诉用户「已记录」，
 *    绝不假装发送成功（那会让他以为问题已经报上去了）。
 */

import { siteUrl } from './pager'
import { samplePageState } from './nya'

/** 问题类型。第一个是默认值 —— 大多数报告都是「数字看着不对」。 */
const TYPES = ['数字不对', '文字有错', '图表不动', '页面报错', '其他'] as const

const MAX_ERRORS = 5
const MAX_TEXT = 1000

/* ------------------------------------------------------------------ *
 * 控制台错误捕获
 *
 * ⚠️ 必须装在**模块顶层**，不能等到面板打开再装 —— 那时候错已经发生过了。
 *    这个模块由 `mountChrome()` 静态引入，所以它会在页面脚本一开始就执行，
 *    是全站最早的时机之一。
 *
 * 这是「页面白屏 / 图表崩了」这类问题唯一能拿到线索的地方：
 * 用户只会说「打不开」，而堆栈只存在于控制台里。
 * ------------------------------------------------------------------ */

const recentErrors: string[] = []

function noteError(text: string): void {
  /* 压成一行并截断：错误堆栈可能几百字符，进邮件只会把正文挤没 */
  const one = text.replace(/\s+/g, ' ').trim().slice(0, 200)
  if (!one) return
  /* 同一条只留一次 —— 循环里的报错会在一秒内刷满整个列表 */
  if (recentErrors.includes(one)) return
  recentErrors.push(one)
  if (recentErrors.length > MAX_ERRORS) recentErrors.shift()
}

if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => {
    const err = (e as ErrorEvent).error
    const head = err instanceof Error ? `${err.name}: ${err.message}` : (e as ErrorEvent).message
    noteError(`${head} @ ${(e as ErrorEvent).filename ?? '?'}:${(e as ErrorEvent).lineno ?? 0}`)
  })
  window.addEventListener('unhandledrejection', (e) => {
    const r = (e as PromiseRejectionEvent).reason
    noteError(`未处理的 Promise 拒绝: ${r instanceof Error ? r.message : String(r)}`)
  })
}

/* ------------------------------------------------------------------ *
 * 采集
 * ------------------------------------------------------------------ */

interface ContextItem {
  /** 服务端和邮件里用的分组名 */
  group: string
  key: string
  value: string
}

/** 采一份现场信息。返回的是**扁平列表**，因为界面要逐项给勾选框。 */
function collectContext(): ContextItem[] {
  const items: ContextItem[] = []

  /* ① 页面参数与指标 —— 复用 Nya 那份读取器（值都是页面上真实显示的那串字）。
   *    没有它就只能靠用户口述，而口述往往缺最关键的那个数。 */
  const state = samplePageState()
  if (state) {
    for (const [key, value] of Object.entries(state)) {
      if (value === undefined || value === null) continue
      const text = String(value).trim()
      if (text) items.push({ group: '页面状态', key, value: text })
    }
  }

  /* ② 环境。用 pathname 而不是 href —— 不带 query / hash，
   *    既够定位页面，也不会顺手把 URL 里的东西一起发出去。 */
  items.push({ group: '环境', key: '页面', value: location.pathname })
  items.push({
    group: '环境',
    key: '视口',
    value: `${window.innerWidth}×${window.innerHeight} @ ${window.devicePixelRatio}x`,
  })
  items.push({
    group: '环境',
    key: '主题',
    value: document.documentElement.dataset.theme === 'dark' ? '深色' : '浅色',
  })
  items.push({ group: '环境', key: '浏览器', value: navigator.userAgent.slice(0, 160) })

  return items
}

/* ------------------------------------------------------------------ *
 * 挂载
 * ------------------------------------------------------------------ */

/**
 * 挂载反馈入口。**幂等** —— 重复调用只有第一次生效。
 *
 * 和 Nya 一样收在 `mountChrome()` 里（全站唯一必经点），
 * 这样以后加页面不用记得再挂一次。
 */
export function mountFeedback(): void {
  if (document.querySelector('.fb-tab')) return

  /* --- 外层容器 ---
   * 和 `#nya` 同一个套路：容器 fixed 且不吃点击，只有子元素吃。
   * ⚠️ 选择器一律用**类**，不要写 `.fb > *` 这种 ——
   *    容器是 ID 权重会压掉子元素自己的 pointer-events（Nya 那边踩过两次）。 */
  const root = document.createElement('div')
  root.className = 'fb'

  const tab = document.createElement('button')
  tab.type = 'button'
  tab.className = 'fb-tab'
  tab.setAttribute('aria-expanded', 'false')
  tab.setAttribute('aria-controls', 'fb-panel')
  tab.innerHTML = '<span class="fb-tab-text">报告问题</span>'

  const panel = document.createElement('div')
  panel.className = 'fb-panel'
  panel.id = 'fb-panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', '报告一个问题')

  /* 面板内容一次建好（不反复重建）—— 用户填到一半不会因为重绘丢字 */
  const form = document.createElement('form')
  form.className = 'fb-form'
  form.noValidate = true

  const head = document.createElement('div')
  head.className = 'fb-head'
  const title = document.createElement('span')
  title.className = 'fb-title'
  title.textContent = '报告一个问题'
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'fb-close'
  close.setAttribute('aria-label', '关闭')
  close.textContent = '×'
  head.append(title, close)

  const typeLabel = document.createElement('p')
  typeLabel.className = 'fb-label'
  typeLabel.textContent = '这是什么类型的问题？'

  const typeWrap = document.createElement('div')
  typeWrap.className = 'fb-types'
  const typeButtons = TYPES.map((t, i) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'fb-type'
    b.dataset.type = t
    b.textContent = t
    /* 默认选中第一个，但**不是**预填内容 —— 用户还是要自己写一句 */
    if (i === 0) b.classList.add('is-on')
    b.addEventListener('click', () => {
      typeButtons.forEach((x) => x.classList.toggle('is-on', x === b))
    })
    typeWrap.append(b)
    return b
  })

  const textLabel = document.createElement('label')
  textLabel.className = 'fb-label'
  textLabel.setAttribute('for', 'fb-text')
  textLabel.textContent = '你看到了什么？'

  const textArea = document.createElement('textarea')
  textArea.className = 'fb-text'
  textArea.id = 'fb-text'
  textArea.rows = 4
  textArea.maxLength = MAX_TEXT
  textArea.placeholder = '比如：把阈值拖到 0.79 以后，准确率反而变低了'

  const mailLabel = document.createElement('label')
  mailLabel.className = 'fb-label'
  mailLabel.setAttribute('for', 'fb-mail')
  mailLabel.textContent = '邮箱（选填，想收到回复再填）'

  const mail = document.createElement('input')
  mail.className = 'fb-mail'
  mail.id = 'fb-mail'
  mail.type = 'email'
  mail.maxLength = 120
  mail.autocomplete = 'email'
  mail.placeholder = 'you@example.com'

  /* --- 现场信息：逐项勾选 --- */
  const ctxBox = document.createElement('details')
  ctxBox.className = 'fb-ctx'
  const ctxSum = document.createElement('summary')
  ctxSum.className = 'fb-ctx-sum'
  ctxSum.textContent = '会一并附带这些现场信息'
  const ctxList = document.createElement('ul')
  ctxList.className = 'fb-ctx-list'
  ctxBox.append(ctxSum, ctxList)

  const errorNote = document.createElement('p')
  errorNote.className = 'fb-ctx-note'
  ctxBox.append(errorNote)

  /* --- 蜜罐 ---
   * 正常用户看不见它（CSS 移出视口），但机器人会老老实实把所有 input 填满。
   * 服务端看到它有值就直接丢弃。 */
  const trap = document.createElement('input')
  trap.className = 'fb-trap'
  trap.type = 'text'
  trap.name = 'company'
  trap.tabIndex = -1
  trap.autocomplete = 'off'
  trap.setAttribute('aria-hidden', 'true')

  const actions = document.createElement('div')
  actions.className = 'fb-actions'
  const send = document.createElement('button')
  send.type = 'submit'
  send.className = 'fb-send'
  send.textContent = '发送'
  const hint = document.createElement('span')
  hint.className = 'fb-hint'
  hint.textContent = '不需要填任何个人信息'
  actions.append(send, hint)

  const status = document.createElement('p')
  status.className = 'fb-status'
  status.setAttribute('role', 'status')

  form.append(
    head,
    typeLabel,
    typeWrap,
    textLabel,
    textArea,
    mailLabel,
    mail,
    ctxBox,
    trap,
    actions,
    status,
  )
  panel.append(form)
  root.append(tab, panel)
  document.body.append(root)

  /* ------------------------------------------------------------------ *
   * 开关
   * ------------------------------------------------------------------ */

  /**
   * 打开面板的时间戳。
   *
   * 提交时把它一起发出去 —— 服务端据此判断「打开不到 1.5 秒就提交」
   * 基本是脚本（真人要先打字）。这是防滥用里最便宜的一层，
   * 因为它是**纯前端测量、服务端只做判断**，不需要任何额外依赖。
   */
  let openedAt = 0

  /** 打开时采集的那份现场信息（勾选状态和它一一对应） */
  let collected: ContextItem[] = []
  let checks: HTMLInputElement[] = []

  const renderContext = () => {
    collected = collectContext()
    checks = []
    ctxList.replaceChildren()
    for (const item of collected) {
      const li = document.createElement('li')
      li.className = 'fb-ctx-item'
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = true
      box.dataset.group = item.group
      box.dataset.key = item.key
      const label = document.createElement('label')
      label.className = 'fb-ctx-label'
      const k = document.createElement('span')
      k.className = 'fb-ctx-key'
      k.textContent = `${item.group} · ${item.key}`
      const v = document.createElement('span')
      v.className = 'fb-ctx-val'
      v.textContent = item.value
      label.append(k, v)
      li.append(box, label)
      ctxList.append(li)
      checks.push(box)
    }

    /* 控制台报错单独列在后面 —— 它和页面参数性质不同，
     * 而且它**不存在**的时候要说清楚（否则用户会以为漏发了） */
    if (recentErrors.length > 0) {
      errorNote.textContent = `另有 ${recentErrors.length} 条控制台报错会一起发给我`
      errorNote.hidden = false
    } else {
      errorNote.textContent = '这次没有捕获到控制台报错'
      errorNote.hidden = false
    }
  }

  const setOpen = (next: boolean) => {
    root.dataset.open = next ? 'true' : 'false'
    tab.setAttribute('aria-expanded', next ? 'true' : 'false')
    if (!next) return
    openedAt = Date.now()
    renderContext()
    /* 焦点给到描述框：打开就是为了写字，少让用户按一次 Tab */
    textArea.focus()
  }

  tab.addEventListener('click', () => setOpen(root.dataset.open !== 'true'))
  close.addEventListener('click', () => setOpen(false))

  /* Esc 关闭。监听挂在 root 上靠冒泡接住真实按键 ——
   * document 上派发的事件走不到这里，真实场景里目标一定是面板内部的元素。 */
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root.dataset.open === 'true') {
      e.stopPropagation()
      setOpen(false)
    }
  })

  /* 点面板外面关掉。用 pointerdown 而不是 click：
   * click 要等松手，拖动页面时容易误触。 */
  document.addEventListener('pointerdown', (e) => {
    if (root.dataset.open !== 'true') return
    const t = e.target as Element | null
    if (t?.closest('.fb-panel') || t?.closest('.fb-tab')) return
    setOpen(false)
  })

  /* ------------------------------------------------------------------ *
   * 提交
   * ------------------------------------------------------------------ */

  const setStatus = (text: string, kind: 'ok' | 'err' | 'busy' | '') => {
    status.textContent = text
    status.className = `fb-status${kind ? ` is-${kind}` : ''}`
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (send.disabled) return

    const text = textArea.value.trim()
    if (text.length < 5) {
      setStatus('再写一句具体的，我才能复现。', 'err')
      textArea.focus()
      return
    }

    const kind = typeButtons.find((b) => b.classList.contains('is-on'))?.dataset.type ?? '其他'

    /* 只带勾选了的项 —— 用户有权把任何一条留下 */
    const context = collected.filter((_, i) => checks[i]?.checked)

    send.disabled = true
    setStatus('正在发送…', 'busy')

    try {
      const res = await fetch(siteUrl('api/report'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind,
          text,
          email: mail.value.trim(),
          context,
          errors: recentErrors,
          /* 蜜罐 + 填写耗时：服务端用它们判"是不是人" */
          trap: trap.value,
          elapsedMs: openedAt ? Date.now() - openedAt : 0,
        }),
      })

      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string }

      if (res.ok && data.ok) {
        setStatus('收到了，谢谢你 —— 我会去看。', 'ok')
        textArea.value = ''
        mail.value = ''
        /* 成功了就别让面板一直占着屏幕 */
        window.setTimeout(() => setOpen(false), 2200)
      } else {
        setStatus(data.message ?? '没发出去，等一会儿再试试。', 'err')
      }
    } catch {
      setStatus('连不上服务器（可能是网络问题）。', 'err')
    } finally {
      send.disabled = false
    }
  })
}
