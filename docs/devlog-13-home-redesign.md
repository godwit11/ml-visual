# ML 演示站 · 开发日志 13：暗红科技感背景 + 首页布局重排

> 站点的 10 个演示页在第 12 轮全部上线之后，这一轮转去做**外包装**：
> 给整站铺一层「黑红 + 青蓝」的机器学习主题背景，再把首页那套
> 「居中标题 + 一排一模一样卡片」的单调排版重新设计一遍。
>
> 这一轮最值得记的不是配色，而是**性能返工**：背景写完之后实测只有
> 18.7fps，逐层归因才发现罪魁是两团光晕的 CSS 动画，而不是 canvas。

---

## 1. 接手时的状态

上一轮留下的背景层是**半成品**：`src/core/background.ts`（665 行）、
`styles/background.css`、`tokens.css` 里的 `--bgfx-*` 调色板都在，
`chrome.ts` 也挂上了，但 `npm run build` 直接挂在 5 个类型错误上：

```
background.ts(285,74): 'len' does not exist in type 'Link'
background.ts(358,5):  'ctx' is possibly 'null'
…（共 50 处）
```

两个原因：

1. `Link` 接口里没有 `len`，但 `links.push({ a, b, len: d })` 塞了进去。
   `len` 全项目没人读——是写的时候顺手记下、后来忘了删的死数据，直接去掉。
2. `ctx` 是 `CanvasRenderingContext2D | null`，中间已经 `early return` 排除了 null，
   但下面的绘制函数是**函数声明（会提升）**，TypeScript 不做跨闭包的控制流窄化，
   于是每一处引用都报 "possibly null"。
   修法是在判空之后钉一个非空别名 `const ctx: CanvasRenderingContext2D = ctx2d`。

### 另一个和配色有关的问题

调色板里节点和连线都是**红色**（`--bgfx-node: 224 106 112`、
`--bgfx-edge: 196 74 92`）。但需求写的是「**青蓝色节点连线做互补**」——
底子用暖红、结构用冷青蓝，靠色相对撞做科技感；节点也用红的话整屏只剩
一个色相，糊成一片，也没了层次。这一条是明确跑偏的，本轮改掉。

---

## 2. 背景：配色逻辑

改完之后 `tokens.css` 里定下了三条分工，写在注释里当约束：

| 角色 | 色系 | 作用 | 用在哪 |
|---|---|---|---|
| 底色 / 光晕 | 酒红、绯红（暖） | 氛围 | `--bgfx-base`、`--bgfx-glow-a/b` |
| 节点 / 连线 | 青蓝（冷） | 结构 | `--bgfx-node`、`--bgfx-edge` |
| 数据脉冲 | 亮红粉（暖 + 高亮） | 强调 | `--bgfx-pulse` |

脉冲是**唯一的高对比点**：冷色连线上跑暖色光点，全屏最亮的那几处正好是
「数据在流动」的地方，不需要再加别的高光。

深色（主）与浅色（暖纸）两套：

- 深色：`--bgfx-base: #0f0709`（近黑的酒红）→ `#170b0f`，
  节点 `122 206 238`，连线 `78 156 202`，脉冲 `255 142 140`
- 浅色：底 `#fbf7f6`，节点/连线压深到 `58 122 165` / `72 132 172`
  （浅底上冷色太亮会看不见），脉冲降亮到 `214 84 92`

浅色主题额外做了两处收敛：光晕的 alpha 单独压一档（CSS 里的光晕强度
不经过 `--bgfx-strength`，那个系数只管 canvas，所以两套主题默认一样强，
浅底上会整页发粉），网格透明度从 0.62 降到 0.34。

---

## 3. ⚠️ 性能返工：18.7fps → 21.9fps，并找到真正的瓶颈

按需求写着「60fps、只用 transform/opacity」，所以必须先量一遍再说别的。

### 第一次测量就发现问题

```
实测 fps: 15.7        （无头 Edge，--disable-gpu）
```

于是做了**分层归因实验**：分别藏掉 canvas、藏掉整个背景层，各测一次。

| 状态 | fps |
|---|---|
| A. 原样 | 18.4 |
| B. 只藏 canvas | 18.5 |
| C. 藏掉整个 `.bg-layer` | **60.5** |

**结论：藏掉 canvas 一点用都没有，藏掉整个层才有用。**
所以瓶颈不在 canvas（那是逐帧绘制），而在 **CSS 图层**。

继续逐个藏：

| 隐藏的对象 | fps | 增量 |
|---|---|---|
| 基线 | 18.7 | — |
| 仅藏 glow A | 23.5 | +4.8 |
| 仅藏 glow B | 23.8 | +5.1 |
| **藏两个 glow** | **31.3** | **+12.6** |
| 仅藏 noise | 22.2 | +3.5 |
| 仅藏 grid | 19.9 | +1.2 |
| 仅藏 vignette | 19.3 | +0.6 |
| 只留 canvas | 44.8 | — |

### 罪魁是光晕的 CSS 动画

初版光晕是这样写的：

```css
.bg-glow-a {
  position: absolute;
  inset: 0;                       /* ← 整屏大小的元素 */
  background: radial-gradient(46% 40% at 22% 24%, …);  /* ← 偏心椭圆 */
  animation: bgfx-drift-a 26s ease-in-out infinite;
}
@keyframes bgfx-drift-a {
  0%, 100% { transform: translate3d(…) scale(1); opacity: 0.86; }
  50%      { transform: translate3d(…) scale(1.07); opacity: 1; }
}
```

三个问题叠在一起：

1. **元素是整屏大小**，但渐变只覆盖一部分 —— 光栅化面积白白多出一大圈。
2. **每帧重新光栅化整个渐变**：元素没有独立合成层，`transform` 动画会触发
   重新绘制，而「整屏 + 径向渐变」是最贵的那类绘制。
3. **`opacity: 0.86 → 1`** 这个呼吸，在 0.86 的基数上做 14% 的起伏，
   肉眼**完全看不出来** —— 相当于白付一半的代价。

### 改法

```css
/* ① 元素缩到渐变实际覆盖的范围；② 用 closest-side 椭圆，stops 从 4 个减到 3 个 */
.bg-glow-a {
  left: -20%; top: -24%;
  width: 82%; height: 74%;
  background-image: radial-gradient(closest-side, …, 52%, transparent 100%);
  animation: bgfx-drift-a 26s ease-in-out infinite;
}
/* ③ 自己就是独立合成层：漂移 = 挪一张烤好的贴图，不再逐帧重画渐变 */
.bg-glow { will-change: transform; }

/* ④ keyframes 只动 transform，删掉那个看不见的 opacity 呼吸 */
@keyframes bgfx-drift-a {
  0%, 100% { transform: translate3d(-2.2%, -1.6%, 0) scale(1); }
  50%      { transform: translate3d(2.6%, 2.2%, 0) scale(1.07); }
}
```

### 噪点的呼吸直接删掉

噪点原本有一个 19s 的 `opacity` 动画。它在噪声透明度基数 0.03~0.055 上
做 0.78×~1.0× 的起伏 —— 对比度变化不到 1.2%，看不见；但要付 3.5fps。
这种「付出可见成本、换来看不见效果」的动画，就该删而不是优化。

### `will-change` 按需开

`.bg-depth` 原本无条件挂 `will-change: transform`。这会让**每个** depth 容器
变成一张全屏尺寸的独立合成层，三层全屏纹理在软件渲染下实测吃掉约 10fps；
而移动端 / `prefers-reduced-motion` 下根本不用视差。
改成只有真开视差时才加类：

```ts
function setParallaxEnabled(on: boolean): void {
  par.enabled = on
  layer.classList.toggle('is-parallax', on)   // ← .is-parallax .bg-depth { will-change: transform }
  …
}
```

顺带修了一个小疏漏：关视差时原本会写 `translate3d(0,0,0)`，视觉上等于没动，
但保留一个非 `none` 的 transform 会让元素成为包含块、可能被提升为合成层。
现在直接 `style.transform = ''` 清掉。

### 环境层限流到 30fps

```ts
const FRAME_MS = 1000 / 30
if (now - lastDraw >= FRAME_MS) { lastDraw = now; drawFrame(dt) }
```

敢砍一半的依据：这一层是**环境背景**，最慢的漂移 0.6~2.4 px/s、粒子 7 px/s、
脉冲走完一条线要 7~17 秒。按 30fps 算每帧位移上限 0.23px —— 不到一个像素，
看不出差别，但重绘开销实打实减半。
`dt` 仍按真实经过时间累加（不是按帧计数），所以动画速度不随帧率变。

### 改后

| | 改前 | 改后 |
|---|---|---|
| 基线 fps | 18.7 | **21.9** |
| 两个光晕的代价 | +12.6 | +8.3 |
| 只留 canvas | 44.8 | 44.8 |

### ⚠️ 对 21.9fps 这个数字要说清楚

**这个数字不代表真实设备上的表现。**

- 无头 Edge 带 `--disable-gpu`，全部走 SwiftShader **软件光栅化**。
- 在这种环境下，**任何**全屏合成都很贵：连「只留 canvas、CSS 层全藏」
  也只有 44.8fps，而 canvas 一帧只是清屏 + 几十个 20px 的小贴图 + 几条线。
  这点工作在 GPU 上是零点几毫秒。
- 可以确定的是**方向**：所有会动的东西都只碰 `transform` / `opacity`，
  并且都（按需）提升为独立合成层 —— 这正是「只碰 transform/opacity」这条
  要求想要的效果，在 GPU 上就是几次贴图移动。

我没有在真机上量过，所以不写「稳定 60fps」这种话。能给的结论是：
**同一环境下帧率提升了 17%，且瓶颈已从「逐帧重绘大面积渐变」变成「合成贴图」。**

---

## 4. 降级能力：逐项实测

需求里的 `prefers-reduced-motion`、DPR、移动端降级，光读代码不算验证，
所以给 e2e 驱动器加了三个模拟开关，真的跑一遍。

用的手段是 CDP 的 `Emulation.setEmulatedMedia`（模拟系统偏好）和
`Emulation.setDeviceMetricsOverride`（模拟 DPR），都必须在 `Page.navigate`
**之前**下发，否则首屏已经按默认值跑完了。

### `prefers-reduced-motion: reduce`

```
prefersReducedMotion: true
canvas是否在动:  false      ← 只画了一帧静态图，没起循环
glow动画:        none
noise动画:       none
实测 fps:        58.7       ← 什么都不动，自然接近 60
```

用「隔 350ms 取两次像素指纹」判断 canvas 是否还在动 —— 比读代码可靠。

### DPR 上限

```
devicePixelRatio:        3     （模拟出来的）
canvasBuffer:  2792x3006
canvasCss:     1396x1503
实测缓冲区倍率:  2             ← 上限生效
```

### 移动端（420×900）

```
命中移动端分支: true
有 is_parallax 类: false
视差后 transform: none        ← 视差确实没接
背景仍在绘制: true            （9486 个非透明像素）
```

这三个开关固化成了 `npm run verify:bg:motion` / `verify:bg:dpr` / `verify:bg:mobile`，
以后改背景可以直接复跑。

---

## 5. 布局重排

原首页的问题：**每一屏都是同一个节奏**。居中大标题 + 一行胶囊 + 一组
一模一样的卡片网格，然后重复五遍；卡片里只有「图标 / 标题 / 两行描述 / 已上线」，
信息密度也低。

新版给每个区块一个明确的角色：

| 区块 | 原来 | 现在 |
|---|---|---|
| hero | 居中标题 + 徽章 | 左右分栏：左边定位 + 四个硬数字，右边「参数↔代码」取样面板 |
| 分区标题 | 标题 + 一行描述 | mono 两位编号（01–07）+ 标题 + 描述 + 一道红起头的渐隐线 |
| 演示卡片 | 图标/标题/描述/徽章 | 多出右上角编号、底部 sklearn 入口标签、hover 点亮的顶部渐变线 |
| 学习路线 | 10 个一模一样的胶囊 + 箭头 | 一条横向流：STEP 01–10 节点 + 连接箭头 + 当前进度高亮 |
| 差异化 | 5 张普通卡片 | 带 mono 编号的条目，左侧一道 hover 才亮的竖条 |

### 几个具体决定

**hero 右侧做成「取样面板」而不是插画。**
深色代码块 + 语法高亮 + 迷你损失曲线 + 三个指标（`0.1032` / `0.9672` / `14 次`）。
理由是本站的差异化就是「参数 ↔ 代码 联动」，那首屏最该证明的就是这件事，
而不是放一张抽象的神经网络插画。曲线复用背景层那条曲线的**同一套公式**
（`0.97·e^(-4.1u) + 0.05 + 0.028·sin(19u)·e^(-2.2u)`），
所以首页的「示意」和背景的「氛围」是同一条线，不是随手画的。

**卡片上加 sklearn 入口标签。**
给 `DemoMeta` 加了一个 `api` 字段（`LinearRegression` / `SVC` / `KMeans` …），
渲染成 `>>> LinearRegression` 这样的等宽标签。这一条直接回应
「文字信息过于单调」—— 每张卡片多了一层「玩完能带走哪一行代码」的信息。

**学习路线画成流，不折行。**
`overflow-x: auto` + 连接线画在容器伪元素上（节点盖在上面，滚动时线跟着走）。
折行会把「这是一条有方向的路线」这个信息毁掉。
桌面端 1180px 能放下 10 步（节点用 `flex: 1 1 0` 等分 + `min-width: 92px` 兜底），
窄屏转横向滚动。
节点之间用 `align-items: stretch` 让它们等高 —— 否则「Logistic 回归」
这种要换两行的名字会把单独那一格撑高，整排看着没对齐。

**主题一致性：面板色也改暖。**
底色换成黑红之后，卡片面板还是原来的蓝灰（`#161a22`），
整页变成「蓝灰卡片浮在红底上」，两个色温打架。
把深色主题的中性面统一往酒红偏一点（`--bg: #120a0c`、`--bg-elev: #1b1114`、
`--border: #35242b` …），亮度梯度保持不变，所以层级关系没动。

**顺手修掉一处双份定义。**
`core/chart.ts` 的 `palette()` 硬编码了一整套深灰蓝给 ECharts 用，
和 `tokens.css` 里的变量是两份数据。主题一变，图表的网格/坐标轴/散点描边
还是冷的，和页面不是一个色温，而且改主题要改两个地方。
改成从 CSS 变量读，`tokens.css` 成为唯一颜色来源。

---

## 6. ⚠️ 本轮逮到的两个真 bug

### ① `.hero` 的 padding 简写冲掉了 `.container` 的左右内边距

`layout.css` 里：

```css
.container { padding: 0 var(--sp-5); }   /* 左右 24px */
.hero      { padding: var(--sp-8) 0 var(--sp-6); }  /* ← 简写把左右覆盖成 0 */
```

`.hero` 同时挂着 `.hero` 和 `.container` 两个类，`layout.css` 里 `.hero`
写在 `.container` 后面，于是那个简写的 `0` 把左右内边距吃掉了。
我在 `home.css` 里只覆盖了 `padding-top` / `padding-bottom`，
以为修好了 —— 结果 computed padding 仍然是 `"48px 0px 32px"`。

**定位方式**：直接在浏览器里读 `getComputedStyle(hero).padding`，
一眼看出左右是 0。改完是 `"64px 24px 48px"`（桌面）/ `"48px 16px 32px"`（移动）。

> 教训：用 `padding` 简写去覆盖一个已经带了 padding 的类，会连带把其它方向
> 一起清零。**组件类的内边距只用单方向属性写**（`padding-top` 等）。

### ② canvas 缓冲区与 CSS 盒差 10px

`resize()` 用 `layer.clientWidth` 量尺寸。首屏渲染时页面还没有滚动条（1406），
内容加载出来后滚动条一出现就变成 1396；而 `window.resize` 不会因为滚动条
出现而触发，尺寸一直停在首次测量值 —— 画布被横向压扁 0.7%。

改成读 `canvas.clientWidth` 并加一个 `ResizeObserver` 盯着它，
现在缓冲区与 CSS 盒精确一致（`1396x1503` = `1396x1503`）。

---

## 7. 回归

| 项目 | 结果 |
|---|---|
| 类型检查 | 0 错误（接手时 50 个） |
| 首页 e2e | 24/24 |
| 全站 e2e（10 页） | **全绿，0 失败** |
| 十套算法对拍 | **10/10 通过** |
| 渲染器单元测试 | 24/24 |
| reduced-motion | canvas 静止、动画 none、58.7fps |
| DPR 上限 | 设备 3 → 缓冲区 2 倍 |
| 移动端 | 视差关闭、背景正常绘制 |

新增可复跑入口：`verify:bg`、`verify:bg:motion`、`verify:bg:dpr`、
`verify:bg:mobile`、`shot:home`。

### 顺手补的两个缺

重排之后发现有两个「有测试但跑不到」的地方，一并补上：

1. **首页的 e2e 断言没有 npm 入口。** `scripts/tests/home.js` 一直存在，
   但 `npm run e2e` 指向的是**决策树页**（历史遗留命名），首页那套断言从来
   没被任何入口调用过。现在加了 `e2e:home`，并把首页断言从「一个聚合 `ok`」
   改写成和其它页一致的 `passed / total` 约定、补到 20 条 ——
   包含卡片刻度（10 张、10 个 id 都能点到）、hero 分栏、四个硬数字、
   流水线 10 步 + 9 个箭头、每张卡片都有编号与 sklearn 入口标签、
   背景层层级（fixed / z-index 0 / pointer-events none / 内容层 z-index 10）、
   以及「页面没有横向溢出」。
   > 重排最容易静默弄丢的就是这类结构性事实，断言写细一点值得。

2. **没有「一条命令跑完全部」的入口。** 三层质量保证（类型+单测 / 页面 e2e /
   算法对拍）要手敲二十几条 `npm run xxx`，很容易漏跑一层（我漏过）。
   新增 `scripts/verify-all.mjs`，23 步串行执行、失败不中断、最后统一汇总
   并给出退出码：

   ```
   npm run verify:all              # 全跑，23 步
   npm run verify:all -- --list     # 只列出会跑什么
   npm run verify:all -- --only=e2e # 只跑页面断言
   npm run verify:fast              # 跳过对拍
   ```

   实测全量 **23/23 通过，209.4 秒**（神经网络页 e2e 34.5s + 十套对拍是主要开销）。
   失败分支也实测过（临时把某一步换成必定失败的脚本）：标记 ❌、打印该步输出尾部、退出码 1。

3. **写了 `docs/RUNBOOK.md`** —— 本机启动与验证手册，所有命令都实测过。
   其中一个值得单独记的发现：**Vite 5 在这台机器上只监听 IPv6 `[::1]`**，
   所以 `http://localhost:5173/` 能开、`http://127.0.0.1:5173/` 打不开
   （`preview` 的 4173 同理）。所有 e2e 脚本内部显式传 `--host 127.0.0.1`，
   所以它们用 127.0.0.1 没问题 —— 这个不对称很容易让人以为是脚本坏了。


---

## 8. 关于「技术：React + Canvas / Three.js / 纯 CSS」

需求里列的是**可选项**，这里选的是 **Canvas + 纯 CSS**，理由：

- 本项目的 10 个演示页是**无框架的原生 TS + Vite**（`src/pages/*.ts`
  直接操作 DOM，算法模块全部手写且和 sklearn 逐项对拍）。
  为了一个背景层引入 React，等于给一个已经跑通、有 10 套对拍兜底的
  项目换地基，风险和收益完全不成比例。
- Three.js 也不必要：这一层要画的是几十个光点、几条线、一条曲线，
  2D canvas 完全够用；上 WebGL 反而要处理上下文丢失、着色器、包体积
  （当前 bundle 的主项已经是 ECharts + KaTeX）。
- 需求里的「只用 transform/opacity」「60fps」这些约束，2D canvas + CSS
  都能满足，而且更容易守住（见第 3 节）。

如果之后要做 3D 的模型拓扑或粒子场，再单独评估 Three.js 会更合理。

---

## 9. 文件清单

**新增**

- `src/styles/home.css` —— 首页新布局（按区块组织，带性能与取舍注释）
- `scripts/verify-all.mjs` —— 一键全量回归（23 步）
- `docs/RUNBOOK.md` —— 本机启动与验证手册
- `scripts/tests/probe-bgperf.js` —— 背景性能与 reduced-motion/DPR 验证
- `scripts/tests/probe-mobile.js` —— 移动端降级验证
- `scripts/tests/probe-overflow.js` —— 横向溢出与容器内边距检查
- `scripts/tests/shot-home-dark.js` / `shot-home-light.js` / `shot-dark-any.js`

**修改**

- `src/core/background.ts` —— 修 50 个类型错误；canvas 尺寸改用自身布局盒 +
  `ResizeObserver`；`will-change` 按需开；关视差时清 transform；30fps 限流
- `src/styles/tokens.css` —— 节点/连线改青蓝；深色中性面全部改暖调；
  浅色主题网格与光晕收敛
- `src/styles/background.css` —— 光晕缩范围 + 只动 transform + 独立合成层；
  删掉噪点动画；浅色主题单独压档；reduced-motion 块同步更新
- `src/styles/layout.css` —— `.hero` 的 padding 简写改成单方向
- `src/core/chart.ts` —— `palette()` 改读 CSS 变量
- `src/data/demos.ts` —— `DemoMeta` 新增 `api` 字段（10 个页面各填上）
- `src/pages/home.ts` —— 首页重写（hero 取样面板 / 流水线路 / 编号卡片 / 编号条目）
- `scripts/tests/home.js` —— 从聚合 `ok` 改成 20 条具名断言，覆盖新结构
- `index.html` —— hero 结构重排
- `src/styles/index.css` —— 引入 `home.css`
- `scripts/e2e.mjs` —— 新增 `--viewport` / `--reduced-motion` / `--dpr` / `--size`
- `package.json` —— 新增 `e2e:home`、`e2e:tree`、`verify:all`、`verify:fast`、
  `verify:bg*`、`shot:home`

---

## 10. 遗留

- **没在真机上量过帧率。** 手头的无头 Edge 只能软件光栅化，所以文中只给了
  同环境的前后对比和瓶颈归因，没有「稳定 60fps」这种结论。如果要做发布前的
  性能验收，需要一台带 GPU 的机器跑一次 —— 这一步还没做。
- 决策树页 Canvas 绘制的历史遗留项（任务 #4 / #5），非本轮范围。
- 用户提过的「单独整理一篇成体系的 PCA 笔记」，尚未确认是否需要。
