/* 默认：高斯团 k=4，跑完，质心轨迹完整 */
click('#btn-run')
await sleep(1000)
return { ok: true, inertia: document.querySelectorAll('#metrics .metric')[0].querySelector('.metric-value').textContent }
