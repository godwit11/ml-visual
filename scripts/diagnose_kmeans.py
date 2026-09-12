"""诊断 K-means 对拍的分歧：逐轮对比 TS 与 sklearn 的质心 / inertia / 簇大小。

用法：python scripts/diagnose_kmeans.py [数据集] [k] [init]
例：  python scripts/diagnose_kmeans.py circles 3 kmeans++
"""
import json
import pathlib
import subprocess
import sys

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent

which_ds = sys.argv[1] if len(sys.argv) > 1 else "circles"
which_k = int(sys.argv[2]) if len(sys.argv) > 2 else 3
which_init = sys.argv[3] if len(sys.argv) > 3 else "kmeans++"

r = subprocess.run(
    ["node", str(ROOT / "scripts/crosscheck_kmeans.mjs")],
    capture_output=True, text=True, cwd=str(ROOT),
)
data = json.loads(r.stdout)
ds = {d["id"]: d for d in data["datasets"]}[which_ds]
X = np.array(ds["X"], dtype=float)

run = next(
    x for x in data["runs"]
    if x["dataset"] == which_ds and x["k"] == which_k and x["initType"] == which_init
)

from sklearn.cluster import KMeans

print(f"=== {which_ds} k={which_k} init={which_init} ===")
print(f"初始质心（两边相同）：{np.array(run['init']).round(6).tolist()}")
print("")
print(f"{'轮':>3} | {'TS inertia':>12} {'TS sizes':>16} | {'sk inertia':>12} {'sk sizes':>16}")
print("-" * 74)

n_show = max(len(run["steps"]) + 3, 12)
for i in range(n_show):
    # sklearn：用 max_iter=i 跑出第 i 轮的状态
    try:
        clf = KMeans(
            n_clusters=which_k, init=np.array(run["init"], dtype=float),
            n_init=1, max_iter=max(1, i), tol=1e-4, algorithm="lloyd",
        ).fit(X)
        sk_in = float(clf.inertia_)
        sk_sz = np.bincount(clf.labels_, minlength=which_k).tolist()
    except Exception as e:  # noqa: BLE001
        sk_in, sk_sz = float("nan"), str(e)[:16]

    ts = run["steps"][i] if i < len(run["steps"]) else None
    ts_in = f"{ts['inertia']:.6f}" if ts else "-"
    ts_sz = str(ts["sizes"]) if ts else "-"
    print(f"{i:>3} | {ts_in:>12} {ts_sz:>16} | {sk_in:>12.6f} {str(sk_sz):>16}")

print("")
print(f"TS   收敛于第 {run['iters']} 轮，最终 inertia {run['inertia']:.6f}，簇大小 {run['sizes']}")
clf = KMeans(n_clusters=which_k, init=np.array(run["init"], dtype=float), n_init=1,
             max_iter=300, tol=1e-4, algorithm="lloyd").fit(X)
print(f"sklearn 收敛于第 {int(clf.n_iter_)} 轮，最终 inertia {float(clf.inertia_):.6f}，"
      f"簇大小 {np.bincount(clf.labels_, minlength=which_k).tolist()}")
