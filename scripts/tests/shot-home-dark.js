await sleep(1200)
/* 点主题切换按钮：走 applyTheme → 会通知 canvas 重新取色，比直接改 attribute 靠谱 */
const btn = document.querySelector('[data-theme-toggle]')
if (btn) btn.click()
await sleep(2400)
return {
  ok: document.documentElement.getAttribute('data-theme') === 'dark',
  theme: document.documentElement.getAttribute('data-theme'),
  strength: getComputedStyle(document.documentElement).getPropertyValue('--bgfx-strength').trim(),
}
