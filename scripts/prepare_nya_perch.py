"""
把用户给的「扒着板子探头」那张图做成：

  1. `nya.webp`         —— 身体（含耳朵、睁眼），给"减少动态效果"的用户 + 静态用
  2. `nya-twitch.webp`  —— 动图：耳朵甩动 + 眨眼，趴到对话窗口上沿时用

背景的构成比想象中复杂，所以抠图分三步（每一步针对一种"白"）：

  外部背景 (~249)  ┐
  板面     (~253)  ├─ 三者亮度只差 4~18，靠单一阈值分不开
  板子描边 (~140)  ┘  而且她的女仆头饰、白袖口也都是白的

  A. 从画面四边区域生长 → 吃掉外部背景。停在她的描边和板子描边上。
  B. 从板面内部区域生长 → 吃掉板面本身。停在她的手/袖口的深色描边。
     ⚠️ 种子必须避开板子内部那三条灰色横线（在 y≈1280），
        一开始种子放在 y=1300 正好压线，结果一个像素都没吃到。
  C. 定向清除板子描边：它是一条**中性灰**曲线。判据用"三通道接近（纯灰）
     + 亮度居中"，这样她的暖色皮肤和亮白袖口都不会被误伤。

最后裁到内容框（底部正好保到她的手指），缩放，然后做两套动画。

⚠️ 裁剪框底部的选择是有取舍的：板子的残迹集中在最下面约 22 行，
   而她的手指就在那附近。所以裁到"露出约 2/3 手指"的位置，
   剩下那 22 行的残迹**由对话面板盖住**（见 nya.ts 的 PERCH_OVERLAP）。
"""

from collections import deque
from dataclasses import dataclass
import math
from pathlib import Path

from PIL import Image, ImageFilter


@dataclass
class EarSpec:
    """一只耳朵的几何。

    box   —— 影响范围的矩形上限（缩放后坐标）
    pivot —— 耳朵根部，弯曲就是绕它转
    tip   —— 耳尖，决定"沿耳轴"的方向和耳长
    sign  —— 向外甩动的方向（左耳 -1、右耳 +1）
    """

    name: str
    box: tuple[int, int, int, int]
    pivot: tuple[float, float]
    tip: tuple[float, float]
    sign: int

    @property
    def length(self) -> float:
        return math.hypot(self.tip[0] - self.pivot[0], self.tip[1] - self.pivot[1])

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / ".shots" / "nya-src" / "perch-src.jpg"
OUT_DIR = ROOT / "src" / "assets"

# 显示高度约 150px，2 倍图 ⇒ 300px
TARGET_H = 300

# 裁剪线的取舍（这里踩了很久，写清楚免得以后又绕回来）：
#
#   她双手扒着板子上沿，手指越过边线垂到板面上（原图 y 约 1000~1130）。
#   板子的上沿外线在 y≈1049。
#
#   想保住完整的手指，就得把板面 + 板子的双层边框全部抠干净；
#   但她的**白袖口和板面在同一区域，且颜色上分不开**（都是中性浅色），
#   抠板面必然连带切掉袖口。
#
#   试过裁在边线上方（y=1044）：手指全没了，她只剩一个头 —— 更糟。
#   最后选择裁在 y=1100（保住手指），把板子最下面约 8px 的残迹
#   **交给对话面板的上边框盖住**（见 nya.ts 的 PERCH_OVERLAP）。
#   面板自己有一条 1px 边框，剩下的那一点点浅色线正好和它融在一起。

# 板子的上沿外线在 y≈1049~1053（平坦段），两端因圆角向下弯
STROKE_SEEDS = [(150, 1120), (250, 1093), (1700, 1052)]
CROP_BOTTOM = 1100
# 板面内部取种子的高度（避开 y≈1280 的横线）
BOARD_SEED_Y = 1150

# 耳朵裁剪框（原图坐标）+ 旋转支点（耳朵根部，旋转绕它才自然）
EAR_L_BOX = (300, 30, 780, 580)
EAR_L_PIVOT = (680, 520)
EAR_R_BOX = (1180, 40, 1620, 510)
EAR_R_PIVOT = (1270, 490)

"""
耳尖坐标 —— **必须手工量**，不能让脚本去找。

裁剪框里混进了头顶的呆毛和脸侧的头发，所以"离支点最远的像素"会选到呆毛上
（实测选到身体图坐标 (210,2)，也就是那根呆毛），于是整条旋转轴偏掉，
甩起来呆毛跟着动、耳朵却不动。这两个点是照着放大图一个个读出来的。

左耳尖：原图 (332,177)  —— 两条描边交汇的那个尖
右耳尖：原图 (1480,90)  —— 耳朵最高的那个尖
"""
EAR_L_TIP = (332, 177)
EAR_R_TIP = (1480, 90)

# ---------------------------------------------------------------------------
# 耳朵甩动：**局部弯曲**，不是把耳朵当贴纸整体转
# ---------------------------------------------------------------------------
#
# 上一版的做法（单独切一层耳朵、在 CSS 里 rotate）有两个问题，都是实测出来的：
#
#   ① 身体图上**本来就有耳朵**。图层转到一边时，底下那只静止的耳朵就露出来了
#      —— 用户看到的是"两对耳朵"。
#   ② 呼吸动画作用在身体图上，而耳朵图层是它的兄弟节点、不跟着动，
#      于是两者错位最多 9px（实测 0% 相位对齐、50% 相位差 9px），也是"两对耳朵"。
#
# 现在改成：不切层了，直接对**整张立绘**做一次局部网格形变。
# 每个像素按它"沿耳轴走到哪、离轴多远"决定被转多少 ——
# 耳根几乎不动、耳尖转得最多，所以耳朵是**弯**出去的。
# 旋转走开的区域由旁边的像素被拉过来补上：天空拉过来看不出来，
# 头饰是平的也看不出来，于是既没有接缝、也没有第二只耳朵。

# 沿耳轴的权重：走到 RAMP_IN 之前完全不动（那是埋在头发里的耳根），
# 走到 RAMP_FULL 时满权重（基本就是耳尖）
RAMP_IN = 0.22
RAMP_FULL = 0.92
# 耳根处的半宽 ≈ 这个比例 × 耳长（耳朵近似三角形，往外收窄）
HALF_WIDTH = 0.34
# 离轴超过半宽之后，再多少像素衰减到 0
OFF_AXIS_FALLOFF = 9.0

# 网格边长：6px 已经足够平滑，再细对观感没有帮助、只增加耗时
GRID = 6
# 影响范围外扩量：必须**实测覆盖整个权重场**（见 ear_weight 的 beyond 说明），
# 否则贴回矩形的边界会切掉正在移动的像素，出现一道硬边。
PAD = 40
# 甩动的最大角度（度）。8° 时耳尖位移约 19px（显示尺寸约 10px），
# 够明显但不至于像"耳朵要掉下来"
BEND_MAX = 8.0

# 一次甩动的时间线：(秒, 弯曲量 0~1)。甩出去 → 回弹 → 二次余振 → 归位。
# 两个耳朵**各自独立**跑这条曲线，起始时间错开 ⇒ 不会同步抖（同步像机器）。
TWITCH = (
    (0.00, 0.00),
    (0.05, 0.60),
    (0.10, 1.00),
    (0.16, 0.35),
    (0.22, 0.72),
    (0.30, 0.18),
    (0.38, 0.26),
    (0.50, 0.00),
)

# ---------------------------------------------------------------------------
# 眨眼：**合成**出来的，不是把眼睛压扁
# ---------------------------------------------------------------------------
#
# 走过的弯路（别再绕回去）：
#   · 几何压扁：位移场必折叠。按"向闭合线收缩"定义位移场后，
#     q 处的一阶导是 1 + amount·(w + (q−L)·w')，衰减区里 w'<0 而 (q−L) 又大，
#     必然变号 ⇒ 映射折叠（实测在离闭合线 ~37px 处折叠）。
#     要让导数恒正，衰减宽度得 ≥52px，那等于把整张脸卷进来。
#   · 逐列填皮肤：眼睛正下方有腮红斜线，被抹成竖条纹。
#   · 调和插值：边界取到刘海（深色），整块补丁被渗成黑的。
#
# 最终做法：
#   ① 逐列求「刘海下沿」= 区域顶往下第一个亮像素。**那条线以上原样保留**
#      —— 刘海被平切是肉眼最敏感的破绽，绝不能动。
#   ② 以下用**三段色调锚点**铺皮肤（都是实测值）：
#        眼皮 = 刘海下沿那几行的真实皮肤（上眼皮被刘海压着，本来就暗）
#        眼侧 = 眼框左右外侧的皮肤（浅白，眼周主色调）
#        眼下 = 眼下那一行做横向滑动平均（抹掉腮红 ⇒ 不再有竖条纹）
#      左右两列再朝"同行最近的皮肤色"渐变靠 ⇒ 补丁边界消失。
#   ③ 闭眼线 = 原图上睫毛的**暗核心**逐列提取 → 滑动平均 → 二次拟合
#      （拟合出一条光滑的弧）→ 内眼角一侧收细。
#      好处：形状和颜色天然和原画一致，不是我们"画"出来的。
#   ④ 中间帧用**交叉淡化**（睁 ↔ 闭 的 alpha 混合）—— 闭眼的过程只有 200ms，
#      淡化出来的过渡帧肉眼分辨不出。

EYES = {
    "l": (173, 185, 228, 246),
    "r": (271, 184, 326, 243),
}
SKIN_FALLBACK = (250, 236, 234)

PAD_X = 4              # 眼框左右各外扩（补丁范围）
PAD_BOTTOM = 4
SEARCH_UP = 8          # 从眼框上沿再往上找多少行（用来找刘海下沿）
BRIGHT = 178           # 判定"亮像素（皮肤/眼睛）"的阈值
FEATHER = 2.5          # 上沿羽化
EDGE_FEATHER = 3       # 左/右/下三边羽化
MAX_TOP_DROP = 0.22    # 刘海下沿最多允许探这么深（防横跨眼睛的细发丝把整列判成刘海）
BOTTOM_BLUR = 9        # 眼下那一行的横向平均宽度
GRAD_POW = 2.2         # 下半段渐变指数（越大 ⇒ 粉色越集中在最下面几行）
LID_RAMP = 11          # 从"刘海下的暗眼皮"过渡到"眼侧浅皮肤"的深度
EDGE_BLEND = 6         # 左右各多少像素朝边界真实色靠

LASH_BAND = 20         # 从眼框上沿往下取多少行找睫毛暗核心
LASH_AT = 0.60         # 闭眼线中心落在眼框高度的哪里
LASH_SMOOTH_WIN = 5
LASH_MIN_T = 2.2
LASH_MAX_T = 5.5
LASH_MAX_CURVE = 7.0   # 拟合出的弧最多偏离均值多少 px（防止外推跑飞）
INNER_TAPER = 0.4      # 内眼角一侧收细到多少

# 一次眨眼的时间线：(距开始秒, 闭合度 0=睁 1=闭)
# 快闭（85ms）→ 保持（30ms）→ 稍慢睁（125ms），总共 240ms。
BLINK = (
    (0.000, 0.00),
    (0.055, 0.85),
    (0.085, 1.00),
    (0.115, 1.00),
    (0.160, 0.45),
    (0.240, 0.00),
)

# 一个循环里安排两次甩耳、两次眨眼，时间点**故意不对称**
# （等间隔会读成节拍器；眨眼本来就不规律）
TWITCH_L_AT = 0.9
TWITCH_R_AT = 3.6
BLINK_AT = (2.05, 5.30)
ANIM_CYCLE = 7.4


def smoothstep(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def ear_weight(x: float, y: float, ear: "EarSpec") -> float:
    """点 (x,y) 参与多少旋转：0 = 完全不动，1 = 满角度。"""
    ax, ay = ear.tip[0] - ear.pivot[0], ear.tip[1] - ear.pivot[1]
    length = math.hypot(ax, ay) or 1.0
    ux, uy = ax / length, ay / length
    rx, ry = x - ear.pivot[0], y - ear.pivot[1]
    along = rx * ux + ry * uy
    off = abs(rx * -uy + ry * ux)

    ramp = smoothstep((along / length - RAMP_IN) / (RAMP_FULL - RAMP_IN))
    half = max(4.0, HALF_WIDTH * length * (1.0 - 0.75 * max(0.0, along / length)))
    # 耳尖之外要**明确收尾**：half 在 along/length > 1 之后不再收窄，
    # 于是会形成一条沿耳轴无限延伸的胶囊（实测一路伸到 x=27，比裁剪框还靠左 48px），
    # 贴回矩形就框不住它了。这里在越过耳尖一点点之后把权重掐掉。
    beyond = 1.0 - smoothstep((along - length * 1.02) / 18.0)
    taper = (1.0 - smoothstep((off - half) / OFF_AXIS_FALLOFF)) * beyond
    return ramp * taper


def warp_ears(img: Image.Image, ears: list["EarSpec"], bends: tuple[float, float]) -> Image.Image:
    """按两只耳朵各自的弯曲量，对整张图做局部网格形变。"""
    W, H = img.size
    active = [
        (ear, math.radians(ear.sign * BEND_MAX * bend))
        for ear, bend in zip(ears, bends)
        if abs(bend) > 1e-6
    ]
    if not active:
        return img.copy()

    def source_of(x: float, y: float) -> tuple[float, float]:
        """输出点 (x,y) 对应原图的哪个点（近似逆映射）。

        位移最大 19px、且是缓变的，用"在该点求正向位移再减掉"的近似完全够
        —— 真做数值反解要多几十倍耗时，换来的差别看不出来。
        """
        dx = dy = 0.0
        for ear, angle in active:
            w = ear_weight(x, y, ear)
            if w <= 0.0:
                continue
            a = angle * w
            rx, ry = x - ear.pivot[0], y - ear.pivot[1]
            ca, sa = math.cos(a), math.sin(a)
            dx += (ear.pivot[0] + rx * ca - ry * sa) - x
            dy += (ear.pivot[1] + rx * sa + ry * ca) - y
        return x - dx, y - dy

    quads = []
    for ear, _ in active:
        x0, y0, x1, y1 = ear.box
        for gx in range(max(0, x0 - PAD), min(W, x1 + PAD), GRID):
            for gy in range(max(0, y0 - PAD), min(H, y1 + PAD), GRID):
                cx, cy = min(gx + GRID, W), min(gy + GRID, H)
                # PIL 的 QUAD 顺序是 左上 / 左下 / 右下 / 右上
                src: list[float] = []
                for px_, py_ in ((gx, gy), (gx, cy), (cx, cy), (cx, gy)):
                    sx, sy = source_of(px_, py_)
                    src.extend([sx, sy])
                quads.append(((gx, gy, cx, cy), tuple(src)))

    warped = img.transform((W, H), Image.Transform.MESH, quads, resample=Image.BICUBIC)

    # 只把有影响的矩形贴回去 —— 其余地方保持原样，一个像素都不动
    out = img.copy()
    for ear, _ in active:
        x0, y0, x1, y1 = ear.box
        rx0, ry0 = max(0, x0 - PAD), max(0, y0 - PAD)
        rx1, ry1 = min(W, x1 + PAD), min(H, y1 + PAD)
        out.paste(warped.crop((rx0, ry0, rx1, ry1)), (rx0, ry0))
    return out


# --------------------------- 闭眼合成 ---------------------------


def _bright(px, x, y):
    r, g, b, a = px[x, y]
    return (r + g + b) / 3 if a > 120 else 0.0


def _is_skin_px(px, x, y):
    r, g, b, a = px[x, y]
    v = (r + g + b) / 3
    return a > 120 and v > 188 and (max(r, g, b) - min(r, g, b)) > 8


def _smooth_1d(seq, win):
    half = win // 2
    n = len(seq)
    out = []
    for i in range(n):
        lo, hi = max(0, i - half), min(n, i + half + 1)
        vals = [v for v in seq[lo:hi] if v is not None]
        out.append(sum(vals) / len(vals) if vals else None)
    return out


def _nearest_skin(px, x_from, y, step, span=14):
    """从 x_from 沿 step 方向找最近的皮肤像素色。"""
    x = x_from
    for _ in range(span):
        if x < 0:
            return None
        if _is_skin_px(px, x, y):
            return px[x, y][:3]
        x += step
    return None


def _smooth_cross(px, x, y, win, W):
    """跨列滑动平均取色（抹掉腮红斜线这种横向条纹）。"""
    half = win // 2
    acc = [0.0, 0.0, 0.0]
    n = 0
    for xx in range(x - half, x + half + 1):
        if xx < 0 or xx >= W:
            continue
        r, g, b, a = px[xx, y]
        if a < 120:
            continue
        acc[0] += r
        acc[1] += g
        acc[2] += b
        n += 1
    if not n:
        return SKIN_FALLBACK
    return (acc[0] / n, acc[1] / n, acc[2] / n)


def eye_top_per_column(px, box, H):
    """逐列求「刘海下沿」：区域顶往下第一个亮像素。"""
    x0, y0, x1, y1 = box
    tops = {}
    limit = y0 + round((y1 - y0) * MAX_TOP_DROP)
    for x in range(x0 - PAD_X, x1 + PAD_X + 1):
        found = None
        for y in range(max(0, y0 - SEARCH_UP), y1):
            if _bright(px, x, y) > BRIGHT:
                found = y
                break
        if found is None or found > limit:
            found = limit
        tops[x] = found
    return tops


def tone_anchors(px, box, tops, W, H):
    """三个色调锚点：刘海下的眼皮 / 眼侧皮肤 / 眼下（已横向平均）。"""
    x0, y0, x1, y1 = box

    def mean_of(points):
        acc = [0.0, 0.0, 0.0]
        n = 0
        for x, y in points:
            if 0 <= x < W and 0 <= y < H and _is_skin_px(px, x, y):
                r, g, b, _ = px[x, y]
                acc[0] += r
                acc[1] += g
                acc[2] += b
                n += 1
        return (acc[0] / n, acc[1] / n, acc[2] / n) if n >= 8 else None

    top_pts = []
    for x in range(x0 - PAD_X, x1 + PAD_X + 1):
        ys = tops.get(x, y0)
        for y in range(ys, min(ys + 5, y1)):
            top_pts.append((x, y))
    mid_pts = []
    for x in (x0 - PAD_X - 2, x0 - PAD_X - 3, x1 + PAD_X + 2, x1 + PAD_X + 3):
        for y in range(y0 + 6, y1):
            mid_pts.append((x, y))

    top = mean_of(top_pts) or SKIN_FALLBACK
    mid = mean_of(mid_pts) or top
    bot = _smooth_cross(px, (x0 + x1) // 2, min(y1 + 4, H - 1), BOTTOM_BLUR, W)
    return top, mid, bot


def lash_line(px, box):
    """逐列取上睫毛暗核心 → 平滑 → 二次拟合，得到一条光滑的闭眼线。"""
    x0, y0, x1, y1 = box
    xs, centers, thicks, colors = [], [], [], []
    for x in range(x0, x1 + 1):
        vals = []
        for y in range(y0, min(y0 + LASH_BAND, y1)):
            if _bright(px, x, y) <= 120:
                r, g, b, a = px[x, y]
                vals.append((y, (r + g + b) / 3, (r, g, b)))
        if not vals:
            continue
        vmin = min(v for _, v, _ in vals)
        core = [t for t in vals if t[1] < vmin + 58] or [min(vals, key=lambda t: t[1])]
        cs = sorted((t[2] for t in core), key=lambda c: sum(c))
        xs.append(x)
        centers.append(sum(t[0] for t in core) / len(core))
        thicks.append(len(core))
        colors.append(cs[max(0, len(cs) // 4)])

    centers = _smooth_1d(centers, LASH_SMOOTH_WIN)
    thicks = _smooth_1d(thicks, LASH_SMOOTH_WIN)
    cols = [_smooth_1d([c[i] for c in colors], 5) for i in range(3)]

    n = len(xs)
    mean_x = sum(xs) / n
    mean_c = sum(centers) / n
    s11 = s12 = s22 = t0 = t1 = 0.0
    for x, c in zip(xs, centers):
        dx = x - mean_x
        s11 += dx * dx
        s12 += dx * dx * dx
        s22 += dx ** 4
        t0 += dx * c
        t1 += dx * dx * c

    # 最小二乘拟 c ≈ a0 + a1·dx + a2·dx²（Σdx = 0，消去 a0 后剩 2×2）
    #
    # ⚠️ 这里我连错两版，记下来：
    #   第一版把 a1/a2 的公式写反 ⇒ 线性项被当成二次项，拟合出振幅 50px 的大抛物线。
    #   第二版照搬 "2×2 的 Cramer 公式"，但漏了**必须先减掉均值**：
    #     消去 a0 后的两个方程是
    #       s11·a1 + s12·a2          = t0
    #       s12·a1 + (s22−s11²/n)·a2 = t1 − s11·mean_c
    #   直接拿 [s11 s12; s12 s22] 去解，a2 会大一个量级（实测线跑到 y=516）。
    A, B, C = s11, s12, s22 - s11 * s11 / n
    rhs1, rhs2 = t0, t1 - s11 * mean_c
    det = A * C - B * B
    if abs(det) > 1e-6:
        a1 = (C * rhs1 - B * rhs2) / det
        a2 = (A * rhs2 - B * rhs1) / det
    else:
        a1 = a2 = 0.0
    a0 = mean_c - a2 * s11 / n

    dev = max(abs(a2 * (x - mean_x) ** 2) for x in xs) if abs(a2) > 0 else 0.0
    if dev > LASH_MAX_CURVE:
        a2 *= LASH_MAX_CURVE / dev

    line = []
    for i, x in enumerate(xs):
        dx = x - mean_x
        c_fit = a0 + a1 * dx + a2 * dx * dx
        f = (x - xs[0]) / max(1, xs[-1] - xs[0])
        inner = f if x0 == EYES["l"][0] else (1 - f)
        taper = 1.0 - (1.0 - INNER_TAPER) * (inner ** 3)
        t = max(LASH_MIN_T, min(LASH_MAX_T, (thicks[i] or 3) * 0.62)) * taper
        line.append((x, c_fit, t, tuple(round(cols[k][i]) for k in range(3))))
    return line, mean_c


def closed_eyes(img: Image.Image) -> Image.Image:
    """返回"两只眼睛都闭上"的整图（闭合度 1）。其余部分一个像素不动。"""
    out = img.copy()
    W, H = img.size
    jobs = build_eye_jobs(out)
    for job in jobs:
        patch, origin, mask = job.frame(1.0)
        out.paste(patch, origin, mask)
    return out


# --------------------------- 眼睛作业（逐帧复用） ---------------------------


@dataclass
class EyeJob:
    """一只眼睛的预计算数据 —— 有了它，每帧只要按闭合度切一刀。

    ⚠️ 为什么不"每帧重新合成"：合成里有扫描全图找刘海下沿、逐列取睫毛暗核心、
      二次拟合这些活儿，逐帧做等于白算 29 遍。这里算一次、存下来。
    """

    box: tuple[int, int, int, int]
    origin: tuple[int, int]
    size: tuple[int, int]
    tops: dict
    base: list                      # 皮肤渐变（覆盖整个补丁高度，按绝对 y 算，不随闭合度变）
    line: list                      # [(x, 闭眼线基准 y, 厚度, 颜色)]
    mean_c: float

    def frame(self, coverage: float):
        """按闭合度生成 (补丁, 原点, 遮罩)。

        闭合度 0 = 完全睁开（不会走到这里，调用方会跳过），1 = 完全闭上。

        做法：眼睑**从刘海下沿往下压**到闭眼线的位置 ——
        线以上铺皮肤、线上画闭眼线、线以下保留原画的瞳孔。
        所以中间帧是真的"半闭眼"，不是两张图交叉淡化（淡化会出现两层眼睛的鬼影）。
        """
        x0, y0, x1, y1 = self.box
        X0, Y0 = self.origin
        W_, H_ = self.size
        c = max(0.0, min(1.0, coverage))

        patch = Image.new("RGBA", (W_, H_), (0, 0, 0, 0))
        pp = patch.load()
        mask = Image.new("L", (W_, H_), 0)
        mp = mask.load()

        base_y = y0 + (y1 - y0) * LASH_AT
        box_bottom = y1 + PAD_BOTTOM

        for i in range(W_):
            x = X0 + i
            ys = self.tops.get(x, y0)
            for j in range(H_):
                y = Y0 + j
                if y < ys:
                    continue
                # 这一列闭眼线在哪
                li = self.line[i] if i < len(self.line) else None
                if li is None:
                    lid_y = ys + (base_y - ys) * c
                else:
                    lid_y = ys + ((base_y + li[1] - self.mean_c) - ys) * c
                if c >= 0.6:
                    # 眼睑接近闭合时，**下眼睑也一起抬上来**：
                    # 只让上眼睑下压是不够的 —— 瞳孔下半还露在闭眼线下面（实测 c=0.85
                    # 时会露出一截瞳孔，看起来像半睁而不是快闭上）。所以这里让遮盖面向下延展。
                    k = (c - 0.6) / 0.4
                    bottom = lid_y + (box_bottom - lid_y) * (k ** 0.8)
                else:
                    bottom = lid_y
                if y > bottom + 2:
                    continue
                # 皮肤（渐变按绝对 y 取，不随闭合度变 —— 否则眼睑下压时明暗会跟着飘）
                pp[i, j] = self.base[i][j]
                # 遮罩：上沿羽化、下沿（眼睑边缘）羽化 2px
                a = 255 if (y - ys) >= FEATHER else 255 * ((y - ys) + 1) / (FEATHER + 1)
                if y > bottom - 1.2:
                    a = min(a, 255 * max(0.0, (bottom + 1.2 - y) / 2.4))
                a = min(a, 255 * (i + 1) / (EDGE_FEATHER + 1))
                a = min(a, 255 * (W_ - i) / (EDGE_FEATHER + 1))
                mp[i, j] = max(0, min(255, round(a)))

        # 闭眼线画在眼睑边缘上
        for i, li in enumerate(self.line):
            x, c_fit, t, color = li
            if i >= W_:
                break
            ys = self.tops.get(x, y0)
            lid_y = ys + ((base_y + c_fit - self.mean_c) - ys) * c
            t_eff = t * (0.65 + 0.35 * c)
            top, bot = lid_y - t_eff / 2, lid_y + t_eff / 2
            for y_orig in range(int(top) - 1, int(bot) + 2):
                if y_orig < ys:
                    continue
                pj = y_orig - Y0
                if pj < 0 or pj >= H_:
                    continue
                cov = min(1.0, max(0.0, min(bot, y_orig + 1) - max(top, y_orig)))
                if cov <= 0:
                    continue
                if mp[i, pj] == 0:
                    continue
                r0, g0, b0, _ = pp[i, pj]
                pp[i, pj] = (round(r0 * (1 - cov) + color[0] * cov),
                             round(g0 * (1 - cov) + color[1] * cov),
                             round(b0 * (1 - cov) + color[2] * cov), 255)
        return patch, self.origin, mask


def build_eye_jobs(img: Image.Image) -> list["EyeJob"]:
    """把两只眼睛的合成数据算出来（皮肤渐变 + 闭眼线），供逐帧复用。"""
    px = img.load()
    W, H = img.size
    jobs = []
    for name, box in EYES.items():
        x0, y0, x1, y1 = box
        tops = eye_top_per_column(px, box, H)
        top_ref, mid_ref, bot_ref = tone_anchors(px, box, tops, W, H)
        line, mean_c = lash_line(px, box)

        X0 = x0 - PAD_X
        Y0 = max(0, y0 - SEARCH_UP)
        W_ = x1 + PAD_X - X0 + 1
        H_ = y1 + PAD_BOTTOM - Y0 + 1

        # 皮肤渐变：竖直方向分三段（眼皮 → 眼侧 → 眼下），再朝左右边界对齐
        cols = []
        for i in range(W_):
            x = X0 + i
            ys = tops.get(x, y0)
            bot = _smooth_cross(px, x, min(y1 + 4, H - 1), BOTTOM_BLUR, W)
            span = max(1, y1 + PAD_BOTTOM - ys)
            col = []
            for j in range(H_):
                y = Y0 + j
                d = y - ys
                if d < 0:
                    col.append((0, 0, 0, 0))
                elif d < LID_RAMP:
                    k = (d / LID_RAMP) ** 1.6
                    col.append(tuple(round(top_ref[ch] * (1 - k) + mid_ref[ch] * k) for ch in range(3)) + (255,))
                else:
                    k = ((d - LID_RAMP) / max(1, span - LID_RAMP)) ** GRAD_POW
                    col.append(tuple(round(mid_ref[ch] * (1 - k) + bot[ch] * k) for ch in range(3)) + (255,))
            cols.append(col)

        for j in range(H_):
            y = Y0 + j
            lcol = _nearest_skin(px, X0 - 1, y, -1)
            rcol = _nearest_skin(px, x1 + PAD_X + 1, y, +1)
            for i in range(EDGE_BLEND):
                w = 1.0 - i / EDGE_BLEND
                for idx, col in ((i, lcol), (W_ - 1 - i, rcol)):
                    if col is None or idx < 0 or idx >= W_:
                        continue
                    r, g, b, a = cols[idx][j]
                    if a == 0:
                        continue
                    cols[idx][j] = (round(r * (1 - w) + col[0] * w),
                                    round(g * (1 - w) + col[1] * w),
                                    round(b * (1 - w) + col[2] * w), 255)

        jobs.append(EyeJob(box=box, origin=(X0, Y0), size=(W_, H_), tops=tops,
                           base=cols, line=line, mean_c=mean_c))
        print(f"  眼 {name}: 眼皮 ({top_ref[0]:.0f},{top_ref[1]:.0f},{top_ref[2]:.0f})  "
              f"眼侧 ({mid_ref[0]:.0f},{mid_ref[1]:.0f},{mid_ref[2]:.0f})  "
              f"眼下 ({bot_ref[0]:.0f},{bot_ref[1]:.0f},{bot_ref[2]:.0f})")
    return jobs


# --------------------------- 时间线 ---------------------------


def curve_at(points, elapsed: float) -> float:
    """在分段线性曲线上取 elapsed 处的值；不在区间内就是 0。"""
    if elapsed < 0 or elapsed > points[-1][0]:
        return 0.0
    for (t0, v0), (t1, v1) in zip(points, points[1:]):
        if t0 <= elapsed <= t1:
            span = t1 - t0
            k = 0.0 if span <= 0 else (elapsed - t0) / span
            return v0 + (v1 - v0) * k
    return 0.0


def bend_at(elapsed: float) -> float:
    return curve_at(TWITCH, elapsed)


def blink_at(elapsed: float) -> float:
    return curve_at(BLINK, elapsed)


def build_anim(body: Image.Image, ears: list["EarSpec"]) -> None:
    """把「耳朵甩动 + 眨眼」烘焙成动图 WebP。

    为什么烘焙成动图、而不是留在 CSS 里：
      局部弯曲没有对应的 CSS 变换（CSS 没有网格形变），眨眼是合成出来的像素，
      两者都只能把帧算好。代价是体积，好处是动作完全由我们控制、
      而且**没有任何接缝**（也不是拿两张图叠出来的）。
    """
    jobs = build_eye_jobs(body)

    keys: set[float] = {0.0}
    for start in (TWITCH_L_AT, TWITCH_R_AT):
        keys.update(round(start + dt, 3) for dt, _ in TWITCH)
    for start in BLINK_AT:
        keys.update(round(start + dt, 3) for dt, _ in BLINK)
    times = sorted(t for t in keys if t < ANIM_CYCLE)

    frames: list[tuple[Image.Image, int]] = []
    for i, t in enumerate(times):
        nxt = times[i + 1] if i + 1 < len(times) else ANIM_CYCLE
        dur = max(20, round((nxt - t) * 1000))
        bl = min(1.0, blink_at(t - BLINK_AT[0]) + blink_at(t - BLINK_AT[1]))

        # ⚠️ 按闭合度**逐级下压眼睑**，不用 Image.blend 交叉淡化：
        #    淡化会出现两层眼睛的鬼影（冻结看很明显），而真实的眨眼是
        #    上眼睑把瞳孔一点点盖住。这里是把"盖多少"参数化。
        base = body
        if bl > 1e-6:
            base = body.copy()
            for job in jobs:
                patch, origin, mask = job.frame(bl)
                base.paste(patch, origin, mask)

        img = warp_ears(base, ears, (bend_at(t - TWITCH_L_AT), bend_at(t - TWITCH_R_AT)))
        frames.append((img, dur))
        print(
            f"  帧 {i:>2}  t={t:5.2f}s  时长 {dur:>4}ms  "
            f"左耳 {bend_at(t - TWITCH_L_AT):.2f}  右耳 {bend_at(t - TWITCH_R_AT):.2f}  "
            f"闭眼 {bl:.2f}"
        )

    total = sum(d for _, d in frames)
    anim = OUT_DIR / "nya-twitch.webp"
    frames[0][0].save(
        anim,
        "WEBP",
        save_all=True,
        append_images=[f for f, _ in frames[1:]],
        duration=[d for _, d in frames],
        loop=0,
        quality=82,
        alpha_quality=60,
        method=5,
    )
    print(f"动图：nya-twitch.webp  {anim.stat().st_size / 1024:.1f} KB"
          f"  （{len(frames)} 帧 / 共 {total / 1000:.2f}s / 循环 {ANIM_CYCLE}s）")


def main() -> None:
    im = Image.open(SRC).convert("RGB")
    W, H = im.size
    px = im.load()
    print(f"读入 {SRC.name}  {W}x{H}")

    def grow(seeds, pred):
        m = bytearray(W * H)
        dq: deque[tuple[int, int]] = deque()

        def push(x: int, y: int) -> None:
            i = y * W + x
            if m[i] or not pred(*px[x, y]):
                return
            m[i] = 1
            dq.append((x, y))

        for s in seeds:
            push(*s)
        while dq:
            x, y = dq.popleft()
            if x > 0:
                push(x - 1, y)
            if x < W - 1:
                push(x + 1, y)
            if y > 0:
                push(x, y - 1)
            if y < H - 1:
                push(x, y + 1)
        return m

    def near(ref, tol):
        return lambda r, g, b: abs(r - ref[0]) <= tol and abs(g - ref[1]) <= tol and abs(b - ref[2]) <= tol

    def neutral_gray(r, g, b):
        return max(r, g, b) - min(r, g, b) <= 18 and 85 <= (r + g + b) // 3 <= 218

    border = (
        [(x, 0) for x in range(0, W, 3)]
        + [(x, H - 1) for x in range(0, W, 3)]
        + [(0, y) for y in range(0, H, 3)]
        + [(W - 1, y) for y in range(0, H, 3)]
    )
    bg = grow(border, near(px[3, 3], 10))
    board = grow(
        [(300, BOARD_SEED_Y), (960, BOARD_SEED_Y), (1620, BOARD_SEED_Y)], near(px[960, BOARD_SEED_Y], 10)
    )
    stroke = grow(STROKE_SEEDS, neutral_gray)
    print(
        f"外部背景 {sum(bg) / (W * H) * 100:.1f}%   "
        f"板面 {sum(board) / (W * H) * 100:.1f}%   "
        f"描边 {sum(stroke) / (W * H) * 100:.1f}%"
    )

    solid = bytearray(1 if (bg[i] or board[i] or stroke[i]) else 0 for i in range(W * H))

    # 板沿所在的横向带：把"中性色"的像素全部清掉。
    # 这一带里除了板子，只有她的手指（暖色皮肤）和深色描边 —— 颜色上分得开。
    # 唯一会误伤的是白袖口（中性色），但被切掉的那一点点高度只有个位数缩放像素，
    # 而且正好在对话面板上边框附近，看不出来。
    band_top = CROP_BOTTOM - 56
    cleaned = 0
    for y in range(band_top, CROP_BOTTOM):
        for x in range(W):
            i = y * W + x
            if solid[i]:
                continue
            r, g, b = px[x, y]
            if max(r, g, b) - min(r, g, b) <= 14:
                solid[i] = 1
                cleaned += 1
    print(f"板沿带 {band_top}~{CROP_BOTTOM} 定向清除 {cleaned} 像素")

    mask = Image.frombytes("L", (W, H), bytes(255 * solid[i] for i in range(W * H)))
    # 膨胀 1px 吃掉边缘的半透明残留（否则深色底上会镶一圈白边），再轻微模糊做软边
    mask = mask.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(0.7))

    body = im.convert("RGBA")
    body.putalpha(mask.point(lambda v: 255 - v))

    box = body.getbbox()
    pad = 6
    x0, x1 = max(0, box[0] - pad), min(W, box[2] + pad)
    y0 = max(0, box[1] - pad)
    body = body.crop((x0, y0, x1, CROP_BOTTOM))
    print(f"裁剪 ({x0},{y0})-({x1},{CROP_BOTTOM}) ⇒ {body.size}")

    scale = TARGET_H / body.size[1]
    new_w = round(body.size[0] * scale)
    body = body.resize((new_w, TARGET_H), Image.LANCZOS)
    print(f"缩放到 {body.size[0]}x{body.size[1]}（放大倍数 {scale:.4f}）")

    body.save(OUT_DIR / "nya.webp", "WEBP", lossless=True, method=6)
    print(f"身体（静止帧）：nya.webp  {(OUT_DIR / 'nya.webp').stat().st_size / 1024:.1f} KB")

    def to_scaled(x, y):
        """原图坐标 → 缩放后的成品坐标"""
        return (x - x0) * scale, (y - y0) * scale

    ears = []
    for name, ebox, pivot, tip in (
        ("l", EAR_L_BOX, EAR_L_PIVOT, EAR_L_TIP),
        ("r", EAR_R_BOX, EAR_R_PIVOT, EAR_R_TIP),
    ):
        box_s = (
            round(to_scaled(ebox[0], ebox[1])[0]),
            max(0, round(to_scaled(ebox[0], ebox[1])[1])),
            round(to_scaled(ebox[2], ebox[3])[0]),
            round(to_scaled(ebox[2], ebox[3])[1]),
        )
        ears.append(
            EarSpec(
                name=name,
                box=box_s,
                pivot=to_scaled(*pivot),
                tip=to_scaled(*tip),
                # 左耳向外 = 逆时针（负），右耳向外 = 顺时针（正）
                sign=-1 if name == "l" else 1,
            )
        )
        e = ears[-1]
        print(
            f"耳朵 {e.name}：框 {e.box}  支点 ({e.pivot[0]:.1f},{e.pivot[1]:.1f})"
            f"  耳尖 ({e.tip[0]:.1f},{e.tip[1]:.1f})  耳长 {e.length:.1f}"
        )

    build_anim(body, ears)


if __name__ == "__main__":
    main()
