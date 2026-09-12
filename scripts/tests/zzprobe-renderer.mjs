/**
 * 「决策概率场单元格渲染器」的单元测试（Node 侧）。
 *
 * 直接把 src/dev/zzprobe.ts 里的渲染器拿出来，喂一份**假 api**，
 * 断言它算出来的像素矩形与颜色是否符合预期。
 *
 * 为什么值得单独测：
 *   这条路径曾经出过一个很隐蔽的 bug —— 决策边界只铺出两条细横带。
 *   浏览器里肉眼只能看出"画错了"，看不出"错在哪"，
 *   而把渲染器抽出来之后，几何就是几个纯函数，可以精确定位。
 *
 * 用法：node scripts/tests/zzprobe-renderer.mjs
 */
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const res = await build({
  entryPoints: ['src/dev/zzprobe.ts'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  logLevel: 'silent',
})

const mod = { exports: {} }
new Function('module', 'exports', 'require', res.outputFiles[0].text)(mod, mod.exports, require)
const { makeCellRenderItem, cellColor } = mod.exports

/* ---------------- 断言工具 ---------------- */
const results = []
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra })
const near = (name, got, want, tol = 1e-6) => check(name, Math.abs(got - want) <= tol, `got=${got} want=${want}`)

/* ---------------- 假坐标轴 ---------------- */
/*
 * 模拟一块 500×300 的绘图区：
 *   x ∈ [-2, 2]  →  像素 [0, 500]
 *   y ∈ [-2, 2]  →  像素 [300, 0]（屏幕 y 轴向下，所以是反的）
 */
const X0 = -2, X1 = 2, Y0 = -2, Y1 = 2
const PX0 = 0, PX1 = 500, PY_TOP = 0, PY_BOT = 300

const toPxX = (x) => PX0 + ((x - X0) / (X1 - X0)) * (PX1 - PX0)
const toPxY = (y) => PY_BOT - ((y - Y0) / (Y1 - Y0)) * (PY_BOT - PY_TOP)

const fakeApi = (row) => ({
  value: (dim) => row[dim],
  coord: (pt) => [toPxX(pt[0]), toPxY(pt[1])],
})

/* ================= 1. 几何 ================= */
{
  const cellW = (X1 - X0) / 71
  const cellH = (Y1 - Y0) / 71
  const render = makeCellRenderItem(cellW, cellH)

  const x = 0.5
  const y = -0.25
  /*
   * 注意：单元格故意放大 2%（`* 1.02`），让相邻格子有一点重叠，
   * 避免浮点误差在格与格之间留出 1px 的缝（细缝连起来就是"网格线"）。
   * 所以期望矩形是按 **1.02 倍**算的，2% 在 500px 宽的图上只有 0.14px，
   * 肉眼无感，但断言必须写对。之前这里忘了乘 1.02，报 3 个假失败。
   */
  const GROW = 1.02
  const w = cellW * GROW
  const h = cellH * GROW
  const row = [x - cellW / 2, y - cellH / 2, w, h, 0.9]
  const el = render({}, fakeApi(row))

  check('type 是 rect', el.type === 'rect', String(el.type))

  const dataL = row[0]
  const dataB = row[1]
  const dataR = row[0] + w
  const dataT = row[1] + h

  near('矩形 x = 左边界映射', el.shape.x, toPxX(dataL), 1e-4)
  near('矩形 y = 顶边映射（屏幕上更靠上）', el.shape.y, toPxY(dataT), 1e-4)
  near('矩形 width', el.shape.width, toPxX(dataR) - toPxX(dataL), 1e-4)
  near('矩形 height', el.shape.height, toPxY(dataB) - toPxY(dataT), 1e-4)

  check('width > 0', el.shape.width > 0, el.shape.width)
  check('height > 0', el.shape.height > 0, el.shape.height)
  check('格子宽度在合理量级 3~12px', el.shape.width > 3 && el.shape.width < 12, el.shape.width)
  check('格子高度在合理量级 2~12px', el.shape.height > 2 && el.shape.height < 12, el.shape.height)
  // 膨胀量确实存在且很小：相对 2%，绝对不到 1px
  near('膨胀后的宽度是基准的 1.02 倍', el.shape.width / (toPxX(X1) - toPxX(X0)) * 71, GROW, 1e-3)
  check('膨胀量很小（< 1px）', el.shape.width - (toPxX(X1) - toPxX(X0)) / 71 < 1, el.shape.width)
}

/* ================= 2. 铺满性 ================= */
{
  const cellW = (X1 - X0) / 15
  const cellH = (Y1 - Y0) / 15
  const render = makeCellRenderItem(cellW, cellH)

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (let j = 0; j < 16; j++) {
    for (let i = 0; i < 16; i++) {
      const gx = X0 + (i * (X1 - X0)) / 15
      const gy = Y0 + (j * (Y1 - Y0)) / 15
      const el = render({}, fakeApi([gx - cellW / 2, gy - cellH / 2, cellW * 1.02, cellH * 1.02, 0.5]))
      minX = Math.min(minX, el.shape.x)
      maxX = Math.max(maxX, el.shape.x + el.shape.width)
      minY = Math.min(minY, el.shape.y)
      maxY = Math.max(maxY, el.shape.y + el.shape.height)
    }
  }
  check('横向铺满绘图区', minX <= 0 && maxX >= 500, `minX=${minX.toFixed(1)} maxX=${maxX.toFixed(1)}`)
  check('纵向铺满绘图区', minY <= 0 && maxY >= 300, `minY=${minY.toFixed(1)} maxY=${maxY.toFixed(1)}`)
}

/* ================= 3. 颜色 ================= */
{
  const alpha = (s) => Number(s.slice(s.lastIndexOf(',') + 1, -1))

  const t = cellColor(0.5)
  check('p=0.5 完全透明', t === 'rgba(0,0,0,0)' || alpha(t) === 0, t)

  check('p=0.9 偏 indigo', cellColor(0.9).startsWith('rgba(99,102,241'), cellColor(0.9))
  check('p=0.1 偏 teal', cellColor(0.1).startsWith('rgba(13,148,136'), cellColor(0.1))

  check('p=0.9 比 p=0.6 更不透明', alpha(cellColor(0.9)) > alpha(cellColor(0.6)))
  check('透明度上限 0.75', Math.abs(alpha(cellColor(1)) - 0.75) < 1e-6, alpha(cellColor(1)))
  check('p=0 也有颜色', alpha(cellColor(0)) > 0.7, alpha(cellColor(0)))
}

/* ================= 4. 退化输入 ================= */
{
  const render = makeCellRenderItem(0.1, 0.1)
  const el = render({}, fakeApi([-2, -2, 0.102, 0.102, 0]))
  const s = el.shape
  check('shape 无 NaN', Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.width) && Number.isFinite(s.height), s)
  check('style.fill 是字符串', typeof el.style.fill === 'string', el.style.fill)
  check('显式 stroke:none', el.style.stroke === 'none', el.style.stroke)
  check('显式 lineWidth:0', el.style.lineWidth === 0, el.style.lineWidth)
  check('strokeFirst:false', el.style.strokeFirst === false, el.style.strokeFirst)
}

/* ---------------- 汇总 ---------------- */
const passed = results.filter((r) => r.ok).length
const failed = results.filter((r) => !r.ok)
const out = { ok: failed.length === 0, passed, total: results.length, failures: failed }
console.log(JSON.stringify(out, null, 2))
process.exit(failed.length ? 1 : 0)
