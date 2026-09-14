/**
 * Nya · 前端（猫娘形象 + 对话面板）
 *
 * 她是一个浮在页面上的猫娘立绘：**可以拖着走**，点一下开对话。
 * 面板打开时她会「趴」在面板上沿（下半身被面板挡住），
 * 关掉再回到你上次拖到的位置。
 *
 * 全站共用一份，挂载点收在 `chrome.ts`（和背景层一样，
 * 那里是每个页面唯一都会经过的地方）。
 *
 * ------------------------------------------------------------------ *
 * 四个设计决定
 * ------------------------------------------------------------------ *
 *
 * 1. **面板不持有业务知识。**
 *    「这一页讲什么」「有哪些术语」「正确数字是多少」全部在服务端
 *    （`chat/nya.ts`）。前端只做两件事：把学生的问题发出去、
 *    把页面当前的状态**按白名单键名**报上去。
 *    这样即使有人改前端（或者伪造请求），也塞不进假"事实"进提示词。
 *
 * 2. **状态由各页自己注册，不在这里猜。**
 *    `provideNyaState(fn)` 让每个演示页交出「怎么读出自己当前状态」。
 *    面板不认识任何页面的内部变量，只调用这个函数。
 *    好处：加新页时只改那一页，这个文件一行都不用动。
 *
 * 3. **AI 是增强项，不是地基。**
 *    请求失败、超时、没配密钥 —— 面板只显示一条提示，页面其余功能
 *    一律照常。不弹窗、不阻塞、不改变任何页面状态。
 *    （站点要能在 `file://` 下当离线 App 用，那时这个面板等于不存在。）
 *
 * 4. **位置算出来，不在 CSS 里写死。**
 *    她能停在视口的任何地方，而面板必须贴着她的脚下 ——
 *    这种关系 CSS 表达不了（没有"贴住另一个元素底边并重叠 30px"的写法），
 *    所以统一由下面的 `layout()` 计算，CSS 只负责长相。
 */

import { siteUrl } from './pager'
/*
 * 两套立绘：
 *   idle  —— 她还没被点开时用的，在原地跑步的动图（由视频抽帧做成，见
 *            `scripts/prepare_nya_idle.py`）
 *   perch —— 对话打开、她扒在窗口上沿时用的图（见 `scripts/prepare_nya_perch.py`）
 *
 * 为什么不是一套：待机那套是在原地跑（动图），而扒在窗口上沿需要"双手搭住
 * 一条边"的姿势 —— 两套各自对应一种状态，换不过去。
 */
import nyaIdleAnim from '../assets/nya-idle.webp'
import nyaIdleStill from '../assets/nya-idle-still.webp'
import nyaPerchAnim from '../assets/nya-twitch.webp'
import nyaPerchStill from '../assets/nya.webp'

/* ------------------------------------------------------------------ *
 * 对外接口
 * ------------------------------------------------------------------ */

/**
 * 读当前页面状态的回调。
 *
 * 返回值里的**键名必须**在服务端 `DemoKnowledge.stateKeys` 白名单里，
 * 不在白名单的键会被服务端丢掉（那里是防注入的闸门，不在这里）。
 */
type StateProvider = () => Record<string, unknown> | undefined

let stateProvider: StateProvider | null = null
let mounted = false

/**
 * 注册「怎么读这一页的当前状态」。
 *
 * 演示页在文件末尾调用即可。不调用也不报错 —— 面板会以
 * 「不知道学生屏幕上有哪些数字」的模式工作（此时 Nya 被要求
 * 不许提任何具体数字，只能讲概念）。
 */
export function provideNyaState(fn: StateProvider): void {
  stateProvider = fn
}

/**
 * 通用状态读取器：把「这一页此刻显示在屏幕上的东西」收成一组键值。
 *
 * ------------------------------------------------------------------ *
 * 为什么要有它（这是用户实测反馈后的返工）
 * ------------------------------------------------------------------ *
 * 第一版只给线性回归页写了状态上报。学生在「模型评估」页问
 * 「我这张表里是什么表现」，Nya 的回答是「这一页我看不到，你打开线性回归
 * 那一页」—— 完全答非所问。
 *
 * 根因不是 bug，是**只有一页接进来了**。而给十页各写一份状态上报，
 * 就是十份会各自过期的代码（"上一个/下一个"按钮当年就是这么写坏的）。
 *
 * 所以改成读**页面上已经渲染出来的字**：
 *   · `#metrics` / `#cv-metrics` 里的指标卡  → 「准确率 = 87.3%」
 *   · `#controls` / `#cv-controls` 里的滑杆   → 「判定阈值 = 0.50」
 *   · 页面上的下拉框                          → 「数据集 = 稀有病筛查」
 *
 * 这三个容器是十页共用的版式（`makeMetric` / `mountSlider` 统一生成），
 * 所以一个读取器就覆盖全部页面。加新页时也不用改这里。
 *
 * ⚠️ 每次调用都**重新读 DOM**，不许缓存 —— 学生拖完滑杆再问，报的必须是新值。
 *    报一个过期的数字比不报更糟（他会以为 Nya 在胡说）。
 *
 * ⚠️ 值的长度由服务端再截一次（`chat/nya.ts` 的 formatState），
 *    这里只负责"取到页面上真实显示的那串字"。
 *
 * @param extra 额外补充的键值（比如页面上没显示的内部量）。键名同样受
 *              服务端 `stateKeys` 白名单约束，不在白名单里的会被丢掉。
 */
export function provideNyaStateFromPage(extra?: () => Record<string, unknown>): void {
  provideNyaState(() => {
    const out: Record<string, unknown> = {}

    /* ① 下拉框（数据集 / 算法 / 核函数 …）—— 先收，后面的同名键会覆盖它。
     *    「模型评估」页有两个都叫「数据集」的下拉框（主图一个、交叉验证一个），
     *    按 DOM 顺序后来的赢，也就是主图那个 —— 正是我们要的。 */
    for (const sel of Array.from(document.querySelectorAll('select'))) {
      const label = labelFor(sel)
      const text = sel.selectedOptions[0]?.textContent?.trim()
      if (label && text) out[label] = text
    }

    /* ② 滑杆／数字框／开关。
     *    开关（checkbox）是后来补的：模型评估页的「分层切分」原先读不到，
     *    于是学生关掉分层再问她"为什么有一折没有正例"，她看不见那个开关。 */
    for (const ctrl of Array.from(document.querySelectorAll('.ctrl'))) {
      const label = ctrl.querySelector('label')?.textContent?.trim()
      if (!label) continue
      /*
       * 显式按优先级取，不用 `querySelector('input')` ——
       * 那取的是**文档顺序里第一个** input，而滑杆那套 DOM 里
       * 数字框（.ctrl-input）和 range 谁在前是实现细节，不该赌。
       */
      const input =
        ctrl.querySelector<HTMLInputElement>('.ctrl-input') ??
        ctrl.querySelector<HTMLInputElement>('input[type=checkbox]') ??
        ctrl.querySelector<HTMLInputElement>('input[type=range]')
      if (!input) continue
      if (input.type === 'checkbox') out[label] = input.checked ? '已打开' : '已关闭'
      else if (input.value) out[label] = input.value
    }

    /* ③ 多行输入框（学生自己敲进去的内容）。
     *    朴素贝叶斯页的主角操作就是"改一句话看判决怎么变" ——
     *    读不到那句话，她只能靠指标卡反推，等于盲猜。
     *    键名优先用 aria-label（那本来就是给读屏软件用的名字）。 */
    for (const box of Array.from(document.querySelectorAll('textarea'))) {
      const label = labelFor(box) ?? box.getAttribute('aria-label')?.trim()
      const text = box.value.trim()
      /* 空的不报 —— 报一个空值只会让她以为学生输了个空字符串 */
      if (label && text) out[label] = text
    }

    /* ④ 指标卡 —— 最后收，所以「正例占比」这种既是指标又是滑杆的，
     *    报的是指标卡上那串更好读的（「30.0%」而不是「0.3」）。 */
    for (const card of Array.from(document.querySelectorAll('.metric'))) {
      const key = card.querySelector('.metric-label')?.textContent?.trim()
      const value = card.querySelector('.metric-value')?.textContent?.trim()
      /* '-' 是还没算出来的占位，报了等于告诉 Nya 一个假数字 */
      if (key && value && value !== '-') out[key] = value
    }

    if (extra) Object.assign(out, extra())
    return out
  })
}

/** 找表单元素对应的 `<label for>`；没有就用它外层 `.ctrl` 的 label */
function labelFor(el: Element): string | undefined {
  if (el.id) {
    const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
    const text = lab?.textContent?.trim()
    if (text) return text
  }
  return el.closest('.ctrl')?.querySelector('label')?.textContent?.trim() || undefined
}

/**
 * 挂载猫娘与面板。**幂等** —— 重复调用只有第一次生效。
 *
 * 之所以做成幂等：它由 `mountChrome()` 统一调用，而有些页面的
 * dev 入口会重复触发 chrome 挂载（自测页）。多挂一次会出现两只猫。
 */
export function mountNya(): void {
  if (mounted) return
  mounted = true

  const root = document.createElement('div')
  root.id = 'nya'

  const mascot = buildMascot()
  const panel = buildPanel()

  root.append(mascot, panel)
  document.body.append(root)

  /* 演示页底部的分页器也在右下角，会给页脚补一条空白带避免遮挡（见 chat.css） */
  if (document.querySelector('.pager')) {
    document.documentElement.classList.add('nya-has-pager')
  }

  wireNya(root, mascot, panel)
}

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 面板尺寸。手机上是整宽抽屉，见 layout() */
const PANEL_W = 380
const PANEL_H = 540
/** 手机断点，和 chat.css 里的媒体查询保持一致 */
const MOBILE_BP = 640
/**
 * 她扒在面板上沿时，被面板压住的深度（px）。
 *
 * 这一版换成了「双手扒住板子」的立绘，所以这个值从 52 降到 12：
 * 52 是给半身像用的（要让下半身埋进面板才读得出"趴着"），
 * 而这套图本身就画着一条"她扒住的边"，压太多会把她的手一起切掉。
 * 只留一点点重叠，用来盖住图片最下面那条深色描边（抠图时板子留下的）——
 * 再大就会把她的手一起切掉。
 * ⚠️ 改这个值要同步改 `scripts/tests/nya-panel.js` 里那条断言。
 */
const PERCH_OVERLAP = 4
/**
 * 她落在面板**右上角**时，右边缘离面板右边留多少（px）。
 *
 * 为什么要往右上角放（用户 2026-09-14 的要求）：面板是 380×540，
 * 而她横向铺开接近 280px —— 按原来的"落在面板靠左 1/5 处"，
 * 整只猫占了面板上头一大块，比例上头重脚轻。
 * 靠到右上角之后，视觉重心回到面板本身，她像"趴在窗口右上角往里看"。
 *
 * ⚠️ 这里用**固定像素**，不用面板宽度的百分比 —— 面板头那一行是固定像素布局
 *    （左内边距 16 / 关闭按钮 28 / 右内边距 12），百分比在宽面板（手机整宽抽屉）
 *    上会把她一起往右推。这个坑踩过两次。
 * ⚠️ 她只压住面板顶边 4px（PERCH_OVERLAP），所以**不会盖住关闭按钮** ——
 *    这条有断言盯着（"没有压住关闭按钮"）。
 */
const PERCH_INSET = 6
/** 贴边留白 */
const EDGE = 12
/** 位置存这里。存的是**相对右下角的偏移**，这样换个屏幕尺寸她还在老地方 */
const POS_KEY = 'nya:pos'

/* ------------------------------------------------------------------ *
 * 对话记录的存放
 * ------------------------------------------------------------------ */

/**
 * 对话记录存这里。
 *
 * 为什么需要：站点是**多页**应用 —— 从线性回归点进 PCA 是一次真实的整页加载，
 * JS 内存里的一切都会重来。第一版把记录放在闭包里，于是学生一换页，
 * 「我们刚才聊到哪」就没了（用户 2026-09-14 反馈）。
 *
 * 为什么是 sessionStorage 而不是 localStorage：
 *   · sessionStorage 只在**同一个标签页**内跨页有效，关掉标签页就清空 ——
 *     这正好是"同一段学习过程"的边界；
 *   · localStorage 会一直留在机器上（多个人用一台电脑时，下一个人能看到
 *     上一个人问过什么），而且可能残留几个月后突然"接上一段陌生的对话"。
 * 要多标签页共享或长期保留的话，改这一个常量即可 —— 但那是另一个取舍。
 */
const CHAT_KEY = 'nya:chat'

/** 最多留多少条（一问一答算两条）。超了从最早的一对开始丢 */
const CHAT_LIMIT = 40

type ChatMessage = { role: 'user' | 'assistant'; content: string }

function loadChat(): ChatMessage[] {
  try {
    const raw = sessionStorage.getItem(CHAT_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    const msgs = (parsed as { msgs?: unknown } | null)?.msgs
    if (!Array.isArray(msgs)) return []
    /* 逐条校验：存储区里的东西可能是别的版本写的、也可能被手改过，
     * 直接信它等于把外部输入喂给渲染和请求体 */
    return msgs
      .filter(
        (m): m is ChatMessage =>
          !!m &&
          typeof m === 'object' &&
          ((m as ChatMessage).role === 'user' || (m as ChatMessage).role === 'assistant') &&
          typeof (m as ChatMessage).content === 'string',
      )
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))
      .slice(-CHAT_LIMIT)
  } catch {
    /* 隐私模式、配额满、JSON 坏了 —— 一律当成"没有历史"，不影响使用 */
    return []
  }
}

function saveChat(msgs: ChatMessage[]): void {
  try {
    sessionStorage.setItem(CHAT_KEY, JSON.stringify({ v: 1, msgs: msgs.slice(-CHAT_LIMIT) }))
  } catch {
    /* 存不下就算了：面板照常能用，只是换页会丢 */
  }
}

function dropChat(): void {
  try {
    sessionStorage.removeItem(CHAT_KEY)
  } catch {
    /* 同上 */
  }
}

/* ------------------------------------------------------------------ *
 * 图标（内联 SVG，避免为一个按钮引入图标库）
 * ------------------------------------------------------------------ */

const ICON_CLOSE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'
const ICON_SEND =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12h14M13 5.5l6.5 6.5-6.5 6.5"/></svg>'

/* ------------------------------------------------------------------ *
 * 文案
 *
 * 开场引导语和「不知道问什么」的示例问题。
 * ⚠️ 这里写的只是「入口」，不是知识 —— 不出现任何未解释的术语，
 *    和 `core/guide.ts` 的开场守则同一条标准。
 * ------------------------------------------------------------------ */

const GREETING = '我是 Nya。这一页有看不明白的地方，直接问我 —— 我尽量不直接给答案，会先陪你一起看。'

/**
 * 按页给示例问题。key 是演示页 id（从 URL 读，不依赖页面自报）。
 *
 * ⚠️ 只能问**这一页真的能回答**的东西：她看得见这一页的指标和控件，
 *    看不见别的页面的数字。写一条"跨页对比"的问题，她只能含糊其辞。
 */
const CHIPS: Record<string, string[]> = {
  'linear-regression': ['这条线怎么调才对？', 'MSE 是什么意思？', 'R² 是 0.48 算好吗？'],
  'logistic-regression': ['这条 S 形线是什么？', '交叉熵越小越好吗？', '月牙那组为什么分不开？'],
  'decision-tree': ['树太深会怎么样？', '它为什么只能切方块？', '不纯度是什么？'],
  'ensemble-learning': ['Bagging 和 AdaBoost 差在哪？', '圆点大小是什么意思？', '加更多的树会更好吗？'],
  svm: ['支持向量是哪几个点？', 'C 调大调小有什么区别？', '核函数到底做了什么？'],
  'naive-bayes': ['这个词为什么被判成垃圾？', '先验是什么？', 'α 调大会怎样？'],
  'model-evaluation': ['准确率高就说明模型好吗？', '阈值该切在哪？', 'AUC 算好吗？'],
  'neural-network': ['为什么非要激活函数？', '梯度消失是什么？', '隐层多了有什么用？'],
  pca: ['主成分是什么？', '为什么要标准化？', '降维到底丢了什么？'],
  clustering: ['质心是怎么挪过去的？', 'k 该取几？', '同心圆为什么聚不好？'],
}

const CHIPS_FALLBACK = ['机器学习到底在干什么？', '我应该从哪一页开始看？']

/* ------------------------------------------------------------------ *
 * 构建 DOM
 * ------------------------------------------------------------------ */

/**
 * 猫娘本体。
 *
 * 用 `<button>` 而不是 `<div>`：她既是拖拽手柄也是"开启对话"按钮，
 * 用原生按钮就自动拿到键盘可达性和 Enter/Space 激活，不用自己补。
 * 拖拽是**附加**在她身上的能力，不是替代品。
 */
function buildMascot(): HTMLButtonElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'nya-mascot'
  el.setAttribute('aria-label', '打开 Nya 助教（可以拖动我）')
  el.setAttribute('data-pose', 'idle')

  const img = document.createElement('img')
  img.className = 'nya-mascot-img'
  img.src = idleSrc()
  img.alt = 'Nya'
  /* 首屏就要用上，别等她进入视口才开始下载（她是浮层，永远在视口里） */
  img.decoding = 'async'
  img.draggable = false

  const hint = document.createElement('span')
  hint.className = 'nya-mascot-hint'
  hint.textContent = '有不懂的问我'

  el.append(img, hint)
  return el
}

/**
 * 待机立绘用哪一张。
 *
 * ⚠️ 为什么每套都要两张：动图 WebP 是**浏览器层面**在播，CSS 管不了它 ——
 *    `prefers-reduced-motion` 对它完全无效。所以对"减少动态效果"的用户
 *    直接换成同一帧的静态图。这也和背景层的做法一致（那边是只渲染一帧）。
 */
function idleSrc(): string {
  return prefersStill() ? nyaIdleStill : nyaIdleAnim
}

/**
 * 扒窗口的立绘用哪一张。
 *
 * 动作用的是动图（耳朵会甩），静态那张给"减少动态效果"的用户。
 * 两张的静止帧是同一个画面，切换看不出跳。
 */
function perchSrc(): string {
  return prefersStill() ? nyaPerchStill : nyaPerchAnim
}

function prefersStill(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function buildPanel(): HTMLDivElement {
  const panel = document.createElement('div')
  panel.id = 'nya-panel'
  panel.className = 'nya-panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', 'Nya 助教对话')

  const head = document.createElement('div')
  head.className = 'nya-head'
  head.innerHTML = `
    <div class="nya-head-main">
      <div class="nya-head-title"><span class="nya-dot"></span>Nya</div>
      <div class="nya-head-sub">机器学习助教 · 看不懂就问我</div>
    </div>`

  /*
   * 清空对话。为什么必须有：对话记录会**跨页面保留**（见 CHAT_KEY），
   * 所以"重新开始"这件事必须让学生自己做得到 —— 否则他只能靠关标签页。
   * 文本按钮而不是图标：两个图标挨在一起容易点错，这一个动作又不可撤销。
   */
  const clear = document.createElement('button')
  clear.type = 'button'
  clear.className = 'nya-clear'
  clear.textContent = '清空'
  clear.setAttribute('aria-label', '清空对话记录')
  clear.hidden = true

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'nya-close'
  close.setAttribute('aria-label', '关闭')
  close.innerHTML = ICON_CLOSE
  head.append(clear, close)

  const body = document.createElement('div')
  body.className = 'nya-body'

  const form = document.createElement('form')
  form.className = 'nya-form'
  form.innerHTML = `
    <textarea class="nya-input" rows="1" placeholder="哪里没看懂？" aria-label="输入问题"></textarea>`
  const send = document.createElement('button')
  send.type = 'submit'
  send.className = 'nya-send'
  send.setAttribute('aria-label', '发送')
  send.innerHTML = ICON_SEND
  form.append(send)

  panel.append(head, body, form)
  return panel
}

/* ------------------------------------------------------------------ *
 * 交互
 * ------------------------------------------------------------------ */

function wireNya(root: HTMLElement, mascot: HTMLButtonElement, panel: HTMLElement): void {
  const body = panel.querySelector<HTMLElement>('.nya-body')!
  const head = panel.querySelector<HTMLElement>('.nya-head')!
  const form = panel.querySelector<HTMLFormElement>('.nya-form')!
  const input = panel.querySelector<HTMLTextAreaElement>('.nya-input')!
  const send = panel.querySelector<HTMLButtonElement>('.nya-send')!
  const close = panel.querySelector<HTMLButtonElement>('.nya-close')!
  const clear = panel.querySelector<HTMLButtonElement>('.nya-clear')!
  const hint = mascot.querySelector<HTMLElement>('.nya-mascot-hint')!
  const img = mascot.querySelector<HTMLImageElement>('.nya-mascot-img')!

  /**
   * 完整的对话历史（发给服务端时会截断，见 send()）。
   *
   * 初值从 sessionStorage 读 —— 站点是多页应用，换页是一次真实的整页加载，
   * 放在内存里的话一换页就没了（用户 2026-09-14 反馈）。
   */
  const history: ChatMessage[] = loadChat()
  /**
   * 上一次**成功**送达的状态快照 + 它属于哪一页。
   * 有了它 Nya 才能说"你把阈值从 0.50 拖到 0.79，召回率掉了一半"。
   */
  let lastState: Record<string, unknown> | null = null
  let lastPageId: string | undefined
  let busy = false
  let open = false
  /** 她当前的左上角坐标（视口坐标）。拖动改它，layout() 读它 */
  let pos = loadPos()
  /** 开面板前的位置 —— 关闭时她要回到这里，而不是被"落座"后的新位置粘住 */
  let restPos = { ...pos }
  /** 面板左上角的绝对坐标，由 layout() 维护 */
  let panelPos = { x: 0, y: 0 }
  /**
   * 用户拖过面板没有。
   * 拖过之后面板就"钉"在自己被拖到的位置，不再由她的位置推导 ——
   * 否则她跟着面板一动，面板又会被拽回去，形成互相追赶。
   */
  let panelPinned = false

  /* --- 位置与尺寸 --- */

  const clamp = (v: number, lo: number, hi: number) => (hi < lo ? lo : Math.min(Math.max(v, lo), hi))

  const applyMascot = () => {
    mascot.style.left = `${Math.round(pos.x)}px`
    mascot.style.top = `${Math.round(pos.y)}px`
  }

  const layout = () => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const mobile = vw <= MOBILE_BP
    const mw = mascot.offsetWidth
    const mh = mascot.offsetHeight

    /*
     * 图还没加载完时量不到尺寸（offsetHeight 是 0），这时候算位置会把
     * 她扔到屏幕角落去。直接跳过 —— 下面的 load 监听会再调一次。
     */
    if (!mw || !mh) return

    /*
     * 面板高度要同时满足两件事：
     *   ① 别顶到视口外；② 顶边必须给她留出位置（她要站在上面）。
     * 先按正常值取，放不下再压。
     */
    const pw = mobile ? Math.max(240, vw - EDGE * 2) : Math.min(PANEL_W, vw - EDGE * 2)
    const maxPh = vh - EDGE * 2 - (mh - PERCH_OVERLAP)
    const ph = Math.max(220, Math.min(mobile ? Math.round(vh * 0.6) : PANEL_H, maxPh))
    panel.style.width = `${pw}px`
    panel.style.height = `${ph}px`

    /* 夹住她，别让她被拖出屏幕外（拖出去就再也点不到了） */
    pos.x = clamp(pos.x, EDGE, vw - mw - EDGE)
    pos.y = clamp(pos.y, EDGE, vh - mh - EDGE)

    if (!open) {
      applyMascot()
      return
    }

    /*
     * 面板位置：
     *   · 默认「她趴哪，面板就开在哪」—— 面板顶边 = 她的底边往上收 PERCH_OVERLAP；
     *   · 一旦用户拖过面板（panelPinned），就用拖出来的绝对坐标，
     *     直到面板关闭 —— 否则她一动，面板又会被拽回她自己那套推导上。
     */
    let px = panelPinned ? panelPos.x : clamp(pos.x - pw * 0.2, EDGE, vw - pw - EDGE)
    let py = panelPinned ? panelPos.y : pos.y + mh - PERCH_OVERLAP
    px = clamp(px, EDGE, Math.max(EDGE, vw - pw - EDGE))
    py = clamp(py, EDGE + mh - PERCH_OVERLAP, Math.max(EDGE, vh - EDGE - ph))

    panel.style.left = `${Math.round(px)}px`
    panel.style.top = `${Math.round(py)}px`
    /* 夹紧后的真实位置回写 —— 拖拽下一帧要从这里接着算 */
    panelPos = { x: px, y: py }

    /* 她落在面板右上角 */
    pos.x = px + pw - PERCH_INSET - mw
    pos.y = py + PERCH_OVERLAP - mh
    applyMascot()
  }

  /*
   * 落座／回位是 CSS transition 做的动画（见 chat.css 的 .nya-mascot）。
   * 但首帧不能有过渡 —— 否则她会从 (0,0) 飞进屏幕，像出了 bug。
   */
  mascot.style.transition = 'none'
  layout()
  requestAnimationFrame(() => {
    mascot.style.transition = ''
  })

  /*
   * 换姿势 = 换立绘。
   * 两张图长宽比不同（待机是全身、趴着是半身），换完之后尺寸会变，
   * 位置必须按新尺寸重算 —— 而图是异步加载的，所以加载完成后再算一次。
   */
  let pose: 'idle' | 'perched' = 'idle'
  const setPose = (next: 'idle' | 'perched') => {
    if (pose === next) return
    pose = next
    mascot.setAttribute('data-pose', next)
    img.src = next === 'idle' ? idleSrc() : perchSrc()
    layout()
  }

  img.addEventListener('load', layout)
  if (img.complete) layout()

  /*
   * 用户在系统里切换"减少动态效果"时要跟着换图 ——
   * 动图 WebP 一旦在 src 里，CSS 是停不掉它的。
   */
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => {
    img.src = pose === 'idle' ? idleSrc() : perchSrc()
  })

  const savePos = () => {
    const dx = window.innerWidth - (pos.x + mascot.offsetWidth)
    const dy = window.innerHeight - (pos.y + mascot.offsetHeight)
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({ dx: Math.round(dx), dy: Math.round(dy) }))
    } catch {
      /* 隐私模式下 localStorage 会抛异常。存不了就算了，不影响使用 */
    }
  }

  function loadPos(): { x: number; y: number } {
    /*
     * 默认站位：右下角。这里**硬编码**而不是读 offsetWidth，
     * 因为挂载时元素还没进 DOM、量不到尺寸 —— 真正的位置会在
     * 紧接着的 layout() 里用真实尺寸重算一次。
     */
    let dx = 24
    let dy = 20
    try {
      const raw = localStorage.getItem(POS_KEY)
      if (raw) {
        const v = JSON.parse(raw) as { dx?: unknown; dy?: unknown }
        if (typeof v.dx === 'number') dx = v.dx
        if (typeof v.dy === 'number') dy = v.dy
      }
    } catch {
      /* 同上 */
    }
    return { x: window.innerWidth - 140 - dx, y: window.innerHeight - 150 - dy }
  }

  /* --- 拖拽 --- */

  let drag: { id: number; ox: number; oy: number; moved: boolean } | null = null
  /**
   * 拖完之后要吞掉紧随其后的那一次 click（否则"挪一下她"会变成"打开对话"）。
   *
   * ⚠️ 是**会自己过期的标志**，不是永久布尔值：
   *    布尔值只在"松手一定跟着一次 click"时成立。指针被取消（pointercancel）、
   *    或松手落在元素外时那次 click 不会来，标志就一直挂着，
   *    下一次真实点击被白白吃掉（表现是"点她没反应"，极难复现）。
   *    加上超时兜底之后：该吞的照吞，没人来消费时也会自己放下。
   */
  let swallowClick = false
  let swallowClickTimer = 0
  const armSwallowClick = () => {
    swallowClick = true
    window.clearTimeout(swallowClickTimer)
    swallowClickTimer = window.setTimeout(() => {
      swallowClick = false
    }, 400)
  }

  mascot.addEventListener('pointerdown', (e) => {
    /* 面板打开时她是"落座"状态，不参与拖动（位置由面板决定） */
    if (open) return
    if (e.pointerType === 'mouse' && e.button !== 0) return

    drag = { id: e.pointerId, ox: e.clientX - pos.x, oy: e.clientY - pos.y, moved: false }
    mascot.classList.add('is-dragging')
    /*
     * 抓住指针：这样即使手指滑出她身上，事件仍然送到她这里。
     * 不做这件事的话，拖快了就会"脱手"。
     */
    try {
      mascot.setPointerCapture(e.pointerId)
    } catch {
      /* 某些浏览器在特定情况下会抛，忽略即可 —— 不抓也能拖，只是容易脱手 */
    }
  })

  mascot.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return
    const nx = e.clientX - drag.ox
    const ny = e.clientY - drag.oy
    /* 超过 4px 才算拖动。手抖 1-2px 不该被当成拖动而吃掉点击 */
    if (Math.abs(nx - pos.x) + Math.abs(ny - pos.y) > 4) drag.moved = true
    pos = { x: nx, y: ny }
    layout()
  })

  const endDrag = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return
    const moved = drag.moved
    drag = null
    try {
      mascot.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }

    if (moved) {
      savePos()
      /*
       * 拖完紧接着会来一次 click。如果不拦，松手就开会话 ——
       * 用户会觉得"我只是想挪个位置，怎么就弹窗了"。
       */
      armSwallowClick()
      /*
       * ⚠️ 隔一帧再撤掉 .is-dragging（它带 `transition: none`）。
       *
       * 如果在这一帧就撤：浏览器只在任务结束时做一次样式重算，
       * 它看到的净变化是「left/top 从起点变到终点，而 transition 一直是 460ms」
       * —— 于是把一次拖动**当成位置变化播成动画**，她会从起点"飞"过去。
       * 真人的拖动每帧都有间隔，不会这样；但"最后一次 pointermove 和
       * pointerup 落在同一帧"是可能发生的（快速甩动、程序化事件）。
       * 等一帧，让浏览器先以 `transition: none` 提交终点位置，再恢复过渡。
       */
      requestAnimationFrame(() => mascot.classList.remove('is-dragging'))
    } else {
      mascot.classList.remove('is-dragging')
    }
  }

  mascot.addEventListener('pointerup', endDrag)
  mascot.addEventListener('pointercancel', endDrag)

  /* --- 拖面板（抓手是标题栏） --- */

  /*
   * 为什么抓手是**标题栏**而不是用户说的"上半部分"：
   *   面板上半部分里是消息列表 —— 那是要能选中文字、能上下滚的区域。
   *   把拖拽挂上去，选中一段话就会把面板拖走，手机上更是连滑动浏览都被吃掉。
   *   标题栏是整块面板里唯一"没有别的用途"的地方，所以它当抓手。
   *   （想扩大抓手范围的话，告诉我扩到哪一块。）
   */
  let panelGrab: { id: number; ox: number; oy: number; moved: boolean } | null = null
  /** 同上：会自己过期的标志 */
  let swallowPanelClick = false
  let swallowPanelTimer = 0
  const armSwallowPanelClick = () => {
    swallowPanelClick = true
    window.clearTimeout(swallowPanelTimer)
    swallowPanelTimer = window.setTimeout(() => {
      swallowPanelClick = false
    }, 400)
  }

  head.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    panelGrab = {
      id: e.pointerId,
      ox: e.clientX - panelPos.x,
      oy: e.clientY - panelPos.y,
      moved: false,
    }
    head.classList.add('is-dragging')
    /* 关掉她那 460ms 的过渡 —— 面板跟手，她也必须跟手，
     * 否则面板已经走远了，她还"飞"在后面追。 */
    mascot.classList.add('is-dragging')
    try {
      head.setPointerCapture(e.pointerId)
    } catch {
      /* 抓不住也能拖，只是拖快了会脱手 */
    }
  })

  head.addEventListener('pointermove', (e) => {
    if (!panelGrab || e.pointerId !== panelGrab.id) return
    const nx = e.clientX - panelGrab.ox
    const ny = e.clientY - panelGrab.oy
    if (Math.abs(nx - panelPos.x) + Math.abs(ny - panelPos.y) > 4) panelGrab.moved = true
    panelPinned = true
    panelPos = { x: nx, y: ny }
    layout()
  })

  const endPanelGrab = (e: PointerEvent) => {
    if (!panelGrab || e.pointerId !== panelGrab.id) return
    const moved = panelGrab.moved
    panelGrab = null
    try {
      head.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    head.classList.remove('is-dragging')
    requestAnimationFrame(() => mascot.classList.remove('is-dragging'))
    if (moved) {
      /* 拖到哪儿就记到哪儿：下次打开、刷新页面她还在那儿 */
      savePos()
      /* 松手时如果正好压在关闭按钮上，那一击不能算"点击" */
      armSwallowPanelClick()
    }
  }

  head.addEventListener('pointerup', endPanelGrab)
  head.addEventListener('pointercancel', endPanelGrab)

  /*
   * 拖完立刻会来一次 click。它可能落在标题栏，也可能落在关闭按钮上 ——
   * 后者会让"我想挪一下面板"变成"面板被关掉了"。用捕获阶段拦下来。
   */
  head.addEventListener(
    'click',
    (e) => {
      if (!swallowPanelClick) return
      swallowPanelClick = false
      e.stopPropagation()
      e.preventDefault()
    },
    true,
  )

  /* --- 开关 --- */

  const openPanel = () => {
    open = true
    root.classList.add('is-open')
    restPos = { ...pos }
    mascot.setAttribute('data-drag', 'off')
    /* 先换成立绘再算位置 —— 她要从"原地跑步"切成"趴在窗口上沿" */
    setPose('perched')
    layout()
    panel.classList.add('is-open')
    /* 首次打开把焦点送进输入框，省掉一次点击。
     * 移动端会自动弹软键盘 —— 这是想要的 */
    input.focus()
  }

  const shutPanel = () => {
    open = false
    root.classList.remove('is-open')
    mascot.removeAttribute('data-drag')
    panel.classList.remove('is-open')
    /*
     * 回到哪儿：
     *   · 没拖过面板 → 回到拖动她的那个位置（开面板时她可能被"顶"上去了）
     *   · 拖过面板   → 就停在被拖到的地方。那是他**主动**把她挪过去的，
     *                  再弹回原位会像"我明明放这儿了它自己跑回去"
     */
    if (!panelPinned) {
      pos = { ...restPos }
    } else {
      restPos = { ...pos }
    }
    panelPinned = false
    setPose('idle')
    layout()
    mascot.focus()
  }

  mascot.addEventListener('click', () => {
    if (swallowClick) {
      swallowClick = false
      return
    }
    if (open) return
    openPanel()
  })

  close.addEventListener('click', shutPanel)

  /* Esc 关闭；面板没开时不做任何事 */
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation()
      shutPanel()
    }
  })

  /* --- 视口变化 --- */

  window.addEventListener('resize', layout)

  /* --- 输入框 --- */

  const autosize = () => {
    input.style.height = 'auto'
    /* 上限交给 CSS 的 max-height，这里只需要给出内容高度 */
    input.style.height = `${input.scrollHeight}px`
  }
  input.addEventListener('input', autosize)

  /* Enter 发送、Shift+Enter 换行（输入法组合中的 Enter 不算） */
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
    e.preventDefault()
    form.requestSubmit()
  })

  /* --- 开场引导 --- */
  const hello = document.createElement('div')
  hello.className = 'nya-hello'
  hello.innerHTML = `<p></p><div class="nya-chips"></div>`
  hello.querySelector('p')!.textContent = GREETING

  const chipBox = hello.querySelector<HTMLElement>('.nya-chips')!
  for (const q of CHIPS[currentPageId() ?? ''] ?? CHIPS_FALLBACK) {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'nya-chip'
    chip.textContent = q
    chip.addEventListener('click', () => {
      input.value = q
      form.requestSubmit()
    })
    chipBox.append(chip)
  }

  /**
   * 开场引导：只在**没有历史记录**时挂上。
   * 已经有对话了还显示"我是 Nya"和三条示例问题，会显得她失忆了。
   */
  const ensureHello = () => {
    if (history.length === 0 && !hello.isConnected) body.append(hello)
  }
  ensureHello()

  /** 「清空」按钮：只有有记录时才出现，且请求进行中不许点 */
  const syncHead = () => {
    clear.hidden = history.length === 0
    clear.disabled = busy
  }
  syncHead()

  /*
   * 她刚出现时闪一句话。不这么做的话，新访客很可能把她当成装饰画，
   * 根本不会去点。有历史记录时换一句 —— 让换页回来的学生知道记录还在。
   */
  const hintAt = { show: 0, hide: 0 }
  hint.textContent = history.length > 0 ? '上次的对话还在' : '有不懂的问我'
  hintAt.show = window.setTimeout(() => hint.classList.add('is-show'), 900)
  hintAt.hide = window.setTimeout(() => hint.classList.remove('is-show'), 7000)

  /* --- 渲染 --- */
  const scrollDown = () => {
    body.scrollTop = body.scrollHeight
  }

  const addBubble = (text: string, kind: 'nya' | 'user' | 'err'): HTMLElement => {
    const el = document.createElement('div')
    el.className = `nya-msg is-${kind}`
    /* 用 textContent 而不是 innerHTML：模型的回答是外部输入，
     * 这里不做任何 HTML 解析，从结构上排掉注入 */
    el.textContent = text
    body.append(el)
    scrollDown()
    return el
  }

  const typing = document.createElement('div')
  typing.className = 'nya-typing'
  typing.innerHTML = '<i></i><i></i><i></i>'

  /* --- 恢复上次的对话 ---
   *
   * 从 sessionStorage 读回来的记录直接铺进消息列表 —— 学生换页回来（或刷新）
   * 就能接着聊，而不是对着"我是 Nya"重新自我介绍。
   *
   * ⚠️ 服务端收到的上下文里，这些消息可能来自**别的页面**
   *    （比如在线性回归问完 MSE，换到 PCA 页继续问）。
   *    这一点在提示词里也说明了（见 chat/nya.ts 的数字纪律）：
   *    旧消息里的数字属于当时的页面，不能当成当前页的状态。
   */
  if (history.length > 0) {
    for (const m of history) addBubble(m.content, m.role === 'user' ? 'user' : 'nya')
  }

  /**
   * 「清空」= 把记录和界面一起清掉，回到开场状态。
   * 请求进行中不允许点（否则回答回来会挂在一段已经清空的对话后面）。
   */
  clear.addEventListener('click', () => {
    if (busy) return
    history.length = 0
    dropChat()
    for (const el of Array.from(body.querySelectorAll('.nya-msg'))) el.remove()
    ensureHello()
    syncHead()
    input.focus()
  })

  /* --- 发送 --- */
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (busy) return

    const text = input.value.trim()
    if (!text) return

    /* 首次发问后，开场引导的示例问题就该退场了 */
    hello.remove()

    busy = true
    send.disabled = true
    syncHead()
    input.value = ''
    autosize()

    history.push({ role: 'user', content: text })
    /* 立刻落盘：万一这次请求没回来（断网、超时），学生换页后
     * 至少还看得到自己问过什么，不会以为"白问了" */
    saveChat(history)
    addBubble(text, 'user')
    body.append(typing)
    scrollDown()

    try {
      const pageId = currentPageId()
      const now = stateProvider?.()
      /*
       * 上一次**成功**送达模型的那份快照。
       *
       * 为什么是"成功之后"才更新：失败的请求没有真的让她看见，
       * 如果照样记下来，下一轮她就会拿一份"她其实没见过"的旧状态当基准，
       * 说出"你把它改成了 X"这种没根据的话。
       *
       * 换页就丢掉（`lastPageId` 比对）—— 两页的键根本对不上。
       */
      const prev = pageId === lastPageId ? lastState : undefined

      const res = await fetch(siteUrl('api/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          /* 只发最近若干轮：更早的对话对当前问题没什么帮助，却要按量付费 */
          messages: history.slice(-10),
          context: { demoId: pageId, state: now, prev: prev ?? undefined },
        }),
      })

      const data = (await res.json().catch(() => ({}))) as { reply?: string; message?: string }

      if (res.ok && data.reply) {
        history.push({ role: 'assistant', content: data.reply })
        saveChat(history)
        addBubble(data.reply, 'nya')
        lastPageId = pageId
        lastState = now ?? null
      } else {
        /* 服务端的 message 已经是给人看的中文（见 chat/handler.ts），
         * 拿不到就用兜底文案。这里不暴露错误码 —— 学生不需要知道 HTTP 状态。 */
        addBubble(data.message ?? 'Nya 这边出了点问题，等一下再试试。', 'err')
      }
    } catch {
      /* 网络层失败（断网、被拦截、超时）。强调页面其他功能正常，避免学生以为站点坏了 */
      addBubble('连不上 Nya（可能是网络问题）。页面其他功能不受影响，可以继续玩。', 'err')
    } finally {
      typing.remove()
      busy = false
      send.disabled = false
      syncHead()
      input.focus()
    }
  })
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/**
 * 从 URL 判断当前在哪一页。
 *
 * 为什么不要求页面自报 id：少一处可能写错的地方（之前 clustering 页
 * 漏标签就是这么漏的）。URL 是唯一的、不会被漏抄的事实来源。
 *
 * 返回的是**页面 id**，会被拼进请求里的 `context.demoId`：
 *   · `demos/xxx/` → `'xxx'`（演示页）
 *   · 站点根      → `'home'`
 *   · 其他（自测页等）→ undefined ⇒ 面板退化成纯概念问答
 *
 * ⚠️ `'home'` 也在服务端 DEMOS 里有一份知识（2026-09-14 补的）。
 *    补之前会出现这种对话：学生在首页问"你能看到我在哪一页吗"，
 *    她答"看不到，我只能看到你发的文字"—— 她连"你在首页"都不知道，
 *    因为首页压根没有 id 可报。
 */
function currentPageId(): string | undefined {
  const m = location.pathname.match(/\/demos\/([^/]+)\//)
  if (m) return m[1]
  /* 站点根：可能是 `/`、`/index.html`，也可能带一层子路径（部署在子目录时） */
  if (/\/$|\/index\.html$/.test(location.pathname)) return 'home'
  return undefined
}
