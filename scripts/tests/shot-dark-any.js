/* 通用：任意页面切到深色后截图（首页与演示页共用） */
await sleep(1500)
const btn = document.querySelector('[data-theme-toggle]')
if (document.documentElement.getAttribute('data-theme') !== 'dark' && btn) btn.click()
await sleep(2000)
return { ok: document.documentElement.getAttribute('data-theme') === 'dark', theme: document.documentElement.getAttribute('data-theme') }
