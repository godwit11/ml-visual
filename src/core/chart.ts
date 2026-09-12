import * as echarts from 'echarts/core'
import { ScatterChart, LineChart, BarChart, CustomChart } from 'echarts/charts'
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  MarkAreaComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsOption } from 'echarts'
import { onThemeChange } from './theme'

echarts.use([
  ScatterChart,
  LineChart,
  BarChart,
  CustomChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  MarkAreaComponent,
  CanvasRenderer,
])

export type OptionFactory = () => EChartsOption

export interface ChartHandle {
  chart: echarts.ECharts
  update: () => void
  dispose: () => void
}

/** 创建画布并在主题切换 / 容器尺寸变化时自动刷新。 */
export function createChart(el: HTMLElement, factory: OptionFactory): ChartHandle {
  const chart = echarts.init(el, undefined, { renderer: 'canvas' })
  const update = () => chart.setOption(factory(), true)
  update()
  const off = onThemeChange(update)
  const ro = new ResizeObserver(() => chart.resize())
  ro.observe(el)

  const handle: ChartHandle = {
    chart,
    update,
    dispose: () => {
      off()
      ro.disconnect()
      chart.dispose()
    },
  }

  // 调试钩子：e2e 脚本（scripts/e2e.mjs）通过 el.__chart 读到 ECharts 实例，
  // 才能断言坐标轴范围这类只存在于实例内部的状态。
  ;(el as HTMLElement & { __chart?: ChartHandle }).__chart = handle

  return handle
}

/**
 * 图表用色。
 *
 * 从 CSS 变量读，而不是在这里写死一套 —— 之前这里硬编码了深灰蓝
 * （`#232935` 之类），主题换成黑红底之后，所有图表的网格线、坐标轴、
 * 散点描边还是冷灰蓝，跟页面完全不是一个色温，而且改主题要改两处。
 * 现在 tokens.css 是唯一的颜色来源。
 *
 * 只在构建 option / 切主题时调用，不在逐帧路径上，读计算样式没有性能问题。
 */
export function palette() {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback
  return {
    text: v('--text', '#1a1d24'),
    sub: v('--text-2', '#565b66'),
    axis: v('--chart-axis', '#8b90a0'),
    split: v('--chart-grid', '#e8eaf0'),
    surface: v('--bg-elev', '#ffffff'),
  }
}

export function baseGrid(pad = 8) {
  return { left: 52, right: pad + 8, top: pad + 16, bottom: 44, containLabel: false }
}
