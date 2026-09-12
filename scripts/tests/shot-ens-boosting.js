/* 月牙 + AdaBoost 30 轮：点的大小就是样本权重 */
setSelect('#sel-algo', 'boosting')
await sleep(600)
setRange(qa('#controls .ctrl')[0].querySelector('input[type=range]'), 30)
await sleep(1500)
return { ok: true }
