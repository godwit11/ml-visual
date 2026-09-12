/* 稀有病场景：同一模型、5% 患病率 */
setSelect('#sel-data', 'rare')
await sleep(900)
return { ok: true, dataset: q('#sel-data').value }
