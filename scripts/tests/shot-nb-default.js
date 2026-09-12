/* 默认：含 claim / txt / free 的垃圾短信，spam 100% */
await sleep(1000)
return { ok: true, verdict: document.querySelector('#verdict .verdict-value').textContent }
