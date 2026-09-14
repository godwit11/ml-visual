import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readdirSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { handleChat } from './chat/handler'

const root = dirname(fileURLToPath(import.meta.url))

function demoEntries(): Record<string, string> {
  const dir = resolve(root, 'demos')
  const out: Record<string, string> = {}
  if (!existsSync(dir)) return out
  // `_` 开头的目录是开发期自测页，不进生产构建（dev 模式下仍可直接访问）
  for (const name of readdirSync(dir)) {
    if (name.startsWith('_')) continue
    const file = resolve(dir, name, 'index.html')
    if (existsSync(file)) out[name] = file
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Nya 对话接口的本地开发支持
 *
 * 为什么需要这个：
 *   线上是 Vercel 负责把 `api/chat.ts` 变成一个网址。但 `npm run dev`
 *   只起一个 Vite 静态服务器，它不认识 `/api/chat` —— 于是本地开发时
 *   AI 功能完全没法测，只能推上去试，一次一轮，非常慢。
 *
 *   这个插件给 Vite 的 dev server 挂一段中间件，把 `/api/chat` 的请求
 *   交给同一份 `chat/handler.ts`。好处是**本地和线上跑的是同一份逻辑**，
 *   不存在"本地好好的、推上去就坏"这类问题。
 *
 * 密钥从哪来：
 *   项目根目录的 `.env.local`（已在 .gitignore 里，不会进仓库）。
 *   需要的变量见 `.env.example`。生产环境的同名变量填在 Vercel 后台。
 * ------------------------------------------------------------------ */

const NYA_ENV_KEYS = [
  'MINIMAX_API_KEY',
  'MINIMAX_BASE_URL',
  'MINIMAX_MODEL',
  'NYA_ALLOWED_ORIGINS',
] as const

/** Vite 默认不会把 .env 的变量塞进 process.env（只暴露 VITE_ 前缀给前端），所以手动加载 */
function loadNyaEnv(mode: string): void {
  const env = loadEnv(mode, root, '')
  for (const key of NYA_ENV_KEYS) {
    if (env[key]) process.env[key] = env[key]
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined
}

/** Node 的 header 值可能是 string | string[] | undefined，转成干净的 Headers */
function toHeaders(req: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value)
    else if (Array.isArray(value)) headers.set(key, value.join(', '))
  }
  return headers
}

function nyaDevApi(mode: string): Plugin {
  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    const url = req.url ?? ''
    if (!url.startsWith('/api/chat')) return next()

    loadNyaEnv(mode)

    /*
     * 开发时端口可能变（5173 被占时 Vite 会自动换），也可能用 localhost
     * 或 127.0.0.1 打开。与其猜端口，不如把本次请求的来源直接加进白名单 ——
     * 只对 localhost / 127.0.0.1 生效，生产环境走不到这段代码。
     */
    const origin = req.headers.origin
    if (typeof origin === 'string' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      const current = process.env.NYA_ALLOWED_ORIGINS ?? ''
      if (!current.split(',').includes(origin)) {
        process.env.NYA_ALLOWED_ORIGINS = [current, origin].filter(Boolean).join(',')
      }
    }

    try {
      const request = new Request(new URL(url, 'http://localhost'), {
        method: req.method,
        headers: toHeaders(req),
        body: await readBody(req),
      })
      const response = await handleChat(request)
      res.statusCode = response.status
      response.headers.forEach((value, key) => res.setHeader(key, value))
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch (err) {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(
        JSON.stringify({
          error: 'DEV_MIDDLEWARE_ERROR',
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    }
  }

  return {
    name: 'nya-dev-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}

export default defineConfig(({ mode }) => ({
  base: './',
  server: { port: 5173, open: false },
  plugins: [nyaDevApi(mode)],
  build: {
    target: 'es2019',
    outDir: 'dist',
    assetsDir: 'assets',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: { main: resolve(root, 'index.html'), ...demoEntries() },
    },
  },
}))
