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
 *    （`api/nya.ts`）。前端只做两件事：把学生的问题发出去、
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
import { listCharts } from './chart'
import { shrinkToJpeg } from './image'
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
 * ⚠️ 值的长度由服务端再截一次（`api/nya.ts` 的 formatState），
 *    这里只负责"取到页面上真实显示的那串字"。
 *
 * @param extra 额外补充的键值（比如页面上没显示的内部量）。键名同样受
 *              服务端 `stateKeys` 白名单约束，不在白名单里的会被丢掉。
 */
/**
 * 读一次「当前页面状态」—— 就是 Nya 每次提问时会上报的那一份。
 *
 * 这个出口是给**反馈表单**开的：用户报「这个数字不对」时，
 * 你真正需要的是当时那几个参数值，而不是他的文字描述。
 * 让两边共用同一个读取器，就不会出现「她看到的」和「报告里带的」对不上
 * ——那种偏差比缺信息更难查。
 *
 * ⚠️ 只有页面调过 `provideNyaStateFromPage()` 才有值。十页都调了；
 *    万一将来某页忘了，这里返回 undefined，反馈照样能提交（少一份现场）。
 * ⚠️ 它**每次重新读 DOM**（和 Nya 用的是同一份实现），所以拿到的是点击那一刻的值。
 */
export function samplePageState(): Record<string, unknown> | undefined {
  return stateProvider?.()
}

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

/* ------------------------------------------------------------------ *
 * 抓图（Nya 的「眼睛」）
 * ------------------------------------------------------------------ */

/**
 * 截图长边上限（px）。**故意比反馈那边的 1600 小得多。**
 *
 * 900 是权衡出来的：再小散点就糊成一团（她要用它看"哪一簇更散"），
 * 再大纯粹烧 token —— 实测 256KB 的图约占 3000 个 prompt token，
 * 压到 900px / JPEG 之后落在 40~150KB，成本掉到零头。
 *
 * 压缩本身走共用的 `shrinkToJpeg`（见 `core/image.ts`，反馈表单也用同一个）。
 */
const IMG_MAX_SIDE = 900

/**
 * 把学生此刻看着的那张图抓成一张 JPEG（data URL）。抓不到就返回 undefined。
 *
 * ------------------------------------------------------------------ *
 * 三个设计决定
 * ------------------------------------------------------------------ *
 *
 * 1. **只抓一张，抓面积最大的那张。**
 *    一页可能有 1~4 张图（模型评估页有 4 张），但主图总是最大的那个，
 *    而学生的疑问绝大多数时候冲的就是主图。每张图约 1.5 千 token，
 *    全带上成本翻几倍，而"你想问的是哪一张"他自己一句话就能说清。
 *    （服务端提示词里也写明了"你只收到一张，别的图看不到"。）
 *
 * 2. **走 canvas 重画一遍，而不是直接把 ECharts 的图发出去。**
 *    ECharts 只能出 PNG，而 PNG 截图动辄几百 KB；转成 JPEG 体积掉到 1/4。
 *    ⚠️ 转 JPEG 必须在 canvas 上**先铺一层白底** —— JPEG 没有透明通道，
 *    不铺的话透明区域会变成**黑块**，她看到的就是一张脏图。
 *
 * 3. **任何一步失败都返回 undefined，绝不抛。**
 *    图是附加品：抓不到就照常提问，学生最多回到"她看不到图"的旧体验，
 *    而不是"问不出问题"。这条比抓图成功本身重要。
 *
 * ⚠️ 每次提问都重新抓一次（不缓存）—— 学生拖完滑杆再问，抓到的必须是
 *    **变化之后**的那一帧。这和状态读取器"每次重新读 DOM"是同一条原则。
 */
export async function captureChartImage(): Promise<string | undefined> {
  try {
    /* 太小的容器不是图（可能是还没量出尺寸的占位 div） */
    const hosts = listCharts().filter((el) => el.clientWidth > 80 && el.clientHeight > 80)
    if (!hosts.length) return undefined

    const main = hosts.reduce((a, b) =>
      a.clientWidth * a.clientHeight >= b.clientWidth * b.clientHeight ? a : b,
    )

    const handle = (main as HTMLElement & { __chart?: { chart: { getDataURL: (o: object) => string } } })
      .__chart
    if (!handle) return undefined

    /* 让 ECharts 自己出一张 PNG —— 只有它知道自己的图怎么画的 */
    const raw = handle.chart.getDataURL({
      type: 'png',
      pixelRatio: 1.5,
      /* 页面是浅色的，而且 JPEG 不接受透明，索性一开始就铺白 */
      backgroundColor: '#ffffff',
    })

    /* 缩放 + 转 JPEG 走共用实现（白底那个坑在 core/image.ts 里统一处理） */
    const out = await shrinkToJpeg(raw, { maxSide: IMG_MAX_SIDE })
    if (!out) return undefined

    /*
     * 服务端另有一道大小闸（400KB **真实字节**）。这里先自己拦一次 ——
     * 前端这道必须**比服务端更紧**，否则会"抓了半天图、却被那边丢掉"，
     * 白跑一趟请求，而且失败得无声无息。
     * base64 每 4 字符 3 字节 ⇒ 45 万字符 ≈ 337KB，安全落在 400KB 之内。
     */
    return out.length > 450_000 ? undefined : out
  } catch {
    return undefined
  }
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

/**
 * 服务端流式输出的媒体类型（对应 `api/handler.ts` 里的 `NDJSON_CONTENT_TYPE`）。
 *
 * 为什么前端要**靠它分流**而不是"有 body 就当流"：
 *   服务端的错误（未配置 503、上游 401/超时/非 2xx）仍然是普通的 JSON ——
 *   那是**进入流之前**就决定的，还来得及给一个体面的状态码和中文提示。
 *   所以响应只有两种形态：`x-ndjson` = 逐字正文，`json` = 一条完整消息。
 *   两边都认这一个判据，就不会出现"把错误 JSON 当正文逐字显示出来"。
 *
 * ⚠️ 改这里要同时改 `api/handler.ts`。判据不一致的后果不是报错，
 *    而是**错误信息被当成回答渲染**（或者反过来，回答被丢掉）。
 */
const NDJSON_TYPE = 'application/x-ndjson'

/**
 * 读 Nya 的 NDJSON 流。
 *
 * 每帧一行 JSON：
 *   `{"t":"正文增量"}` · `{"done":true,"finish":"stop"}` · `{"error":"CODE","message":"中文提示"}`
 *
 * 为什么要处理"半行"：TCP 怎么切包不由我们决定 —— 一个 chunk 可能
 * 正好切在某个 JSON 的中间。所以**残片一律留在缓冲区里等下一块**，
 * 只有凑齐一整行（见到 `\n`）才 parse。这是流式解析唯一必须做对的事，
 * 而它恰恰是最容易漏的：在本地测试时响应往往是一整块到齐的，
 * 写错也看不出来。
 *
 * 中途断流（`done` 帧没来）时**不报错** —— 已经上屏的字是真实回答的一部分，
 * 保留它比丢掉它更对。只有"一个字都没收到"才值得提示用户。
 */
async function readNyaStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (replySoFar: string) => void,
): Promise<{ reply: string; error: string }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let reply = ''
  let error = ''

  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>
    try {
      chunk = await reader.read()
    } catch {
      /*
       * 读到一半连接断了（断网、切页、或者 Vercel 函数到了 300s 上限）。
       * **不往上抛** —— 已收到的字是真实回答的一部分，保留它；
       * 抛出去的话外层会再补一条"连不上 Nya"，看起来像整段回答作废了。
       * 一个字都没收到的情况下，调用方自然走错误分支（有兜底文案）。
       */
      break
    }
    if (chunk.done) break
    buf += decoder.decode(chunk.value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      let frame: { t?: unknown; error?: unknown; message?: unknown }
      try {
        frame = JSON.parse(line) as typeof frame
      } catch {
        /* 坏行跳过，不因为一帧毁了整段回答 */
        continue
      }
      if (typeof frame.t === 'string' && frame.t) {
        reply += frame.t
        onDelta(reply)
      } else if (typeof frame.error === 'string') {
        error = typeof frame.message === 'string' ? frame.message : ''
      }
    }
  }
  return { reply, error }
}

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
/** 立绘升级的序号，用来作废旧回调（见 setUpgradingSrc） */
let srcToken = 0

function buildMascot(): HTMLButtonElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'nya-mascot'
  el.setAttribute('aria-label', '打开 Nya 助教（可以拖动我）')
  el.setAttribute('data-pose', 'idle')

  const img = document.createElement('img')
  img.className = 'nya-mascot-img'
  setUpgradingSrc(img, nyaIdleStill, nyaIdleAnim)
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
 * 🔴 先放**静态小图**，动图下完再升级过去。
 *
 * 为什么必须这样（用户实测报上来的）：
 *   原来是一步到位 `img.src = 动图`。而动图有 300~500 KB，
 *   网络慢的时候要**十几秒**才下完 —— 这期间浏览器**继续显示上一张图**
 *   （她待机时那张全身像）。用户看到的就是
 *   **「面板都开了，她还在原地跑步」**，而且一跑就是十几秒，像坏了。
 *   实测：首页打开面板后，趴姿那张 384 KB 用了 **10.4 秒**才就绪。
 *
 * 换法：静态帧只有几十 KB，一两秒就到位 ⇒ 姿势立刻是对的；
 * 动图下完再换过来。**静态那张就是动图的第一帧**（同一次导出），
 * 切过去看不出跳，长宽也一样 ⇒ 不会触发重排。
 *
 * ⚠️ 用 token 作废旧回调：连点开关、或者"下到一半又关掉面板"时，
 *    旧的 onload 不能把图换回上一套姿势。
 */
function setUpgradingSrc(el: HTMLImageElement, still: string, anim: string): void {
  const token = ++srcToken
  el.src = still
  /* "减少动态效果"的用户就停在静态图上，别再去下那张大的 */
  if (prefersStill()) return
  const pre = new Image()
  pre.onload = () => {
    if (token === srcToken && !el.src.endsWith(anim.split('/').pop()!)) el.src = anim
  }
  pre.src = anim
}

/**
 * 待机／扒窗口各两张图：动图 + 同帧的静态图。
 *
 * ⚠️ 为什么每套都要两张：动图 WebP 是**浏览器层面**在播，CSS 管不了它 ——
 *    `prefers-reduced-motion` 对它完全无效。所以对"减少动态效果"的用户
 *    直接换成同一帧的静态图。这也和背景层的做法一致（那边是只渲染一帧）。
 * ⚠️ 静态图还兼一个职责：**动图下载期间先顶上去**（见 setUpgradingSrc）。
 */
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

  const applyMascot = (x = pos.x, y = pos.y) => {
    mascot.style.left = `${Math.round(x)}px`
    mascot.style.top = `${Math.round(y)}px`
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
    /* ⚠️ 走"小图→动图"两步，别一步到位 —— 理由见 setUpgradingSrc */
    if (next === 'idle') setUpgradingSrc(img, nyaIdleStill, nyaIdleAnim)
    else setUpgradingSrc(img, nyaPerchStill, nyaPerchAnim)
    layout()
  }

  img.addEventListener('load', layout)
  if (img.complete) layout()

  /*
   * 用户在系统里切换"减少动态效果"时要跟着换图 ——
   * 动图 WebP 一旦在 src 里，CSS 是停不掉它的。
   */
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => {
    /* 重走一遍两步流程：关掉动画时立刻切到静态图；打开时再去下动图 */
    if (pose === 'idle') setUpgradingSrc(img, nyaIdleStill, nyaIdleAnim)
    else setUpgradingSrc(img, nyaPerchStill, nyaPerchAnim)
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
    /*
     * ⚠️ 标题栏里的按钮（「清空」和「×」）必须先放行 —— 2026-09-15 用户报的就是这个。
     *
     * 不排除的话：按在按钮上时 pointerdown 冒泡到这里 → 启动拖拽 →
     * 下面那句 `head.setPointerCapture()` 会把指针**捕获到标题栏上**。
     * 而按规范，click 事件派发到「pointerdown 目标与 pointerup 目标的最近公共祖先」——
     * pointerup 被捕获后目标成了标题栏，于是 **click 也落到标题栏上**，
     * 按钮自己的 click 监听器根本不触发。表现就是「按钮点了没反应」。
     *
     * ⚠️ 为什么测试没抓到：驱动里的 `el.click()` 是**合成事件**，
     *    不走 pointerdown/pointerup，指针捕获无从介入。所以断言必须派发
     *    真实的 pointer 序列（见 `scripts/tests/nya-panel.js` 里那条
     *    「点『清空』不会启动面板拖拽」）。
     */
    if ((e.target as Element | null)?.closest('button')) return
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

  /**
   * 滚到底，但**攒到下一帧只滚一次**。
   *
   * 流式输出时每收到一个字都要把新内容带进视野，那是每秒几十次的
   * 布局读取（`scrollHeight` 会强制重排）+ 写入。直接滚会把主线程占满，
   * 反而让文字长得一顿一顿 —— 本末倒置。攒到 rAF 里合并成一次即可。
   */
  let scrollQueued = false
  const scrollSoon = () => {
    if (scrollQueued) return
    scrollQueued = true
    requestAnimationFrame(() => {
      scrollQueued = false
      scrollDown()
    })
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
   *    这一点在提示词里也说明了（见 api/nya.ts 的数字纪律）：
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

      /*
       * 抓一张"他此刻正看着的那张图"，随提问一起发出去。
       *
       * 抓图是**附加通道**：抓不到（页面上没有图 / 画布还没画完 / 浏览器
       * 不给转）就照常提问 —— 不带图的老路径一个字节都没变。
       */
      const image = await captureChartImage()

      const res = await fetch(siteUrl('api/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          /* 只发最近若干轮：更早的对话对当前问题没什么帮助，却要按量付费 */
          messages: history.slice(-10),
          context: { demoId: pageId, state: now, prev: prev ?? undefined },
          /* 没抓到图就整个字段不带 —— 服务端据此决定提示词怎么写 */
          ...(image ? { image: { dataUrl: image } } : {}),
          /*
           * 要逐字输出。服务端按这个开关决定回 NDJSON 流还是回一次性 JSON
           * （见 api/handler.ts）。**它是请求方的选择**，因为自动化检查
           * （check:server / nya:smoke）走的还是那条一次性 JSON 的路。
           */
          stream: true,
        }),
      })

      const kind = (res.headers.get('content-type') ?? '').split(';')[0].trim()

      if (res.ok && kind === NDJSON_TYPE && res.body) {
        /*
         * 流式：**先把气泡建出来**（内容是空的），再逐字往里填。
         *
         * 这样「···」能在第一个字到达的那一刻立刻撤掉 —— 学生看到的顺序是
         * "省略号 → 字一个一个长出来"，而不是"省略号 → 一整段啪地出现"。
         * 后者正是改流式之前的样子：明明 0.9 秒就有第一个字了，
         * 却非要等 2.6 秒把整段收完才显示（实测数据见 devlog-21）。
         */
        const bubble = addBubble('', 'nya')
        let painted = false

        const { reply, error } = await readNyaStream(res.body, (soFar) => {
          if (!painted) {
            painted = true
            typing.remove()
          }
          /* 整量重设而不是追加：不会因为丢过一帧就拼出重复文字 */
          bubble.textContent = soFar
          scrollSoon()
        })

        if (reply) {
          /*
           * ⚠️ 中途断流也会走到这里（`reply` 有内容、但没有 `done` 帧）。
           *    那时保留已收到的文字是**对的** —— 那是她真实回答的一部分，
           *    丢掉它反而像"她答了一半就不见了"。
           */
          history.push({ role: 'assistant', content: reply })
          saveChat(history)
          lastPageId = pageId
          lastState = now ?? null
        } else {
          /* 一个字都没来。把那个空壳气泡撤掉，换成错误提示 ——
           * 文案来自服务端在流末尾补的 error 帧；拿不到就用兜底 */
          bubble.remove()
          addBubble(error || 'Nya 这边出了点问题，等一下再试试。', 'err')
        }
      } else {
        /* 非流式：服务端在进入流之前就失败了（未配置 / 上游报错 / 超时），
         * 回的是普通 JSON。这段逻辑和改流式之前完全一样。 */
        const data = (await res.json().catch(() => ({}))) as { reply?: string; message?: string }

        if (res.ok && data.reply) {
          history.push({ role: 'assistant', content: data.reply })
          saveChat(history)
          addBubble(data.reply, 'nya')
          lastPageId = pageId
          lastState = now ?? null
        } else {
          /* 服务端的 message 已经是给人看的中文（见 api/handler.ts），
           * 拿不到就用兜底文案。这里不暴露错误码 —— 学生不需要知道 HTTP 状态。 */
          addBubble(data.message ?? 'Nya 这边出了点问题，等一下再试试。', 'err')
        }
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
