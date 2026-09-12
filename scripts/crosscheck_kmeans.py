"""用 sklearn 的 KMeans 复算，与 TS 手写的 K-means 对拍。

这一页的对拍思路和 Bagging 那轮是一个套路：
K-means 的初始化（k-means++ / 随机）依赖随机数，两边 PRNG 不同源，
所以 **Node 侧把初始质心回传，Python 用同一组初始质心**。
给定起点之后 Lloyd 迭代是完全确定的，于是可以逐项比对：

  1. **labels** —— 每个点被分到哪一簇
  2. **cluster_centers_** —— 最终的簇中心坐标
  3. **inertia_** —— 目标函数值（K-means 真正在最小化的那个数）
  4. 迭代轮数（允许 ±1，因为两边的收敛检查时机差半步）

另外还把"多种初始化取最优"的分布也报出来：K-means 只保证局部最优，
跑 8 次不同起点的 inertia 应当有差异——这正是 n_init 存在的理由。

用法：python scripts/crosscheck_kmeans.py
"""
import json
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

def ensure_env():
    """当前解释器缺 numpy/sklearn 时，切到 .venv-python 指定的环境重跑自己。

    注意必须在 `import numpy` 之前调用 —— 否则切换来不及生效
    （这正是本文件原先的 bug：检查写在 import 之后，永远走不到）。
    """
    try:
        import numpy  # noqa: F401
        import sklearn  # noqa: F401

        return
    except ImportError:
        pass
    marker = ROOT / ".venv-python"
    if marker.exists():
        alt = marker.read_text(encoding="utf-8").strip()
        if alt and pathlib.Path(alt).exists() and os.path.abspath(alt) != os.path.abspath(sys.executable):
            print(f"当前解释器缺少 numpy/sklearn，切换到：{alt}")
            os.execv(alt, [alt, str(pathlib.Path(__file__).resolve()), *sys.argv[1:]])
    print("❌ 未找到可用的 numpy/sklearn，无法对拍")
    sys.exit(2)


ensure_env()

import numpy as np

TOL_LABEL = 0
TOL_INERTIA = 1e-9

PY = sys.executable  # 仅用于给 subprocess 跑 Node；本脚本自身的解释器由 ensure_env 保证


def load_ts():
    r = subprocess.run(
        ["node", str(ROOT / "scripts/crosscheck_kmeans.mjs")],
        capture_output=True, text=True, cwd=str(ROOT),
    )
    if r.returncode != 0:
        print("Node 侧跑失败了：\n", r.stderr[-3000:])
        sys.exit(1)
    return json.loads(r.stdout)


def main():
    from sklearn.cluster import KMeans

    data = load_ts()
    ds_by_id = {d["id"]: d for d in data["datasets"]}

    fails = []
    notes = []
    worst_inertia = 0.0
    worst_center = 0.0
    n_checked = 0
    n_label_mismatch = 0

    for run in data["runs"]:
        ds = ds_by_id[run["dataset"]]
        X = np.array(ds["X"], dtype=float)
        k = run["k"]
        init = np.array(run["init"], dtype=float)
        tag = f"{run['dataset']:<8} k={k} init={run['initType']:<8}"

        clf = KMeans(
            n_clusters=k,
            init=init,
            n_init=1,
            max_iter=300,
            tol=1e-4,
            algorithm="lloyd",
        ).fit(X)

        lab_ts = np.array(run["labels"], dtype=int)
        lab_sk = clf.labels_

        same = int(np.sum(lab_ts == lab_sk))
        if same != len(lab_ts):
            n_label_mismatch += 1
            # 可能是簇编号被置换（虽然给了相同初始质心，理论上不该发生）
            fails.append(
                f"{tag} labels 有 {len(lab_ts) - same}/{len(lab_ts)} 个不一致"
            )

        c_ts = np.array(run["centers"], dtype=float)
        c_sk = clf.cluster_centers_
        dcenter = float(np.max(np.abs(c_ts - c_sk)))
        worst_center = max(worst_center, dcenter)
        if dcenter > 1e-8:
            fails.append(f"{tag} 质心最大差异 {dcenter:.3e}")

        din = abs(float(clf.inertia_) - run["inertia"]) / max(1e-12, abs(float(clf.inertia_)))
        worst_inertia = max(worst_inertia, din)
        if din > TOL_INERTIA:
            fails.append(
                f"{tag} inertia 不一致 TS={run['inertia']:.10f} sk={float(clf.inertia_):.10f}"
            )

        if abs(int(clf.n_iter_) - run["iters"]) > 1:
            fails.append(f"{tag} 迭代轮数差太多 TS={run['iters']} sk={int(clf.n_iter_)}")

        notes.append(
            f"  {tag} inertia {float(clf.inertia_):9.4f}　迭代 {int(clf.n_iter_):2d} 轮　"
            f"簇大小 {run['sizes']}"
        )
        n_checked += 1

    notes.append("")
    notes.append("· 多种初始化（k-means++，8 次不同起点）的 inertia 分布：")
    for r in data["restarts"]:
        vals = sorted(r["inertias"])
        notes.append(
            f"  {r['dataset']:<8} 最好 {r['bestInertia']:.4f} / 最差 {r['worstInertia']:.4f}"
            f"　（{vals[0]:.4f} … {vals[-1]:.4f}）"
        )

    print("\n".join(notes))
    print("=" * 74)
    print(f"· 共比对 {n_checked} 组（4 个数据集 × 3 个 k × 2 种初始化）")
    print(f"· labels 不一致的组数：{n_label_mismatch}")
    print(f"· 质心最大差异 {worst_center:.3e}；inertia 最大相对差 {worst_inertia:.3e}")
    print("=" * 74)
    if fails:
        print(f"❌ 对拍失败，共 {len(fails)} 处：")
        for f in fails[:20]:
            print("  -", f)
        return 1
    print("✅ 对拍通过：labels / 簇中心 / inertia / 迭代轮数与 sklearn 一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
