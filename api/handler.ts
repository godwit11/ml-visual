/**
 * Nya 的对话接口 —— 核心逻辑。
 *
 * 写成 `handleChat(request: Request): Promise<Response>` 这种「Web 标准」形状，
 * 是为了同一份逻辑能同时被两个地方调用：
 *   1. 线上：`api/chat.ts`（Vercel 把它变成 https://www.godwit.asia/api/chat）
 *   2. 本地：`vite.config.ts` 里的一个中间件（不需要装 Vercel CLI 就能开发）
 *
 * ⚠️ 密钥只从环境变量读，永远不写进代码、不下发给浏览器。
 *    这是"加一层代理"的全部意义 —— 浏览器只知道自己问了一个问题，
 *    永远拿不到 token。
 *
 * ⚠️ 这个文件**必须**待在 `/api` 目录里、而且**名字不能带下划线**。
 *    理由（两条 Vercel 规则叠加）写在 `api/chat.ts` 顶部，改动前先读一遍。
 */

/*
 * ⚠️ 扩展名 `.js` 不能省。
 *
 * `package.json` 里有 `"type": "module"` ⇒ 产物是 ESM，而 Node 的 ESM
 * 解析器**不做扩展名猜测**（不像 CommonJS 会试 .js / .json / index.js）。
 * Vercel 把 TS 编译成 JS 后**原样保留** import 里的路径字符串，所以
 * 写 `'./nya'` 在线上就是 `Cannot find module` —— 2026-09-15 那次
 * 线上 500 的两个成因之一。
 *
 * 源文件是 `nya.ts`，但这里**必须**写成 `nya.js`：编译之后存在的是 .js。
 * 本地 dev / typecheck 都不会报错，所以改这里之后记得跑 `npm run check:vercel`。
 */
import { buildSystemPrompt, type ChatMessage, type ChatContextPayload } from './nya.js'

/* ------------------------------------------------------------------ *
 * 请求限制
 * ------------------------------------------------------------------ */

/** 最多带多少轮历史。太多会烧 token，也会让学生把整段对话当上下文依赖 */
const MAX_MESSAGES = 16
/** 单条消息最长多少字符。防止有人塞一整本书进来 */
const MAX_CHARS_PER_MESSAGE = 1500
/**
 * 单次回答的 token 上限。
 *
 * ⚠️ 关掉思考（见下方 THINKING）之后这个值很宽松了 ——
 *    两三句话的回答通常 200 token 以内。留着余量是因为
 *    「被截断」的代价（用户拿到空回复）远大于「额度多留一点」。
 */
const MAX_COMPLETION_TOKENS = 800

/**
 * 关掉 M3 的思考。
 *
 * 为什么必须关（这是实测出来的，不是拍脑袋）：
 *   MiniMax-M3 默认开启"自适应思考"，而**思考消耗的 token 也计入
 *   max_completion_tokens**。原本上限 600 时，模型一想到 600 token
 *   就把额度烧光、正文一个字都没输出就被截断 ——
 *   表现是 finish_reason: "length" + 空 content，
 *   实测 5 次里失败 2 次（40%）。
 *
 * 实测对比（同一问题、上限都设 600）：
 *   不传 thinking  → 正文字数 395，思考 token 71，耗时 1.8s
 *   disabled       → 正文字数 213，思考 token 0， 耗时 1.2s
 *   （none / off 都是无效值，API 返回 400 —— 实测过）
 *
 * 对「两三句话的入门助教」来说，推理没什么收益，却带来 40% 的失败率，
 * 所以关掉。如果哪天想让它回答更复杂的问题，可以改成 'adaptive' 重试。
 */
const THINKING = { type: 'disabled' } as const

/**
 * 采样温度。
 *
 * ⚠️ 为什么要**显式设成 0.3**（2026-09-14 实测后才加的）：
 *    MiniMax 的默认值是 **1**（官方文档：range [0,2]，default 1），
 *    我们一直没传 —— 于是同一份系统提示词，连问两次同一个问题，
 *    她一次照办、一次完全不理。
 *
 *    实测那次：提示词里已经写着「和上一次提问相比：判定阈值 0.50 → 0.79」
 *    并且结尾有一条硬指令「绝对不许回答'我看不到你刚才动了什么'」，
 *    但两次回答**都是**"我看不到你之前的操作"。
 *    把提示词打出来核对过，差异块和硬指令都在（不是管道问题）。
 *
 *    对一个**要守规矩**的助教来说，"每次说法不一样"本身就是缺陷 ——
 *    她要么总能说出学生改了什么，要么这个能力就不算存在。
 *
 * 取 0.3 而不是 0：留一点变化，否则每轮句式会一模一样；
 * 同时 0.3 在中英文两版文档的取值范围（(0,1] 与 [0,2]）里都合法。
 */
const TEMPERATURE = 0.3
/** 上游超时。Vercel 函数的硬上限是 300s，我们远早于此收手 */
const UPSTREAM_TIMEOUT_MS = 30_000
/** 每个 IP 在窗口内最多问几次 */
const RATE_LIMIT_MAX = 12
const RATE_LIMIT_WINDOW_MS = 60_000

interface Env {
  key: string
  baseUrl: string
  model: string
  allowedOrigins: string[]
}

/**
 * 读环境变量。
 *
 * ⚠️ 关于默认值的一个坦白：
 *    MiniMax 有**两套账号体系**，接口地址和模型名都不一样：
 *      国内  https://api.minimax.cn/v1
 *      国际  https://api.minimax.io/v1
 *    我看不到你的控制台，无法确认你属于哪一套，所以这里只给默认值、
 *    真正的值请在 Vercel 的环境变量里显式设置。设错了会报 401/404，
 *    错误信息会原样带回到前端，便于你对照排查。
 */
function readEnv(): Env {
  return {
    key: process.env.MINIMAX_API_KEY ?? '',
    baseUrl: (process.env.MINIMAX_BASE_URL ?? 'https://api.minimax.cn/v1').replace(/\/+$/, ''),
    /* 默认值取自你套餐页写的「M3 用量」；若报"模型不存在"，改成控制台里的准确名字 */
    model: process.env.MINIMAX_MODEL ?? 'MiniMax-M3',
    allowedOrigins: (
      process.env.NYA_ALLOWED_ORIGINS ?? 'https://www.godwit.asia,https://godwit.asia,http://localhost:5173,http://127.0.0.1:5173'
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  }
}

/* ------------------------------------------------------------------ *
 * 限流
 *
 * ⚠️ 这是一个**尽力而为**的实现，不是可靠防线。
 *    Vercel 的无服务器函数是**无状态**的 —— 每个实例各有自己的内存，
 *    冷启动会清空，并发高时会起多个实例。
 *    所以这套计数只能在单个实例内生效，换个实例就绕过了。
 *
 * 它能挡住：同一个人连续猛点、脚本在短时间内的粗暴刷量。
 * 它挡不住：分布式刷量、刻意换 IP。（那需要 KV 之类的共享存储，或用 Vercel WAF 规则）
 *
 * 之所以仍然写上：成本几乎为零，而绝大多数误用都是"手贱连点"这种。
 * ------------------------------------------------------------------ */

const hits = new Map<string, number[]>()

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const list = (hits.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS)
  list.push(now)
  hits.set(ip, list)
  /* 顺手清理过期条目，避免内存无限增长 */
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (v.every((t) => now - t >= RATE_LIMIT_WINDOW_MS)) hits.delete(k)
    }
  }
  return list.length > RATE_LIMIT_MAX
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

/**
 * 流式输出的媒体类型 —— **NDJSON**，每行一个独立 JSON 对象。
 *
 * 为什么不用 SSE（`text/event-stream`）：
 *   SSE 的 `data:` 字段**遇到换行必须拆成多条 `data:` 行**，正文里每一个
 *   换行都要先拆开、前端再拼回去 —— 多一层编解码就多一处能写错的地方，
 *   而这个"正文"恰恰是学生要读的每一个字。
 *   NDJSON 反过来：JSON 字符串里的换行天生就是 `\n` 转义，**按行切天然安全**，
 *   前端攒够一整行就 parse，"粘包/半包"各只需要一行代码。
 *
 * 代价：不是浏览器原生认识的标准格式，不能用 `EventSource` 直接读。
 *   但我们的前端本来就要 POST + 带请求体，而 `EventSource` 只支持 GET
 *   （还要把请求体塞进 query string），本来就用不上。
 *
 * ⚠️ 这个 Content-Type 是**前端的判据**：`src/core/nya.ts` 靠它区分
 *    "这是流式正文"还是"这是 JSON 错误"。改了这里要同时改那边。
 */
const NDJSON_CONTENT_TYPE = 'application/x-ndjson; charset=utf-8'

function clientIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return request.headers.get('x-real-ip') ?? 'unknown'
}

/**
 * 摘掉思考过程。
 *
 * MiniMax 的部分模型会把推理过程包在 <think> 里一起返回。
 * 我们请求时带了 reasoning_split（见下方），理论上它会被分到单独字段、
 * 不混进正文；但**不赌它一定生效** —— 这里再剥一次，双保险。
 * 教学助教的回答里出现大段推理过程，对学生是纯噪音。
 */
function stripThinking(text: string): string {
  return text
    .replace(/<think[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking[\s\S]*?<\/thinking>/gi, '')
    /* 截断导致没有闭合标签时，从开标签起全部丢掉 */
    .replace(/<think[\s\S]*$/i, '')
    .replace(/<thinking[\s\S]*$/i, '')
    .trim()
}

/** 归一化前端传来的历史，顺手做长度和条数限制 */
function normalizeMessages(raw: unknown): ChatMessage[] | null {
  if (!Array.isArray(raw)) return null
  const out: ChatMessage[] = []
  for (const item of raw.slice(-MAX_MESSAGES)) {
    if (!item || typeof item !== 'object') return null
    const role = (item as { role?: unknown }).role
    const content = (item as { content?: unknown }).content
    if (role !== 'user' && role !== 'assistant') return null
    if (typeof content !== 'string') return null
    const text = content.slice(0, MAX_CHARS_PER_MESSAGE).trim()
    if (!text) continue
    out.push({ role, content: text })
  }
  return out.length > 0 ? out : null
}

function normalizeContext(raw: unknown): ChatContextPayload {
  if (!raw || typeof raw !== 'object') return {}
  const demoId = (raw as { demoId?: unknown }).demoId
  const state = (raw as { state?: unknown }).state
  const prev = (raw as { prev?: unknown }).prev
  /*
   * ⚠️ 这个函数是「白名单式拷贝」—— 字段必须**逐个**列出来。
   *
   * 2026-09-14 在这里栽了一次：加 `prev`（上一次快照）时只改了类型和前端，
   * 忘了往这里加一行，于是它被**静默丢掉**：
   *   · 类型检查过（`prev` 是可选字段，不传也合法）
   *   · 前端测试过（请求体里确实有 prev）
   *   · 提示词也"看着对"（我的调试脚本直接调 buildSystemPrompt，绕过了这里）
   * 表现是 Nya 说「我看不到你之前的状态」，而她其实收到了——
   * 只是那句话根本没进提示词。
   *
   * 所以：**往 ChatContextPayload 加字段时，必须同时改这里**，
   * 并且用 `scripts/nya-prompt.mjs` 验一遍（那个脚本走的是完整链路）。
   */
  return {
    demoId: typeof demoId === 'string' ? demoId.slice(0, 60) : undefined,
    state: state && typeof state === 'object' ? (state as Record<string, unknown>) : undefined,
    prev: prev && typeof prev === 'object' ? (prev as Record<string, unknown>) : undefined,
  }
}

/* ------------------------------------------------------------------ *
 * 图表截图（Nya 的「眼睛」）
 * ------------------------------------------------------------------ */

/**
 * 单张图的体积上限 —— 这里算的是**解码后的真实字节数**，不是 base64 字符串长度。
 *
 * 400KB 是怎么来的：前端把图压到长边 ~900px 的 JPEG 后，实测落在 100~200KB，
 * 这里留一倍余量。再多就说明前端压缩没生效 —— 与其硬塞给上游（函数请求体
 * 4.5MB 上限、上游 64MB 上限），不如直接丢掉这一次的图。
 */
const MAX_IMAGE_BYTES = 400_000
/** 比这还小的一律不可能是真图（正常压缩后的截图至少几十 KB） */
const MIN_IMAGE_BYTES = 512

export interface ChatImage {
  /** 只可能是 image/png 或 image/jpeg */
  mime: string
  /** 原样保留的 data URL，直接可以塞进上游的 image_url */
  dataUrl: string
}

/**
 * 校验并归一化前端传来的一张图。**不合格就返回 null，不抛错。**
 *
 * ⚠️ 为什么是"丢弃"而不是"拒绝整个请求"：
 *    图是我们**额外送**给她的（状态值那条路才是主力）。图坏了、太大、
 *    格式不对，都不该让学生问不出问题 —— 那等于用一个附加功能毁掉主体功能。
 *    所以这里只在最外层做静默降级，提问本身照常走完。
 *
 * ⚠️ 为什么必须验 base64 的**真实形状**而不是只信 mime 声明：
 *    前端可以撒谎。一个 `data:image/png;base64,<随便什么>` 如果直接转发，
 *    轻则上游报错，重则把被夹带的内容塞进上游。这里的正则同时钉死了
 *    前缀、mime 白名单和 base64 字符集，三者缺一不可。
 */
function normalizeImage(raw: unknown): ChatImage | null {
  if (!raw || typeof raw !== 'object') return null
  const dataUrl = (raw as { dataUrl?: unknown }).dataUrl
  if (typeof dataUrl !== 'string') return null

  /* data:<mime>;base64,<payload> —— 只认这一种形状，且 mime 只放行两种 */
  const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl)
  if (!m) return null

  const payload = m[2]
  /* base64 每 4 个字符编码 3 字节 */
  const bytes = Math.floor((payload.length * 3) / 4)
  if (bytes < MIN_IMAGE_BYTES || bytes > MAX_IMAGE_BYTES) return null

  return { mime: m[1], dataUrl }
}

/** 上游消息的内容块（OpenAI 兼容格式） */
type UpstreamContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

interface UpstreamMessage {
  role: 'user' | 'assistant'
  content: string | UpstreamContentPart[]
}

/**
 * 把截图**挂到最后一条学生消息上**，而不是新增一条消息。
 *
 * 为什么必须挂上去：模型看到的应该是「他提问那一刻的画面」。
 * 单独作为一条消息，它可能被理解成更早的上下文，甚至被当成学生发来了两张图。
 *
 * 为什么它比其他做法都安全：除了最后一条，前面的历史仍然是纯字符串 ——
 * **不带图的老路径一个字节都没变**，`check-server-path.mjs` 里那条
 * 「不带图时 content 仍是纯字符串」的断言盯的就是这件事。
 */
function attachImage(messages: ChatMessage[], image: ChatImage | null): UpstreamMessage[] {
  if (!image) return messages
  const i = messages.length - 1
  const last = messages[i]
  if (!last || last.role !== 'user') return messages
  return [
    ...messages.slice(0, i),
    {
      role: 'user',
      content: [
        { type: 'text', text: last.content },
        { type: 'image_url', image_url: { url: image.dataUrl } },
      ],
    },
  ]
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

export async function handleChat(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error: 'METHOD_NOT_ALLOWED', message: '只接受 POST' }, 405)
  }

  const env = readEnv()

  /* --- 来源检查 ---
   * 附带的好处：不返回 Access-Control-Allow-Origin，浏览器默认就会拦截
   * 其他网站的跨域调用。所以这个检查挡住的是「别的网页盗用你的代理」。
   * 它挡不住 curl 之类的非浏览器客户端 —— 那由限流兜。 */
  const origin = request.headers.get('origin')
  if (origin && !env.allowedOrigins.includes(origin)) {
    return json({ error: 'FORBIDDEN_ORIGIN', message: '这个来源不能调用本接口' }, 403)
  }

  if (isRateLimited(clientIp(request))) {
    return json({ error: 'RATE_LIMITED', message: '问得有点快，歇一分钟再聊。' }, 429)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: 'BAD_REQUEST', message: '请求体不是合法 JSON' }, 400)
  }

  /*
   * ⚠️ 输入校验排在「有没有配密钥」之前，是有意的。
   *    反过来写的话，未配置的环境会对**任何**输入都返回 503，
   *    输入校验那条分支就永远走不到、也测不了。现在这个顺序下：
   *      坏输入 → 400（无论配置与否）
   *      好输入 + 没配密钥 → 503
   *      好输入 + 配了密钥 + 问太快 → 429
   *    三条分支都能被单独观测。
   */
  const messages = normalizeMessages((body as { messages?: unknown })?.messages)
  if (!messages) {
    return json({ error: 'BAD_REQUEST', message: 'messages 必须是 {role, content} 的数组' }, 400)
  }
  const context = normalizeContext((body as { context?: unknown })?.context)

  /*
   * 图表截图（可选）。**校验不过就当成"这一轮没图"**，绝不返回 400 ——
   * 它是附加通道，坏了不该连累提问本身（理由见 normalizeImage 的注释）。
   */
  const image = normalizeImage((body as { image?: unknown })?.image)

  /**
   * 要不要流式。
   *
   * 为什么是**请求方说了算**（而不是"一律流式"）：
   *   非流式那条路是**所有自动化检查的落脚点** —— `check-server-path.mjs`
   *   直接调 `handleChat` 看 `res.json()`、`nya-smoke.mjs` 拿一个完整对象
   *   判断"有没有编数字"。把它们全改成解析流式，等于为了一个新特性
   *   把所有旧的验证推翻重写一遍，收益却是零（它们根本不在乎首字延迟）。
   *   ⇒ 默认走 JSON，前端显式要 `stream: true` 才走流式。
   */
  const wantStream = (body as { stream?: unknown })?.stream === true

  if (!env.key) {
    /* 明确区分「没配密钥」和「上游出错」——前端要显示不同的提示 */
    return json(
      {
        error: 'NOT_CONFIGURED',
        message: 'Nya 还没配置好。需要在部署环境里设置 MINIMAX_API_KEY。',
      },
      503,
    )
  }

  const payload = {
    model: env.model,
    /*
     * 把对话历史也交给提示词组装 —— 它要用来自查「是不是连着反问太多次了」
     * （见 `nya.ts` 的 escalationNotice）。这条规则不能只靠模型自己数，
     * 实测它会数错。
     */
    /*
     * 系统提示词必须知道"这一轮有没有图" —— 否则它会照旧写着
     * 「你看不到任何图形」，于是她**对着图说我看不到**（见 nya.ts 的 sightSection）。
     */
    messages: [
      { role: 'system', content: buildSystemPrompt(context, messages, image !== null) },
      ...attachImage(messages, image),
    ],
    max_completion_tokens: MAX_COMPLETION_TOKENS,
    temperature: TEMPERATURE,
    thinking: THINKING,
    /* 思考已关闭，这一项其实用不上了；留着是为了"哪天重开思考"时不用再改结构 */
    reasoning_split: true,
    /* 只有前端要流式时才开。多传一个字段对上游没有副作用，但语义上更清楚 */
    ...(wantStream ? { stream: true } : {}),
  }

  let upstream: Response
  try {
    upstream = await fetch(`${env.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.key}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'TimeoutError'
    return json(
      {
        error: isTimeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
        message: isTimeout
          ? 'Nya 想太久了，再说一遍试试。'
          : '连不上模型服务，可能是网络问题。页面其他功能不受影响。',
      },
      502,
    )
  }

  if (!upstream.ok) {
    /* ⚠️ 只带状态码和上游的简短说明，**绝不**回传请求头（里面是密钥） */
    let detail = ''
    try {
      const text = await upstream.text()
      detail = text.slice(0, 300)
    } catch {
      /* ignore */
    }
    return json(
      {
        error: 'UPSTREAM_ERROR',
        status: upstream.status,
        message: '模型服务返回了错误。',
        detail,
      },
      502,
    )
  }

  /*
   * 流式分支 —— 放在这里是有讲究的：**上面两道失败闸门都已经过了**
   * （连不上 / 上游非 2xx 都还来得及回一个干净的 JSON + 502）。
   * 一旦开始吐流，HTTP 状态码就已经发出去了，再也改不了，
   * 所以"能不能给前端一个体面的错误"这件事必须在**进入流之前**决定。
   *
   * ⚠️ `upstream.body` 理论上一定存在。真要缺席（某些运行时会把 body 吃掉），
   *    就顺着往下走非流式那条路 —— 前端按 Content-Type 分流，会走 JSON 分支，
   *    结果是"这次没有逐字效果"，而不是"这次没有回答"。
   */
  if (wantStream && upstream.body) {
    return streamChat(upstream)
  }

  let data: unknown
  try {
    data = await upstream.json()
  } catch {
    return json({ error: 'UPSTREAM_BAD_JSON', message: '模型服务的返回看不懂。' }, 502)
  }

  const text = extractText(data)
  if (!text) {
    /*
     * 走服务端日志而不是把原始返回丢给浏览器：
     * 原始返回可能很大，也可能带着模型对提示词的复述，不适合下发。
     * 但排查「为什么是空的」又必须看到 finish_reason 和 token 用量，
     * 所以记在服务端（Vercel 的 Runtime Logs 里能看到）。
     */
    const reason = finishReason(data)
    console.error('[nya] 空回复。上游返回摘要：', summarizeForLog(data))
    return json(
      {
        /* 把「被截断」和「真的没说话」分开报，前者换问法可解，后者要查配置 */
        error: reason === 'length' ? 'REPLY_TRUNCATED' : 'EMPTY_REPLY',
        message:
          reason === 'length'
            ? '这段话说到一半被截断了，换个短点的问题再试试。'
            : 'Nya 没说出话来，再问一次试试。',
        reason,
      },
      502,
    )
  }

  return json({ reply: text })
}

/** 服务端日志用的精简摘要 —— 只留诊断必需字段 */
function summarizeForLog(data: unknown): string {
  const choices = (data as { choices?: unknown })?.choices
  const first = Array.isArray(choices) ? (choices[0] as { message?: Record<string, unknown> }) : undefined
  const msg = first?.message ?? {}
  return JSON.stringify({
    finish_reason: (first as { finish_reason?: unknown })?.finish_reason,
    contentLen: typeof msg.content === 'string' ? msg.content.length : null,
    messageKeys: Object.keys(msg),
    usage: (data as { usage?: unknown })?.usage,
    baseResp: (data as { base_resp?: unknown })?.base_resp,
  })
}

/** 取出 finish_reason，便于判断是被 token 上限截断还是模型真的没说话 */
function finishReason(data: unknown): string {
  const choices = (data as { choices?: unknown })?.choices
  if (!Array.isArray(choices) || choices.length === 0) return 'NO_CHOICES'
  const r = (choices[0] as { finish_reason?: unknown })?.finish_reason
  return typeof r === 'string' ? r : 'UNKNOWN'
}

/** 从 OpenAI 兼容的返回里取出正文 */
function extractText(data: unknown): string {
  const choices = (data as { choices?: unknown })?.choices
  if (!Array.isArray(choices) || choices.length === 0) return ''
  const content = (choices[0] as { message?: { content?: unknown } })?.message?.content
  if (typeof content !== 'string') return ''
  return stripThinking(content)
}

/* ------------------------------------------------------------------ *
 * 流式输出
 * ------------------------------------------------------------------ */

/** 把一帧编成一行 NDJSON。分帧符是 `\n`，而 JSON 保证正文里不会出现裸换行 */
function ndjsonFrame(data: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(data) + '\n')
}

/**
 * 「思考」滤网：把上游正文增量喂进来，只把**该给学生看的部分**回调出去。
 *
 * 两道过滤，可靠性完全不同，**不要弄混**：
 *
 *   ① 丢 `delta.reasoning_content`（在 streamChat 里，结构化字段）
 *      —— 这是主防线。字段级丢弃不可能漏。
 *   ② 剥正文里的 `<think>` 标签（这里，字符串匹配）
 *      —— 廉价兜底。`thinking: disabled` 之后模型本来就不产生思考，
 *         `reasoning_split: true` 还要求它即使产生也分行存放，所以这一层
 *         正常情况下根本不会触发。
 *
 * ⚠️ **已知局限（写清楚，别当成没有）**：标签匹配**不跨 chunk 缓冲**。
 *    如果 `<think` 这五个字符正好被网络切成两半（前半在上一 chunk 末尾、
 *    后半在这一 chunk 开头），过滤会漏。
 *    不为它加缓冲区的原因：那会让**每个字**都晚最多一个 chunk 才上屏，
 *    而它要防的东西已经被 ①② 两道消掉了 —— 拿确定的体验损失去换一个
 *    概率极低的边界，不划算。
 */
function makeThinkingFilter(emit: (text: string) => void): (delta: string) => void {
  let inside = false
  return (delta: string) => {
    let rest = delta
    while (rest) {
      if (inside) {
        const close = /<\/(?:think|thinking)>/i.exec(rest)
        if (!close) return
        rest = rest.slice(close.index + close[0].length)
        inside = false
        continue
      }
      const open = /<think(?:ing)?/i.exec(rest)
      /* 没有开标签：整段放行（这是绝大多数情况） */
      if (!open) {
        emit(rest)
        return
      }
      if (open.index > 0) emit(rest.slice(0, open.index))
      rest = rest.slice(open.index + open[0].length)
      inside = true
    }
  }
}

/**
 * 把上游的 SSE 正文流转成我们自己的 NDJSON 流。
 *
 * 调用它的前提：上游已经回了 2xx、并且给了 body（见 handleChat 里的顺序）。
 * 因此**这里再也改不了 HTTP 状态码**，错误只能分成两类处理：
 *   · 流跑到一半断了 ⇒ 已经上屏的字照常保留，只是收不到 `done` 帧。
 *     前端"只要收到过正文就算成功"，所以不需要为这种情况弹错误。
 *   · 一个字都没吐出来 ⇒ 补一条 `error` 帧（前端看到它且一个字都没显示过，
 *     就渲染成错误气泡）。最常见的成因是开关没配好或 token 被烧光。
 *
 * 状态机很简单，因为上游给的就是"按行分帧"的 SSE：攒够一整行就处理。
 * 网络怎么切包都不用管 —— 残行留在 `raw` 里等下一块。
 */
async function streamChat(upstream: Response): Promise<Response> {
  const reader = upstream.body!.getReader()
  const decoder = new TextDecoder()
  /** 还没凑成一整行的残片 */
  let raw = ''
  /** 累计正文。用来判断"她到底说没说话"，同时供日志使用 */
  let text = ''
  let finish = 'UNKNOWN'

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (obj: unknown) => {
        /* 学生中途关掉页面 / 切走时会取消这个流，enqueue 会抛。
         * 这不是错误，静默收手即可（否则日志里会多一堆噪音） */
        try {
          controller.enqueue(ndjsonFrame(obj))
        } catch {
          /* 客户端已断开 */
        }
      }

      const emit = makeThinkingFilter((t) => {
        text += t
        push({ t })
      })

      const handleLine = (line: string) => {
        /* 上游的 SSE 里还有 `event:` / `id:` / 空行，只认 `data:` */
        if (!line.startsWith('data:')) return
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') return
        let frame: unknown
        try {
          frame = JSON.parse(payload)
        } catch {
          /* 上游偶发的半帧，跳过就好，不该因为一行坏了把整段回答丢掉 */
          return
        }
        const choices = (frame as { choices?: unknown })?.choices
        /* 有些实现会给一个只带 usage 的收尾帧，choices 是空数组 */
        if (!Array.isArray(choices) || choices.length === 0) return
        const first = choices[0] as { delta?: Record<string, unknown>; finish_reason?: unknown }
        if (typeof first.finish_reason === 'string') finish = first.finish_reason
        const delta = first.delta
        if (!delta) return
        /*
         * 🔴 「思考不上屏」的主防线就是这一行：只读 `content`。
         *    `reasoning_content` 里是模型的推理过程，对学生是纯噪音，
         *    而且会先把答案剧透一遍（"让我想想…答案是 C"）。
         */
        const content = delta.content
        if (typeof content === 'string' && content) emit(content)
      }

      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          raw += decoder.decode(value, { stream: true })
          let nl: number
          while ((nl = raw.indexOf('\n')) !== -1) {
            handleLine(raw.slice(0, nl).trim())
            raw = raw.slice(nl + 1)
          }
        }
        /* 上游最后一帧没带换行时，别把它漏掉 */
        if (raw.trim()) handleLine(raw.trim())

        if (text) {
          push({ done: true, finish })
        } else {
          console.error('[nya] 流式空回复，finish_reason =', finish)
          push({
            error: finish === 'length' ? 'REPLY_TRUNCATED' : 'EMPTY_REPLY',
            message:
              finish === 'length'
                ? '这段话说到一半被截断了，换个短点的问题再试试。'
                : 'Nya 没说出话来，再问一次试试。',
          })
        }
      } catch (err) {
        console.error('[nya] 流式读取中断：', err instanceof Error ? err.message : String(err))
        if (!text) {
          push({
            error: 'UPSTREAM_INTERRUPTED',
            message: '连不上模型服务，可能是网络问题。页面其他功能不受影响。',
          })
        }
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': NDJSON_CONTENT_TYPE,
      /*
       * ⚠️ 这一行不是可选的。
       *    反向代理（Vercel 的边缘网络、CDN）默认会**攒够一块再转发**，
       *    一攒就把流式的意义全攒没了 —— 首字延迟又退化成整体延迟。
       *    `no-transform` 明确禁止它改写响应体，`X-Accel-Buffering` 是
       *    nginx 系（含 Vercel 边缘）认的关缓冲开关。
       */
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}

/* ------------------------------------------------------------------ *
 * 兜底：这个文件本身也是个「函数」
 *
 * Vercel 会把 `/api` 下**不带下划线**的每个 `.ts` 都当函数入口编译
 * —— 这正是让 `api/chat.ts` 能 import 到它的唯一办法（因果链写在
 * `api/chat.ts` 顶部）。副作用是它顺带成了一个可访问的网址
 * （`/api/handler`）。如果这里没有 default 导出，Vercel 找不到
 * handler 会回一个**看起来像故障的 500**；给个明确的 404 干净些。
 *
 * 真正处理对话的是 `api/chat.ts`，这个文件只提供 `handleChat`。
 * ------------------------------------------------------------------ */

export default {
  fetch: () =>
    new Response(JSON.stringify({ error: 'NOT_FOUND', message: '这个地址不是接口' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }),
}
