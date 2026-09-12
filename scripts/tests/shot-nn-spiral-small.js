/* 神经网络页截图：双螺旋 + 神经元不足（糊成一片）。 */
await sleep(1000)

setSelect('#sel-data', 'spiral')
await sleep(2000)
window.__nn.configure([2], 'relu')
await sleep(2000)

return {
  ok: true,
  dataset: window.__nn.ds,
  sizes: window.__nn.sizes,
  acc: window.__nn.acc,
}
