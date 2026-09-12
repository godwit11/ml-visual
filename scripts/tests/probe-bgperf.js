/*
 * 背景层的性能与降级验证。
 *
 * 页面上写着「60fps、只用 transform/opacity、支持 prefers-reduced-motion、
 * 移动端降级」，这些说法必须真的量一遍，不能靠读代码下结论。
 *
 * 配合 e2e 驱动器使用：
 *   node scripts/e2e.mjs --serve --url <url> --script <本文件> --reduced-motion
 *   node scripts/e2e.mjs --serve --url <url> --script <本文件> --dpr 3
 */
const canvas = document.querySelector('.bg-canvas')
if (!canvas) return { ok: false, reason: '没有 .bg-canvas' }

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
const dpr = window.devicePixelRatio

/* ---- 1. 尺寸与 DPR ---- */
const rect = canvas.getBoundingClientRect()
const widthRatio = canvas.width / Math.max(1, rect.width)

/* ---- 2. 帧率：数 2 秒内 rAF 的回调数 ---- */
let frames = 0
const t0 = performance.now()
await new Promise((done) => {
  const tick = () => {
    frames++
    if (performance.now() - t0 < 2000) requestAnimationFrame(tick)
    else done()
  }
  requestAnimationFrame(tick)
})
const elapsed = performance.now() - t0
const fps = (frames / elapsed) * 1000

/* ---- 3. canvas 是否真的在动 ----
 * 隔 350ms 取两次像素指纹，比较是否变化。
 * 用 getImageData 采样一部分（全画布太慢，会污染帧率测量）。
 */
function fingerprint() {
  const ctx = canvas.getContext('2d')
  const img = ctx.getImageData(0, 0, Math.min(600, canvas.width), Math.min(600, canvas.height)).data
  let h = 0
  for (let i = 0; i < img.length; i += 97) h = (h * 31 + img[i]) >>> 0
  return h
}
const f1 = fingerprint()
await new Promise((r) => setTimeout(r, 350))
const f2 = fingerprint()

/* ---- 4. 视差层有没有被写入 transform ---- */
const depths = Array.from(document.querySelectorAll('.bg-depth')).map((el) => ({
  cls: el.className.replace('bg-depth ', ''),
  transform: getComputedStyle(el).transform,
  willChange: getComputedStyle(el).willChange,
}))

/* ---- 5. CSS 动画是否还在跑（reduced-motion 下应该全停） ---- */
const glowAnim = getComputedStyle(document.querySelector('.bg-glow-a')).animationName
const noiseAnim = getComputedStyle(document.querySelector('.bg-noise')).animationName

/* ---- 6. 有没有用 shadowBlur 之类的重活（读不到源码，只能看结论性指标） ---- */
return {
  ok: true,
  prefersReducedMotion: reduced,
  devicePixelRatio: dpr,
  canvasBuffer: canvas.width + 'x' + canvas.height,
  canvasCss: Math.round(rect.width) + 'x' + Math.round(rect.height),
  DPR上限是否生效: widthRatio <= 2.001 && widthRatio >= 0.99,
  实测缓冲区倍率: +widthRatio.toFixed(3),
  两秒帧数: frames,
  实测fps: +fps.toFixed(1),
  canvas是否在动: f1 !== f2,
  像素指纹: [f1, f2],
  视差层: depths,
  glow动画: glowAnim,
  noise动画: noiseAnim,
}
