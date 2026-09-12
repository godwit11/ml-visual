"""诊断决策树对拍分歧：判断是"算错"还是"两个候选打平导致的浮点噪声"。

用法：python scripts/diagnose_tree.py [dataset] [criterion] [maxDepth]
"""
import json
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import numpy as np  # noqa: E402
from sklearn.tree import DecisionTreeClassifier  # noqa: E402


def gini(counts, n):
    if n == 0:
        return 0.0
    p = counts / n
    return float(1.0 - np.sum(p**2))


def entropy(counts, n):
    if n == 0:
        return 0.0
    p = counts[counts > 0] / n
    return float(-np.sum(p * np.log2(p)))


def ranked(Xs, ys, criterion, n_classes, dtype):
    """枚举所有候选分裂，返回增益 top3（与 TS 的 findSplitsRanked 同定义）"""
    Xs = np.asarray(Xs, dtype=dtype)
    n = len(ys)
    counts_all = np.bincount(ys, minlength=n_classes).astype(np.float64)
    imp = gini if criterion == "gini" else entropy
    parent = imp(counts_all, n)

    cands = []
    for f in range(Xs.shape[1]):
        order = np.argsort(Xs[:, f], kind="stable")
        vals = Xs[order, f]
        for p in range(n - 1):
            if vals[p] == vals[p + 1]:
                continue
            thr = (vals[p] + vals[p + 1]) / 2
            left = order[: p + 1]
            right = order[p + 1 :]
            if len(left) == 0 or len(right) == 0:
                continue
            cl = np.bincount(ys[left], minlength=n_classes).astype(np.float64)
            cr = np.bincount(ys[right], minlength=n_classes).astype(np.float64)
            w = (len(left) / n) * imp(cl, len(left)) + (len(right) / n) * imp(cr, len(right))
            cands.append((parent - w, f, float(thr)))
    cands.sort(key=lambda t: -t[0])
    return cands[:3]


def sk_dfs(tree):
    left, right, feature, threshold = (
        tree.children_left,
        tree.children_right,
        tree.feature,
        tree.threshold,
    )
    out = []

    def walk(node, depth):
        if node == -1:
            return
        if feature[node] == -2:
            out.append({"id": node, "depth": depth, "feature": -1, "threshold": 0.0})
            return
        out.append(
            {"node_id": node, "depth": depth, "feature": int(feature[node]), "threshold": float(threshold[node])}
        )
        walk(left[node], depth + 1)
        walk(right[node], depth + 1)

    walk(0, 0)
    return out


def main():
    filt = sys.argv[1:] if len(sys.argv) > 1 else None
    node = shutil.which("node")
    r = subprocess.run(
        [node, str(ROOT / "scripts/crosscheck_tree.mjs"), "--with-idx"],
        capture_output=True,
        text=True,
        cwd=str(ROOT),
    )
    if r.returncode != 0:
        print(r.stderr[:3000])
        return 1
    data = json.loads(r.stdout)
    ds_map = {d["id"]: d for d in data["datasets"]}

    shown = 0
    for run in data["runs"]:
        if filt and not all(
            any(f in str(run[k]) for k in ("dataset", "criterion") ) for f in filt
        ):
            pass  # 简单起见，命令行过滤只按 dataset 名
        ds = ds_map[run["dataset"]]
        X = np.array(ds["X"], dtype=np.float64)
        y = np.array(ds["y"], dtype=np.int64)
        n_classes = ds["nClasses"]

        clf = DecisionTreeClassifier(
            criterion=run["criterion"],
            max_depth=run["maxDepth"],
            min_samples_split=run["minSamplesSplit"],
            min_samples_leaf=1,
            random_state=0,
        ).fit(X, y)
        sk = sk_dfs(clf.tree_)
        ts = run["dfs"]

        diff_at = None
        for i, (a, b) in enumerate(zip(sk, ts)):
            if a["depth"] != b["depth"] or a["feature"] != b["feature"]:
                diff_at = (i, a, b)
                break
        if diff_at is None:
            continue

        i, a, b = diff_at
        tag = f"{run['dataset']}/{run['criterion']}/d{run['maxDepth']}/mss{run['minSamplesSplit']}"
        print(f"=== {tag} ===")
        print(f"分歧于前序第 {i} 个节点（depth={b['depth']}）")
        print(f"  sklearn 选: feature={a['feature']} threshold={a['threshold']!r}")
        print(f"  TS      选: feature={b['feature']} threshold={b['threshold']!r}")

        # TS 侧该节点的样本与候选排行
        info = next((n for n in run["nodeInfo"] if n["id"] == b["id"]), None)
        if not info or not info.get("idx"):
            print("  （无 idx 数据）")
            continue
        idx = info["idx"]
        Xs = X[idx]
        ys = y[idx]
        print(f"  该节点样本数 n={len(idx)}")
        print("  TS  top3:  " + " | ".join(f"f={t['feature']} t={t['threshold']:.8f} g={t['gain']:.12f}" for t in info["top"]))

        for dtype in (np.float64, np.float32):
            top = ranked(Xs, ys, run["criterion"], n_classes, dtype)
            name = "PY64" if dtype == np.float64 else "PY32"
            print(
                f"  {name} top3: "
                + " | ".join(f"f={f} t={t:.8f} g={g:.12f}" for g, f, t in top)
            )

        top64 = ranked(Xs, ys, run["criterion"], n_classes, np.float64)
        ts_top = info["top"][0]
        d_ts = abs(ts_top["gain"] - top64[0][0])
        print(f"  TS 最优增益 vs PY 最优增益 差 = {d_ts:.3e}  （越小说明 TS 算得对）")
        if len(top64) > 1:
            print(f"  PY 第1名与第2名增益差 = {top64[0][0] - top64[1][0]:.3e}  （越小说明两个候选几乎打平）")
        print()
        shown += 1
        if shown >= 6:
            break
    return 0


if __name__ == "__main__":
    sys.exit(main())
