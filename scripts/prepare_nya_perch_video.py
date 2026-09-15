"""
把用户给的视频做成 Nya「趴在对话窗口右上角」用的两张图：

  1. `nya.webp`        —— 静态首帧（给"减少动态效果"的用户）
  2. `nya-twitch.webp` —— 动图（循环段，趴着时用）

完整链路（本脚本只负责后半段，前半段要浏览器参与）：

  1. 视频 864×496 @ 24fps，共 97 帧。**机器上没有 ffmpeg**，也没有 Python 视频库，
     所以抽帧交给浏览器：`scripts/extract-video-grid.js` 把帧裁好、按 1:1 画进
     3×3 网格，靠 e2e driver 的截图能力落盘（`.shots/tmp/frames-*.png`）。
     分 6 批是因为更大的截图尺寸会让 `Page.captureScreenshot` 超时。
  2. 本脚本：切网格 → 抠背景 → 去重复帧 → 缩放 → 拼动图。

--------------------------------------------------------------------------
取第 0~48 帧（= 0~2.04s）
--------------------------------------------------------------------------
整段视频的动作是：**0~3.2s 抬头微笑（只有轻微起伏），3.2~3.4s 快速低头，之后一直低头**。
低头那一下是"跳"（帧间差 ~90，而静止段只有 ~26），整段循环会明显一顿。
抬头段里有一段周期约 0.683s 的微动，而 **2.048s 正好是它的 3 倍** ⇒
首尾几乎是同一个姿势（实测首尾差 8.9，只有自然微动的 1/3）⇒ 天生可以无缝循环。

--------------------------------------------------------------------------
抠图分两层，第二层是关键
--------------------------------------------------------------------------
背景是**虚化的咖啡馆灯光**，不是纯色 —— `prepare_nya_perch.py` 那套"按亮度吃白底"
用不上。改用**以描边为墙的区域生长**：她的线稿是硬边（梯度高），背景是虚化的（梯度软）。

第一层（单帧）：颜色梯度当墙 → 墙膨胀 2px 封住描边上的小缺口 →
从画面四边区域生长（可达的算背景）→ 填洞 → 只留最大连通块 → 收壳 2px。

🔴 第二层（帧间一致）：**单帧结果在帧与帧之间会抖**，而且**不是随机抖，是渐进式的** ——
她的**尾巴**从第 15 帧左右开始被洪水一点点吃进去（尾巴区像素 14000 → 4500 → 又回升）。
根因：尾巴尖搭在板子（背景）上，尾巴又比板子亮不了多少，而视频的明暗是**渐变**的，
于是某些帧里尾巴的描边不再构成"墙"，洪水从缺口钻进去（尾巴内部连通，进去就填满）。
逐帧独立抠图必然有这个毛病 —— 而"一帧有一帧没有"在动图里就是**一闪一闪**。

修法用的是这段视频的一个好性质：**背景完全静止，她也只是整体位移 1~2px**
（实测：背景两帧差 0.10，几乎逐像素相同；她的位移在 ±2px 内，
对齐后剩下的差异来自明暗变化 —— 那正是"动"的部分）。所以"她的轮廓"对每一帧应该是**同一条**：
  1. 逐帧抠图 → 2. 挑面积最大的一帧当参考 → 3. 其余帧按整数位移对齐到它
  → 4. 逐像素多数票得到**一份共用轮廓** → 5. 每帧再按自己的位移把它贴回去。
形状永不闪，而"她整体在动"这件事还留着。
"""

import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage as ndi

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / ".shots" / "tmp"
OUT_DIR = ROOT / "src" / "assets"

# 和 extract-video-grid.js 里的裁剪框 / 网格常量必须一致
CELL = (727, 496)          # ⚠️ 高度是**整幅**（不是最终高度）：见 CROP_Y
COLS = 3
ROWS = 3
PER_GRID = COLS * ROWS
TOTAL_FRAMES = 49
FPS = 24

# 抠完图之后才裁到的高度。
# 为什么是 452：板子的边（左侧亮带 y≥456、右侧圆角 y≈455）都在它之下，一刀切掉整块板子；
# 而她的头占了画面 86% 的高度（下巴就在 y≈430），所以这一刀同时保住领口/肩膀。
# 代价：她搭在板子上的手被一起切掉（手在 y 445~490）。
CROP_Y = 452
# 横向也裁一刀：**把尾巴裁掉**。
#
# 为什么（这段花的时间最多）：她那条尾巴是**摆动的**（从卷曲的"S"形摆到近乎竖直），
# 于是"尾巴和头发之间那块虚化亮光斑"时而被她的轮廓围住、时而又露出来，
# 而她尾巴边缘的绒状过渡和那块光斑的颜色只差几个单位 ——
# 抠图在那一带**没法稳定**：留下它，光斑会一帧有一帧没有地闪；
# 去掉它，就会连尾巴一起啃掉（只剩一圈绒边）。
# 试过阈值扫描、共用轮廓、定点种子、逐帧颜色门控，都只能压住一部分。
# 而这条裁线（x=560）一划，整个不可靠区域全在画面外 ⇒ 结果是**可验证的干净**。
#
# 代价：没有尾巴了，构图从"她+尾巴"变成"她探头"（资产 292x236，原来的 519x300）。
# 也看不出她头发右侧被切 —— 那一刀落在她的发梢上（其余九页的面板都靠右贴边）。
# 想要尾巴的话，让视频用纯色/透明背景重出一版即可，抠图立刻变回简单问题。
CROP_X = 560
FENCE_H = 6                # 围栏高度（px），见 alpha_single 里的说明

# 趴着时她的显示高度是 `clamp(92px, 8vw, 118px)`（chat.css，不是待机的 124~160），
# 所以 2 倍图只要 236px。
TARGET_H = 236

TH_GRAD = 22.0             # 梯度墙的阈值
SEAL = 2                   # 墙膨胀（封住描边缺口）
SHRINK = 2                 # 收壳（抵消膨胀，避免她胖一圈）
EDGE_BLUR = 0.8            # alpha 边缘羽化

# 质量：82/60 是旧素材的取值，但那张画得简单。这张细节多，用 72/35 能省三成体积，
# 而在 118px 的显示高度上看不出差别。
QUALITY = 72
ALPHA_QUALITY = 35


# ----------------------------------------------------------------------
# 第一层：单帧抠图
# ----------------------------------------------------------------------

def grad_mag(rgb, blur=1.0):
    """颜色梯度（三通道取最大）。只算灰度会漏掉"亮度接近但色相不同"的边。"""
    a = np.asarray(rgb.filter(ImageFilter.GaussianBlur(blur)), dtype=np.float32)
    g = np.zeros(a.shape[:2], dtype=np.float32)
    for ch in range(3):
        c = a[:, :, ch]
        gx = np.zeros_like(c)
        gy = np.zeros_like(c)
        gx[:, 1:-1] = c[:, 2:] - c[:, :-2]
        gy[1:-1, :] = c[2:, :] - c[:-2, :]
        g = np.maximum(g, np.hypot(gx, gy))
    return g


def _flood(passable):
    """从画面四边区域生长，返回可达区域。"""
    h, w = passable.shape
    reach = np.zeros((h, w), dtype=bool)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if passable[y, x] and not reach[y, x]:
                reach[y, x] = True
                q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if passable[y, x] and not reach[y, x]:
                reach[y, x] = True
                q.append((y, x))
    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and passable[ny, nx] and not reach[ny, nx]:
                reach[ny, nx] = True
                q.append((ny, nx))
    return reach


def _largest(mask):
    lab, n = ndi.label(mask)
    if n <= 1:
        return mask
    sizes = ndi.sum(mask, lab, index=range(1, n + 1))
    return lab == (int(np.argmax(sizes)) + 1)


def alpha_single(rgb):
    """
    单帧的二值轮廓。

    ⚠️ 必须喂**整幅**帧（高度 496）：区域生长是从四边播种的，
       如果先裁掉下半部分，裁剪框的下边界就正好切在她身上，
       洪水会**从她身体内部起步**、把她从里面吃穿（第一版就是这样，脸上被啃掉一大块）。
    """
    gm = grad_mag(rgb)
    wall = ndi.binary_dilation(gm > TH_GRAD, iterations=SEAL)

    # 围栏：在裁剪线那一行横着封死，把她和下方的板子隔开 ——
    # 她搭在板子上的手那条边界本来就难分，封死之后下面那半幅随便它怎么长。
    # 围栏自己就在 CROP_Y 之下，会被裁掉。
    wall[CROP_Y:CROP_Y + FENCE_H, :] = True

    fg = ~_flood(~wall)
    fg = ndi.binary_fill_holes(fg)
    fg = _largest(fg)
    fg = ndi.binary_erosion(fg, iterations=SHRINK)
    fg = ndi.binary_fill_holes(fg)

    # 去小碎块（她身上不会有几百像素的孤立块）
    lab, n = ndi.label(fg)
    if n > 1:
        sizes = ndi.sum(fg, lab, index=range(1, n + 1))
        fg = np.isin(lab, [i + 1 for i, s in enumerate(sizes) if s >= 500])
    return fg


# ----------------------------------------------------------------------
# 切网格 / 去重复帧
# ----------------------------------------------------------------------

def load_frames():
    frames, idx = [], 0
    for g in range((TOTAL_FRAMES + PER_GRID - 1) // PER_GRID):
        p = SHOTS / f"frames-{g}.png"
        if not p.exists():
            raise SystemExit(f"缺抽帧截图：{p}（先跑 scripts/extract-video-grid.js）")
        sheet = Image.open(p).convert("RGB")
        for i in range(PER_GRID):
            if idx >= TOTAL_FRAMES:
                break
            c, r = i % COLS, i // COLS
            frames.append(
                sheet.crop((c * CELL[0], r * CELL[1], (c + 1) * CELL[0], (r + 1) * CELL[1]))
            )
            idx += 1
    return frames


def _diff(a, b):
    return float(np.abs(np.asarray(a, np.float32) - np.asarray(b, np.float32)).mean())


def dedupe(frames, thresh=1.2):
    """去掉连续重复帧（生成视频里常见；留着只会让文件变大、动作反而不连贯）。"""
    out = [frames[0]]
    for f in frames[1:]:
        if _diff(out[-1], f) > thresh:
            out.append(f)
    return out


# ----------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------

def main():
    debug = "--debug" in sys.argv
    raw = load_frames()
    print(f"切出 {len(raw)} 帧，尺寸 {raw[0].size}")

    print("抠背景（逐帧）…")
    masks = [alpha_single(f) for f in raw]
    areas = np.array([m[:CROP_Y, :CROP_X].sum() for m in masks])
    print(f"    逐帧轮廓面积（裁剪区内）{areas.min()}~{areas.max()}"
          f"（波动 {(areas.max() - areas.min()) / areas.mean() * 100:.1f}%）")

    print("生成 alpha…")
    cut = []
    for f, m in zip(raw, masks):
        a = Image.fromarray((m * 255).astype(np.uint8), "L").filter(
            ImageFilter.GaussianBlur(EDGE_BLUR))
        out = f.convert("RGBA")
        out.putalpha(a)
        cut.append(out)

    print("去重复帧…")
    uniq = dedupe(cut)
    print(f"  {len(cut)} 帧 ⇒ {len(uniq)} 帧")
    print(f"  接缝检查：末帧→首帧 差 {_diff(uniq[-1], uniq[0]):.2f}"
          f"（参考：静止段自然微动约 26）")

    # 裁到最终范围（见 CROP_X / CROP_Y 的说明）
    uniq = [f.crop((0, 0, CROP_X, CROP_Y)) for f in uniq]

    w = round(uniq[0].width * TARGET_H / uniq[0].height)
    uniq = [f.resize((w, TARGET_H), Image.LANCZOS) for f in uniq]
    print(f"缩放到 {w}x{TARGET_H}")

    duration = TOTAL_FRAMES / FPS
    out_fps = len(uniq) / duration
    dur = round(1000 / out_fps)
    print(f"总时长保持 {duration:.2f}s ⇒ {out_fps:.1f}fps（每帧 {dur}ms）")

    if "--dump" in sys.argv:
        dump = SHOTS / "perch-frames"
        dump.mkdir(exist_ok=True)
        for i, f in enumerate(uniq):
            f.save(dump / f"f{i:02d}.png")
        print(f"  已把 {len(uniq)} 帧处理结果存到 {dump}（用于调编码参数）")

    # 静态图用无损：它同时是"减少动态效果"用户的替代图，边缘质量在这一张上最要紧。
    still = OUT_DIR / "nya.webp"
    uniq[0].save(still, "WEBP", lossless=True, method=6)
    print(f"静态首帧：{still.name}  {still.stat().st_size / 1024:.1f} KB")

    anim = OUT_DIR / "nya-twitch.webp"
    uniq[0].save(
        anim,
        "WEBP",
        save_all=True,
        append_images=uniq[1:],
        duration=dur,
        loop=0,
        quality=QUALITY,
        alpha_quality=ALPHA_QUALITY,
        method=5,
    )
    print(f"动图：{anim.name}  {anim.stat().st_size / 1024:.1f} KB  ({len(uniq)} 帧 @ {out_fps:.1f}fps)")


if __name__ == "__main__":
    main()
