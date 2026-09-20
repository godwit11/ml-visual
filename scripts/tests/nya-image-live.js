/*
 * 「Nya 真的能看着图回答吗」—— 端到端验收。
 *
 * ⚠️ 这个脚本**会真发请求、真花额度**，所以它不进 verify:all，
 *    也不挂到 package.json 的日常脚本里。只在改动了看图相关代码之后手动跑一次。
 *
 * 和 nya-image.js 的区别：
 *   nya-image.js 把 fetch 拦下来，验的是"图有没有被抓出来、有没有发出去"（免费的）。
 *   这个脚本不拦，验的是"她拿到图之后答得对不对"（花钱的）。
 *   两者都要有 —— 前者能天天跑，后者只能偶尔跑，但只有后者能回答"这功能到底有没有用"。
 */

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))

const input = document.querySelector('.nya-input')
if (!input) throw new Error('找不到输入框 .nya-input')
const form = input.closest('form')
if (!form) throw new Error('找不到输入框所在的 form')

/* 这个问题**必须看图才答得出来**：状态里只有"簇 1 的点数"这种数字，
 * 没有任何一个键能告诉她"右上角那簇是紧还是散"。 */
const QUESTION = '这张图里右上角那团橙色的点，看起来聚得紧还是散？'

input.value = QUESTION
input.dispatchEvent(new Event('input', { bubbles: true }))
form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
/* 等**助教**的回答稳定下来。
 *
 * ⚠️ 必须按角色取（`.is-nya`），不能取"最后一条 .nya-msg" ——
 *    提问之后她还没开口的那段时间里，最后一条是**学生自己那条**，
 *    于是脚本会把你问的问题当成她的回答，还报告 ok:true。
 *    （2026-09-18 第一次跑就踩到了，假绿。）
 */
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
  if (text && text.length > 15 && text === prev) {
    if (++stable >= 4) break
  } else {
    stable = 0
  }
  prev = text
}

return {
  /* 判定要能**变红**：答非所问（等于问题）、出现错误气泡、太短，都算失败 */
  ok:
    answer.length > 15 &&
    answer !== QUESTION &&
    !errText &&
    !/看不到|看不见/.test(answer),
  问题: QUESTION,
  她的回答: answer,
  回答长度: answer.length,
  错误气泡: errText || null,
  /* 这几个词说明她真的在看图（而不是在背概念） */
  提到方位: /右上|右上方|上边|那一团|那团/.test(answer),
  提到疏密: /散|紧|密|集中|铺开|聚/.test(answer),
  /* **正向指标（2026-09-20 加的）**：她有没有**报出面板标题原文**。
   * 锚点改成"标题原文"之后，如果她认出了问的那张图，第一句应该会带上
   * 页面上印着的名字（"聚类结果"）。带上 ⇒ 学生能逐字核对，改对了。 */
  报出标题原文: /聚类结果/.test(answer),
  /* **反向指标**：出现带两位小数的数字 ⇒ 提示词的分工规则没生效（她在从图上读数） */
  疑似读数字: /\d+\.\d{2,}/.test(answer),
}

