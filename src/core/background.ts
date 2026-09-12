/**
 * 主题背景层：「红色科技感 + 机器学习」。
 *
 * 这一层的内容分成两类：
 *   ① **CSS 层**（光晕、网格、噪点、边缘压暗）—— 见 `styles/background.css`。
 *      要么静态，要么是超低频的 transform/opacity 漂移，交给合成器跑，基本不占主线程。
 *   ② **canvas 层**（本文件）—— 需要逐帧计算的东西：
 *      神经网络节点（呼吸 + 缓慢漂移）、节点之间的连线、
 *      沿连线流动的数据脉冲、漂浮粒子、底部的损失曲线、右下角的模型拓扑示意。
 *
 * 三条硬约束，下面大部分写法都是为了它们：
 *   · **60fps**：单 canvas、单 rAF、**不用 shadowBlur**（大面积模糊是性能杀手，
 *     改用预渲染的径向渐变小贴图 + drawImage 放大）、DPR 上限 2。
 *   · **不遮挡内容**：所有 alpha 压在很低的区间，统一乘 `--bgfx-strength`；
 *     浅色主题该系数是 0.5，等于再砍一半。
 *   · **降级**：`prefers-reduced-motion` → 只画一帧静态图，不启动循环、不接视差；
 *     移动端 → 节点/粒子数量减半、不做视差。
 */
import { onThemeChange } from './theme'

type Rgb = readonly [number, number, number]

interface Palette {
  node: Rgb
  edge: Rgb
  pulse: Rgb
  curve: Rgb
  /** 总强度系数：深色 1，浅色 0.5 */
  strength: number
}

interface Node {
  x: number
  y: number
  vx: number
  vy: number
  /** 基准半径 */
  r: number
  /** 呼吸相位，让每个节点错开 */
  phase: number
  /** 呼吸角速度 */
  speed: number
}

interface Link {
  a: number
  b: number
}

interface Pulse {
  link: number
  /** 0..1，在连线上的位置 */
  t: number
  speed: number
  forward: boolean
}

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  /** 基础透明度 */
  a: number
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo)

function prefersReduced(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

function isMobile(): boolean {
  return (
    (window.matchMedia?.('(max-width: 768px)').matches ?? false) ||
    (window.matchMedia?.('(pointer: coarse)').matches ?? false)
  )
}

/* ------------------------------------------------------------------ *
 * 调色板：从 CSS 变量读，保证页面和画布用的是同一份数字
 * ------------------------------------------------------------------ */

function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement)
  const triple = (name: string, fallback: Rgb): Rgb => {
    const raw = cs.getPropertyValue(name).trim()
    // 变量写成 "224 106 112" 这种三段式
    const m = raw.match(/(-?\d+(?:\.\d+)?)\D+(-?\d+(?:\.\d+)?)\D+(-?\d+(?:\.\d+)?)/)
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])]
    return fallback
  }
  const strength = Number.parseFloat(cs.getPropertyValue('--bgfx-strength'))
  return {
    node: triple('--bgfx-node', [224, 106, 112]),
    edge: triple('--bgfx-edge', [196, 74, 92]),
    pulse: triple('--bgfx-pulse', [255, 176, 150]),
    curve: triple('--bgfx-curve', [208, 92, 96]),
    strength: Number.isFinite(strength) && strength > 0 ? clamp(strength, 0.1, 1) : 1,
  }
}

/* ------------------------------------------------------------------ *
 * 预渲染「光点」贴图
 *
 * 为什么不直接用 shadowBlur？它在浏览器里是逐图元做一次模糊卷积，
 * 几十个节点每帧各来一次会直接把帧率打下来。
 * 这些光点形状完全相同、只是颜色不同，所以按颜色预渲染一张 64×64 的
 * 径向渐变贴图，之后每帧只做 drawImage（纯位图缩放，走 GPU 很快）。
 * ------------------------------------------------------------------ */

function makeGlowSprite(rgb: Rgb, size = 64): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const g = c.getContext('2d')
  if (!g) return c
  const [r, gg, b] = rgb
  const half = size / 2
  const grad = g.createRadialGradient(half, half, 0, half, half, half)
  grad.addColorStop(0, `rgba(${r},${gg},${b},1)`)
  grad.addColorStop(0.28, `rgba(${r},${gg},${b},0.5)`)
  grad.addColorStop(0.62, `rgba(${r},${gg},${b},0.13)`)
  grad.addColorStop(1, `rgba(${r},${gg},${b},0)`)
  g.fillStyle = grad
  g.fillRect(0, 0, size, size)
  return c
}

/* ------------------------------------------------------------------ *
 * 损失曲线
 *
 * 一条"训练损失随迭代下降"的形状：前期陡降、后期趋平，带轻微振荡。
 * 只在初始化时生成一次，之后每帧照着画，不重算。
 * ------------------------------------------------------------------ */

const CURVE_POINTS = 132

/** 归一化到 0..1 的损失曲线（1 = 起点的高损失） */
function buildLossCurve(): number[] {
  const pts: number[] = []
  for (let i = 0; i < CURVE_POINTS; i++) {
    const u = i / (CURVE_POINTS - 1)
    // 主衰减 + 逐渐消失的振荡，形状像真实训练的 loss
    const v = 0.97 * Math.exp(-4.1 * u) + 0.05 + 0.028 * Math.sin(u * 19) * Math.exp(-2.2 * u)
    pts.push(clamp(v, 0, 1))
  }
  return pts
}

/* ------------------------------------------------------------------ *
 * 模型拓扑（一个示意用的 MLP）
 * ------------------------------------------------------------------ */

/** 每层的单元数，画成经典的"漏斗"拓扑 */
const TOPO_LAYERS = [3, 6, 6, 2]

interface TopoNode {
  x: number
  y: number
  layer: number
}

export interface BackgroundHandle {
  dispose: () => void
}

/**
 * 挂载背景层。幂等：重复调用不会插入第二份。
 */
export function mountBackground(): BackgroundHandle | null {
  if (document.querySelector('.bg-layer')) return null

  /* ---------------- DOM ---------------- */
  const layer = document.createElement('div')
  layer.className = 'bg-layer'
  layer.setAttribute('aria-hidden', 'true')

  const depth = (cls: string) => {
    const d = document.createElement('div')
    d.className = `bg-depth ${cls}`
    return d
  }

  const d1 = depth('bg-depth-1')
  const glowA = document.createElement('div')
  glowA.className = 'bg-glow bg-glow-a'
  d1.appendChild(glowA)

  const d2 = depth('bg-depth-2')
  const glowB = document.createElement('div')
  glowB.className = 'bg-glow bg-glow-b'
  d2.appendChild(glowB)

  const d3 = depth('bg-depth-3')
  const grid = document.createElement('div')
  grid.className = 'bg-grid'
  d3.appendChild(grid)

  const canvas = document.createElement('canvas')
  canvas.className = 'bg-canvas'

  const noise = document.createElement('div')
  noise.className = 'bg-noise'

  const vignette = document.createElement('div')
  vignette.className = 'bg-vignette'

  layer.append(d1, d2, d3, canvas, noise, vignette)
  // 插到 body 最前面，尽量不影响既有 DOM 顺序
  document.body.insertBefore(layer, document.body.firstChild)

  const ctx2d = canvas.getContext('2d', { alpha: true })
  if (!ctx2d) {
    // 拿不到 2d context（极罕见）：留着 CSS 层即可，功能不残缺
    return { dispose: () => layer.remove() }
  }
  /*
   * 非空别名。
   * `ctx2d` 的类型是 `CanvasRenderingContext2D | null`，虽然上面已经 early return
   * 排除了 null，但下面那些绘制函数是**函数声明（会提升）**，TypeScript 不做
   * 跨闭包的控制流窄化，所以直接引用 `ctx2d` 会在每一处都报"possibly null"。
   * 在这里钉死成非空类型，后面所有绘制代码就都能安心用。
   */
  const ctx: CanvasRenderingContext2D = ctx2d

  /* ---------------- 状态 ---------------- */
  let palette = readPalette()
  let sprites = {
    node: makeGlowSprite(palette.node),
    pulse: makeGlowSprite(palette.pulse),
    curve: makeGlowSprite(palette.curve),
  }

  let w = 0
  let h = 0
  let dpr = 1

  let nodes: Node[] = []
  let links: Link[] = []
  let pulses: Pulse[] = []
  let particles: Particle[] = []
  let lossCurve = buildLossCurve()
  let topoNodes: TopoNode[] = []
  let topoLinks: Array<[number, number]> = []

  /* 视差：目标位移（鼠标）与当前位移（缓动跟随） */
  const par = { tx: 0, ty: 0, cx: 0, cy: 0, enabled: false }

  let raf = 0
  let running = false
  let last = 0
  /** 上一次真正绘制的时间戳（用于 30fps 限流） */
  let lastDraw = 0
  let elapsed = 0

  /* ---------------- 构建场景 ---------------- */
  function buildScene(): void {
    const mobile = isMobile()
    const area = w * h
    // 数量跟着视口面积走，并设上下限：小屏不空、大屏不糊
    const nodeCount = clamp(Math.round(area / (mobile ? 46000 : 27000)), mobile ? 12 : 20, mobile ? 24 : 54)
    const particleCount = clamp(Math.round(area / (mobile ? 62000 : 34000)), mobile ? 16 : 26, mobile ? 34 : 78)

    nodes = []
    for (let i = 0; i < nodeCount; i++) {
      nodes.push({
        x: rand(0, w),
        y: rand(0, h),
        // 漂移速度：像素/秒，非常慢（0.6~2.4 px/s），肉眼几乎察觉不到"在动"
        vx: rand(-1.2, 1.2) * (mobile ? 0.6 : 1),
        vy: rand(-1.2, 1.2) * (mobile ? 0.6 : 1),
        r: rand(1.1, 2.5),
        phase: rand(0, Math.PI * 2),
        // 呼吸周期 4.5~11s
        speed: rand(0.57, 1.4),
      })
    }

    /*
     * 连线：只按**初始位置**算一次邻接关系，之后节点漂移就让它漂 ——
     * 每帧重算距离是 O(n²)，而且连线会不停抖动，看着很躁。
     * 固定拓扑 + 缓慢漂移反而像一张有生命的网。
     */
    links = []
    const maxLen = Math.min(w, h) * (mobile ? 0.42 : 0.32)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].x - nodes[j].x
        const dy = nodes[i].y - nodes[j].y
        const d = Math.hypot(dx, dy)
        // 加一点随机性，避免连成规整的网
        if (d < maxLen && Math.random() < 0.55) links.push({ a: i, b: j })
      }
    }

    // 数据脉冲：挑一部分连线，让数据在上面来回跑
    const pulseCount = clamp(Math.round(links.length * 0.16), 3, mobile ? 8 : 16)
    pulses = []
    for (let i = 0; i < pulseCount && links.length > 0; i++) {
      pulses.push({
        link: Math.floor(Math.random() * links.length),
        t: Math.random(),
        // 0.06~0.15 /s → 走完一条线要 7~17 秒，够慢
        speed: rand(0.06, 0.15),
        forward: Math.random() < 0.5,
      })
    }

    particles = []
    for (let i = 0; i < particleCount; i++) {
      particles.push({
        x: rand(0, w),
        y: rand(0, h),
        vx: rand(-7, 7),
        vy: rand(-7, 7),
        r: rand(0.5, 1.5),
        a: rand(0.25, 0.75),
      })
    }

    // 模型拓扑：右下角一个示意 MLP
    const topoW = clamp(w * 0.17, 140, 230)
    const topoH = topoW * 0.62
    const ox = w - topoW - clamp(w * 0.05, 24, 72)
    const oy = h - topoH - clamp(h * 0.13, 48, 110)
    topoNodes = []
    topoLinks = []
    const layerGap = topoW / (TOPO_LAYERS.length - 1)
    TOPO_LAYERS.forEach((count, li) => {
      const x = ox + li * layerGap
      const gap = topoH / (count + 1)
      for (let k = 0; k < count; k++) {
        topoNodes.push({ x, y: oy + gap * (k + 1), layer: li })
      }
    })
    let offset = 0
    for (let li = 0; li < TOPO_LAYERS.length - 1; li++) {
      const from = offset
      const fromCount = TOPO_LAYERS[li]
      const to = offset + fromCount
      const toCount = TOPO_LAYERS[li + 1]
      for (let a = 0; a < fromCount; a++) {
        for (let b = 0; b < toCount; b++) topoLinks.push([from + a, to + b])
      }
      offset += fromCount
      void toCount
    }
  }

  /* ---------------- 尺寸 ---------------- */
  /*
   * 测量**画布自身**的布局盒，而不是 `layer.clientWidth`。
   *
   * 踩过：一开始用 `layer.clientWidth`，结果缓冲区是 1406×1503、CSS 盒却是
   * 1396×1503——首屏渲染时页面还没滚动条（1406），内容加载出来之后滚动条一出现
   * 就变成 1396，而 `window.resize` 不会因为滚动条出现而触发，于是尺寸一直停在
   * 首次测量值，画布被横向压扁 0.7%。
   * 现在改成读 canvas 自己的 clientWidth，并用 ResizeObserver 盯住它，
   * 滚动条出现/消失、字体加载、侧栏折叠这些都会触发重测。
   */
  function resize(): void {
    const nextW = Math.max(1, canvas.clientWidth || window.innerWidth)
    const nextH = Math.max(1, canvas.clientHeight || window.innerHeight)
    // DPR 上限 2：再高对背景这种低对比内容没有可见收益，只是白白多画像素
    const nextDpr = clamp(window.devicePixelRatio || 1, 1, 2)

    const changed = nextW !== w || nextH !== h || nextDpr !== dpr
    if (!changed) return

    w = nextW
    h = nextH
    dpr = nextDpr
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    lossCurve = buildLossCurve()
    buildScene()
    if (!running) drawFrame(0) // 静态模式下立刻重画一帧
  }

  /* ---------------- 绘制 ---------------- */

  /** 画一条损失曲线（底部） */
  function drawLossCurve(t: number): void {
    const baseY = h - clamp(h * 0.045, 18, 40)
    const amp = clamp(h * 0.19, 48, 150)
    const x0 = w * 0.04
    const span = w * 0.92
    const a = 0.16 * palette.strength

    ctx.beginPath()
    for (let i = 0; i < CURVE_POINTS; i++) {
      const x = x0 + (span * i) / (CURVE_POINTS - 1)
      const y = baseY - amp * lossCurve[i]
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.strokeStyle = `rgba(${palette.curve[0]},${palette.curve[1]},${palette.curve[2]},${a})`
    ctx.lineWidth = 1.4
    ctx.stroke()

    /*
     * 曲线上一个缓慢右移的高亮点，像"训练进度"在推进。
     * 走到头停一会儿再从头开始，避免生硬跳回。
     */
    const cycle = 16
    const local = (t % cycle) / cycle
    if (local < 0.82) {
      const u = local / 0.82
      const idx = u * (CURVE_POINTS - 1)
      const i0 = Math.floor(idx)
      const frac = idx - i0
      const v = lossCurve[i0] + (lossCurve[Math.min(i0 + 1, CURVE_POINTS - 1)] - lossCurve[i0]) * frac
      const x = x0 + span * u
      const y = baseY - amp * v
      const s = 26
      ctx.globalAlpha = 0.5 * palette.strength
      ctx.drawImage(sprites.curve, x - s / 2, y - s / 2, s, s)
      ctx.globalAlpha = 1
    }
  }

  /** 画右下角的模型拓扑示意（带一次"前向传播"的高亮扫过） */
  function drawTopology(t: number): void {
    if (topoNodes.length === 0) return
    const a = palette.strength

    // 连线
    ctx.beginPath()
    for (const [i, j] of topoLinks) {
      ctx.moveTo(topoNodes[i].x, topoNodes[i].y)
      ctx.lineTo(topoNodes[j].x, topoNodes[j].y)
    }
    ctx.strokeStyle = `rgba(${palette.edge[0]},${palette.edge[1]},${palette.edge[2]},${0.085 * a})`
    ctx.lineWidth = 0.8
    ctx.stroke()

    // 高亮：按层依次点亮，周期 9s，模拟一次前向传播
    const swing = (t % 9) / 9
    const activeLayer = swing < 0.72 ? Math.floor((swing / 0.72) * TOPO_LAYERS.length) : -1

    for (const n of topoNodes) {
      const on = n.layer === activeLayer
      const r = on ? 2.6 : 1.7
      ctx.beginPath()
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
      ctx.fillStyle = on
        ? `rgba(${palette.pulse[0]},${palette.pulse[1]},${palette.pulse[2]},${0.3 * a})`
        : `rgba(${palette.node[0]},${palette.node[1]},${palette.node[2]},${0.15 * a})`
      ctx.fill()
    }
  }

  /** 一帧 */
  function drawFrame(dt: number): void {
    elapsed += dt
    const t = elapsed

    ctx.clearRect(0, 0, w, h)

    // 全局低频脉冲：整层亮度在 ~8.5s 周期里轻微起伏（"低透明度脉冲"）
    const breath = 0.84 + 0.16 * Math.sin((t * Math.PI * 2) / 8.5)
    const S = palette.strength * breath

    drawLossCurve(t)
    drawTopology(t)

    /* --- 节点漂移 --- */
    for (const n of nodes) {
      n.x += n.vx * dt
      n.y += n.vy * dt
      // 出界回绕，留一点边距再回来，避免贴在边上闪
      if (n.x < -12) n.x = w + 12
      else if (n.x > w + 12) n.x = -12
      if (n.y < -12) n.y = h + 12
      else if (n.y > h + 12) n.y = -12
    }

    /* --- 连线（一次路径 + 一次 stroke，最省） --- */
    if (links.length) {
      ctx.beginPath()
      for (const l of links) {
        ctx.moveTo(nodes[l.a].x, nodes[l.a].y)
        ctx.lineTo(nodes[l.b].x, nodes[l.b].y)
      }
      ctx.strokeStyle = `rgba(${palette.edge[0]},${palette.edge[1]},${palette.edge[2]},${0.075 * S})`
      ctx.lineWidth = 0.75
      ctx.stroke()
    }

    /* --- 数据脉冲：沿连线流动的光点 --- */
    for (const p of pulses) {
      const l = links[p.link]
      if (!l) continue
      p.t += p.speed * dt
      if (p.t > 1) {
        // 跑完换一条线，并且换向，看起来像双向通信
        p.t -= 1
        p.link = Math.floor(Math.random() * links.length)
        p.forward = Math.random() < 0.5
      }
      const u = p.forward ? p.t : 1 - p.t
      const ax = nodes[l.a].x
      const ay = nodes[l.a].y
      const bx = nodes[l.b].x
      const by = nodes[l.b].y
      const x = ax + (bx - ax) * u
      const y = ay + (by - ay) * u

      // 尾迹：朝来向画一小段，做出"流动"的方向感
      const trail = 0.1
      const tu = p.forward ? Math.max(0, u - trail) : Math.min(1, u + trail)
      ctx.beginPath()
      ctx.moveTo(ax + (bx - ax) * tu, ay + (by - ay) * tu)
      ctx.lineTo(x, y)
      ctx.strokeStyle = `rgba(${palette.pulse[0]},${palette.pulse[1]},${palette.pulse[2]},${0.2 * S})`
      ctx.lineWidth = 1.1
      ctx.stroke()

      const s = 16
      ctx.globalAlpha = 0.55 * S
      ctx.drawImage(sprites.pulse, x - s / 2, y - s / 2, s, s)
      ctx.globalAlpha = 1
    }

    /* --- 节点：呼吸 --- */
    for (const n of nodes) {
      const breathe = 0.68 + 0.32 * (0.5 + 0.5 * Math.sin(t * n.speed + n.phase))
      const r = n.r * 5.2 * breathe
      ctx.globalAlpha = 0.32 * S * breathe
      ctx.drawImage(sprites.node, n.x - r, n.y - r, r * 2, r * 2)

      // 实心核心：让节点在光晕里有一个明确的"点"
      ctx.globalAlpha = 0.3 * S * breathe
      ctx.beginPath()
      ctx.arc(n.x, n.y, n.r * 0.62, 0, Math.PI * 2)
      ctx.fillStyle = `rgb(${palette.node[0]},${palette.node[1]},${palette.node[2]})`
      ctx.fill()
    }
    ctx.globalAlpha = 1

    /* --- 粒子 --- */
    if (particles.length) {
      for (const q of particles) {
        q.x += q.vx * dt
        q.y += q.vy * dt
        if (q.x < -6) q.x = w + 6
        else if (q.x > w + 6) q.x = -6
        if (q.y < -6) q.y = h + 6
        else if (q.y > h + 6) q.y = -6
      }
      ctx.beginPath()
      for (const q of particles) {
        ctx.moveTo(q.x + q.r, q.y)
        ctx.arc(q.x, q.y, q.r, 0, Math.PI * 2)
      }
      ctx.fillStyle = `rgba(${palette.node[0]},${palette.node[1]},${palette.node[2]},${0.3 * S})`
      ctx.fill()
    }
  }

  /* ---------------- 主循环 ---------------- */
  /*
   * 帧率上限 30fps。
   *
   * 为什么敢砍一半：这一层是**环境背景**，最慢的漂移是 0.6~2.4 px/s，
   * 粒子 7 px/s，脉冲走完一条线要 7~17 秒。按 30fps 算，每帧位移最大也只有
   * 0.23px —— 低于一个像素，肉眼不可能看出 30 与 60 的差别。
   * 但重绘开销是实打实减半，笔记本和手机上的风扇/耗电都受益。
   *
   * 注意 dt 仍按**真实经过时间**累加（不是按帧数），所以动画速度不随帧率变，
   * 掉帧时也不会变慢，只是采样点稀疏一点。
   */
  const FRAME_MS = 1000 / 30

  function loop(now: number): void {
    if (!running) return
    // dt 上限 50ms：切回标签页时别一下子跳一大步
    const dt = Math.min(0.05, (now - last) / 1000 || 0)
    last = now

    // 视差缓动：用 0.06 的系数做指数逼近，鼠标停住后仍会慢慢归位
    if (par.enabled) {
      par.cx += (par.tx - par.cx) * 0.06
      par.cy += (par.ty - par.cy) * 0.06
      applyParallax()
    }

    if (now - lastDraw >= FRAME_MS) {
      lastDraw = now
      drawFrame(dt)
    }

    raf = requestAnimationFrame(loop)
  }

  function applyParallax(): void {
    /*
     * 视差关掉时**清掉 inline transform**，而不是写一个 translate3d(0,0,0)。
     * 两者视觉上一样，但保留一个非 none 的 transform 会让元素成为包含块
     * （并可能被提升为合成层），白白多一层开销。清掉最干净。
     */
    if (!par.enabled) {
      d1.style.transform = ''
      d2.style.transform = ''
      d3.style.transform = ''
      noise.style.transform = ''
      return
    }
    // 不同层给不同系数 → 视差层次
    d1.style.transform = `translate3d(${(par.cx * 1.0).toFixed(2)}px, ${(par.cy * 1.0).toFixed(2)}px, 0)`
    d2.style.transform = `translate3d(${(par.cx * 1.5).toFixed(2)}px, ${(par.cy * 1.5).toFixed(2)}px, 0)`
    d3.style.transform = `translate3d(${(par.cx * 0.4).toFixed(2)}px, ${(par.cy * 0.4).toFixed(2)}px, 0)`
    noise.style.transform = `translate3d(${(par.cx * 0.7).toFixed(2)}px, ${(par.cy * 0.7).toFixed(2)}px, 0)`
  }

  function start(): void {
    if (running) return
    running = true
    last = performance.now()
    lastDraw = 0 // 立刻画一帧，不要等满一个限流周期
    raf = requestAnimationFrame(loop)
  }

  function stop(): void {
    running = false
    if (raf) cancelAnimationFrame(raf)
    raf = 0
  }

  /* ---------------- 视差 ---------------- */
  let pendingMove = false
  let pointerX = 0
  let pointerY = 0

  function onPointerMove(e: PointerEvent): void {
    if (!par.enabled) return
    // 换算成 -1..1
    pointerX = (e.clientX / window.innerWidth) * 2 - 1
    pointerY = (e.clientY / window.innerHeight) * 2 - 1
    if (pendingMove) return
    // rAF 节流：鼠标事件可能远高于帧率，不能每次都写 transform
    pendingMove = true
    requestAnimationFrame(() => {
      pendingMove = false
      const MAX = 9 // 位移上限，务必"轻微"
      par.tx = -pointerX * MAX
      par.ty = -pointerY * MAX
    })
  }

  function setParallaxEnabled(on: boolean): void {
    par.enabled = on
    /*
     * 只有真的开视差时才给 depth 容器加 will-change（见 background.css）。
     * 这个类会让每个 depth 容器变成一张独立的全屏合成层，
     * 移动端 / 减少动态效果时用不上视差，就不该付这份显存和帧率。
     */
    layer.classList.toggle('is-parallax', on)
    if (!on) {
      par.tx = par.ty = par.cx = par.cy = 0
      applyParallax()
    }
    window.removeEventListener('pointermove', onPointerMove)
    if (on) window.addEventListener('pointermove', onPointerMove, { passive: true })
  }

  /* ---------------- 生命周期 ---------------- */
  function onResize(): void {
    resize()
  }

  function onVisibility(): void {
    if (document.hidden) stop()
    else if (!prefersReduced()) start()
  }

  const offTheme = onThemeChange(() => {
    palette = readPalette()
    sprites = {
      node: makeGlowSprite(palette.node),
      pulse: makeGlowSprite(palette.pulse),
      curve: makeGlowSprite(palette.curve),
    }
    if (!running) drawFrame(0)
  })

  let resizeTimer = 0
  function onWindowResize(): void {
    // 防抖 140ms：拖动窗口时不要每帧重建场景
    if (resizeTimer) window.clearTimeout(resizeTimer)
    resizeTimer = window.setTimeout(onResize, 140)
  }

  /*
   * 除了 window.resize，还要盯元素自身的尺寸变化。
   * 滚动条出现/消失、字体加载完成导致的重排，都不会触发 window.resize，
   * 但都会改变画布的实际宽高。
   */
  let ro: ResizeObserver | null = null
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => onWindowResize())
    ro.observe(canvas)
  }

  /* ---------------- 启动 ---------------- */
  resize()
  window.addEventListener('resize', onWindowResize)

  if (prefersReduced()) {
    // 减少动态效果：只画一帧静态画面，不启动循环、不接视差、不听 visibility
    drawFrame(0)
  } else {
    setParallaxEnabled(!isMobile())
    document.addEventListener('visibilitychange', onVisibility)
    start()
  }

  return {
    dispose: () => {
      stop()
      window.removeEventListener('resize', onWindowResize)
      window.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('visibilitychange', onVisibility)
      if (resizeTimer) window.clearTimeout(resizeTimer)
      ro?.disconnect()
      offTheme()
      layer.remove()
    },
  }
}
