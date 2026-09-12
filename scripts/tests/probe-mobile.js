/* 移动端降级验证：窄视口下应当关掉视差、背景仍然在画 */
const layer = document.querySelector('.bg-layer')
const canvas = document.querySelector('.bg-canvas')
if (!layer || !canvas) return { ok: false }

await new Promise((r) => setTimeout(r, 1200))

const ctx = canvas.getContext('2d')
const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data
let opaque = 0
for (let i = 3; i < img.length; i += 4) if (img[i] > 0) opaque++

/* 视差有没有真的关掉：移动端不应该有 is-parallax */
const hasParallaxClass = layer.classList.contains('is-parallax')

/* 试着派发一个 pointermove，看 depth 层会不会被写 transform */
window.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: 10 }))
await new Promise((r) => setTimeout(r, 300))
const depthTransform = getComputedStyle(document.querySelector('.bg-depth-1')).transform

return {
  ok: true,
  视口: window.innerWidth + 'x' + window.innerHeight,
  命中移动端分支: window.matchMedia('(max-width: 768px)').matches,
  有is_parallax类: hasParallaxClass,
  视差后transform: depthTransform,
  /* matrix(1,0,0,1,0,0) 或 none 都表示零位移 */
  视差是否关闭: !hasParallaxClass && (depthTransform === 'none' || depthTransform === 'matrix(1, 0, 0, 1, 0, 0)'),
  背景仍在绘制: opaque > 0,
  非透明像素: opaque,
  canvas: canvas.width + 'x' + canvas.height,
}
