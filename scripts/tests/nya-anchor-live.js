/*
 * 本轮 bug 的**针对性验收**（会花钱，刻意不进 verify:all）。
 *
 * 验的是什么：学生用**方位**问「下面那张小的图」，她能不能认领正确、
 * 并且**用页面上印着的标题原文**回答（而不是跟着学生的方位词走）。
 *
 * 为什么这条最重要：
 *   学生说的方位在**手机端**可能是错的（两图并排 → 堆叠）。
 *   她要是跟着方位词答，两边就永远对不上 —— 那正是用户报的"识图有问题"。
 *   改对了的表现：她**不接方位**，改成报标题原文，
 *   学生拿这个名字去屏幕上一看就明白了。
 *
 * ⚠️ 这个脚本**不拦 fetch**，真调模型。
 */

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))

const input = document.querySelector('.nya-input')
if (!input) throw new Error('找不到输入框 .nya-input')
const form = input.closest('form')

/* 用**方位**问（这正是会翻车的问法） */
const QUESTION = '下面那张小图是什么？'

input.value = QUESTION
input.dispatchEvent(new Event('input', { bubbles: true }))
form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

let answer = ''
let stable = 0
let prev = ''
let errText = ''
for (let i = 0; i < 200; i++) {
  await sleepMs(500)
  const bubbles = Array.from(document.querySelectorAll('.nya-msg.is-nya'))
  const last = bubbles[bubbles.length - 1]
  const text = last ? last.textContent.trim() : ''
  const err = document.querySelector('.nya-msg.is-err')
  errText = err ? err.textContent.trim() : ''
  answer = text
  if (text && text.length > 10 && text === prev) {
    if (++stable >= 4) break
  } else {
    stable = 0
  }
  prev = text
}

/* 这一页（clustering）两张图的标题原文 */
const pageTitles = ['聚类结果', 'inertia 随迭代下降']

return {
  ok: answer.length > 10 && answer !== QUESTION && !errText && !/看不到|看不见/.test(answer),
  问题: QUESTION,
  她的回答: answer,
  错误气泡: errText || null,
  /* 🔴 核心判据：她有没有**报出页面上的标题原文**（而不是顺着方位说"下面那张"） */
  报出标题原文: pageTitles.filter((t) => answer.includes(t)),
  /* 反向指标：她如果通篇只有方位词、一个标题都没报，说明锚点没起作用 */
  只用了方位: !pageTitles.some((t) => answer.includes(t)),
  疑似读数字: /\d+\.\d{2,}/.test(answer),
}
