/* 月牙 + 线性核：核函数的墙 */
setSelect('#sel-data', 'moons')
await sleep(400)
setSelect('#sel-kernel', 'linear')
await sleep(1600)
return { ok: true, acc: document.querySelectorAll('#metrics .metric')[3].querySelector('.metric-value').textContent }
