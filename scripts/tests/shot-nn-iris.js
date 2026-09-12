/* 神经网络页截图：鸢尾花三分类（真实数据 + softmax 输出）。 */
await sleep(1000)

setSelect('#sel-data', 'iris')
await sleep(2500)

return {
  ok: true,
  dataset: window.__nn.ds,
  sizes: window.__nn.sizes,
  lr: window.__nn.lr,
  acc: window.__nn.acc,
}
