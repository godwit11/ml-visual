#!/usr/bin/env node
/**
 * 扫描 demos/ 下所有已上线的演示页，生成 public/sitemap.xml 与 public/robots.txt。
 *
 * 为什么自动生成：演示页会从 7 个一路加到 16 个（见 PLAN.md §3），
 * 手写 sitemap 一定会漏。放在构建前跑，就不可能忘。
 *
 * 用法：
 *   node scripts/gen-sitemap.mjs
 *   SITE_URL=https://example.com node scripts/gen-sitemap.mjs
 */

import { readdirSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// 站点根地址。与域名现状一致：godwit.asia 根域名 307 跳到 www，
// 所以 canonical 一律用带 www 的版本；日后改主域名只需设这个环境变量。
const SITE_URL = (process.env.SITE_URL || 'https://www.godwit.asia').replace(/\/+$/, '')

const dateOf = (p) => {
  const d = new Date(statSync(p).mtime)
  const p2 = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

/** 收集所有已上线的演示页路径（`_` 开头的是开发期自测页，与 vite.config.ts 保持一致） */
function collectPages() {
  const homeIndex = join(root, 'index.html')
  const pages = [{ loc: '/', lastmod: dateOf(homeIndex) }]

  const demosDir = join(root, 'demos')
  if (existsSync(demosDir)) {
    const names = readdirSync(demosDir)
      .filter((n) => !n.startsWith('_'))
      .filter((n) => existsSync(join(demosDir, n, 'index.html')))
      .sort()
    for (const name of names) {
      pages.push({
        loc: `/demos/${name}/`,
        lastmod: dateOf(join(demosDir, name, 'index.html')),
      })
    }
  }
  return pages
}

const pages = collectPages()

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<!-- 本文件由 scripts/gen-sitemap.mjs 自动生成，请勿手工编辑 -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages
  .map(
    (p) => `  <url>
    <loc>${SITE_URL}${p.loc}</loc>
    <lastmod>${p.lastmod}</lastmod>
  </url>`
  )
  .join('\n')}
</urlset>
`

const robots = `User-agent: *
Allow: /

Sitemap: ${SITE_URL}/sitemap.xml
`

const publicDir = join(root, 'public')
if (!existsSync(publicDir)) mkdirSync(publicDir, { recursive: true })
writeFileSync(join(publicDir, 'sitemap.xml'), sitemap, 'utf8')
writeFileSync(join(publicDir, 'robots.txt'), robots, 'utf8')

console.log(`[gen-sitemap] ${SITE_URL} — 共 ${pages.length} 条 URL（首页 1 + 演示 ${pages.length - 1}）`)
for (const p of pages) console.log(`  ${p.loc}  (${p.lastmod})`)
