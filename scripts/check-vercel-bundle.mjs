#!/usr/bin/env node
/*
 * 验证「服务端代码搬到 Vercel 之后，能不能被加载」。
 *
 * ------------------------------------------------------------------
 * 为什么需要这个脚本（2026-09-15 线上事故）
 *
 * 线上 /api/chat 连续报 500 `FUNCTION_INVOCATION_FAILED`，
 * Vercel 日志里的真身是：
 *
 *     Error [ERR_MODULE_NOT_FOUND]: Cannot find module
 *     '/var/task/chat/handler' imported from /var/task/api/chat.js
 *
 * 表层原因是依赖文件放在项目根的 `chat/` 目录。但真正难的地方在于：
 * **这里的规则有两条，而且第二条非常反直觉** ——
 *
 *   ① Vercel 只处理 `/api` 目录下的文件。
 *      `/api` 之外的 TS 既不编译也不打包。
 *
 *   ② 在 `/api` 里，**不带 `_` / `.` 前缀的 `.ts` 会被当成函数入口
 *      ⇒ 会被编译成 `.js`**；而**以 `_` 开头的文件会被 Vercel
 *      「忽略」⇒ 也就不会被编译**。
 *
 *   所以"给共享文件加下划线前缀，好让它别变成公开路由"这个看起来
 *   最自然的做法是**错的**：它确实不成为路由，但**也不会被编译**，
 *   于是入口要 import 的 `handler.js` 不存在 —— 照样 500。
 *   （实测：2026-09-15 先按这个思路改过一遍，是这个脚本把它拦下来的。）
 *
 *   ③ 再加上 `package.json` 里的 `"type": "module"` ⇒ 产物是 ESM，
 *      而 **ESM 的解析器不做扩展名猜测**（CommonJS 才猜）。
 *      所以导入必须写成 `'./handler.js'`，哪怕源文件叫 `handler.ts`。
 *
 * ------------------------------------------------------------------
 * 这三条**本地全都测不出来**：
 *   · `npm run dev` 走 vite.config.ts 的中间件 —— Vite 用 bundler
 *     那套解析（会猜扩展名、也不在乎文件在哪个目录），一律正常；
 *   · `npm run typecheck` 也看不出来 —— TS 在 bundler 模式下
 *     同样接受省略扩展名。
 * 于是「本地全绿、线上全崩」，而线上验证一次要等一次部署。
 *
 * ------------------------------------------------------------------
 * 这个脚本做的事：
 *
 *   A. 静态规则检查（①②③）—— 不需要编译，最快，也最常拦住问题
 *   B. 复刻 Vercel 的加载环境：用 esbuild 把 `api/*.ts` **各自**编译成
 *      独立 `.js`（`bundle: false`，保留 import 语句原样 —— 这正是
 *      Vercel 交出来的形状），放一个 `{"type":"module"}` 的
 *      package.json 进去，再用 node 以 ESM **真去 import 一遍**。
 */

import { build } from 'esbuild'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const API_DIR = join(ROOT, 'api')
const OUT = join(ROOT, '.shots', 'vercel-probe')

const results = []
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra })

/* ------------------------------------------------------------------ *
 * ① 入口必须是 api/chat.ts
 * ------------------------------------------------------------------ */

check('入口 api/chat.ts 存在', existsSync(join(API_DIR, 'chat.ts')))

/* ------------------------------------------------------------------ *
 * ② 服务端逻辑不许住在 api/ 之外（Vercel 不会碰它们）
 * ------------------------------------------------------------------ */

const strays = []
/* `api/` 里面的不算跑出去；vite.config.ts 是本地开发配置，允许它引用服务端逻辑 */
const ALLOW = new Set(['vite.config.ts'])
const walk = (dir, depth = 0) => {
  if (depth > 4) return
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.name === 'node_modules' || name.name.startsWith('.')) continue
    const p = join(dir, name.name)
    if (name.isDirectory()) {
      walk(p, depth + 1)
      continue
    }
    if (!/\.ts$/.test(name.name)) continue
    const rel = p.slice(ROOT.length + 1).replace(/\\/g, '/')
    if (rel.startsWith('api/') || ALLOW.has(rel)) continue
    if (/handleChat|buildSystemPrompt/.test(readFileSync(p, 'utf8'))) strays.push(rel)
  }
}
walk(ROOT)
check(
  '服务端逻辑都在 api/ 目录内（Vercel 只处理这里）',
  strays.length === 0,
  strays.length ? `跑到外面了：${strays.join(', ')}` : '都在 api/ 里',
)

/* ------------------------------------------------------------------ *
 * ③ 逐个检查相对导入（规则 ②③）
 *
 * 这是本脚本最值钱的部分，因为它拦的正是"本地全绿、线上全崩"那类错。
 * ------------------------------------------------------------------ */

const apiTs = readdirSync(API_DIR).filter((f) => f.endsWith('.ts'))
const RE_IMPORT = /(?:from\s*|import\s*)(['"])([^'"]+)\1/g

const noExt = [] // 漏扩展名
const noTarget = [] // 目标源文件不存在
const underscored = [] // 目标带下划线 ⇒ Vercel 不编译它

for (const f of apiTs) {
  const src = readFileSync(join(API_DIR, f), 'utf8')
  for (const m of src.matchAll(RE_IMPORT)) {
    const spec = m[2]
    if (!spec.startsWith('.')) continue

    if (!spec.endsWith('.js')) {
      noExt.push(`${f} → ${spec}`)
      continue
    }
    /* './nya.js' ⇒ 源码里应当存在同目录的 nya.ts */
    const targetTs = basename(spec).slice(0, -3) + '.ts'
    if (!existsSync(join(API_DIR, targetTs))) {
      noTarget.push(`${f} → ${spec}（缺 api/${targetTs}）`)
      continue
    }
    /* 带下划线的文件会被 Vercel「忽略」，因而不被编译 ⇒ 线上照样找不到 */
    if (targetTs.startsWith('_')) {
      underscored.push(`${f} → ${spec}`)
    }
  }
}

check(
  '相对导入都带 .js 扩展名（ESM 不猜扩展名）',
  noExt.length === 0,
  noExt.length ? noExt.join('; ') : '全部带 .js',
)
check(
  '被导入的文件在 api/ 里真实存在',
  noTarget.length === 0,
  noTarget.length ? noTarget.join('; ') : `${apiTs.length} 个文件互相引用正常`,
)
check(
  '被导入的文件名不带下划线（带下划线 Vercel 就不编译它）',
  underscored.length === 0,
  underscored.length ? underscored.join('; ') : '没有下划线开头的依赖',
)

/* ------------------------------------------------------------------ *
 * ④ 复刻 Vercel：各自编译成独立 .js（保留 import 原样）
 * ------------------------------------------------------------------ */

/*
 * 清掉上一轮的产物再写。
 *
 * ⚠️ 删除必须容错：某些沙箱环境有「本回合累计删除数」的护栏（删多了会
 *    直接抛异常），而这里删的只是自己上一轮的临时产物 —— 删不掉无所谓，
 *    esbuild 会覆盖同名文件。**不能让它把整个检查脚本带崩。**
 *    （2026-09-15 真被这个绊过一次：脚本抛异常退出，看起来像"检查失败"，
 *      实际上面几条静态规则根本没跑到。）
 */
try {
  rmSync(OUT, { recursive: true, force: true })
} catch {
  /* 忽略：清不掉就用覆盖写 */
}
mkdirSync(OUT, { recursive: true })

let builtOk = true
try {
  await build({
    entryPoints: apiTs.map((f) => join(API_DIR, f)),
    outdir: OUT,
    outbase: API_DIR,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    bundle: false, // ← 关键：保留 import 语句，不内联
    logLevel: 'silent',
  })
} catch (e) {
  builtOk = false
  check('esbuild 编译通过', false, String(e).split('\n')[0])
}
if (builtOk) check('esbuild 编译通过', true, `${apiTs.length} 个文件`)

/* ------------------------------------------------------------------ *
 * ⑤ 用 ESM 真加载入口
 * ------------------------------------------------------------------ */

writeFileSync(join(OUT, 'package.json'), '{"type":"module"}')

const probe = spawnSync(
  process.execPath,
  [
    '-e',
    `import('./chat.js').then(m => {
       if (typeof m.default?.fetch !== 'function') {
         console.log('NO_FETCH'); process.exit(2)
       }
       console.log('LOADED'); process.exit(0)
     }).catch(e => {
       console.log('FAILED:' + e.code + ':' + (e.url || '')); process.exit(1)
     })`,
  ],
  { cwd: OUT, encoding: 'utf8' },
)

const out = (probe.stdout ?? '').trim()
check(
  '在 ESM 环境下能加载入口（模拟 Vercel 的 /var/task）',
  out === 'LOADED',
  out || (probe.stderr ?? '').split('\n')[0],
)
check(
  '入口导出了 default.fetch（Vercel 约定的形状）',
  out !== 'NO_FETCH',
  out === 'NO_FETCH' ? '没有 fetch 方法' : 'ok',
)

/* ------------------------------------------------------------------ *
 * 输出
 * ------------------------------------------------------------------ */

console.log('Nya 服务端部署形态检查（复刻 Vercel 的加载环境）')
console.log('─'.repeat(64))
let failed = 0
for (const r of results) {
  const mark = r.ok ? '✅' : '❌'
  if (!r.ok) failed++
  console.log(`${mark} ${r.name}${r.extra ? `  · ${r.extra}` : ''}`)
}
console.log('─'.repeat(64))
if (failed > 0) {
  console.log(`❌ ${failed} 项没过 —— 现在推上去，线上 /api/chat 大概率是 500`)
  console.log('   规则写在 api/chat.ts 顶部的注释里（那里解释了为什么下划线前缀是错的）。')
  process.exit(1)
}
console.log(`✅ ${results.length}/${results.length} 项通过 —— 这个形状 Vercel 能加载`)
