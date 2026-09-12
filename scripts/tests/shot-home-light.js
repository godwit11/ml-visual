/*
 * 首页截图：浅色主题。
 * 与 shot-home-dark.js 对称 —— 一个点主题按钮切深色，这个确保停在浅色。
 * 用来出验收对比图（背景层两套主题配色不同，必须都看一眼）。
 */
await sleep(1200)
const root = document.documentElement
if (root.getAttribute('data-theme') === 'dark') {
  const btn = document.querySelector('[data-theme-toggle]')
  if (btn) btn.click()
}
await sleep(2400)
return {
  ok: root.getAttribute('data-theme') === 'light',
  theme: root.getAttribute('data-theme'),
  卡片数: document.querySelectorAll('.demo-card').length,
  流水线步数: document.querySelectorAll('.pipe-node').length,
  分区数: document.querySelectorAll('.sec-head').length,
}
