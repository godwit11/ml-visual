/**
 * 「报告问题」的服务端 —— 把用户填的东西变成一封邮件发给你。
 *
 * ------------------------------------------------------------------ *
 * 🔴 部署形态：和 `handler.ts` 同一套规矩（改动前先读 `api/chat.ts` 顶部）
 * ------------------------------------------------------------------ *
 *   · 必须待在 `/api` 目录里
 *   · **名字不能带下划线**（带下划线的文件 Vercel 不编译它）
 *   · ESM 不猜扩展名 ⇒ import 要写成 `'./report-handler.js'`
 *   · 副作用：它自身会成为一个可访问路由 ⇒ 文件末尾导出一个 404 兜底
 *
 * 反过来说：**这个文件存在的代价就是多一个路由**，所以要靠
 * `npm run check:vercel` 保证它真的能被加载（本地测不出来）。
 *
 * ------------------------------------------------------------------ *
 * 为什么密钥只在服务端
 * ------------------------------------------------------------------ *
 * 另一条路是不写后端、直接用第三方表单服务的公开 access key —— 省事，
 * 但那个 key 会出现在网页源码里，任何人都能拿它给你发垃圾邮件。
 * 这里沿用 Nya 那套：**浏览器只知道自己提交了一份报告，永远拿不到密钥**。
 * ------------------------------------------------------------------ */

/** 单条描述的长度上限。前端也限了，但服务端必须再限一次 */
const MAX_TEXT = 1000
const MAX_EMAIL = 120
/** 现场信息最多带多少条、每条多长 */
const MAX_CONTEXT_ITEMS = 40
const MAX_ITEM_KEY = 40
const MAX_ITEM_VALUE = 200
const MAX_ERRORS = 5
const MAX_ERROR_LEN = 200

/**
 * 问题类型白名单。
 *
 * ⚠️ 不能信任前端传来的字符串 —— 它**会进邮件主题**，而邮件头里
 *    出现换行就是 header injection（可以伪造收件人、插额外头）。
 *    用白名单而不是"过滤掉换行"：这里本来就只有这几种，白名单更省心也更严。
 */
const KINDS = ['数字不对', '文字有错', '图表不动', '页面报错', '其他'] as const

/**
 * 限流：每个 IP 每分钟最多 3 次。
 *
 * ⚠️ **故意不和 Nya 那条共用一个计数桶。**
 *    两边共用的话，学生问 Nya 十次之后就报不了问题了 —— 而"他刚问过 Nya
 *    还是不懂，所以来报告"恰恰是最可能发生的情形。容量不同，桶就该分开。
 *
 * ⚠️ 和 chat 一样是**尽力而为**：Vercel 函数无状态，每个实例各有内存，
 *    换个实例就绕过。它挡的是"手贱连点"和粗糙脚本，不是刻意的刷量。
 */
const RATE_LIMIT_MAX = 3
const RATE_LIMIT_WINDOW_MS = 60_000

/**
 * 「打开表单到提交」的最短耗时。
 *
 * 真人要先打字，1.5 秒内不可能完成；脚本不看这个，直接 POST。
 * ⚠️ 它是**前端测量、服务端判断** —— 也就是说可以伪造。
 *    所以它只是四层里最便宜的一层，不能单独依赖（还有蜜罐、来源、限流）。
 */
const MIN_ELAPSED_MS = 1500

/** Resend 的接口超时。它是第三方，必须设上限，否则用户会一直等 */
const RESEND_TIMEOUT_MS = 15_000

interface Env {
  key: string
  to: string
  from: string
  allowedOrigins: string[]
}

/**
 * 读环境变量。
 *
 * `REPORT_FROM` 的默认值 `onboarding@resend.dev` 是 **Resend 给未验证域名账号
 * 的测试发件地址** —— 用它只能发到账号自己的注册邮箱，但对"反馈发给自己"
 * 这个场景**刚好够用**。等域名验证通过了，再把它换成 `feedback@godwit.asia`
 * 之类的（那时也能发给任意地址）。
 */
function readEnv(): Env {
  return {
    key: process.env.RESEND_API_KEY ?? '',
    to: process.env.REPORT_TO ?? '',
    from: process.env.REPORT_FROM ?? 'onboarding@resend.dev',
    allowedOrigins: (
      process.env.NYA_ALLOWED_ORIGINS ??
      'https://www.godwit.asia,https://godwit.asia,http://localhost:5173,http://127.0.0.1:5173'
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  }
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

const reportHits = new Map<string, number[]>()

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const list = (reportHits.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS)
  list.push(now)
  reportHits.set(ip, list)
  if (reportHits.size > 5000) {
    for (const [k, v] of reportHits) {
      if (v.every((t) => now - t >= RATE_LIMIT_WINDOW_MS)) reportHits.delete(k)
    }
  }
  return list.length > RATE_LIMIT_MAX
}

/** 去掉换行和控制字符 —— 任何要进邮件头的字符串都必须先过这里 */
function oneLine(text: string, max = MAX_ITEM_VALUE): string {
   
  return text.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max)
}

/**
 * 校验回信地址。
 *
 * ⚠️ 它会被塞进 `reply_to`，所以同样不能含换行。
 *    这里用一个**保守**的格式检查：不追求覆盖所有合法邮箱，
 *    只要求"看起来像"，不合格就当作没填（而不是报错 —— 用户会莫名其妙）。
 */
function normalizeEmail(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const email = oneLine(raw, MAX_EMAIL)
  if (!email) return ''
  return /^[^\s@,;:<>]+@[^\s@,;:<>]+\.[^\s@,;:<>]{2,}$/.test(email) ? email : ''
}

/** 归一化现场信息：只收 {group, key, value} 形状，一律截断 */
function normalizeContext(raw: unknown): { group: string; key: string; value: string }[] {
  if (!Array.isArray(raw)) return []
  const out: { group: string; key: string; value: string }[] = []
  for (const item of raw.slice(0, MAX_CONTEXT_ITEMS)) {
    if (!item || typeof item !== 'object') continue
    const g = (item as { group?: unknown }).group
    const k = (item as { key?: unknown }).key
    const v = (item as { value?: unknown }).value
    if (typeof k !== 'string' || typeof v !== 'string') continue
    const key = oneLine(k, MAX_ITEM_KEY)
    const value = oneLine(v, MAX_ITEM_VALUE)
    if (!key || !value) continue
    out.push({ group: oneLine(typeof g === 'string' ? g : '其他', 20), key, value })
  }
  return out
}

/** 归一化控制台报错 */
function normalizeErrors(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .slice(0, MAX_ERRORS)
    .filter((x): x is string => typeof x === 'string')
    .map((x) => oneLine(x, MAX_ERROR_LEN))
    .filter(Boolean)
}

/* ------------------------------------------------------------------ *
 * 拼邮件
 * ------------------------------------------------------------------ */

/** 邮件正文。用纯文本 —— 它不会因为客户端不渲染 HTML 而看不全 */
function buildBody(input: {
  kind: string
  text: string
  email: string
  context: { group: string; key: string; value: string }[]
  errors: string[]
  ip: string
}): string {
  const lines: string[] = []

  lines.push(`类型：${input.kind}`)

  const page = input.context.find((c) => c.group === '环境' && c.key === '页面')?.value ?? '未知'
  lines.push(`页面：${page}`)
  lines.push(`时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`)
  lines.push('')

  lines.push('【他写了什么】')
  lines.push(input.text)
  lines.push('')

  if (input.email) {
    lines.push('【回信地址】')
    lines.push(input.email)
    lines.push('（直接回复这封邮件就能回给他）')
    lines.push('')
  } else {
    lines.push('【回信地址】他没留 —— 需要追问的话只能等下次')
    lines.push('')
  }

  /* 页面状态单独一组、放在最前面：那是最可能需要复制的数据 */
  const state = input.context.filter((c) => c.group === '页面状态')
  if (state.length > 0) {
    lines.push('【页面状态】')
    for (const c of state) lines.push(`  ${c.key}：${c.value}`)
    lines.push('')
  }

  const env = input.context.filter((c) => c.group === '环境')
  if (env.length > 0) {
    lines.push('【环境】')
    for (const c of env) lines.push(`  ${c.key}：${c.value}`)
    lines.push('')
  }

  const other = input.context.filter((c) => c.group !== '页面状态' && c.group !== '环境')
  if (other.length > 0) {
    lines.push('【其他】')
    for (const c of other) lines.push(`  ${c.group} · ${c.key}：${c.value}`)
    lines.push('')
  }

  if (input.errors.length > 0) {
    lines.push('【控制台报错】')
    input.errors.forEach((e, i) => lines.push(`  ${i + 1}. ${e}`))
    lines.push('')
  }

  /* IP 只用于"同一个人刷了多次"时能看出来，不写进正文顶部的显著位置 */
  lines.push(`—— 来源 IP（仅用于排查刷量）：${input.ip}`)

  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * 主逻辑
 * ------------------------------------------------------------------ */

export async function handleReport(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error: 'METHOD_NOT_ALLOWED', message: '只接受 POST' }, 405)
  }

  const env = readEnv()

  /* 来源检查：挡住"别的网页盗用你的接口"。
   * 附带的好处是不返回 CORS 头，浏览器默认就会拦下跨域调用。 */
  const origin = request.headers.get('origin')
  if (origin && !env.allowedOrigins.includes(origin)) {
    return json({ error: 'FORBIDDEN_ORIGIN', message: '这个来源不能调用本接口' }, 403)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: 'BAD_REQUEST', message: '请求体不是合法 JSON' }, 400)
  }

  const src = (body ?? {}) as Record<string, unknown>

  /* --- 第 1 层：蜜罐 ---
   * 这个字段被 CSS 移出了视口，真人看不见、也不会填；机器人会把所有
   * input 都填满。填了就**当成功返回、什么都不做** —— 不给它任何反馈，
   * 它下次还会这么发，我们也就一直知道要丢。 */
  if (typeof src.trap === 'string' && src.trap.trim() !== '') {
    console.warn('[report] 蜜罐命中，丢弃')
    return json({ ok: true })
  }

  /* --- 第 2 层：填写耗时 --- */
  const elapsed = typeof src.elapsedMs === 'number' ? src.elapsedMs : 0
  if (elapsed > 0 && elapsed < MIN_ELAPSED_MS) {
    console.warn('[report] 提交过快，丢弃。elapsedMs =', elapsed)
    return json({ ok: true })
  }

  /* --- 第 3 层：限流 --- */
  if (isRateLimited(clientIp(request))) {
    return json({ error: 'RATE_LIMITED', message: '已经收到你的报告了，歇一分钟再发下一份。' }, 429)
  }

  /* --- 校验 --- */
  const kind = typeof src.kind === 'string' && (KINDS as readonly string[]).includes(src.kind)
    ? src.kind
    : '其他'
  const text = typeof src.text === 'string' ? src.text.trim().slice(0, MAX_TEXT) : ''
  if (text.length < 5) {
    return json({ error: 'BAD_REQUEST', message: '描述太短了，再写一句具体的。' }, 400)
  }

  const email = normalizeEmail(src.email)
  const context = normalizeContext(src.context)
  const errors = normalizeErrors(src.errors)
  const ip = clientIp(request)

  const page = context.find((c) => c.group === '环境' && c.key === '页面')?.value ?? ''
  const bodyText = buildBody({ kind, text, email, context, errors, ip })

  /* --- 没配密钥：**报告不能丢** ---
   * 走服务端日志（Vercel 的 Runtime Logs 能看到全文），
   * 同时如实告诉用户通道还没开 —— 不假装成功。 */
  if (!env.key || !env.to) {
    console.error('[report] 反馈通道未配置，报告落在这里：\n', bodyText)
    return json(
      {
        error: 'NOT_CONFIGURED',
        message: '反馈通道还没开通，先谢谢你的耐心。',
      },
      503,
    )
  }

  /* --- 发信 --- */
  let upstream: Response
  try {
    upstream = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.key}`,
      },
      body: JSON.stringify({
        from: env.from,
        to: [env.to],
        /* 主题里的每一段都过了白名单或 oneLine()，不可能带换行 */
        subject: `[ML 演示站] ${kind}${page ? ` · ${page}` : ''}`,
        text: bodyText,
        /* 留了邮箱就设 reply_to —— 你直接点"回复"就能回给他，不用复制地址 */
        ...(email ? { reply_to: email } : {}),
      }),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    })
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'TimeoutError'
    console.error('[report] 发信请求失败：', isTimeout ? '超时' : String(err), '\n', bodyText)
    return json(
      {
        error: isTimeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
        message: '没发出去，等一会儿再试试。你的这段描述先别关掉。',
      },
      502,
    )
  }

  if (!upstream.ok) {
    /* ⚠️ 只带状态码和上游的简短说明，**绝不**回传请求头（里面是密钥） */
    let detail = ''
    try {
      detail = (await upstream.text()).slice(0, 300)
    } catch {
      /* ignore */
    }
    /* 邮件没发出去，但报告不能丢 —— 全文进日志 */
    console.error(`[report] 上游 ${upstream.status}：`, detail, '\n', bodyText)
    return json(
      {
        error: 'UPSTREAM_ERROR',
        status: upstream.status,
        message: '没发出去（邮件服务返回了错误），等一下再试试。',
      },
      502,
    )
  }

  return json({ ok: true })
}

/* ------------------------------------------------------------------ *
 * 兜底：这个文件本身也是个「函数」
 *
 * Vercel 会把 `/api` 下不带下划线的每个 `.ts` 都当入口编译
 * —— 这正是让 `report.ts` 能 import 到它的唯一办法。
 * 副作用是它顺带成了一个可访问的网址（`/api/report-handler`）。
 * 没有 default 导出的话 Vercel 会回一个**看起来像故障的 500**，
 * 给个明确的 404 干净些。真正干活的是 `report.ts`。
 * ------------------------------------------------------------------ */

export default {
  fetch: () =>
    new Response(JSON.stringify({ error: 'NOT_FOUND', message: '这个地址不是接口' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }),
}
