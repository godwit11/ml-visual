/**
 * 「报告问题」服务端链路的检查（不起浏览器、不花钱、结果确定）。
 *
 * ------------------------------------------------------------------ *
 * 为什么要有它
 * ------------------------------------------------------------------ *
 * 这条链路和 Nya 那条性质不同，它多了几件**只在服务端才做得对**的事：
 *
 *   ① 用户输入会进**邮件头**（类型 → 主题）⇒ 必须防 header injection。
 *      "过滤掉换行"很容易漏，所以这里用白名单 —— 这个脚本就盯着它。
 *   ② 防滥用的四层（蜜罐 / 耗时 / 来源 / 限流）**全在服务端判断**，
 *      前端只是"采集并上报"。前端测试再全，也验不到这里。
 *   ③ 发信失败时**报告不能丢** ⇒ 必须落进日志。这条只有在这里能验。
 *
 * ------------------------------------------------------------------ *
 * 手法：把对 Resend 的 fetch 拦掉
 *   · 不发真邮件（不花钱、不打扰）
 *   · 但能看到**完整的请求体** —— 邮件长什么样、主题是什么、reply_to 有没有
 *   · 还能随时改上游的行为（成功 / 报错 / 超时）来验错误分支
 *
 * 用法：node scripts/check-report-path.mjs
 */

import { build } from 'esbuild'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/* 没密钥会直接 503（在打上游之前），所以给个假值。
   注意：这里**不会**真的发出网络请求 —— fetch 被下面换掉了。 */
process.env.RESEND_API_KEY ||= 'test-key-not-real'
process.env.REPORT_TO ||= 'owner@example.com'
process.env.REPORT_FROM ||= 'onboarding@resend.dev'
process.env.NYA_ALLOWED_ORIGINS ||= 'http://localhost:5173'

/* 从**入口文件**编译，而不是直接从 report-handler ——
   这样连「入口能不能加载、形状对不对」一起验了。 */
const built = await build({
  entryPoints: [resolve(root, 'api/report.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  logLevel: 'silent',
})
const mod = { exports: {} }
new Function('module', 'exports', 'require', built.outputFiles[0].text)(mod, mod.exports, require)
const entry = mod.exports.default

const results = []
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra })

/* ------------------------------------------------------------------ *
 * 上游桩
 * ------------------------------------------------------------------ */

let sentMail = null
let upstreamMode = 'ok'
/** 服务端 console.error 收集起来 —— 用来验"报告落进日志了" */
let logs = []
const realError = console.error
console.error = (...args) => {
  logs.push(args.map((a) => String(a)).join(' '))
}

globalThis.fetch = async (url, init) => {
  if (!String(url).includes('api.resend.com')) throw new Error(`不该请求别处：${url}`)
  sentMail = JSON.parse(init.body)
  if (upstreamMode === 'error') {
    return new Response('{"message":"Invalid API key"}', { status: 401 })
  }
  return new Response(JSON.stringify({ id: 'stub' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

/* ------------------------------------------------------------------ *
 * 提交helper
 * ------------------------------------------------------------------ */

const BASE = {
  kind: '数字不对',
  text: '把阈值拖到 0.79 以后，准确率反而变低了。',
  email: '',
  context: [
    { group: '页面状态', key: '判定阈值', value: '0.79' },
    { group: '页面状态', key: '准确率', value: '64.3%' },
    { group: '环境', key: '页面', value: '/demos/model-evaluation/' },
    { group: '环境', key: '视口', value: '1440×900 @ 2x' },
  ],
  errors: ['TypeError: Cannot read properties of null (reading map)'],
  trap: '',
  elapsedMs: 5000,
}

/*
 * ⚠️ 每次提交默认换一个 IP。
 *    限流是按 IP 计数的（3 次/分钟），如果所有用例都从同一个 IP 发，
 *    跑到一半就会被自己的限流拦住 —— 后面的断言会以 429 收场，
 *    看起来像"功能坏了"，其实是测试自己踩的。限流本身单独测（最后一节）。
 */
let ipSeq = 0

const submit = async (patch = {}, opts = {}) => {
  sentMail = null
  logs = []
  upstreamMode = opts.upstreamMode ?? 'ok'
  const ip = opts.ip ?? `198.51.100.${++ipSeq}`
  const res = await entry.fetch(
    new Request('http://localhost/api/report', {
      method: opts.method ?? 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: opts.origin ?? 'http://localhost:5173',
        ...(opts.noIp ? {} : { 'x-forwarded-for': ip }),
      },
      body: opts.method === 'GET' ? undefined : JSON.stringify({ ...BASE, ...patch }),
    }),
  )
  return { status: res.status, body: await res.json(), mail: sentMail, logs: [...logs] }
}

/* ---------- ① 正常一封 ---------- */

const ok = await submit({ email: 'student@example.com' })

check('正常报告发得出去', ok.status === 200 && ok.body.ok === true, `${ok.status} ${JSON.stringify(ok.body)}`)
check('收件人来自 REPORT_TO', ok.mail?.to?.length === 1 && ok.mail.to[0] === 'owner@example.com', ok.mail?.to)
check(
  '主题里带上类型和页面（一眼能看出是哪一页的问题）',
  /数字不对/.test(ok.mail?.subject ?? '') && /model-evaluation/.test(ok.mail?.subject ?? ''),
  ok.mail?.subject,
)
check('正文里有他写的那句话', ok.mail?.text?.includes('准确率反而变低了'), '')
check(
  '正文里有页面状态（这是"可复现"的关键）',
  ok.mail?.text?.includes('判定阈值：0.79') && ok.mail?.text?.includes('准确率：64.3%'),
  '',
)
check('正文里有控制台报错', ok.mail?.text?.includes('Cannot read properties of null'), '')
check(
  '留了邮箱 ⇒ 设了 reply_to（你点回复就能回给他）',
  ok.mail?.reply_to === 'student@example.com',
  ok.mail?.reply_to,
)

/* ---------- ② 没留邮箱时不设 reply_to ---------- */

const noMail = await submit({ email: '' })
check('没留邮箱 ⇒ 不设 reply_to', noMail.mail?.reply_to === undefined, noMail.mail?.reply_to)
check('没留邮箱 ⇒ 正文里说清楚（免得你以为漏了）', noMail.mail?.text?.includes('他没留'), '')

/* ---------- ③ 非法邮箱：当作没填，不能进 header ---------- */

for (const bad of ['不是邮箱', 'a@b', 'x@y.c\nBcc: evil@example.com']) {
  const r = await submit({ email: bad })
  check(
    `非法邮箱被丢掉（${JSON.stringify(bad)}）`,
    r.status === 200 && r.mail?.reply_to === undefined,
    r.mail?.reply_to,
  )
}

/* ---------- ④ 🔴 邮件头注入 ---------- */

const inject = await submit({
  kind: '数字不对\r\nBcc: attacker@example.com\r\nSubject: 假的',
})
check(
  '白名单外的类型被归为「其他」，不会原样进主题',
  inject.mail?.subject?.startsWith('[ML 演示站] 其他') === true,
  inject.mail?.subject,
)
check(
  '主题里绝不出现换行（header injection 的入口）',
  !/[\r\n]/.test(inject.mail?.subject ?? 'x'),
  JSON.stringify(inject.mail?.subject),
)

/* ---------- ⑤ 现场信息的归一化 ---------- */

const messy = await submit({
  context: [
    { group: '页面状态', key: 'A'.repeat(200), value: 'B'.repeat(500) },
    { group: '页面状态', key: '', value: '没有键名' },
    '这不是对象',
    { group: '页面状态', key: '正常键', value: '正常值' },
  ],
})
check('超长的键和值被截断', (messy.mail?.text?.match(/B+/)?.[0]?.length ?? 0) <= 200, '')
check('缺键名 / 不是对象的项被丢掉', messy.mail?.text?.includes('正常键：正常值'), '')
check(
  '整封信里没有裸换行以外的异常控制字符',
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(messy.mail?.text ?? ''),
  '',
)

/* ---------- ⑥ 防滥用四层 ---------- */

const honey = await submit({ trap: '机器人填的东西' })
check('蜜罐命中 ⇒ 假装成功但什么都没发', honey.status === 200 && honey.body.ok === true && honey.mail === null, JSON.stringify(honey.body))

const tooFast = await submit({ elapsedMs: 300 })
check('提交过快 ⇒ 丢弃（同样不告诉对方）', tooFast.status === 200 && tooFast.mail === null)

const badOrigin = await submit({}, { origin: 'https://someone-else.example' })
check('来源不在白名单 ⇒ 403', badOrigin.status === 403, `${badOrigin.status}`)

/* 限流放到最后：它会消耗这个 IP 的配额 */
const ips = []
for (let i = 0; i < 5; i++) {
  const r = await submit({}, { ip: '203.0.113.9' })
  ips.push(r.status)
}
check(
  '同一 IP 连刷 ⇒ 429（前 3 次放过，第 4 次开始拦）',
  ips.slice(0, 3).every((s) => s === 200) && ips.slice(3).every((s) => s === 429),
  ips.join(','),
)
const otherIp = await submit({}, { ip: '203.0.113.10' })
check('限流是按 IP 分开的（别人还能报）', otherIp.status === 200, `${otherIp.status}`)

/* ---------- ⑦ 校验 ---------- */

const tooShort = await submit({ text: '嗯' })
check('描述太短 ⇒ 400，不发信', tooShort.status === 400 && tooShort.mail === null, `${tooShort.status}`)

const getRes = await submit({}, { method: 'GET' })
check('GET ⇒ 405', getRes.status === 405, `${getRes.status}`)

/* ---------- ⑧ 🔴 发不出去时，报告不能丢 ---------- */

upstreamMode = 'error'
const fail = await submit({ text: '这一条要确保它进了日志，不会白报。' }, { upstreamMode: 'error' })
check('上游报错 ⇒ 502（如实告诉用户没发出去）', fail.status === 502, `${fail.status}`)
check(
  '上游报错时，报告全文仍然落在服务端日志里',
  fail.logs.some((l) => l.includes('这一条要确保它进了日志')),
  fail.logs.length ? `${fail.logs.length} 条日志` : '日志里没有',
)

/* 没配密钥 */
const savedKey = process.env.RESEND_API_KEY
process.env.RESEND_API_KEY = ''
const unset = await submit({ text: '没配密钥时这一条也必须留下。' })
check('没配密钥 ⇒ 503，不假装成功', unset.status === 503, `${unset.status}`)
check(
  '没配密钥时报告同样落进日志',
  unset.logs.some((l) => l.includes('没配密钥时这一条也必须留下')),
  '',
)
process.env.RESEND_API_KEY = savedKey

console.error = realError

/* ---------- 汇总 ---------- */

const passed = results.filter((r) => r.ok).length
console.log(`${passed}/${results.length} 项通过\n`)
for (const r of results) {
  console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : `  ← ${JSON.stringify(r.extra)}`}`)
}
if (passed !== results.length) process.exit(1)
