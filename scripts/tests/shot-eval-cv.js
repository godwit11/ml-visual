/* 交叉验证：关掉分层，看折的失衡 */
click('[data-tab="cv"]')
await sleep(400)
const chk = q('#chk-stratify')
chk.checked = false
chk.dispatchEvent(new Event('change'))
await sleep(900)
return { ok: true }
