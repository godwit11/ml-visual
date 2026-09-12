/* 神经网络页截图：关键教学点 —— 「线性（无激活）」在异或上怎么都学不会。 */
await sleep(1000)

setSelect('#sel-act', 'identity')
await sleep(1500)
window.__nn.configure([16, 16], 'identity')
await sleep(1800)

return {
  ok: true,
  act: window.__nn.act,
  sizes: window.__nn.sizes,
  acc: window.__nn.acc,
  loss: window.__nn.loss,
}
