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

/* ---------- 图片附件 ---------- */
/*
 * 为什么这几条必须有（2026-09-18 加图片上传）：
 *   图是**唯一一个以二进制形态进邮件的字段**，而且完全来自前端 ——
 *   校验松一格，就等于把任意文件塞进了发件通道。
 *
 *   同时它又必须**坏了不连累报告**：报告才是主体，图是附加品，
 *   一份"带图失败但正文照发"的报告远好过"整份报告发不出去"。
 *   这两条方向相反的约束，只有在这一层能同时验到。
 */
const IMG_PNG =
  'data:image/png;base64,' +
  require('node:fs').readFileSync(resolve(root, '.shots/proto2-mask.png')).toString('base64')

const withImg = await submit({ images: [{ name: 'shot.png', dataUrl: IMG_PNG }] })
check(
  '带图 ⇒ Resend 收到 attachments，且只有 1 张',
  Array.isArray(withImg.mail?.attachments) && withImg.mail.attachments.length === 1,
  JSON.stringify(withImg.mail?.attachments)?.slice(0, 100),
)
check(
  'attachments 里是**纯 base64**（不带 data: 前缀，带上 Resend 解不出来）',
  typeof withImg.mail?.attachments?.[0]?.content === 'string' &&
    !withImg.mail.attachments[0].content.startsWith('data:'),
  String(withImg.mail?.attachments?.[0]?.content).slice(0, 40),
)
check(
  '正文里说清了附了几张图（否则你收到邮件会以为正文就是全部）',
  /* ⚠️ 只断言"有这么一段、且带上了数量"，不去咬死具体措辞 ——
   *    第一版写成 /1 张图/，而实现输出的是「1 张，见本邮件附件」，
   *    于是断言红了一条本来是对的实现。断言盯语义，别盯文案。 */
  /【附图】\s*\d+\s*张/.test(String(withImg.mail?.text)),
  String(withImg.mail?.text).slice(-200),
)

/* 不带图 ⇒ 老路径一个字节都没变 */
const noImg = await submit({})
check(
  '不带图 ⇒ 压根没有 attachments 这个字段（老路径原样）',
  noImg.mail?.attachments === undefined,
  JSON.stringify(noImg.mail?.attachments),
)

/* 数量上限：多传的直接丢，但不能因此报错 */
const manyImgs = await submit({
  images: Array.from({ length: 6 }, (_, i) => ({ name: `s${i}.png`, dataUrl: IMG_PNG })),
})
check('最多只带 3 张（多传的直接丢）', manyImgs.mail?.attachments?.length === 3, manyImgs.mail?.attachments?.length)

/* 坏图：全部丢弃，但报告必须照发 */
const badImgs = await submit({
  images: [
    { name: 'a.png', dataUrl: 'data:image/png;base64,@@@这不是合法base64@@@' },
    /* 非图片 mime —— 绝不能放行，否则可以往邮件里塞任意类型的文件 */
    { name: 'b.png', dataUrl: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' },
    { name: 'c.png', dataUrl: 'javascript:alert(1)' },
    { name: 'd.png', dataUrl: 'data:image/png;base64,' },
    { name: 'e.png' },
    null,
  ],
})
check('非法图全部丢弃，但报告仍然发得出去', badImgs.status === 200 && badImgs.mail !== null, badImgs.status)
check('非法图一张都没混进附件', badImgs.mail?.attachments === undefined, JSON.stringify(badImgs.mail?.attachments))

/* 超大图：丢弃，报告照发 */
const hugeImg = await submit({
  images: [{ name: 'huge.png', dataUrl: 'data:image/png;base64,' + 'A'.repeat(4_000_000) }],
})
check(
  '超大图被丢弃（约 3MB，超过单张上限），报告仍发出',
  hugeImg.status === 200 && hugeImg.mail?.attachments === undefined,
  `status=${hugeImg.status} attachments=${JSON.stringify(hugeImg.mail?.attachments)}`,
)

/* 文件名是**要进邮件头**的字符串，必须消毒 */
const sneakyName = await submit({
  images: [{ name: 'a\r\nBcc: evil@example.com\r\n.png', dataUrl: IMG_PNG }],
})
const sentName = String(sneakyName.mail?.attachments?.[0]?.filename ?? '')
check(
  '文件名被消毒：换行不能进邮件头（否则能注入 Bcc）',
  !sentName.includes('\n') && !sentName.includes('\r') && sentName.length > 0,
  JSON.stringify(sentName),
)

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
