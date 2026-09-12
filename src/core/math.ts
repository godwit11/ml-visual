import katex from 'katex'
import 'katex/dist/katex.min.css'

/** 把页面里所有 .math 元素渲染成公式。用 data-tex 取原文，避免二次渲染把结果当输入。 */
export function renderMath(root: ParentNode = document): void {
  const nodes = root.querySelectorAll<HTMLElement>('.math')
  nodes.forEach((node) => {
    if (node.dataset.rendered === '1') return
    const source = node.getAttribute('data-tex') ?? node.textContent ?? ''
    try {
      katex.render(source, node, {
        displayMode: node.hasAttribute('data-display'),
        throwOnError: false,
        strict: false,
      })
      node.dataset.rendered = '1'
    } catch {
      node.textContent = source
    }
  })
}

/** 生成数学占位标签。display=true 时独占一行居中。 */
export function tex(source: string, display = false): string {
  const attr = display ? ' data-display' : ''
  return `<span class="math" data-tex="${escapeAttr(source)}"${attr}></span>`
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
