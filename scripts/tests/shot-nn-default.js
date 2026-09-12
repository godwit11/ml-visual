/* 神经网络页截图：首屏（异或 + ReLU，已训练 300 轮）。 */
await sleep(1200)

return {
  ok: true,
  dataset: q('#sel-data').value,
  act: q('#sel-act').value,
  sizes: window.__nn.sizes,
  acc: window.__nn.acc,
  loss: window.__nn.loss,
}
