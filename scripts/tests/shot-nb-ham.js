/* 一条正常短信：ham 99.98% */
const el = q('#sms-input')
el.value = 'Sorry, I will call you later. I am in a meeting right now.'
el.dispatchEvent(new Event('input'))
await sleep(400)
return { ok: true, verdict: document.querySelector('#verdict .verdict-value').textContent }
