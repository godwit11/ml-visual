/**
 * 核对「前端上报的状态键」和「服务端白名单」有没有对上。
 *
 * ------------------------------------------------------------------ *
 * 为什么需要这个脚本
 * ------------------------------------------------------------------ *
 * `api/nya.ts` 里的 `stateKeys` 是一张白名单：**不在名单里的键会被安静丢掉**。
 * 这个设计本身是对的（它挡住了"往里塞任意文本"这条路），
 * 但它有一个很坏的失败方式：**不报错**。
 *
 * 页面上把指标卡的标签从「准确率」改成「判对率」，Nya 就再也看不到这个数了 ——
 * 页面照常运行、测试全绿、只有学生问起来才发现她在说"我看不到"。
 * 用户第一版就是这么翻车的（他在模型评估页问表格，Nya 让他去线性回归页）。
 *
 * 所以这里做一次**端到端核对**：
 *   ① 从 `api/nya.ts` 里把这个 id 的 stateKeys 抠出来
 *   ② 在真实浏览器里打开那一页，截下 Nya 真正收到的请求体
 *   ③ 对差集：谁多谁少，逐条列出来
 *
 * ⚠️ 走的是真实链路（真的打开页面、真的点开面板、真的发请求，只是 fetch 被换掉
 *    所以不花钱），不是把 DOM 读取逻辑在测试里重写一遍 —— 重写等于抄一遍生产代码，
 *    抄错了测试反而会通过。
 *
 * 用法：node scripts/check-nya-state.mjs
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 4176
const BASE = `http://127.0.0.1:${PORT}`

/* ------------------------------------------------------------------ *
 * ① 从 api/nya.ts 里抠出每个 id 的 stateKeys
 * ------------------------------------------------------------------ */

/**
 * 为什么用正则抠而不是 import：
 *   `api/nya.ts` 是服务端 TypeScript，这个脚本是 node 脚本，没有编译步骤。
 *   文件是我们自己写的、格式稳定，正则够用；万一格式变了，
 *   下面的"一个 id 都没解析出来"会立刻炸掉，不会安静地放过去。
 */
function readWhitelist() {
  const src = readFileSync(join(ROOT, 'api', 'nya.ts'), 'utf8')
  const out = new Map()

  const idRe = /id:\s*'([a-z0-9-]+)'/g
  const ids = []
  let m
  while ((m = idRe.exec(src))) ids.push({ id: m[1], at: m.index })

  for (let i = 0; i < ids.length; i++) {
    const start = ids[i].at
    const end = i + 1 < ids.length ? ids[i + 1].at : src.length
    const block = src.slice(start, end)
    const keys = block.match(/stateKeys:\s*\[([\s\S]*?)\]/)
    if (!keys) continue
    const list = keys[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
    out.set(ids[i].id, list)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * ② 跑浏览器，截真实的请求体
 * ------------------------------------------------------------------ */

function runProbe(demoId) {
  /* 首页不在 demos/ 下面，它在站点根 —— 别拼成 /demos/home/ */
  const url = demoId === 'home' ? `${BASE}/` : `${BASE}/demos/${demoId}/`
  return new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      [
        join(ROOT, 'scripts', 'e2e.mjs'),
        '--url',
        url,
        '--script',
        join(ROOT, 'scripts', 'tests', 'probe-nya-state.js'),
      ],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    proc.stdout.on('data', (d) => (out += d))
    proc.stderr.on('data', (d) => (out += d))
    proc.on('close', () => {
      const json = out.match(/\{[\s\S]*\}/)
      if (!json) return resolve({ error: `驱动没返回 JSON：${out.slice(-300)}` })
      try {
        resolve(JSON.parse(json[0]))
      } catch {
        resolve({ error: `解析失败：${json[0].slice(0, 300)}` })
      }
    })
  })
}

/* ------------------------------------------------------------------ *
 * ③ 对差集
 * ------------------------------------------------------------------ */

/**
 * 白名单里允许有"这一页偶尔才出现的键"（比如有些指标卡要跑完才渲染），
 * 所以这里只把「多出来的键」当**错误**，「少报的键」当**提示**。
 * 反过来判更危险：会因为一次性的时序问题产生假失败，然后人就学会忽略它了。
 */
const whitelist = readWhitelist()
if (whitelist.size === 0) {
  console.error('❌ 一个 demo 的 stateKeys 都没解析出来 —— api/nya.ts 的格式变了吗？')
  process.exit(1)
}

console.log(`白名单里有 ${whitelist.size} 页\n`)

const server = spawn(
  process.execPath,
  [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(PORT), '--host', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore' },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(2500)

let failed = 0
let warned = 0

try {
  for (const [demoId, allowed] of whitelist) {
    const res = await runProbe(demoId)

    if (res.error) {
      console.log(`❌ ${demoId}: ${res.error}`)
      failed++
      continue
    }
    if (res.demoId !== demoId) {
      console.log(`❌ ${demoId}: 前端认出的页面 id 是「${res.demoId}」—— 对不上`)
      failed++
      continue
    }

    const reported = res.keys
    const dropped = reported.filter((k) => !allowed.includes(k))
    const missing = allowed.filter((k) => !reported.includes(k))

    const extra = reported.length > 0 ? `上报 ${reported.length} 个` : '**一个都没上报**'
    if (dropped.length === 0 && missing.length === 0) {
      console.log(`✅ ${demoId.padEnd(20)} ${extra}，与白名单完全一致`)
    } else {
      console.log(`${dropped.length ? '❌' : '⚠️'} ${demoId.padEnd(20)} ${extra}`)
      if (dropped.length) {
        console.log(`     被白名单丢掉（页面上有、Nya 看不到）：${dropped.join(' / ')}`)
        failed++
      }
      if (missing.length) {
        console.log(`     白名单里有、这次没上报：${missing.join(' / ')}`)
        warned++
      }
    }
  }
} finally {
  server.kill('SIGKILL')
}

console.log('')
if (failed > 0) {
  console.log(`❌ ${failed} 页有键被丢掉 —— 去 api/nya.ts 把 stateKeys 改成和页面上一致`)
  process.exit(1)
}
console.log(`✅ 全部 ${whitelist.size} 页都对上了${warned ? `（另有 ${warned} 页有暂时没上报的键，不影响）` : ''}`)
