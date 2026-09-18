/**
 * 清掉两类「只创建、不清理」的残留。
 *
 * 都是实测撞出来的，而且**形态完全一样**：进程被强杀 ⇒ 退出时的清理没机会跑 ⇒ 残骸累积。
 *
 *   ① **系统 Temp 里的浏览器数据目录**（`mlv-e2e-*`）
 *      每次跑 e2e 建一个约 47M 的目录，一周攒下 1801 个 / **58.92G**，
 *      把 C 盘吃掉一大块。而「磁盘清理」(cleanmgr) **扫不出来** ——
 *      那里文件数过百万，它枚举超时就放弃、把那一项静默隐藏，
 *      看起来像「没什么可清」（实际报的是"可释放 1.16 MB"）。
 *
 *   ② **项目根目录的 Vite 临时配置**（`vite.config.ts.timestamp-*.mjs`）
 *      每个约 130KB，9 天积了 850 个 / **111MB**。
 *      ⚠️ 它们在**项目目录里**，所以「清理系统临时文件夹」那类工具永远碰不到。
 *
 * 治本的那一半在 `e2e.mjs`（每次启动顺手扫一遍旧的）；这个脚本是**一次性清干净**的入口。
 * 判定逻辑都在 `scripts/lib/cleanup.mjs`，两边共用。
 *
 * 用法：
 *   npm run clean:temp                  # 两类都清
 *   npm run clean:temp -- --dry         # 演练：只统计，不删
 *   npm run clean:temp -- --min-age 1   # 只清 1 小时前的（怕删到正在跑的）
 *   npm run clean:temp -- --only=vite   # 只清一类（temp / vite / all）
 */
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { cleanBrowserProfiles, cleanViteConfigTemp, human } from './lib/cleanup.mjs'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : def
}

const dry = has('--dry')
const minAgeH = Math.max(0, Number(arg('min-age', '0')) || 0)
const only = arg('only', 'all')
const maxAgeMs = minAgeH * 3600_000
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const T = tmpdir()

console.log(`项目目录: ${rootDir}`)
console.log(`系统 Temp: ${T}`)
console.log(dry ? '模式: --dry 演练（不会删任何东西）' : '模式: 实际清理')
if (minAgeH) console.log(`只处理 ${minAgeH} 小时以前的`)
console.log('')

const lines = []
let freeing = 0

if (only === 'all' || only === 'temp') {
  const r = cleanBrowserProfiles({ tmpDir: T, maxAgeMs, dryRun: dry })
  lines.push(`浏览器数据目录  mlv-e2e-*           ${String(r.removed).padStart(5)} 个   ${human(r.bytes)}`)
  freeing += r.bytes
}

if (only === 'all' || only === 'vite') {
  const r = cleanViteConfigTemp(rootDir, { maxAgeMs, dryRun: dry })
  lines.push(`Vite 临时配置   *.timestamp-*.mjs   ${String(r.removed).padStart(5)} 个   ${human(r.bytes)}`)
  freeing += r.bytes
}

console.log('清理结果')
console.log('─'.repeat(56))
for (const l of lines) console.log('  ' + l)
console.log('─'.repeat(56))
console.log(`  ${dry ? '预计可释放' : '已释放'}  ${human(freeing)}`)
if (only !== 'all') console.log(`  （--only=${only}，另一类没动）`)
if (freeing === 0) console.log('  ✅ 没有需要清理的残留')
