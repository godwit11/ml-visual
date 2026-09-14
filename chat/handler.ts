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
 */

import { buildSystemPrompt, type ChatMessage, type ChatContextPayload } from './nya'

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
    messages: [{ role: 'system', content: buildSystemPrompt(context, messages) }, ...messages],
    max_completion_tokens: MAX_COMPLETION_TOKENS,
    temperature: TEMPERATURE,
    thinking: THINKING,
    /* 思考已关闭，这一项其实用不上了；留着是为了"哪天重开思考"时不用再改结构 */
    reasoning_split: true,
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
