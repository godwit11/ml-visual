/**
 * 清掉 e2e 测试在系统临时目录里留下的浏览器数据目录（`mlv-e2e-*`）。
 *
 * 为什么需要它：
 *   e2e.mjs 现在会自己收尾（结束后删掉本次那个），但**历史上攒下的**、
 *   以及**被 SIGKILL 时来不及清的**残骸得一次性处理。2026-09-17 实测：
 *   1801 个目录 / 58.92G，占了 C 盘一大块，而「磁盘清理」(cleanmgr) 根本
 *   扫不出来 —— 那里文件数上百万，它枚举到一半就超时放弃，于是显示
 *   「可释放 1.16 MB」，让人以为没得清。
 *
 * 用法：
 *   npm run clean:temp                  # 列出并删除
 *   npm run clean:temp -- --dry         # 演练：只统计，不删
 *   npm run clean:temp -- --keep 3      # 保留最新的 3 个（想留个现场看的时候）
 *   npm run clean:temp -- --min-age 1   # 只删 1 小时前的（默认不限，全删）
 *
 * 说明：
 *   - 只认 `mlv-e2e-` 前缀，别的临时文件一律不碰。
 *   - 删不掉的多半是正被浏览器占用的（某次测试还没跑完）。关掉 Edge / 等测试
 *     结束后重跑即可，脚本会如实报出失败数量。
 */
import { readdirSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : def
}

const dry = has('--dry')
const keep = Math.max(0, Number(arg('keep', '0')) || 0)
const minAgeH = Math.max(0, Number(arg('min-age', '0')) || 0)
const PREFIX = arg('prefix', 'mlv-e2e-')

function human(n) {
  const units = ['B', 'K', 'M', 'G', 'T']
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(2)}${units[i]}`
}

/** 递归求目录大小。逐项 try/catch —— 被占用的文件不该让整个统计崩掉。 */
function dirSize(root) {
  let total = 0
  const stack = [root]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const fp = join(cur, e.name)
      try {
        if (e.isDirectory()) stack.push(fp)
        else if (e.isFile()) total += statSync(fp).size
      } catch {
        /* 占用 / 无权限，跳过 */
      }
    }
  }
  return total
}

const T = tmpdir()
const all = []
for (const name of readdirSync(T)) {
  if (!name.startsWith(PREFIX)) continue
  const p = join(T, name)
  try {
    const st = statSync(p)
    if (st.isDirectory()) all.push({ name, path: p, mtime: st.mtimeMs })
  } catch {
    /* 读不到就算了 */
  }
}
all.sort((a, b) => b.mtime - a.mtime) // 新的在前

const kept = all.slice(0, keep)
let targets = all.slice(keep)
if (minAgeH > 0) {
  const cut = Date.now() - minAgeH * 3600_000
  targets = targets.filter((c) => c.mtime < cut)
}

console.log(`临时目录: ${T}`)
console.log(`匹配 ${PREFIX}* : ${all.length} 个目录`)
if (keep) console.log(`保留最新的 ${kept.length} 个（--keep ${keep}）`)
if (minAgeH) console.log(`只处理 ${minAgeH} 小时以前的`)
console.log(`待处理: ${targets.length} 个${dry ? '   [--dry 演练，不会删任何东西]' : ''}`)
console.log('')

if (!targets.length) {
  console.log('没有需要处理的目录。')
  process.exit(0)
}

let freed = 0
let okCount = 0
let failCount = 0
const t0 = Date.now()

for (let i = 0; i < targets.length; i++) {
  const { name, path } = targets[i]
  const sz = dirSize(path)
  if (dry) {
    freed += sz
  } else {
    try {
      rmSync(path, { recursive: true, force: true })
      freed += sz
      okCount++
    } catch (e) {
      failCount++
      console.error(`  失败: ${name}  —  ${e.code || e.message}`)
    }
  }
  if ((i + 1) % 100 === 0) {
    console.log(`  进度 ${i + 1}/${targets.length}，已${dry ? '统计' : '释放'} ${human(freed)}`)
  }
}

console.log('')
console.log(`${dry ? '预计可释放' : '已释放'}: ${human(freed)}`)
if (!dry) {
  console.log(`成功 ${okCount} 个，失败 ${failCount} 个，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  if (failCount) console.log('（失败的通常是被浏览器占用，关掉后重跑一次即可）')
}
