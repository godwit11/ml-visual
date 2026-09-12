/** 出图用：月牙数据，训练到收敛也只有 87% —— 线性模型的天花板 */
setSelect('#sel-data', 'moons')
await sleep(500)
click('#btn-converge')
await sleep(1500)
return {
  ok: true,
  准确率: qa('.metric-value')[0].textContent,
  损失: qa('.metric-value')[1].textContent,
  状态: q('#train-status').textContent.replace(/\s+/g, ' ').trim(),
}
