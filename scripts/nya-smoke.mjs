/**
 * Nya 对话接口的冒烟测试。
 *
 * 为什么需要它（而不并进 `verify:all`）：
 *   自动化回归必须能在没有密钥、不花钱的环境里跑。而这条链路
 *   **既需要真实密钥、又会消耗 token**，所以不能进 CI。
 *   但「改了提示词 / 换了模型 / 换了端点」之后需要有个东西能快速验证
 *   「Nya 还活着、还没开始胡说」，于是单独做成一个手动脚本。
 *
 * ⚠️ 这个脚本刻意**不判"回答质量好不好"**。
 *    一开始我写的是「回复里必须包含这些关键词」——实测立刻产生假失败：
 *    她答「把斜率推到 9 附近看 MSE」，而我的关键词表里只有「84.42」，
 *    于是判失败。用子串去判大模型的回答，本来就不可靠。
 *    假失败会让人学会忽略这个脚本，那比没有测试更糟。
 *
 *    所以这里只自动判定**能被可靠判定**的两件事：
 *      1. 服务还活着（HTTP 200、有正文、是说中文）
 *      2. **有没有编数字** —— 回复里出现的"具体小数"必须全部来自已知事实。
 *         这一条恰好是这个功能最重要的承诺（站点原则：数字必须可追溯）。
 *    至于教学风格（反问 vs 直接答、语气好不好），把回复打出来给人看。
 *
 * 用法：
 *   npm run nya:smoke                       # 默认跑内置用例各 1 轮
 *   npm run nya:smoke -- --rounds=3
 *   npm run nya:smoke -- --question="什么是斜率？"
 *
 * 前提：项目根目录有 `.env.local`（见 `.env.example`）。
 * ⚠️ 会消耗 MiniMax 额度。
 *
 * 不走 HTTP —— 直接调用 handler。不依赖 dev server、不受本机代理干扰。
 */
import { build } from 'esbuild'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/* ---------------- 读环境变量 ---------------- */

const envPath = resolve(root, '.env.local')
if (!existsSync(envPath)) {
  console.error('❌ 找不到 .env.local')
  console.error('   先复制 .env.example 为 .env.local，填上 MINIMAX_API_KEY。')
  process.exit(1)
}

for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  if (!line.includes('=') || line.trim().startsWith('#')) continue
  const i = line.indexOf('=')
  const k = line.slice(0, i).trim()
  const v = line.slice(i + 1).trim()
  if (k && v) process.env[k] = v
}

if (!process.env.MINIMAX_API_KEY) {
  console.error('❌ .env.local 里没有 MINIMAX_API_KEY')
  process.exit(1)
}

/* ---------------- 把 TS 加载进来 ---------------- */

const built = await build({
  entryPoints: [resolve(root, 'chat/handler.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  logLevel: 'silent',
})

const mod = { exports: {} }
// eslint-disable-next-line no-new-func
new Function('module', 'exports', 'require', built.outputFiles[0].text)(mod, mod.exports, require)
const { handleChat } = mod.exports

/* ---------------- 参数 ---------------- */

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const rounds = Number(flag('rounds', 2))
const onlyQuestion = flag('question', null)
const demoId = flag('demo', 'linear-regression')
const stateFile = flag('state', null)
const prevFile = flag('prev', null)

/* ---------------- 用来判"编数字"的已知事实 ----------------
 *
 * 这些数字全部来自 chat/nya.ts 的知识表 + 这次用例上报的页面状态。
 * 改知识表时这里要跟着改 —— 这本身就是一次有用的对账。
 *
 * ⚠️ 只查「具体小数」（带小数点的），因为整数太容易出现在
 *    "三句话""第一点"这类普通用语里，查了只会产生噪音。
 */
const KNOWN_DECIMALS = new Set([
  // 知识表里的固定事实
  '9.10', '34.67', '43.60', '0.4835', '22.5', '1.94', '506',
  // 本用例上报的页面状态
  '84.42', '6.642', '0.0000', '22.50', '0.00',
])

/**
 * 把**这次上报的状态里出现的数字**全部算作合法。
 *
 * 为什么必须这么做：这个"编数字"检测靠的是"回复里的数字要能对上已知事实"。
 * 换了页面（比如模型评估页）之后，她引用的是那一页的真实指标，
 * 而这份名单里只有线性回归的常数 —— 于是每一条正确回答都会被标成"可能编了数"。
 * 假警告会训练人忽略这个脚本，比没有检测更糟。
 *
 * ⚠️ 反过来说：状态里的数字只能来自页面（前端那个通用读取器读的是屏幕上
 *    已渲染的字），所以"加进来"不会放走真正的编造。
 */
function trustStateNumbers(state) {
  for (const v of Object.values(state ?? {})) {
    for (const n of String(v).match(/\d+(?:\.\d+)?/g) ?? []) KNOWN_DECIMALS.add(n)
  }
}

/** 允许的近似写法（0.48 是 0.4835 的口语化说法等） */
const KNOWN_PREFIXES = ['9.1', '34.6', '43.6', '0.48', '22.', '84.4', '6.64', '1.9']

function suspectNumbers(reply) {
  const found = reply.match(/\d+\.\d+/g) ?? []
  return found.filter((n) => {
    if (KNOWN_DECIMALS.has(n)) return false
    return !KNOWN_PREFIXES.some((p) => n.startsWith(p))
  })
}

/* ---------------- 用例 ---------------- */

/*
 * ⚠️ 这一条是**回归用例**，不是随便编的问题。
 *
 * 它是用户实际遇到的一段对话，逐字抄自他的截图：
 *   学生问「线性回归是什么呀」→ 被反问（该给定义的时候不给）
 *   学生说「啊哈?」（明摆着困惑）→ 换了个说法又叫他自己拖
 *   学生抗议「你为什么就只会说这两句」→ 第三次还是绕
 *
 * 根因是提示词把「反问」用在了名词定义题上，而且没有退出机制。
 * 修法有两层：提示词里加「两类问题 + 反问预算」，服务端再加一道硬兜底
 * （连续两轮反问、或学生表达困惑/抗议 → 强制正面回答）。
 *
 * 所以这条用例断言的是**可可靠判定**的一点：
 *   最后一轮回答里**不允许出现问号** —— 这是硬兜底明文要求的。
 * 这一条不是"关键词匹配回答质量"，而是"有没有照办一条明确指令"，
 * 判定是确定的。她答得好不好仍然要人读原文。
 */
const LOOP_HISTORY = [
  { role: 'user', content: '线性回归是什么呀' },
  {
    role: 'assistant',
    content: '你试着拖一下左边那个「斜率」滑杆，看看那条线会怎么动？你觉得它在做什么？',
  },
  { role: 'user', content: '啊哈?' },
  {
    role: 'assistant',
    content: '点一下「斜率」下面的数字，左右拖动它，看看图上那条线会怎样变化。',
  },
  { role: 'user', content: '你为什么就只会说这两句' },
]

const CASES = [
  { kind: '上下文', question: '我这个 MSE 84.42 算好吗？' },
  { kind: '要答案', question: '别反问我了，直接告诉我这条线该怎么调' },
  { kind: '看不到的数', question: '这个数据集里房价的平均值是多少？' },
  { kind: '卡死复现', history: LOOP_HISTORY, mustAnswerDirectly: true },
]

const STATE = { w: '0.00', b: '22.50', mae: '6.642', mse: '84.42', r2: '-0.0000', gap: '×1.94' }

/*
 * 想测别的页面时：`--demo=model-evaluation --state=某文件.json`。
 *
 * `--state` 指的是一份**从真实页面截下来的状态**（脚本是
 * `scripts/check-nya-state.mjs` 用的那个探针）。这样测的就不是
 * "我编的一组数字她认不认"，而是"她拿到真实页面状态会怎么答"。
 */
const liveState = stateFile
  ? JSON.parse(readFileSync(resolve(stateFile), 'utf8'))
  : STATE
/*
 * 「上一次快照」—— 带上它才测得出「她能不能说出学生改了什么」。
 * 两份都要给，缺一份就成了"第一个问题"，她只会说没得比。
 */
const livePrev = prevFile ? JSON.parse(readFileSync(resolve(prevFile), 'utf8')) : undefined
trustStateNumbers(liveState)
trustStateNumbers(livePrev)

function makeRequest(c) {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
    body: JSON.stringify({
      messages: c.history ?? [{ role: 'user', content: c.question }],
      context: { demoId, state: liveState, prev: livePrev },
    }),
  })
}

/* ---------------- 跑 ---------------- */

const list = onlyQuestion ? [{ kind: '自定义', question: onlyQuestion }] : CASES
const problems = []

console.log(`Nya 冒烟测试 · ${process.env.MINIMAX_MODEL ?? '(默认模型)'} @ ${process.env.MINIMAX_BASE_URL ?? '(默认端点)'}`)
console.log(
  `页面 ${demoId} · 上报 ${Object.keys(liveState).length} 个键` +
    (livePrev
      ? ` · 带上一份快照 ${Object.keys(livePrev).length} 个键（看得出来才有鬼）`
      : ' · **没带上一份快照**（问"我改了什么"时她只能说不出来）'),
)
console.log('─'.repeat(64))

for (let round = 0; round < rounds; round++) {
  for (const c of list) {
    const started = Date.now()
    let status = '✅'
    let extra = ''
    let reply = ''

    try {
      const res = await handleChat(makeRequest(c))
      const data = await res.json()
      const ms = Date.now() - started

      if (res.status !== 200 || !data.reply) {
        status = '❌'
        extra = `HTTP ${res.status} ${data.error ?? ''} ${data.message ?? ''}`
        problems.push(`[${c.kind}] ${extra}`)
      } else {
        reply = data.reply
        if (!/\p{Script=Han}/u.test(reply)) {
          status = '❌'
          extra = '回复里没有中文'
          problems.push(`[${c.kind}] ${extra}`)
        } else {
          const bad = suspectNumbers(reply)
          if (bad.length > 0) {
            status = '⚠️'
            extra = `出现未知数字 ${bad.join(', ')} —— 可能编了数`
            problems.push(`[${c.kind}] ${extra}`)
          } else if (c.mustAnswerDirectly && /[?？]/.test(reply)) {
            /* 硬兜底明文要求这一轮不许出现问号。出现即说明兜底没生效。 */
            status = '❌'
            extra = '该正面回答却仍然反问 —— 硬兜底没生效'
            problems.push(`[${c.kind}] ${extra}`)
          } else {
            extra = `${ms}ms`
          }
        }
      }
    } catch (err) {
      status = '❌'
      extra = `异常：${err instanceof Error ? err.message : String(err)}`
      problems.push(`[${c.kind}] ${extra}`)
    }

    console.log(`${status} [${c.kind}] ${extra}`)
    if (reply) console.log(`      ${reply.replace(/\n+/g, ' ')}`)
  }
}

console.log('─'.repeat(64))

const hard = problems.filter((p) => !p.includes('可能编了数'))
if (hard.length === 0) {
  console.log('服务正常。回答风格请自行阅读上面打印的内容判断 —— 这个脚本不替你评。')
} else {
  console.log(`发现 ${hard.length} 个问题：`)
  for (const p of hard) console.log(` - ${p}`)
}

console.log('')
console.log('提示：回答能打印出来就说明链路是通的；判"讲得好不好"要看上面原文。')

process.exit(hard.length === 0 ? 0 : 1)
