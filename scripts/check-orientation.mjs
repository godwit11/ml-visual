/**
 * 核对「`api/nya.ts` 里 charts[].title」和「页面上真实印着的标题」有没有对上。
 *
 * ------------------------------------------------------------------ *
 * 为什么需要这个脚本（2026-09-18 用户报的 bug）
 * ------------------------------------------------------------------ *
 * `charts[].title` 原本写的是**方位**：「页面上方那张大图」「下方左边那张小图」
 * 「下方右边那张小图」。写这些字的时候看的是**桌面布局**。
 *
 * 而 `.chart-row` 在 `@media (max-width: 768px)` 下变成 `1fr` ——
 * 两张小图从"左右并排"变成"上下一叠"。于是手机端：
 *   学生问「左下角的图」 → 她按桌面方位答「下方左边那张」 → 两边对不上。
 * 学生看到的是"她识图有问题"，实际是**方位词过期**。
 *
 * ⚠️ 这类 bug 的两个特点，决定了这条检查必须这么写：
 *   ① **只在窄屏暴露** —— 桌面端跑任何 e2e 都是绿的
 *   ② **是"文案和布局"的契约** —— 静态 grep 抓得住（方位词本身就是证据）
 *
 * ------------------------------------------------------------------ *
 * 改成什么了（2026-09-20）
 * ------------------------------------------------------------------ *
 * 锚点从**方位**换成**页面上印着的标题原文**。判定规则因此变成两条：
 *   A. `api/nya.ts` 里**不许再出现方位指代**（那类说法天生依赖布局）
 *   B. 每个 title 必须能在**对应页面的 `.panel-title` 里逐字找到**
 *      —— 学生才能拿它去屏幕上核对
 *
 * ⚠️ 例外：有两类图**页面上根本没有 `.panel-title`**：
 *   ① `#chart-dist`（模型评估页的大图）—— 直接挂在 `.panel[data-tabs]` 里，
 *      只有一行说明文字写着「两类样本的分数分布」，没标题可锚
 *   ② `#chart-cv`（交叉验证那张）—— 同理，只有上面那行小字
 *   ③ `#tree-host`（决策树的树结构）—— 手绘 canvas，标题栏在 `.panel-title` 里
 *      **是真的写着「树结构」**，但它不是 `.chart` 容器，探针读不到 ⇒ 核不了
 *   这类图允许在 charts 条目里补一个 `anchor:` 字段，用**人能照着找**的
 *   说法描述它在哪，检查时**跳过 title 核对**、只把 anchor 打出来给人看
 *   （写了 anchor 不等于放过 —— 它的文字仍然要经得起规则 A 的方位词扫描）。
 *
 * ⚠️🔴 **anchor 必须白名单式放行，不能"写了就免检"**（反证过）：
 *    第一版写成 `hasAnchor ⇒ 跳过核对`，结果**随便编一个 title 再配个 `anchor: '随便'`
 *    就能全绿** —— 这条检查当场变成一个摆设。
 *    ⇒ 现在 `anchor` 值必须出现在下面的 `ALLOWED_ANCHORS` 里才生效；
 *      白名单外的 `anchor` 一律当**违规**报错（"你以为加了 anchor 就不用核对？
 *      先把这张图加进白名单，说明它为什么没有标题"）。
 *    ⇒ 加白名单这个动作本身要人过一遍脑子，这就是它该有的摩擦力。
 *
 * 用法：node scripts/check-orientation.mjs
 */

/**
 * 允许"没有标题、只能用 anchor 描述"的图 —— **必须逐条列出**。
 *
 * 键是 `${demoId}::${title}`（title 用来认条目，不是用来核对的）。
 * 加一条前先问：**这张图页面上真的没有 `.panel-title` 吗？**
 * 有的话就别加，改成把 title 写成那个标题原文 —— 那才是我们要的锚点。
 */
const ALLOWED_ANCHORS = new Set([
  'model-evaluation::分数分布',                    // #chart-dist，挂在 data-tabs 容器里，无标题
  'model-evaluation::交叉验证：每一折的准确率',     // #chart-cv，同上
  'model-evaluation::判对了多少，判错了哪种',       // 混淆矩阵，不是 canvas
  'model-evaluation::每一折长什么样',              // 横条列表，不是 canvas
  'decision-tree::树结构',                        // 手绘 canvas，不是 .chart 容器
])

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 4177
const BASE = `http://127.0.0.1:${PORT}`

/**
 * 提示词里的标题和页面上印的，怎样算"对上了"。
 *
 * 三种写法都接受（都让学生能在屏幕上核对到）：
 *   ① **完全一致** —— 「S 形映射：z → 概率」
 *   ② 提示词写的是**页面上标题的前缀** ——
 *      页面上是「每个样本的 α（对偶变量）」，提示词写「每个样本的 α」：
 *      学生照样一眼认出来，而**前缀比全称更稳**（括号里的补充说明可能改）。
 *   ③ 提示词用 `A / B` 表示**同一张图在不同状态下的标题** ——
 *      集成学习那页的面板标题会跟着算法变
 *      （「决策边界：Bagging（投票）」／「决策边界：AdaBoost（加权投票）」），
 *      写死任何一个都会在另一半情况下对不上。
 *      ⇒ 只要**任意一个分支**能对上页面就算过。
 */
function titleMatches(promptTitle, panelTitles) {
  const branches = promptTitle.split('/').map((s) => s.trim()).filter(Boolean)
  return branches.some((b) => panelTitles.some((p) => p === b || p.startsWith(b)))
}

/**
 * 扣出 `charts:[...]` 里每一条的 `title`、`anchor` 原文。
 *
 * ⚠️ 为什么要按**条目**切，而不是整块 `matchAll(/title:/)`：
 *    必须知道**哪一条**写了 anchor、anchor 写的是什么 —— 整块扫就分不清了。
 *
 * 做法：按 `{` ... `}` 把 charts 数组切成条目。这些条目里**没有嵌套对象**
 * （title / what / anchor 都是平铺的字符串字段），所以最简单的花括号配平就够。
 *
 * ⚠️ anchor 用 `([^']*)` 抠**原文**，别只判定"有没有"：
 *    白名单要拿 `demoId::title` 去比对，得先知道这条的 title 是什么。
 */
function parseChartEntries(block) {
  const inner = block.match(/charts:\s*\[([\s\S]*?)\n {4}\]/)
  if (!inner) return []
  const entries = []
  const re = /\{([^{}]*)\}/g
  let m
  while ((m = re.exec(inner[1]))) {
    const body = m[1]
    const t = body.match(/title:\s*'([^']*)'/)
    if (!t) continue
    const a = body.match(/\banchor:\s*'([^']*)'/)
    entries.push({ title: t[1], anchor: a ? a[1] : null })
  }
  return entries
}

/**
 * 会随布局变化的方位指代。
 *
 * ⚠️ 为什么把这些**全部**禁掉，而不是"只禁真的会错的那个"：
 *    哪天有人把 `.chart-row` 挪个位置、或者加一页三列布局，
 *    "上方/下方/左边/右边"里任何一个都可能突然失效 —— 而**没有一个测试会变红**。
 *    禁掉之后，新写的描述必须改用标题原文，那个锚点是**结构无关**的。
 *
 * ⚠️ 只匹配"方位词 + 那张/大图/小图"这种**成形的指代**。
 *    讲数学时单纯说「这条线在点的上方」不算 —— 那不是在指认哪张图。
 *    宁可窄一点：漏判不产生假失败，误判会让人学会忽略这条检查。
 */
const ORIENTATION = /(页面上方那张|下方左边那张|下方右边那张|页面下方那个|上方那张大图|下方那张小图)/

/* ------------------------------------------------------------------ *
 * ① 抠出每个 demo 的 charts[].title，并扫方位词
 * ------------------------------------------------------------------ */

function readCharts() {
  const src = readFileSync(join(ROOT, 'api', 'nya.ts'), 'utf8')
  const out = new Map()

  const idRe = /id:\s*'([a-z0-9-]+)'/g
  const ids = []
  let m
  while ((m = idRe.exec(src))) ids.push({ id: m[1], at: m.index })

  for (let i = 0; i < ids.length; i++) {
    const block = src.slice(ids[i].at, i + 1 < ids.length ? ids[i + 1].at : src.length)
    const entries = parseChartEntries(block)
    if (!entries.length) continue
    out.set(ids[i].id, entries)
  }

  /*
   * 只扫**字符串字面量**里的方位指代，不扫注释。
   *
   * ⚠️ 为什么必须区别对待（第一版就栽在这）：修完之后 `nya.ts` 里**仍然**
   *    留着「页面上方那张大图」这些字 —— 在解释"为什么不能这么写"的注释里。
   *    连注释一起扫 ⇒ 这条检查**永远红着**，然后人就会学会忽略它。
   *    （同一类错误：把"文档"和"数据"混在一个正则里。）
   *
   * 做法：先剥掉块注释和行注释，再在剩下的代码里找。
   */
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  const hits = [...code.matchAll(new RegExp(`^.*${ORIENTATION.source}.*$`, 'gm'))]
  return { charts: out, orientationHits: hits.map((h) => h[0].trim()) }
}

/* ------------------------------------------------------------------ *
 * ② 跑浏览器，读页面上真实印着的 .panel-title
 * ------------------------------------------------------------------ */

function runProbe(demoId) {
  const url = demoId === 'home' ? `${BASE}/` : `${BASE}/demos/${demoId}/`
  return new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      [
        join(ROOT, 'scripts', 'e2e.mjs'),
        '--url',
        url,
        '--script',
        join(ROOT, 'scripts', 'tests', 'probe-chart-titles.js'),
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
 * ③ 比对
 * ------------------------------------------------------------------ */

const { charts, orientationHits } = readCharts()
if (charts.size === 0) {
  console.error('❌ 一个 demo 的 charts 都没解析出来 —— api/nya.ts 的格式变了吗？')
  process.exit(1)
}

console.log(`api/nya.ts 里 ${charts.size} 页有图表清单\n`)

let failed = 0

/* --- 规则 A：不许再有方位指代 --- */
if (orientationHits.length) {
  console.log(`❌ 提示词里还有 ${orientationHits.length} 处方位指代（它们在窄屏会失效）：`)
  for (const h of orientationHits) console.log(`     ${h.slice(0, 100)}`)
  console.log('   ⇒ 改成页面上印着的**标题原文**\n')
  failed++
} else {
  console.log('✅ 提示词里没有任何依赖布局的方位指代\n')
}

/* --- 规则 B：每个 title 都要能在页面的 .panel-title 里逐字找到 --- */
const server = spawn(
  process.execPath,
  [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(PORT), '--host', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore' },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(2500)

try {
  for (const [demoId, entries] of charts) {
    const res = await runProbe(demoId)
    if (res.error) {
      console.log(`❌ ${demoId}: ${res.error}`)
      failed++
      continue
    }
    const panelTitles = res['面板标题'] ?? []

    /*
     * 只有**白名单里点名**的条目才能用 anchor 免掉逐字核对。
     * 白名单外的 anchor ⇒ 直接判违规（见文件头"anchor 必须白名单式放行"那段）。
     */
    const anchored = entries.filter((e) => e.anchor)
    const rogue = anchored.filter((e) => !ALLOWED_ANCHORS.has(`${demoId}::${e.title}`))
    const checkable = entries.filter((e) => !e.anchor)
    const missing = checkable.filter((e) => !titleMatches(e.title, panelTitles))

    if (rogue.length) {
      console.log(`❌ ${demoId.padEnd(20)} 有 ${rogue.length} 条写了 anchor，但不在白名单里：`)
      for (const e of rogue) console.log(`     「${e.title}」→ anchor: ${e.anchor}`)
      console.log('     ⇒ 页面上有标题的话，把 title 改成标题原文；')
      console.log('       确实没标题，才去 check-orientation.mjs 的 ALLOWED_ANCHORS 里加一行')
      failed++
      continue
    }

    if (missing.length === 0) {
      const extra = anchored.length ? `（另有 ${anchored.length} 张没标题、用 anchor 描述）` : ''
      console.log(`✅ ${demoId.padEnd(20)} ${checkable.length} 个标题都在页面上找得到${extra}`)
    } else {
      /* 提示词里的名字和屏幕上的字不一致 ⇒ 她照抄的名字学生核对不上 */
      console.log(`❌ ${demoId.padEnd(20)} 有 ${missing.length} 个标题在页面上找不到：`)
      for (const t of missing) console.log(`     提示词写的是「${t.title}」`)
      console.log(`     页面上印的是：${panelTitles.map((p) => `「${p}」`).join('、')}`)
      failed++
    }
  }
} finally {
  server.kill('SIGKILL')
}

console.log('')
if (failed > 0) {
  console.log(`❌ ${failed} 项没通过 —— 见上面每一条的说明`)
  process.exit(1)
}
console.log('✅ 图表清单的锚点全部与页面一致（且不含方位指代）')
