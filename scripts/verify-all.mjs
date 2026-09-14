/**
 * 一条命令跑完整回归。
 *
 * 为什么需要它：
 *   站点的质量靠三层保证 —— 类型检查 + 单元测试、页面端 e2e 断言、
 *   与 sklearn 的算法对拍。平时改一处样式或算法，要手动敲二十几条
 *   `npm run xxx`，很容易漏跑其中一层（我漏过）。
 *   这里按「快 → 慢」的顺序串起来，任何一步失败都明确标出来。
 *
 * 用法：
 *   node scripts/verify-all.mjs                # 全跑
 *   node scripts/verify-all.mjs --fast         # 只跑类型检查 + 单测 + 全部 e2e（跳过对拍）
 *   node scripts/verify-all.mjs --only=e2e     # 只跑某一层（e2e / crosscheck / unit）
 *   node scripts/verify-all.mjs --list         # 只列出会跑什么，不执行
 *
 * 退出码：全部通过 0，有任何一步失败 1。
 *
 * ⚠️ e2e 步骤会各自起一个 vite preview（端口 4173）并在结束时关掉，
 *    **必须串行**跑，否则会撞端口。对拍步骤是纯 Node/Python 计算，但同样串行，
 *    避免多个 Python 进程抢 CPU 让结果看起来忽快忽慢。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const cwd = resolve(root, '..')

/* 直接调 npm 的 js 入口，不走 shell：Windows 上 `spawn('npm')` 会找不到命令 */
const NPM_CLI = resolve(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
const useNpmCli = existsSync(NPM_CLI)

function runNpm(scriptName) {
  return new Promise((done) => {
    const [cmd, args] = useNpmCli
      ? [process.execPath, [NPM_CLI, 'run', scriptName]]
      : [process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', scriptName]]
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('close', (code) => done({ code: code ?? 1, out }))
  })
}

/* ---------------- 步骤定义 ---------------- */

/*
 * 名字 → npm 脚本。
 * 顺序是有意的：先便宜后昂贵，先在本地能定位的问题、再跑重活。
 */
const UNIT = [['类型检查', 'typecheck'], ['渲染器单元测试', 'unit:renderer']]

const E2E = [
  ['首页', 'e2e:home'],
  /*
   * 链接可达性单独两步。
   * 演示页那步刻意选中间的 PCA：它 prev/next 两条都有，能把
   * 「文档相对路径从嵌套页面解析会多套一层」这类 bug 完整覆盖到。
   * 这类 bug 在首页永远测不出来（同一个 href 在 `/` 下是对的）。
   */
  ['链接可达性 · 首页', 'e2e:links:home'],
  ['链接可达性 · 演示页', 'e2e:links:demo'],
  ['线性回归', 'e2e:lr'],
  ['Logistic 回归', 'e2e:logistic'],
  ['模型评估', 'e2e:eval'],
  ['SVM', 'e2e:svm'],
  ['朴素贝叶斯', 'e2e:nb'],
  ['集成学习', 'e2e:ens'],
  ['聚类', 'e2e:km'],
  ['PCA', 'e2e:pca'],
  ['决策树', 'e2e:tree'],
  ['神经网络', 'e2e:nn'],
]

const CROSSCHECK = [
  ['十套对拍 · 线性回归', 'crosscheck'],
  ['十套对拍 · Logistic', 'crosscheck:logistic'],
  ['十套对拍 · 模型评估', 'crosscheck:eval'],
  ['十套对拍 · SVM', 'crosscheck:svm'],
  ['十套对拍 · 朴素贝叶斯', 'crosscheck:nb'],
  ['十套对拍 · 集成学习', 'crosscheck:ens'],
  ['十套对拍 · 聚类', 'crosscheck:km'],
  ['十套对拍 · PCA', 'crosscheck:pca'],
  ['十套对拍 · 决策树', 'crosscheck:tree'],
  ['十套对拍 · 神经网络', 'crosscheck:nn'],
]

/*
 * 附加检查：不参与「首页断言数」的统计。
 *
 * 为什么不并入 E2E 列表：末尾那个交叉校验会把 E2E 步骤的断言数加起来，
 * 和 `src/data/siteStats.json` 里首页展示的数字比对。这些探针是**独立**的
 * 自查工具（每个 8 项），并入会把总数算错。
 *
 * 它们各自都抓到过真 bug：
 *   · check:heads     —— clustering 页少 9 个 head 标签（canonical/favicon/og:）
 *   · e2e:quality     —— 桌面端资源加载、横向溢出、渲染空白
 *   · e2e:quality:mobile —— 所有演示页在 466px 视口下横向溢出 49px
 */
const EXTRA = [
  ['head 标签一致性', 'check:heads'],
  ['页面质检 · 桌面', 'e2e:quality'],
  ['页面质检 · 移动', 'e2e:quality:mobile'],
  /*
   * Nya 助教面板。
   * 它用的是假后端（替换掉 window.fetch），不真的调用模型 ——
   * 所以这个脚本**不消耗额度、结果确定**，可以放心进全量回归。
   * 真模型的回答质量另有一条 `npm run nya:smoke`（需密钥，刻意不进这里）。
   */
  ['Nya 助教面板 · 桌面', 'e2e:nya'],
  ['Nya 助教面板 · 移动', 'e2e:nya:mobile'],
  /*
   * Nya 能不能看见「当前这一页」。
   *
   * 为什么必须有这条：状态键白名单写错一个字**不会报错**，
   * 只会安静地少一个数字 —— 页面照常、测试全绿，只有学生问起来才发现
   * 她在说"我看不到"。用户第一版就是这么翻车的（他在模型评估页问表格，
   * Nya 让他去线性回归那一页）。
   * 这个脚本会打开全部 10 页、真的发一次请求（fetch 被换掉，不花钱），
   * 然后拿页面实际报的键和白名单对账。
   */
  ['Nya 页面状态对账', 'check:nya-state'],
  /*
   * 服务端链路（不起浏览器、不花钱、结果确定）。
   * 它盯的是「请求 → handleChat → 提示词」这一整条 —— 2026-09-14
   * `prev` 字段被 normalizeContext 静默丢掉，就是这条链路中间的坑，
   * 前端断言和提示词断言**都拦不住它**。
   */
  ['Nya 服务端链路', 'check:server'],
]

/* ---------------- 参数 ---------------- */

const argv = process.argv.slice(2)
const fast = argv.includes('--fast')
const onlyArg = argv.find((a) => a.startsWith('--only='))
const only = onlyArg ? onlyArg.split('=')[1] : null

let steps = []
if (!only || only === 'unit') steps.push(...UNIT)
if (!only || only === 'extra') steps.push(...EXTRA)
if (!only || only === 'e2e') steps.push(...E2E)
if ((!only || only === 'crosscheck') && !fast) steps.push(...CROSSCHECK)

if (argv.includes('--list')) {
  console.log('会按顺序执行：')
  steps.forEach(([label, s], i) => console.log(`  ${String(i + 1).padStart(2)}. ${label.padEnd(24)} npm run ${s}`))
  process.exit(0)
}

/* ---------------- 执行 ---------------- */

const t0 = Date.now()
const results = []

console.log(`\n共 ${steps.length} 步，顺序执行。任何一步失败不会中断，最后统一汇总。\n`)

for (let i = 0; i < steps.length; i++) {
  const [label, script] = steps[i]
  const prefix = `[${String(i + 1).padStart(2)}/${steps.length}] ${label}`
  process.stdout.write(`${prefix} … `)
  const t = Date.now()
  const { code, out } = await runNpm(script)
  const secs = ((Date.now() - t) / 1000).toFixed(1)
  const ok = code === 0

  /*
   * 尽力从输出里抠出一个「N/N」形式的计数，让汇总表能看出断言规模，
   * 也让末尾的「首页断言数交叉校验」有数据可用。
   * e2e 驱动目前有两种输出格式，都要认：
   *   · `{ passed: N, total: N }`（多数页面，脚本自己用 check() 汇总）
   *   · 一串 `{ pass: true/false }`（早期几页逐条返回）
   */
  let count = ''
  const m1 = out.match(/"passed":\s*(\d+)[\s\S]*?"total":\s*(\d+)/)
  if (m1) {
    count = `${m1[1]}/${m1[2]}`
  } else {
    const t = (out.match(/"pass":\s*true/g) || []).length
    const f = (out.match(/"pass":\s*false/g) || []).length
    if (t + f > 0) count = `${t}/${t + f}`
    else if (/对拍通过/.test(out)) count = '通过'
  }

  console.log(ok ? `✅ ${secs}s${count ? ` (${count})` : ''}` : `❌ ${secs}s`)
  results.push({ label, script, ok, secs: Number(secs), count, out })
}

/* ---------------- 汇总 ---------------- */

const failed = results.filter((r) => !r.ok)
const totalSecs = ((Date.now() - t0) / 1000).toFixed(1)

/*
 * 交叉校验首页上的断言总数。
 *
 * 首页 hero 会显示「N 项页面断言全绿」，N 来自 src/data/siteStats.json。
 * 写死的数字迟早会和事实脱节（有人加了断言、没人改这个常量），
 * 所以在这里把实际跑出来的断言数加起来对一遍 —— 对不上就判失败。
 * 这样「页面上的每个数字都能追溯」这条约定就有了机器保证，而不只是靠自觉。
 *
 * 只在 e2e 那一步真的跑了的情况下才有意义（--only=unit / --fast 下会跳过）。
 */
const ranE2E = steps.some(([, s]) => E2E.some(([, es]) => es === s))
let assertionCheck = null
if (ranE2E) {
  const actual = results
    .filter((r) => E2E.some(([, es]) => es === r.script))
    .reduce((sum, r) => {
      const m = /^(\d+)\/(\d+)$/.exec(r.count || '')
      return sum + (m ? Number(m[2]) : 0)
    }, 0)

  let declared = null
  const statsPath = resolve(cwd, 'src', 'data', 'siteStats.json')
  try {
    declared = JSON.parse(readFileSync(statsPath, 'utf-8')).pageAssertions
  } catch {
    /* 读不到就当没声明，下面报出来 */
  }

  assertionCheck = { actual, declared, ok: actual > 0 && actual === declared }
}

console.log('\n' + '─'.repeat(58))
console.log('结果汇总')
console.log('─'.repeat(58))
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'} ${r.label.padEnd(24)} ${String(r.secs + 's').padStart(7)}  ${r.count}`)
}
console.log('─'.repeat(58))
console.log(`  ${results.length - failed.length}/${results.length} 步通过，耗时 ${totalSecs}s`)

if (assertionCheck) {
  const { actual, declared, ok } = assertionCheck
  console.log(
    ok
      ? `  ✅ 首页断言数与实际一致：${actual}`
      : `  ❌ 首页断言数不一致：实际 ${actual}，src/data/siteStats.json 里写的是 ${declared}`,
  )
}

if (failed.length || (assertionCheck && !assertionCheck.ok)) {
  if (assertionCheck && !assertionCheck.ok) {
    console.log('\n首页 hero 显示的断言数已经和事实脱节。')
    console.log('把 src/data/siteStats.json 的 pageAssertions 改成实际值即可。')
  }
  if (failed.length) {
    console.log('\n失败步骤的输出尾部：')
    for (const f of failed) {
      console.log(`\n───── ${f.label} (npm run ${f.script}) ─────`)
      console.log(f.out.trim().split('\n').slice(-25).join('\n'))
    }
  }
  process.exit(1)
}

console.log('\n全部通过。\n')
