/**
 * 把 Nya **真正发给上游的那份提示词**原样打出来。
 *
 * ------------------------------------------------------------------ *
 * 为什么必须走 `handleChat` 而不是直接调 `buildSystemPrompt`
 * ------------------------------------------------------------------ *
 * 直接调 `buildSystemPrompt` 只能证明"提示词组装函数没问题"，
 * 证明不了请求链路上没有把它丢掉。2026-09-14 就栽在这上面：
 * 加了 `prev`（上一次快照）字段之后，组装函数是对的、前端也确实发了，
 * 但 `handler.ts` 的 `normalizeContext` 没往外拷这个字段 ——
 * 它被**静默丢掉**，Nya 就说"我看不到你之前的状态"。
 * 当时我的调试脚本正是直接调组装函数的，所以一直显示"一切正常"，
 * 白查了半天，最后是去数上游 payload 才发现的。
 *
 * 现在这个脚本走完整链路：真实 Request → handleChat → 拦下上游请求 →
 * 打印上游实际收到的 system 消息。顺手还能看到 temperature 之类的参数。
 *
 * 用法：
 *   node scripts/nya-prompt.mjs --demo=model-evaluation \
 *     --state=.shots/state-me-next.json --prev=.shots/state-me-prev.json \
 *     --question="我刚在页面上动了什么？"
 */

import { build } from 'esbuild'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/* 读 .env.local —— handleChat 没有密钥会直接返回 503 */
const envPath = resolve(root, '.env.local')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    if (!line.includes('=') || line.trim().startsWith('#')) continue
    const i = line.indexOf('=')
    const k = line.slice(0, i).trim()
    const v = line.slice(i + 1).trim()
    if (k && v) process.env[k] = v
  }
}

const built = await build({
  entryPoints: [resolve(root, 'api/handler.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  logLevel: 'silent',
})
const mod = { exports: {} }
new Function('module', 'exports', 'require', built.outputFiles[0].text)(mod, mod.exports, require)
const { handleChat } = mod.exports

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const read = (p) => (p ? JSON.parse(readFileSync(resolve(root, p), 'utf8')) : undefined)

/* 拦下上游请求：省钱，并且能拿到完整的 payload */
let sent = null
globalThis.fetch = async (url, init) => {
  if (!String(url).includes('/chat/completions')) throw new Error(`不该请求别处：${url}`)
  sent = JSON.parse(init.body)
  return new Response(JSON.stringify({ choices: [{ message: { content: '（调试桩）' } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const state = read(flag('state', null))
const prev = read(flag('prev', null))
const question = flag('question', '我刚在页面上动了什么？')

const res = await handleChat(
  new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: question }],
      context: { demoId: flag('demo', 'model-evaluation'), state, prev },
    }),
  }),
)

if (res.status !== 200) {
  console.error(`❌ handleChat 返回 ${res.status}：${JSON.stringify(await res.json())}`)
  process.exit(1)
}
if (!sent) {
  console.error('❌ 没有截到上游请求 —— 链路变了？')
  process.exit(1)
}

const system = sent.messages[0].content
console.log(system)

console.log('\n' + '─'.repeat(70))
console.log(
  `上游参数：model=${sent.model} temperature=${sent.temperature ?? '(未设)'} ` +
    `max_completion_tokens=${sent.max_completion_tokens} thinking=${JSON.stringify(sent.thinking)}`,
)
console.log(
  `上下文：上报 ${state ? Object.keys(state).length : 0} 个键 · ` +
    `上一份快照 ${prev ? `${Object.keys(prev).length} 个键 ✅` : '❌ 没传到（检查 normalizeContext！）'}`,
)
console.log(`提示词长度 ${system.length} 字符`)
