/* α 拉到 100：区分度被抹平，准确率明显下滑 */
setRange(qa('#controls .ctrl')[0].querySelector('input[type=range]'), 2)
await sleep(800)
return { ok: true, acc: document.querySelectorAll('#metrics .metric')[0].querySelector('.metric-value').textContent }
