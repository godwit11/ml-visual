import type { CustomSeriesRenderItemAPI, CustomSeriesRenderItemParams } from 'echarts'
import type { RectShape, PathStyleProps } from 'zrender'

type Cell = [number, number, number, number, number]

export type RectEl = {
  type: 'rect'
  shape: RectShape
  style: PathStyleProps
}

/**
 * 决策概率场的单元格渲染器。
 *
 * 抽成独立模块是为了两件事：
 *   ① 在页面里用（真正的渲染）；
 *   ② 在 Node 里用一份"假 api"直接调它，把算出来的像素断言掉，
 *      不必依赖浏览器像素比对就能验证几何算得对不对。
 *
 * ⚠️ 关于宽高为什么必须从 data 里读（api.value(2)/value(3)）而不是用 cellW/cellH：
 *   data 里的宽度是 `cellW * 1.02`，故意比格子略大 2%，让相邻块**重叠**，
 *   否则浮点误差会在格与格之间留下亚像素细缝，连成一片"网格线"。
 *   用固定的 cellW 画就会把这个膨胀量丢掉，边界上会出现发丝一样的白线。
 *   （这个 2% 曾经在渲染器里被静默丢弃过，是"背景铺不满"的成因之一。）
 */
export function makeCellRenderItem(
  _cellW: number,
  _cellH: number,
): (params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) => RectEl {
  return function renderCell(_params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI): RectEl {
    const v = api.value(4) as number
    const x = api.value(0) as number
    const y = api.value(1) as number
    const w = api.value(2) as number
    const h = api.value(3) as number
    // 左下角与右上角的像素坐标（数据 y 轴向上，所以 y + h 在屏幕上更靠上）
    const p0 = api.coord([x, y + h])
    const p1 = api.coord([x + w, y])
    const px = p0[0]
    const py = p0[1]
    const pw = p1[0] - p0[0]
    const ph = p1[1] - p0[1]
    return {
      type: 'rect',
      // 屏幕坐标 y 向下，所以 height 取正
      shape: { x: px, y: py, width: Math.abs(pw), height: Math.abs(ph) },
      style: {
        fill: cellColor(v),
        // 三件套都显式关掉：zrender 对 Path 有默认描边（stroke: '#000'），
        // 不显式置空会把每一格描一圈黑边，整片背景糊成灰的。
        stroke: 'none',
        lineWidth: 0,
        strokeFirst: false,
      },
    }
  }
}

/**
 * 概率 → 颜色。
 *
 * 低于阈值画 teal（类别 0），高于阈值画 indigo（类别 1），
 * 偏离 0.5 越远饱和度越高（0.5 处全透明，1.0 处约 0.75）。
 */
export function cellColor(v: number): string {
  const a = Math.min(0.75, Math.abs(v - 0.5) * 1.5)
  if (!(a > 0.001)) return 'rgba(0,0,0,0)'
  return v > 0.5 ? `rgba(99,102,241,${a.toFixed(3)})` : `rgba(13,148,136,${a.toFixed(3)})`
}

export type { Cell }
