/**
 * 决策树的可视化画布：递归布局 + Canvas 手绘 + 缩放。
 *
 * 为什么不用 ECharts 的 tree 图：
 *   1) 要能在"单步构建"时精确控制每个节点的出现与高亮
 *   2) 要在节点里塞进"样本数 / 不纯度 / 类别分布条"这些教学信息
 *   3) 缩放和适应屏幕的行为要自己说了算
 * 这些用原生 Canvas 反而更直接。
 */
import type { TreeNode } from '../algorithms/decisionTree'

const NODE_W = 126
const NODE_H = 50
const GAP_X = 16
const GAP_Y = 74

interface Placed {
  node: TreeNode
  x: number
  y: number
}

export interface TreeViewMeta {
  featureNames: string[]
  classNames: string[]
  criterionLabel: string
}

export interface TreeView {
  setTree(root: TreeNode | null, meta: TreeViewMeta): void
  highlight(id: number | null): void
  zoomIn(): void
  zoomOut(): void
  fit(): void
  render(): void
  getScale(): number
}

export function createTreeCanvas(host: HTMLElement): TreeView {
  const wrap = document.createElement('div')
  wrap.className = 'tree-wrap'
  const canvas = document.createElement('canvas')
  canvas.className = 'tree-canvas'
  wrap.append(canvas)
  host.append(wrap)

  const ctx = canvas.getContext('2d')
  let root: TreeNode | null = null
  let meta: TreeViewMeta = { featureNames: [], classNames: [], criterionLabel: '' }
  let placed: Placed[] = []
  let contentW = 0
  let contentH = 0
  let scale = 1
  let highlightId: number | null = null

  /* ---------- 布局 ---------- */
  function layout(): void {
    placed = []
    if (!root) {
      contentW = 0
      contentH = 0
      return
    }
    let leafCursor = 0

    const walk = (n: TreeNode | undefined): Placed | null => {
      if (!n) return null
      const isLeaf = n.feature === undefined
      if (isLeaf) {
        const p: Placed = { node: n, x: leafCursor * (NODE_W + GAP_X), y: n.depth * (NODE_H + GAP_Y) }
        leafCursor += 1
        placed.push(p)
        return p
      }
      const l = walk(n.left)
      const r = walk(n.right)
      const x = l && r ? (l.x + r.x) / 2 : (l?.x ?? r?.x ?? 0)
      const p: Placed = { node: n, x, y: n.depth * (NODE_H + GAP_Y) }
      placed.push(p)
      return p
    }
    walk(root)

    const maxX = Math.max(...placed.map((p) => p.x))
    const maxY = Math.max(...placed.map((p) => p.y))
    contentW = maxX + NODE_W
    contentH = maxY + NODE_H
  }

  /* ---------- 绘制 ---------- */
  const CLASS_COLORS = ['#6366f1', '#0d9488', '#f59e0b', '#ec4899', '#8b5cf6']

  function cssVar(name: string, fallback: string): string {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return v || fallback
  }

  function classColor(k: number): string {
    return CLASS_COLORS[k % CLASS_COLORS.length]
  }

  function draw(): void {
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(contentW * scale, 10)
    const h = Math.max(contentH * scale, 10)

    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = `${Math.round(w)}px`
    canvas.style.height = `${Math.round(h)}px`

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.save()
    ctx.scale(scale, scale)

    const bg = cssVar('--bg-elev', '#fff')
    const border = cssVar('--border-strong', '#ccc')
    const text = cssVar('--text', '#111')
    const sub = cssVar('--text-3', '#888')
    const primary = cssVar('--primary', '#4f46e5')

    if (!root) {
      ctx.restore()
      return
    }

    const byId = new Map<number, Placed>()
    for (const p of placed) byId.set(p.node.id, p)

    /* 连线（先画线，后画节点，避免线压住节点） */
    ctx.lineWidth = 1.6
    for (const p of placed) {
      const n = p.node
      if (n.feature === undefined) continue
      for (const child of [n.left, n.right]) {
        if (!child) continue
        const c = byId.get(child.id)
        if (!c) continue
        ctx.strokeStyle = border
        ctx.beginPath()
        const x1 = p.x + NODE_W / 2
        const y1 = p.y + NODE_H
        const x2 = c.x + NODE_W / 2
        const y2 = c.y
        const my = (y1 + y2) / 2
        ctx.moveTo(x1, y1)
        ctx.bezierCurveTo(x1, my, x2, my, x2, y2)
        ctx.stroke()
      }
    }

    /* 节点 */
    for (const p of placed) {
      const n = p.node
      const isLeaf = n.feature === undefined
      const color = classColor(n.predicted)
      const hi = highlightId === n.id

      // 卡片
      roundRect(ctx, p.x, p.y, NODE_W, NODE_H, 8)
      ctx.fillStyle = isLeaf ? hexA(color, 0.16) : bg
      ctx.fill()
      ctx.strokeStyle = hi ? primary : border
      ctx.lineWidth = hi ? 2.4 : 1.2
      ctx.stroke()

      // 左侧类别色条
      ctx.save()
      roundRect(ctx, p.x, p.y, 4, NODE_H, 2)
      ctx.fillStyle = color
      ctx.fill()
      ctx.restore()

      // 文字
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      if (isLeaf) {
        ctx.fillStyle = color
        ctx.font = '600 12px ui-monospace, Menlo, Consolas, monospace'
        const label = meta.classNames[n.predicted] ?? String(n.predicted)
        ctx.fillText(clip(ctx, label, NODE_W - 16), p.x + 12, p.y + 17)
        ctx.fillStyle = sub
        ctx.font = '11px -apple-system, "PingFang SC", sans-serif'
        ctx.fillText(`n=${n.nSamples}`, p.x + 12, p.y + 34)
      } else {
        ctx.fillStyle = text
        ctx.font = '600 12px ui-monospace, Menlo, Consolas, monospace'
        const fname = meta.featureNames[n.feature ?? 0] ?? `x${(n.feature ?? 0) + 1}`
        const cond = `${fname} ≤ ${fmt(n.threshold ?? 0)}`
        ctx.fillText(clip(ctx, cond, NODE_W - 16), p.x + 12, p.y + 16)
        ctx.fillStyle = sub
        ctx.font = '11px -apple-system, "PingFang SC", sans-serif'
        ctx.fillText(`n=${n.nSamples} 增益 ${fmt(n.gain ?? 0)}`, p.x + 12, p.y + 34)
      }

      // 类别分布条（叶子用纯色，内部按比例）
      const total = n.counts.reduce((a, b) => a + b, 0)
      if (total > 0) {
        const barW = NODE_W - 24
        const barY = p.y + NODE_H - 10
        let cx = p.x + 12
        n.counts.forEach((c, k) => {
          if (c === 0) return
          const segW = (c / total) * barW
          ctx.fillStyle = classColor(k)
          ctx.fillRect(cx, barY, segW, 4)
          cx += segW
        })
      }
    }

    ctx.restore()
  }

  function render(): void {
    layout()
    draw()
  }

  function fit(): void {
    if (contentW === 0) return
    // 下限 0.7：再小节点里的 12px 字就糊了，宁可让用户横向滚动
    const avail = wrap.clientWidth - 8
    scale = Math.min(1, Math.max(0.7, avail / contentW))
    draw()
  }

  return {
    setTree(r, m) {
      root = r
      meta = m
      render()
      fit()
    },
    highlight(id) {
      highlightId = id
      draw()
    },
    zoomIn() {
      scale = Math.min(2, scale * 1.2)
      draw()
    },
    zoomOut() {
      scale = Math.max(0.3, scale / 1.2)
      draw()
    },
    fit,
    render,
    getScale: () => scale,
  }
}

function fmt(v: number): string {
  const a = Math.abs(v)
  if (a >= 100) return v.toFixed(1)
  if (a >= 1) return v.toFixed(2)
  return v.toFixed(3)
}

function hexA(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

function clip(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text
  let s = text
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1)
  return s + '…'
}
