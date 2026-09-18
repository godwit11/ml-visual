/**
 * 「只创建、不清理」类残留的统一清理。
 *
 * 这个文件存在的理由，是同一个坑在本项目**踩了两次**：
 *
 *   ① e2e 的浏览器用户数据目录 —— 每次跑测试在系统 Temp 里建一个约 47M 的目录，
 *      `finally` 里只 kill 进程、从不删。一周攒下 1801 个 / 58.92G，把 C 盘吃掉一大块。
 *   ② Vite 的临时配置文件 —— `vite.config.ts.timestamp-<ms>-<hash>.mjs`，
 *      正常退出它会自己删；**但被 SIGKILL 强杀就留下了**，而 e2e 杀 preview
 *      用的正是 SIGKILL。9 天积了 850 个 / 111MB（约 94 个/天）。
 *
 * 两次的形态一模一样：**进程被强杀 ⇒ 清理代码没机会跑 ⇒ 残骸累积**。
 * 所以修法也一样 —— 不能只靠"退出时清理"（那正是失效的那一环），
 * 必须再加一道**下次启动时扫掉旧的**。
 *
 * ⚠️ 所有函数都只认**明确的前缀/后缀**，绝不按"目录大"或"看起来像临时"来删。
 */

import { readdirSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** 递归求和，顺便数一下文件数 */
function measure(dir) {
  let bytes = 0
  let files = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = join(cur, e.name)
      try {
        if (e.isDirectory()) stack.push(p)
        else if (e.isFile()) {
          bytes += statSync(p).size
          files++
        }
      } catch {
        /* 被占用 / 无权限，跳过 */
      }
    }
  }
  return { bytes, files }
}

/**
 * 清掉 e2e 的浏览器用户数据目录。
 *
 * @param opts.maxAgeMs 只清这么老的（默认 0 = 全清）。跑在"每次启动"那条路径上时
 *                      一定要传，否则会把**正在跑的那个实例**的目录删掉。
 * @param opts.cap      一次最多清几个（防止启动时扫上千个把主流程拖慢）
 */
export function cleanBrowserProfiles(opts = {}) {
  const { tmpDir, maxAgeMs = 0, cap = Infinity, prefix = 'mlv-e2e-', dryRun = false } = opts
  const T = tmpDir
  const cutoff = maxAgeMs > 0 ? Date.now() - maxAgeMs : Infinity

  let names
  try {
    names = readdirSync(T)
  } catch {
    return { removed: 0, bytes: 0, files: 0 }
  }

  let removed = 0
  let bytes = 0
  let files = 0
  for (const name of names) {
    if (removed >= cap) break
    if (!name.startsWith(prefix)) continue
    const p = join(T, name)
    try {
      const st = statSync(p)
      if (!st.isDirectory()) continue
      if (st.mtimeMs > cutoff) continue
      const m = measure(p)
      /* dryRun 也要真的量一遍大小，否则演练出来的数字没有意义 */
      if (!dryRun) rmSync(p, { recursive: true, force: true })
      removed++
      bytes += m.bytes
      files += m.files
    } catch {
      /* 被占用，留给下次 */
    }
  }
  return { removed, bytes, files }
}

/**
 * 清掉 Vite 的临时配置文件。
 *
 * 名字形如 `vite.config.ts.timestamp-1789707836072-8894b485002cb.mjs`，
 * 产生在**项目根目录**（不在系统 Temp 里，所以「清临时文件夹」那类工具
 * 永远碰不到它们）。
 */
export function cleanViteConfigTemp(rootDir, opts = {}) {
  const { maxAgeMs = 0, cap = Infinity, dryRun = false } = opts
  const cutoff = maxAgeMs > 0 ? Date.now() - maxAgeMs : Infinity
  /* 只认这个精确形状 —— 中间必须是一串数字 + 一串十六进制哈希 */
  const PATTERN = /^vite\.config\.ts\.timestamp-\d+-[0-9a-f]+\.mjs$/

  let names
  try {
    names = readdirSync(rootDir)
  } catch {
    return { removed: 0, bytes: 0, files: 0 }
  }

  let removed = 0
  let bytes = 0
  let files = 0
  for (const name of names) {
    if (removed >= cap) break
    if (!PATTERN.test(name)) continue
    const p = join(rootDir, name)
    try {
      const st = statSync(p)
      if (!st.isFile()) continue
      if (st.mtimeMs > cutoff) continue
      const size = st.size
      if (!dryRun) rmSync(p, { force: true })
      removed++
      bytes += size
      files++
    } catch {
      /* 被占用，留给下次 */
    }
  }
  return { removed, bytes, files }
}

export function human(bytes) {
  let b = Number(bytes)
  const units = ['B', 'K', 'M', 'G', 'T']
  let i = 0
  while (b >= 1024 && i < units.length - 1) {
    b /= 1024
    i++
  }
  return `${b.toFixed(2)}${units[i]}`
}
