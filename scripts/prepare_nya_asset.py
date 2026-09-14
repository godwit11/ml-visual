"""
把抠图结果加工成能用的网页素材。

要做四件事（都不是"顺手"做的，各有理由）：

1. **去掉孤立的小色块。**
   原图左侧有几个手绘小涂鸦（"zzz" 和一个小闪光），抠图时被当成前景
   一起留下来了。它们在 1440px 下只有几十像素宽，缩到网页尺寸会变成
   几个白点，在暗色背景上像脏东西。
   做法是连通域分析：只保留主体（最大的那块）和足够大的邻近碎块，
   孤立的小块直接抹掉 alpha。
   ⚠️ 阈值不能太大 —— 头发丝本来就是零散的细小块，一刀切会把发梢削掉。
   所以脚本会**打印每个被删掉的块有多大**，让人能核对是不是误删。

2. **裁掉透明边。**
   抠完的图四周有大片全透明区域。不裁的话，网页里算位置时要把这些
   透明边一起算进去，"她看起来在哪儿"和"她的盒子在哪儿"就对不上了。

3. **缩到实际显示尺寸的 2 倍。**
   网页上她大约显示 150px 高。给 2 倍图是为了视网膜屏不糊；再大就是浪费。
   直接用 LANCZOS 重采样（缩小时效果最好）。

4. **压体积。**
   1440px 的 RGBA PNG 有 1.37 MB —— 每开一个页面都要下这一个文件，
   不能这个体积。同时导出 WebP（带 alpha 的有损压缩）做对比，选小的那个。

用法：
  python scripts/prepare_nya_asset.py
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src" / "assets" / "nya.png"
OUT_DIR = ROOT / "src" / "assets"

# 显示高度约 150 CSS px，2 倍图 ⇒ 300 px 高。留点余量给"放大时的轻微缩放动画"。
TARGET_HEIGHT = 320

# alpha 小于这个值就算"透明"。抠图的边缘常有一圈很淡的残留，
# 阈值太低会把一大片近乎透明的噪点算成前景。
ALPHA_CUTOFF = 24

# 小于这个像素数的连通块判为"孤立小色块"。
# 取 400：一个 20x20 的实心点是 400，而一根发梢细丝通常也在这个量级之上
# —— 所以这个值偏保守（宁可留着，不要削掉头发）。脚本会打印实际删了哪些。
MIN_BLOB_PX = 400


def load_rgba(path: Path):
    im = Image.open(path)
    if im.mode != "RGBA":
        im = im.convert("RGBA")
    return im


def drop_isolated_blobs(im: Image.Image):
    """保留主体及其"够大"的碎块，抹掉孤立小块的 alpha。返回 (新图, 被删列表)"""
    w, h = im.size
    alpha = im.getchannel("A")
    px = alpha.load()

    # 二值化成一维数组，方便做并查集
    solid = [0] * (w * h)
    for y in range(h):
        row = y * w
        for x in range(w):
            if px[x, y] > ALPHA_CUTOFF:
                solid[row + x] = 1

    # 两趟连通域标记（4 邻域）
    label = [-1] * (w * h)
    parent: list[int] = []

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    next_label = 0
    for y in range(h):
        row = y * w
        for x in range(w):
            i = row + x
            if not solid[i]:
                continue
            up = label[i - w] if y > 0 else -1
            left = label[i - 1] if x > 0 else -1
            if up < 0 and left < 0:
                label[i] = next_label
                parent.append(next_label)
                next_label += 1
            elif up >= 0 and left >= 0:
                label[i] = min(up, left)
                union(up, left)
            else:
                label[i] = up if up >= 0 else left

    # 统计各连通块的面积
    sizes: dict[int, int] = {}
    for i in range(w * h):
        if solid[i]:
            root = find(label[i])
            sizes[root] = sizes.get(root, 0) + 1

    if not sizes:
        return im, []

    biggest = max(sizes.values())
    keep = {root for root, n in sizes.items() if n >= MIN_BLOB_PX}

    removed = sorted(
        ((n, root) for root, n in sizes.items() if root not in keep), reverse=True
    )

    # 抹掉被丢弃的块
    out = im.copy()
    dst = out.load()
    for y in range(h):
        row = y * w
        for x in range(w):
            i = row + x
            if solid[i] and find(label[i]) not in keep:
                r, g, b, _ = dst[x, y]
                dst[x, y] = (r, g, b, 0)

    return out, [(n, f"{n / biggest * 100:.2f}% of main body") for n, _ in removed]


def main() -> None:
    im = load_rgba(SRC)
    print(f"读入：{SRC.name}  {im.size[0]}x{im.size[1]}")

    im, removed = drop_isolated_blobs(im)
    if removed:
        print(f"删掉 {len(removed)} 个孤立小块：")
        for n, pct in removed:
            print(f"  - {n:>6} px  ({pct})")
    else:
        print("没有发现孤立小块。")

    # 裁掉透明边
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
        print(f"裁掉透明边：{bbox}  ⇒  {im.size[0]}x{im.size[1]}")

    # 缩到目标高度
    w, h = im.size
    scale = TARGET_HEIGHT / h
    im = im.resize((max(1, round(w * scale)), TARGET_HEIGHT), Image.LANCZOS)
    print(f"缩放后：{im.size[0]}x{im.size[1]}")

    png_path = OUT_DIR / "nya.png"
    im.save(png_path, "PNG", optimize=True)
    print(f"写出 PNG：{png_path.name}  {png_path.stat().st_size / 1024:.1f} KB")

    """
    WebP 版本**只用于体积对比**，不写进 src/assets。
    理由：它会被 Vite 当成候选资源、也容易被误 import；
    而实际选用的格式应该只保留一个，免得日后分不清"线上到底用的是哪张"。
    结论（2026-09-13）：WebP 约 25 KB，PNG 约 107 KB —— 差 4 倍。
    仍然选 PNG，因为它无损；而且这张图每页都加载一次、之后走浏览器缓存，
    多出来的 80 KB 只在首次访问付一次，不值得为它引入有损压缩的观感风险。
    """
    webp_path = ROOT / ".shots" / "nya-src" / "nya-compare.webp"
    webp_path.parent.mkdir(parents=True, exist_ok=True)
    im.save(webp_path, "WEBP", quality=88, method=6)
    print(f"（对比用）WebP：{webp_path.stat().st_size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
