/**
 * 演示页底部的「上一个 / 下一个」。
 *
 * ⚠️ 这里修的是一个真实的 404（用户点「下一个」跳到了不存在的地方）：
 *
 *   `DEMOS` 里的 `href` 写成 `demos/xxx/` —— 这是**文档相对路径**。
 *   在首页（`/`）下解析成 `/demos/xxx/`，正好对；
 *   但在演示页（`/demos/linear-regression/`）下会解析成
 *   `/demos/linear-regression/demos/logistic-regression/` —— 404。
 *
 *   也不能把 href 改成 `/demos/xxx/`（根绝对路径）：站点用 `base: './'`，
 *   需要能部署在子路径下，也要能给 Capacitor 当本地资源用（`file://`）。
 *
 *   所以统一从当前路径算「回到站点根」的相对前缀，再拼。
 *
 * 顺带把这段逻辑从 10 个页面里抽出来 —— 之前是 10 份完全相同的拷贝，
 * 只有 demo id 不同。同一个 bug 要改 10 处，注定了会漏。
 */
import { neighbors } from '../data/demos'
import type { DemoMeta } from '../data/demos'

/**
 * 从当前页面回到站点根的相对前缀。
 *
 * 站点只有两种页面深度：根（`/`）和演示页（`/demos/<id>/`）。
 * 用正则而不是数路径段，是为了在部署到子路径（如 `/ml/demos/pca/`）
 * 或 Capacitor 的 `file://.../public/demos/pca/index.html` 下同样成立。
 */
function rootPrefix(): string {
  return /\/demos\/[^/]+\/?(?:index\.html)?$/.test(location.pathname) ? '../../' : './'
}

/**
 * 把「站点根相对」的路径（如 `demos/pca/`）转成当前页面能用的 URL。
 *
 * 首页与演示页通用的链接都应该走这个函数。导航栏里的品牌链接是
 * 每个页面 HTML 里手写的（`./` 或 `../../`），不经过这里。
 */
export function siteUrl(path: string): string {
  return rootPrefix() + path.replace(/^\.?\//, '')
}

/**
 * 挂载上下篇导航。传当前演示页的 id。
 * 页面上没有 `#pager` 时静默跳过（不是每个页面都有）。
 */
export function mountPager(currentId: string): void {
  const pager = document.getElementById('pager')
  if (!pager) return

  const { prev, next } = neighbors(currentId)

  const mk = (label: string, demo?: DemoMeta): HTMLElement => {
    if (!demo) {
      const span = document.createElement('span')
      span.className = 'pager-none'
      span.textContent = `${label}：没有了`
      return span
    }
    const a = document.createElement('a')
    a.className = 'btn'
    a.style.justifyContent = 'flex-start'
    a.textContent = `${label}：${demo.title}${demo.status === 'soon' ? '（即将上线）' : ''}`
    if (demo.status === 'live') {
      a.href = siteUrl(demo.href)
    } else {
      a.style.opacity = '0.5'
      a.style.pointerEvents = 'none'
    }
    return a
  }

  pager.append(mk('上一个', prev), mk('下一个', next))
}
