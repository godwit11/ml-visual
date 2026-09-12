/* 鸢尾花 k=3：纯度 0.9467 */
setSelect('#sel-data', 'iris')
await sleep(700)
setRange(qa('#controls .ctrl')[0].querySelector('input[type=range]'), 3)
await sleep(700)
click('#btn-run')
await sleep(900)
return { ok: true, purity: document.querySelectorAll('#metrics .metric')[3].querySelector('.metric-value').textContent }
