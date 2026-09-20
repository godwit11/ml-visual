/*
 * 把这一页**真实印在屏幕上的**图表标题全部读出来。
 *
 * 用途：核对 `api/nya.ts` 的 `charts[].title` 是不是和它们逐字一致。
 *
 * ⚠️ 为什么必须真的开浏览器读，而不是去 grep 各页的 index.html：
 *    ① 有的标题是 JS 动态渲染的（列表页、标签页里的那一栏）
 *    ② 页面上可能有**多个** `.panel-title`（「数据与参数」「使用说明」也是），
 *       只有挨着 `.chart` 容器的那些才是图表标题 —— 这个关系只有 DOM 能告诉我们
 *    ③ grep 会把注释里的标题也算进来，而学生看不到注释
 */

await sleep(1500)

/* 图表标题 = 挨着图表容器的那个面板标题。用 closest('.panel') 往上一层拿。 */
const 面板标题 = []
for (const el of Array.from(document.querySelectorAll('.chart, .chart-sm'))) {
  const t = el.closest('.panel')?.querySelector('.panel-title')?.textContent?.trim()
  if (t && !面板标题.includes(t)) 面板标题.push(t)
}

/* 顺带把"所有"面板标题也带上 —— 对不上时能一眼看出是不是名字写偏了 */
const 全部面板标题 = Array.from(document.querySelectorAll('.panel-title'))
  .map((p) => p.textContent?.trim())
  .filter(Boolean)

return {
  ok: 面板标题.length > 0,
  页面: location.pathname,
  /* ⚠️ 这里用字符串拼接而不是模板字符串 ——
   *    e2e.mjs 把这些脚本**包进一个模板字符串**里送到页面执行，
   *    所以脚本里任何 `dollar-brace` 都会被**外层**先求值，
   *    页面收到的是替换后的残渣 ⇒ `Unexpected identifier` 语法错误。
   *    （实测踩到：所有页面都报这个错。连**注释里**写一个都会被替换掉 ——
   *      第一版修完还是一样红，就是因为注释里还留着一个样例。） */
  视口: window.innerWidth + 'x' + window.innerHeight,
  面板标题,
  全部面板标题,
}
