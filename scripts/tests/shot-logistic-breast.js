/** 出图用：乳腺癌真实数据，训练到收敛（94%），阈值保持 0.5 */
setSelect('#sel-data', 'breast')
await sleep(500)
click('#btn-converge')
await sleep(1500)
return {
  ok: true,
  准确率: qa('.metric-value')[0].textContent,
  损失: qa('.metric-value')[1].textContent,
  精确率: qa('.metric-value')[2].textContent,
  召回率: qa('.metric-value')[3].textContent,
  状态: q('#train-status').textContent.replace(/\s+/g, ' ').trim(),
}
