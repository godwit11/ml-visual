/**
 * 只为出图：把决策树页摆成一个"过拟合"的典型状态（鸢尾花 + 深度 10），
 * 再交给 scripts/e2e.mjs 的 --shot 截图。断言从简，重点是页面最后长什么样。
 */
setSelect('#sel-data', 'iris')
await sleep(400)
const ranges = qa('#controls input[type="range"]')
setRange(ranges[0], 10)
await sleep(600)
return {
  ok: true,
  准确率: qa('.metric-value')[0].textContent,
  深度: qa('.metric-value')[1].textContent,
  叶子: qa('.metric-value')[2].textContent,
  状态: q('#build-status').textContent.trim(),
}
