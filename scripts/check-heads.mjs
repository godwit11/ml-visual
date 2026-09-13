#!/usr/bin/env node
/**
 * <head> 标签一致性检查（纯静态，不需要起服务器、不需要构建）。
 *
 * 为什么需要它 —— 真实教训：
 *   `demos/clustering/index.html` 曾经少了 **9 个** head 标签
 *   （canonical、favicon、6 个 og:、twitter:card），而另外 9 个演示页都有。
 *   症状是「分享到微信/Twitter 没有卡片」「搜索引擎可能判重」——
 *   页面本身完全正常，所以**肉眼看、跑 e2e 全发现不了**。
 *
 *   根因是这些标签是**逐页手写拷贝**的，复制时漏了一页。
 *   所以这里做的是「一致性」检查而不是「有没有」检查：
 *   以多数页面的标签集合为基准，掉队的页会被点名。
 *
 * 用法：
 *   node scripts/check-heads.mjs          # 检查仓库里的 HTML 源文件
 *   exit 0 = 一致，exit 1 = 有不一致（打印差异）
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/* ---------- 收集页面 ---------- */
const pages = []
if (existsSync(join(root, 'index.html'))) pages.push({ name: '首页', file: 'index.html' })

const demosDir = join(root, 'demos')
if (existsSync(demosDir)) {
  for (const d of readdirSync(demosDir).sort()) {
    if (d.startsWith('_')) continue // 开发期自测页，不参与
    const f = join(demosDir, d, 'index.html')
    if (existsSync(f)) pages.push({ name: `demos/${d}`, file: `demos/${d}/index.html` })
  }
}

/* ---------- 抽取 head 里的标签指纹 ---------- */
function headTags(relPath) {
  const html = readFileSync(join(root, relPath), 'utf8')
  const m = /<head>([\s\S]*?)<\/head>/.exec(html)
  if (!m) return null
  const head = m[1].replace(/\s+/g, ' ')

  const tags = new Set()
  // <link rel="...">
  for (const t of head.match(/<link\s[^>]*>/g) || []) {
    const rel = /rel="([^"]+)"/.exec(t)
    if (rel) tags.add(`link[rel=${rel[1]}]`)
  }
  // <meta name="..."|property="...">
  for (const t of head.match(/<meta\s[^>]*>/g) || []) {
    const n = /name="([^"]+)"/.exec(t) || /property="([^"]+)"/.exec(t)
    if (n) tags.add(`meta[${n[1]}]`)
  }
  if (/<title>/.test(head)) tags.add('title')
  return { tags, head }
}

const data = pages.map((p) => ({ ...p, ...headTags(p.file) })).filter((p) => p.tags)

if (data.length < 2) {
  console.log('[check-heads] 页面太少，跳过')
  process.exit(0)
}

/* ---------- 以「多数页面都有的标签」为基准 ---------- */
const counts = new Map()
for (const p of data) for (const t of p.tags) counts.set(t, (counts.get(t) || 0) + 1)

const MAJORITY = Math.ceil(data.length * 0.6)
const required = [...counts.entries()].filter(([, c]) => c >= MAJORITY).map(([t]) => t).sort()

console.log(`[check-heads] ${data.length} 个页面，基准标签 ${required.length} 项（≥${MAJORITY}/${data.length} 页面共有）\n`)

let bad = 0
for (const p of data) {
  const missing = required.filter((t) => !p.tags.has(t))
  const extra = [...p.tags].filter((t) => !required.includes(t)).sort()
  if (missing.length) {
    bad++
    console.log(`  ✗ ${p.name.padEnd(26)} 缺 ${missing.length} 项: ${missing.join(', ')}`)
  }
  if (extra.length) {
    console.log(`    ${p.name.padEnd(26)} 多出（不参与基准）: ${extra.join(', ')}`)
  }
}

if (bad) {
  console.log(`\n[check-heads] ❌ ${bad} 个页面的 head 标签不一致 —— 逐页手写的标签最容易漏，照着齐的那页补上。`)
  process.exit(1)
}

console.log('  ✓ 所有页面的 head 标签一致')
