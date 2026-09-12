/* 同心圆 + RBF 核：核技巧解开 */
setSelect('#sel-data', 'circles')
await sleep(400)
setSelect('#sel-kernel', 'rbf')
await sleep(1600)
return { ok: true }
