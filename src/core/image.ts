/**
 * 图片压缩 —— 两个地方共用：Nya 抓图表截图、反馈表单收用户上传的截图。
 *
 * 为什么必须压缩：
 *   两边的图都要走 HTTP 出浏览器。原始截图动辄 1~3MB，而
 *   · Nya 那张要作为 token 计费（实测 256KB ≈ 3000 token），
 *   · 反馈那几张要过 Vercel 函数 4.5MB 的请求体闸。
 *   压到长边 1600 以内的 JPEG，体积掉到十几分之一，肉眼几乎看不出差别。
 *
 * ⚠️ **转 JPEG 之前必须铺一层白底。** JPEG 没有透明通道，直接画上去
 *    透明区域会变成**黑块** —— 而 ECharts 的图默认就是透明底，
 *    不铺白底她会看到一张脏图，且这种错肉眼很难第一时间反应过来。
 */

/** 一个能看清细节、又不会把体积撑爆的默认上限 */
export const IMG_MAX_SIDE = 1600
/** 0.85 之后肉眼几乎无感，体积却只有 PNG 的 1/4 左右 */
export const IMG_QUALITY = 0.85

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败'))
    img.src = src
  })
}

/**
 * 把一张图（data URL 或 blob URL）等比缩到 `maxSide` 以内，转成 JPEG data URL。
 *
 * **失败一律返回 undefined，绝不抛** —— 两个调用方都是"图是附加品"的场景：
 * Nya 抓不到图照常提问，反馈压不了图照常提交报告。宁可少一张图，
 * 不能让主流程因为一张图挂掉。
 */
export async function shrinkToJpeg(
  src: string,
  opts: { maxSide?: number; quality?: number; background?: string } = {},
): Promise<string | undefined> {
  const maxSide = opts.maxSide ?? IMG_MAX_SIDE
  const quality = opts.quality ?? IMG_QUALITY
  const background = opts.background ?? '#ffffff'

  try {
    const bmp = await loadImage(src)
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height, 1))
    const w = Math.max(1, Math.round(bmp.width * scale))
    const h = Math.max(1, Math.round(bmp.height * scale))

    const cv = document.createElement('canvas')
    cv.width = w
    cv.height = h
    const cx = cv.getContext('2d')
    if (!cx) return undefined

    /* 先铺底再画 —— 顺序反了白底会盖住图 */
    cx.fillStyle = background
    cx.fillRect(0, 0, w, h)
    cx.drawImage(bmp, 0, 0, w, h)

    return cv.toDataURL('image/jpeg', quality)
  } catch {
    return undefined
  }
}

/** 把 File / Blob 读成 data URL（只用于喂给上面的压缩函数，用完要 revoke） */
export function readAsDataUrl(file: Blob): Promise<string | undefined> {
  return new Promise((resolve) => {
    const fr = new FileReader()
    fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : undefined)
    fr.onerror = () => resolve(undefined)
    fr.readAsDataURL(file)
  })
}
