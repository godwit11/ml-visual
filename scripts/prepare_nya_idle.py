"""
把视频抽出来的帧做成 Nya 的待机动画（透明底 WebP）。

完整链路（这个脚本只负责后半段，前半段要浏览器参与）：

  1. 用户给的 MP4（960×960，97 帧 @ 24fps）——**机器上没有 ffmpeg**，
     也没有任何 Python 视频库，所以抽帧交给浏览器做：
     `scripts/tests/` 里那个临时脚本把它画进 canvas，
     再拼成 5×5 的网格，靠 e2e driver 的截图能力落盘成 PNG。
     （走截图是因为 97 帧的数据走 CDP 返回值又慢又容易超限。）
  2. 本脚本：切网格 → 抠背景 → 统一裁剪 → 缩放 → 拼动图。

为什么要抠背景：视频背景是近白的 #f8f8f8。不抠的话，
她在站点的暗红底上会是一个白方块。

抠法用的是**区域生长**，不是"把接近白色的都变透明"：
后者会把她的白围裙、白袜子、米色头发一起抠掉。
区域生长只从画面四边往里长，长到角色的深色描边就停 ——
所以"和背景连通的浅色"才会被去掉，角色内部的浅色一个不动。

⚠️ 裁剪框必须是**所有帧共用的同一个**，不能每帧各裁各的 ——
每帧单独裁会把她"跑动时在画面里移动"这件事一起裁掉，动起来像在原地抽搐。
"""

import base64
import io
import json
import re
from collections import deque
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / ".shots"
OUT_DIR = ROOT / "src" / "assets"

# 和临时抽帧脚本里的常量必须一致
CELL = 300
COLS = 5
TOTAL_FRAMES = 97
FPS = 24

# 背景色。视频四个角的采样值都是 (248,248,248)，非常均匀
BG_REF = (248, 248, 248)
# 容差。太大 → 会长进角色的浅色部分；太小 → 背景里的噪点会留下斑点。
# 14 是试出来的：背景的均匀度允许更大的值，但留点余量更安全。
BG_TOL = 14

# 输出尺寸：CSS 里她显示约 160px 高，2 倍图 ⇒ 300px 足够
TARGET_SIZE = 300

# 输出帧数上限。
#
# 不去重直接抽帧会得到一个"走一步停一下"的动画 —— 原视频 97 帧里
# **每 3 帧就有 2 帧完全相同**（0→1、3→4、6→7…一直规律地重复到结尾），
# 也就是说它的真实动作只有约 15.3fps，剩下都是保持帧。
# 按固定步长抽帧会随机抽到保持帧，于是节奏变得忽快忽慢（用户反馈的"卡"）。
#
# 正确顺序是：**先去掉重复帧（得到真实的动作序列），再决定输出帧数**。
# 去重后是 62 帧；这里再用等间隔重采样降到 52 帧控制体积
# （重采样是等间隔的，不会重新引入忽快忽慢）。
# 播放帧率按"总时长不变"反算，所以抽帧不会让她跑得更快或更慢。
TARGET_FRAMES = 52

# 画质。alpha_quality 是关键 —— Pillow 其实支持这个参数，
# 从 100 降到 50 能省 24%，而边缘只是稍微糙一点点（我们的边缘本来就是软的）。
QUALITY = 70
ALPHA_QUALITY = 50


def slice_sheets() -> list[Image.Image]:
    """把 4 张网格截图切成 97 张按时间排序的帧"""
    batches = []
    for start in (0, 25, 50, 75):
        p = SHOTS / f"vid-batch-{start}.png"
        if not p.exists():
            raise SystemExit(f"缺少 {p.name} —— 先跑抽帧脚本（见文件头说明）")
        batches.append((start, Image.open(p).convert("RGB")))

    frames: list[Image.Image | None] = [None] * TOTAL_FRAMES
    for start, sheet in batches:
        w, h = sheet.size
        rows = h // CELL
        for k in range(rows * COLS):
            idx = start + k
            if idx >= TOTAL_FRAMES:
                break
            col, row = k % COLS, k // COLS
            frames[idx] = sheet.crop((col * CELL, row * CELL, (col + 1) * CELL, (row + 1) * CELL))
        if w != CELL * COLS:
            print(f"  ⚠️ 网格宽度 {w} 和预期 {CELL * COLS} 不一致，切图可能错位")

    missing = [i for i, f in enumerate(frames) if f is None]
    if missing:
        raise SystemExit(f"这些帧没切到：{missing}")
    return frames  # type: ignore[return-value]


def background_mask(img: Image.Image) -> Image.Image:
    """从四边做区域生长，返回"背景"掩码（255 = 背景）"""
    w, h = img.size
    px = img.load()
    bg = bytearray(w * h)
    dq: deque[tuple[int, int]] = deque()

    def push(x: int, y: int) -> None:
        i = y * w + x
        if bg[i]:
            return
        r, g, b = px[x, y][:3]
        if abs(r - BG_REF[0]) <= BG_TOL and abs(g - BG_REF[1]) <= BG_TOL and abs(b - BG_REF[2]) <= BG_TOL:
            bg[i] = 1
            dq.append((x, y))

    for x in range(w):
        push(x, 0)
        push(x, h - 1)
    for y in range(h):
        push(0, y)
        push(w - 1, y)

    while dq:
        x, y = dq.popleft()
        if x > 0:
            push(x - 1, y)
        if x < w - 1:
            push(x + 1, y)
        if y > 0:
            push(x, y - 1)
        if y < h - 1:
            push(x, y + 1)

    m = Image.new("L", (w, h), 0)
    md = m.load()
    for y in range(h):
        row = y * w
        for x in range(w):
            if bg[row + x]:
                md[x, y] = 255
    return m


def cut_out(img: Image.Image) -> Image.Image:
    """抠掉背景，返回 RGBA"""
    mask = background_mask(img)
    # 先把背景掩码膨胀 1px：吃掉描边外侧那圈半透明的浅色残留。
    # 不这么做的话，她在深色底上会镶一圈白边（抠图最常见的脏东西）。
    # 再轻微模糊，让边缘不是硬切的锯齿。
    mask = mask.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(0.6))
    alpha = mask.point(lambda v: 255 - v)
    out = img.convert("RGBA")
    out.putalpha(alpha)
    return out


def resample_evenly(frames: list[Image.Image], target: int) -> list[Image.Image]:
    """
    等间隔重采样到 target 帧。

    ⚠️ 必须用"按下标均匀取"，不能按时间步长 round：后者在非整数倍下会让
    同一个下标被 round 到两次（等于插入重复帧），节奏又乱了。
    按下标取则保证结果是严格递增的、不会有重复。
    """
    n = len(frames)
    if target >= n:
        return frames
    return [frames[round(i * (n - 1) / (target - 1))] for i in range(target)]


def dedupe_and_trim(frames: list[Image.Image], dup_tol: float = 2.0) -> tuple[list[Image.Image], int]:
    """
    去掉重复帧、并砍掉"已经跑回开头"的尾巴。

    为什么必须做（用户实测反馈："跑到最后接上开头会停顿，有点卡"）：
      原视频尾部有**重复帧**，而且最后两帧几乎等于第 0 帧。实测数据：
        帧84→85 差 0.00   帧87→88 差 0.01   帧90→91 差 0.00   帧93→94 差 0.00
        帧95 vs 帧0 差 3.96    帧96 vs 帧0 差 3.54
      于是循环点的实际顺序是 …92 → 93 → 94(=93) → 95(=开头) → 96(=开头) → 0(=开头)
      —— **同一个画面连着出现三四次**，看起来就是"卡住了一下"。
      （对照：一帧正常的位移量是 24.81，而帧93→帧0 是 23.82，正好接得上。）

    返回值第二项是"砍掉了几帧"，用于打印。
    """
    # ① 去掉与上一保留帧几乎相同的帧
    kept = [frames[0]]
    for f in frames[1:]:
        if _diff(f, kept[-1]) >= dup_tol:
            kept.append(f)

    # ② 从尾部往回砍：凡是"和开头几乎一样"的帧都不要 ——
    #    它们被循环天然覆盖了，留着只会变成一次停顿
    head = kept[0]
    trimmed = 0
    while len(kept) > 1 and _diff(kept[-1], head) < 6.0:
        kept.pop()
        trimmed += 1

    return kept, trimmed


def _diff(a: Image.Image, b: Image.Image) -> float:
    """两帧的平均差（RGB 三通道 + alpha 平均）"""
    from PIL import ImageChops, ImageStat

    dr = ImageStat.Stat(ImageChops.difference(a.convert("RGB"), b.convert("RGB")))
    da = ImageStat.Stat(ImageChops.difference(a.getchannel("A"), b.getchannel("A")))
    return (dr.mean[0] + dr.mean[1] + dr.mean[2]) / 3 + da.mean[0]


def main() -> None:
    print("切网格…")
    raw = slice_sheets()
    print(f"  得到 {len(raw)} 帧，每帧 {raw[0].size[0]}x{raw[0].size[1]}")

    print("抠背景…")
    cut = []
    for i, f in enumerate(raw):
        cut.append(cut_out(f))
        if (i + 1) % 25 == 0:
            print(f"  {i + 1}/{len(raw)}")

    # 所有帧共用一个裁剪框（取并集），否则跑动时的位移会被裁掉
    left = min(c.getbbox()[0] for c in cut)
    top = min(c.getbbox()[1] for c in cut)
    right = max(c.getbbox()[2] for c in cut)
    bottom = max(c.getbbox()[3] for c in cut)
    pad = 4
    box = (
        max(0, left - pad),
        max(0, top - pad),
        min(CELL, right + pad),
        min(CELL, bottom + pad),
    )
    print(f"共用裁剪框 {box} ⇒ {box[2] - box[0]}x{box[3] - box[1]}")

    frames = [c.crop(box) for c in cut]

    w, h = frames[0].size
    if (w, h) != (TARGET_SIZE, TARGET_SIZE):
        frames = [f.resize((TARGET_SIZE, TARGET_SIZE), Image.LANCZOS) for f in frames]
        print(f"缩放到 {frames[0].size[0]}x{frames[0].size[1]}")

    print("去重复帧 / 修循环接缝…")
    unique, trimmed = dedupe_and_trim(frames)
    print(f"  97 帧 ⇒ {len(unique)} 帧（尾部砍掉 {trimmed} 帧）")
    print(f"  接缝检查：末帧→首帧 差 {_diff(unique[-1], unique[0]):.2f}")

    unique = resample_evenly(unique, TARGET_FRAMES)
    print(f"  等间隔重采样 ⇒ {len(unique)} 帧")

    # ⚠️ 帧率要按**去重后的帧数**重算，不能还用原视频的 24fps 或固定的 12fps。
    #    去重后每一帧代表的是"动作走了一步"，不是"过了 1/24 秒"；
    #    保持总时长不变 ⇒ 帧率 = 帧数 / 原始时长。
    duration = TOTAL_FRAMES / FPS
    out_fps = len(unique) / duration
    dur = round(1000 / out_fps)
    print(f"按总时长 {duration:.2f}s 不变 ⇒ {out_fps:.1f}fps（每帧 {dur}ms）")

    # 静态首帧 —— 给"减少动态效果"的用户用。
    # 动图 WebP 没法用 CSS 暂停，只能换一张静态图。
    # 存成单帧 WebP 而不是 PNG：带 alpha 的 PNG 要 79 KB，WebP 只要十几 KB。
    still = OUT_DIR / "nya-idle-still.webp"
    unique[0].save(still, "WEBP", quality=82, method=5)
    print(f"静态首帧：{still.name}  {still.stat().st_size / 1024:.1f} KB")

    anim = OUT_DIR / "nya-idle.webp"
    unique[0].save(
        anim,
        "WEBP",
        save_all=True,
        append_images=unique[1:],
        duration=dur,
        loop=0,
        quality=QUALITY,
        alpha_quality=ALPHA_QUALITY,
        method=5,
    )
    print(f"动图：{anim.name}  {anim.stat().st_size / 1024:.1f} KB  ({len(unique)} 帧 @ {out_fps:.1f}fps)")


if __name__ == "__main__":
    main()
