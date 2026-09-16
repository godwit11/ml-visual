import { initTheme, toggleTheme, currentTheme, onThemeChange } from './theme'
import { mountBackground } from './background'
import { mountNya } from './nya'
import { mountFeedback } from './feedback'

const SUN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>'
const MOON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>'

export function mountChrome(): void {
  initTheme()
  /*
   * 主题背景层（红色科技感）。
   * 放在 initTheme 之后 —— 它要读 `data-theme` 上的 CSS 变量来决定配色。
   * 每个页面都会调 mountChrome，所以这里是全站唯一的挂载点。
   */
  mountBackground()
  wireThemeToggle()
  wireTabs()
  wireCopy()
  /*
   * Nya 助教面板（右下角浮动按钮 + 对话）。
   * 和背景层同理，这里是全站唯一都会经过的挂载点 —— 收在这里，
   * 以后加页面不用记得再挂一次。它是幂等的，重复调用无副作用。
   *
   * 面板本身不依赖网络：问答失败只影响它自己，页面其余部分照常。
   */
  mountNya()
  /*
   * 「报告问题」（贴右边缘的竖标签）。
   *
   * 和 Nya 一样是全站共享的浮层，所以也收在这里。
   * ⚠️ 它的**控制台错误捕获**装在模块顶层、随这个 import 一起执行 ——
   *    所以 `src/core/feedback.ts` 必须是**静态引入**（不能改成按需 import），
   *    否则页面一开始那几秒的报错就抓不到了。
   */
  mountFeedback()
}

function wireThemeToggle(): void {
  const btns = document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]')
  const paint = () => {
    const dark = currentTheme() === 'dark'
    btns.forEach((b) => {
      b.innerHTML = dark ? SUN : MOON
      b.title = dark ? '切换到浅色' : '切换到深色'
    })
  }
  paint()
  onThemeChange(paint)
  btns.forEach((b) => b.addEventListener('click', () => toggleTheme()))
}

function wireTabs(): void {
  document.querySelectorAll<HTMLElement>('[data-tabs]').forEach((group) => {
    const tabs = Array.from(group.querySelectorAll<HTMLButtonElement>('[data-tab]'))
    const panels = Array.from(group.querySelectorAll<HTMLElement>('[data-panel]'))
    const activate = (name: string) => {
      tabs.forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name))
      panels.forEach((p) => p.classList.toggle('is-active', p.dataset.panel === name))
    }
    tabs.forEach((t) => t.addEventListener('click', () => activate(t.dataset.tab ?? '')))
  })
}

function wireCopy(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const pre = btn.closest('.code-wrap')?.querySelector('.code-block')
      if (!pre) return
      const text = pre.textContent ?? ''
      try {
        await navigator.clipboard.writeText(text)
        btn.textContent = '已复制'
      } catch {
        btn.textContent = '复制失败'
      }
      setTimeout(() => {
        btn.textContent = '复制'
      }, 1400)
    })
  })
}
