/* 神经网络页截图：同心圆（需要闭合边界，双层才圆滑）。 */
await sleep(1000)

setSelect('#sel-data', 'circles')
await sleep(2500)

return {
  ok: true,
  dataset: window.__nn.ds,
  sizes: window.__nn.sizes,
  acc: window.__nn.acc,
}
