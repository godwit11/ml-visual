/*
 * 从视频里抽帧（浏览器端）—— 「Nya 趴在对话窗口」那套立绘的前半段。
 *
 * 为什么用浏览器：机器上没有 ffmpeg，也没有任何 Python 视频库。
 * 做法是把帧画进 canvas、按网格拼好，靠 e2e driver 的截图能力落盘
 * （97 帧的数据走 CDP 返回值又慢又容易超限）。
 *
 * 用法（批次号走 URL 片段，片段不会发给服务器，视频请求不受影响）：
 *   node scripts/e2e.mjs --url "http://localhost:5199/<video>.mp4#g0" \
 *        --script scripts/extract-video-grid.js --viewport \
 *        --size 2181,1488 --shot .shots/tmp/frames-0.png
 *
 * ---------------------------------------------------------------------------
 * ⚠️ 两个踩过的坑，别改回去
 * ---------------------------------------------------------------------------
 * 1. **网格不能大过 3×3**。4×4（2908×1720）和 5×5（3635×2150）都会让
 *    `Page.captureScreenshot` 直接超时。3×3 是 2181×1290/1488，稳。
 *
 * 2. 🔴 **`seeked` 事件不等于"画面已经画出来了"**。
 *    第一版只 `await seeked` + 等 25ms 就 drawImage，结果 49 帧里
 *    **26 帧画的是空白**（纯黑一大片），而且呈固定周期（每格里第 3、6~9 格必坏）。
 *    更坑的是：空白帧在肉眼上"看着像帧"，只有量像素才发现 ——
 *    当时还以为是抠图算法不稳定（尾巴一帧有一帧没有），绕了很远。
 *    所以现在：**等 rVFC（真正的"帧被呈现"回调）+ 画完自检 + 失败重试**。
 */
const SRC = '/.shots/nya-src/perch-video-src.mp4'
/*
 * 裁剪框：x 118~845（左留 30px 余量、右刚好装下尾巴 832），y 取**整幅 496**。
 * ⚠️ 高度必须取满：抠图靠"从画面四边区域生长"，先裁掉下半部分的话，
 *    裁剪框下边界就正好切在她身上，洪水会从她身体内部起步、把她吃穿。
 */
const CROP = { x: 118, y: 0, w: 727, h: 496 }
const COLS = 3
const ROWS = 3
const PER_GRID = COLS * ROWS
const FPS = 24
const TOTAL = 49                 // 第 0~48 帧 = 0~2.04s（循环段）
const BLANK_LIMIT = 200          // 一格内还剩这么多底色像素 = 这格没画全

const GRID = (() => {
  const m = /#g?(\d+)/.exec(location.hash || '')
  return m ? Number(m[1]) : 0
})()

let v = document.querySelector('video')
if (!v) {
  v = document.createElement('video')
  document.body.appendChild(v)
}
v.muted = true
v.playsInline = true
v.preload = 'auto'
v.src = SRC
v.style.display = 'none'

await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('元数据超时')), 20000)
  v.onloadedmetadata = () => {
    clearTimeout(t)
    res()
  }
  v.onerror = () => {
    clearTimeout(t)
    rej(new Error('视频加载失败'))
  }
  v.load()
})
if (!v.videoWidth) {
  await new Promise((res) => {
    v.oncanplay = res
    setTimeout(res, 5000)
  })
}

const cv = document.createElement('canvas')
cv.width = COLS * CROP.w
cv.height = ROWS * CROP.h
cv.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647'
document.body.appendChild(cv)
const ctx = cv.getContext('2d', { willReadFrequently: true })
/*
 * 🔴 先铺一层醒目的洋红当底：任何"没画出来"的地方都会是洋红，一眼可见。
 *    曾经吃过亏：画布用 #000 打底 + 截图越界，坏帧看起来就像"正常的深色画面"。
 */
const FILL = [128, 64, 192]
ctx.fillStyle = 'rgb(128,64,192)'
ctx.fillRect(0, 0, cv.width, cv.height)

/** 等"真的有一帧被呈现"（rVFC），拿不到就退回固定等待 */
function nextFrame(timeout = 300) {
  return new Promise((res) => {
    let done = false
    const fin = () => {
      if (!done) {
        done = true
        res()
      }
    }
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(fin)
    setTimeout(fin, timeout)
  })
}

function seekTo(t) {
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('seek 超时 @' + t)), 8000)
    v.onseeked = () => {
      clearTimeout(to)
      res()
    }
    v.currentTime = t
  })
}

/** 这一格里还剩多少底色像素 */
function blankCount(c, r) {
  const d = ctx.getImageData(c * CROP.w, r * CROP.h, CROP.w, CROP.h).data
  let blank = 0
  for (let i = 0; i < d.length; i += 4) {
    if (
      Math.abs(d[i] - FILL[0]) < 8 &&
      Math.abs(d[i + 1] - FILL[1]) < 8 &&
      Math.abs(d[i + 2] - FILL[2]) < 8
    ) {
      blank++
    }
  }
  return blank
}

function looksDrawn(c, r) {
  return blankCount(c, r) < BLANK_LIMIT
}

/*
 * 🔴 视口必须装得下整块画布 —— 这条是踩出来的。
 *    窗口尺寸（--size）**不等于**视口尺寸：浏览器边框/滚动条会吃掉几十像素。
 *    2181×1488 的窗口，实测视口只有 2147×1391 ⇒ 画布右侧 34px、下侧 97px 在视口外，
 *    截图只截到视口那一块，Python 侧切网格切到越界就**补黑** ——
 *    表现为"一列一格整片是黑的"，当时误判成"抽帧失败"，绕了一大圈。
 *    所以宁可让调用方把窗口开大些，也不能静默截歪。
 */
if (innerWidth < cv.width || innerHeight < cv.height) {
  return {
    ok: false,
    reason: '视口装不下画布（把 --size 调大）',
    viewport: [innerWidth, innerHeight],
    canvas: [cv.width, cv.height],
  }
}

const start = GRID * PER_GRID
const count = Math.min(PER_GRID, TOTAL - start)
const report = []

for (let i = 0; i < count; i++) {
  const k = start + i
  const c = i % COLS
  const r = Math.floor(i / COLS)
  let ok = false
  let tries = 0
  for (; tries < 8 && !ok; tries++) {
    if (tries > 0) await sleep(120)
    await seekTo((k + tries * 0.0015) / FPS)
    await nextFrame()
    ctx.drawImage(v, CROP.x, CROP.y, CROP.w, CROP.h, c * CROP.w, r * CROP.h, CROP.w, CROP.h)
    ok = looksDrawn(c, r)
  }
  report.push({ frame: k, tries: tries, ok, blank: blankCount(c, r) })
}
window.scrollTo(0, 0)
await sleep(200)

const failed = report.filter((x) => !x.ok)
return {
  ok: failed.length === 0,
  grid: GRID,
  frames: count,
  retried: report.filter((x) => x.tries > 1).map((x) => `${x.frame}:${x.tries}`),
  failed: failed.map((x) => x.frame),
  blankPx: report.map((x) => x.blank),
  viewport: [innerWidth, innerHeight],
  canvas: [cv.width, cv.height],
}
