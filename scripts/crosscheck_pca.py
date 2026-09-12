"""用 sklearn 的 PCA 复算，与 TS 手写的 PCA 对拍。

为什么这轮不需要"回传随机产物"：
    PCA 是**确定性**的（没有随机初始化），两边吃同一份数据就该给出同一组方向。
    唯一的坑是**主成分的符号**——特征向量的方向可以整体翻转（v 与 -v 是同一根轴），
    numpy 与我的 Jacobi 实现取哪一侧是任意的，所以比对时要把符号对齐。

比对项（由弱到强）：
  1. **mean_** —— 中心化用的均值
  2. **explained_variance_** / **_ratio_** —— 每根轴上的方差与占比
  3. **components_** —— 主成分**方向**（先按符号对齐，再比最大绝对偏差）
  4. **transform(X)** —— 投影坐标（同样先对齐符号）
  5. **逆变换 / 重构误差** —— 用 k 个主成分重构回原空间，MSE 必须一致
  6. **累计方差比** —— 页面文案里的"降 4→2 保住 97.77%"必须是真的

另外把主成分之间的**正交性**、以及"投影后各列协方差为 0"也各自验一遍——
这两条是 PCA 的定义性质，比单纯比数字更能说明实现是对的。

用法：python scripts/crosscheck_pca.py
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


PY = sys.executable  # 仅用于给 subprocess 跑 Node；本脚本自身的解释器由 ensure_env 保证


def load_ts():
    r = subprocess.run(
        ["node", str(ROOT / "scripts/crosscheck_pca.mjs")],
        capture_output=True, text=True, cwd=str(ROOT),
    )
    if r.returncode != 0:
        print("Node 侧跑失败了：\n", r.stderr[-3000:])
        sys.exit(1)
    return json.loads(r.stdout)


def align_sign(a, b):
    """把 b 的每一列（每个主成分）翻转成与 a 同向，再做比较。

    符号本身没有意义（v 与 -v 是同一根轴），所以只比"方向"。
    这里比较的最大偏差是**绝对值**偏差，符号对齐只是为了让诊断输出好读。
    """
    out = b.copy()
    for j in range(b.shape[0] if b.ndim == 2 else 1):
        av = a[j] if a.ndim == 2 else a
        bv = b[j] if b.ndim == 2 else b
        if float(np.dot(av, bv)) < 0:
            out[j] = -bv
        else:
            out[j] = bv
    return out


def main():
    from sklearn.decomposition import PCA

    data = load_ts()
    ds_by_id = {d["id"]: d for d in data["datasets"]}

    fails = []
    notes = []
    worst = {"comp": 0.0, "ratio": 0.0, "score": 0.0, "mse": 0.0, "mean": 0.0}
    n_checked = 0

    for run in data["runs"]:
        ds = ds_by_id[run["dataset"]]
        X = np.array(ds["X"], dtype=float)
        p = ds["p"]
        tag = f"{run['dataset']:<9} n={ds['n']:<4} p={p}"

        sk = PCA(svd_solver="full").fit(X)

        # 1. mean_
        dmean = float(np.max(np.abs(np.array(run["mean"]) - sk.mean_)))
        worst["mean"] = max(worst["mean"], dmean)
        if dmean > 1e-12:
            fails.append(f"{tag} mean 最大差异 {dmean:.3e}")

        # 2. explained_variance_ / ratio
        dvar = float(np.max(np.abs(np.array(run["explainedVariance"]) - sk.explained_variance_)))
        dratio = float(np.max(np.abs(np.array(run["explainedVarianceRatio"]) - sk.explained_variance_ratio_)))
        worst["ratio"] = max(worst["ratio"], dratio)
        if dvar > 1e-9:
            fails.append(f"{tag} explained_variance 最大差异 {dvar:.3e}")
        if dratio > 1e-12:
            fails.append(f"{tag} 解释方差比最大差异 {dratio:.3e}")

        # 3. components_（方向）
        c_ts = np.array(run["components"], dtype=float)
        c_al = align_sign(c_ts, sk.components_)
        dcomp = float(np.max(np.abs(c_al - c_ts)))
        worst["comp"] = max(worst["comp"], dcomp)
        if dcomp > 1e-10:
            fails.append(f"{tag} 主成分方向最大偏差 {dcomp:.3e}")

        # 主成分必须两两正交（定义性质）
        gram = c_ts @ c_ts.T
        orth_err = float(np.max(np.abs(gram - np.eye(p))))
        if orth_err > 1e-10:
            fails.append(f"{tag} 主成分不正交，偏差 {orth_err:.3e}")

        # 4-5. 各 k 的投影 / 重构
        for rc in run["reconstructions"]:
            k = rc["k"]
            pk = PCA(n_components=k, svd_solver="full").fit(X)

            z_ts = np.array(rc["scores"], dtype=float)
            z_sk = pk.transform(X)
            z_al = align_sign(z_ts.T, z_sk.T).T
            dscore = float(np.max(np.abs(z_al - z_ts)))
            worst["score"] = max(worst["score"], dscore)
            if dscore > 1e-9:
                fails.append(f"{tag} k={k} 投影坐标最大偏差 {dscore:.3e}")

            # 投影后每一列的协方差必须接近 0（"去掉相关性"）
            if z_ts.shape[1] >= 2:
                cov = np.cov(z_ts.T)
                offd = cov - np.diag(np.diag(cov))
                if float(np.max(np.abs(offd))) > 1e-8:
                    fails.append(f"{tag} k={k} 投影后仍存在相关，最大协方差 {float(np.max(np.abs(offd))):.3e}")

            xh_ts = np.array(rc["Xhat"], dtype=float)
            xh_sk = pk.inverse_transform(z_sk)
            dmse = abs(float(np.mean((X - xh_ts) ** 2)) - float(np.mean((X - xh_sk) ** 2)))
            worst["mse"] = max(worst["mse"], dmse)
            if dmse > 1e-10:
                fails.append(f"{tag} k={k} 重构 MSE 差 {dmse:.3e}")

            # 保住的比例也要对得上
            kept_ts = rc["keptRatio"]
            kept_sk = float(np.sum(pk.explained_variance_ratio_))
            if abs(kept_ts - kept_sk) > 1e-12:
                fails.append(f"{tag} k={k} 累计方差比 TS={kept_ts:.12f} sk={kept_sk:.12f}")

        notes.append(
            f"  {tag} 主成分占比 " + " ".join(f"{v:.4f}" for v in sk.explained_variance_ratio_)
            + f"　累计 " + " ".join(f"{v:.3f}" for v in np.cumsum(sk.explained_variance_ratio_))
        )
        n_checked += 1

    notes.append("")
    notes.append("· 降维到 2 维后，原始空间 top-5 邻居还剩几个（只对 p>2 的数据集有意义）：")
    for r in data["knnPreserve"]:
        notes.append(f"  {r['dataset']:<9} {r['from']}→{r['to']} 维　保持 {r['overlap'] * 100:5.1f}%")

    print("\n".join(notes))
    print("=" * 76)
    print(f"· 共比对 {n_checked} 个数据集（每个都跑了全维度 + 所有 k 的重构）")
    print(f"· 均值 {worst['mean']:.3e}　主成分方向 {worst['comp']:.3e}　"
          f"解释方差比 {worst['ratio']:.3e}")
    print(f"· 投影坐标 {worst['score']:.3e}　重构 MSE {worst['mse']:.3e}")
    print("=" * 76)
    if fails:
        print(f"❌ 对拍失败，共 {len(fails)} 处：")
        for f in fails[:20]:
            print("  -", f)
        return 1
    print("✅ 对拍通过：均值 / 主成分方向 / 方差占比 / 投影坐标 / 重构误差与 sklearn 一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
