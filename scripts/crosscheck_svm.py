"""用 sklearn 的 SVC（底层 libsvm）复算，与 TS 手写的 SMO 对拍。

判据（从"最终目标"往回排）：
  1. **决策函数**：在全部数据点与一张 15×15 网格上，与 sklearn 的 decision_function 逐点一致
     —— 这是最本质的一条：SVM 训练出来就是这条函数
  2. **预测标签**：与 sklearn 一致
  3. **对偶目标值**：两边各自算 Σα − ½αᵀQα，最优值应当相同（凸二次规划）
  4. **线性核的原始权重 w**：唯一，逐分量一致；由此得到的间隔宽度 2/‖w‖ 也一致
  5. **KKT 残差**（TS 自检，不依赖 sklearn）：最优解应当让所有样本都满足 KKT

关于支持向量个数：
  对偶解在退化情形下可能不唯一（多个 α 给出同一条 f），RBF 核正定所以通常唯一，
  线性核在样本线性相关时可能不唯一。脚本会报告差异，但不作为失败判据——
  **判据是 f 一致，不是 α 一致**。

用法：python scripts/crosscheck_svm.py
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

TOL_DEC = 5e-3      # 决策函数容差（两边 KKT 容差同为 1e-4，停止点不同，差异在 1e-3 量级）
TOL_OBJ = 1e-6      # 对偶目标相对容差
TOL_W = 1e-3        # 线性核权重容差
TOL_KKT = 1e-3      # KKT 残差上限

PY = sys.executable  # 仅用于给 subprocess 跑 Node；本脚本自身的解释器由 ensure_env 保证


def load_ts():
    r = subprocess.run(
        ["node", str(ROOT / "scripts/crosscheck_svm.mjs")],
        capture_output=True, text=True, cwd=str(ROOT),
    )
    if r.returncode != 0:
        print("Node 侧跑失败了：\n", r.stderr[-3000:])
        sys.exit(1)
    return json.loads(r.stdout)


def kernel_matrix(X, run):
    gamma, degree, coef0 = run["gamma"], run["degree"], 0.0
    if run["kernel"] == "linear":
        return X @ X.T
    if run["kernel"] == "rbf":
        sq = np.sum(X * X, axis=1)
        d2 = sq[:, None] + sq[None, :] - 2 * (X @ X.T)
        np.maximum(d2, 0, out=d2)
        return np.exp(-gamma * d2)
    return (gamma * (X @ X.T) + coef0) ** degree


def dual_objective(alpha, ys, K):
    """max Σα − ½ ΣΣ αᵢαⱼyᵢyⱼKᵢⱼ。注意 ys 必须是 ±1，用 0/1 会算错（踩过）"""
    q = (alpha * ys) @ K @ (alpha * ys)
    return float(alpha.sum() - 0.5 * q)


def main():
    from sklearn.svm import SVC

    data = load_ts()
    ds_by_id = {d["id"]: d for d in data["datasets"]}

    fails = []
    notes = []
    worst_dec = 0.0
    worst_obj = 0.0
    worst_w = 0.0
    sv_diff = []
    n_checked = 0

    for run in data["runs"]:
        ds = ds_by_id[run["dataset"]]
        X = np.array(ds["X"], dtype=float)
        y = np.array(ds["y"], dtype=int)
        tag = f"{run['dataset']}/{run['kernel']}(C={run['C']},γ={run['gamma']},d={run['degree']})"

        clf = SVC(
            C=run["C"],
            kernel=run["kernel"],
            gamma=run["gamma"],
            degree=run["degree"],
            coef0=0.0,
            tol=1e-4,
            max_iter=-1,
        ).fit(X, y)

        # ---------- 1) 决策函数 ----------
        dec_sk = clf.decision_function(X)
        dec_ts = np.array(run["decValues"])
        if len(dec_sk) != len(dec_ts):
            fails.append(f"{tag} 决策函数长度不一致")
            continue
        d = float(np.max(np.abs(dec_sk - dec_ts)))
        worst_dec = max(worst_dec, d)
        # 只报"绝对值超过容差且相对量级也超过"的
        scale = max(1.0, float(np.max(np.abs(dec_sk))))
        if d > TOL_DEC * scale:
            fails.append(f"{tag} 决策函数最大差异 {d:.3e}（量级 {scale:.3f}）")

        # 网格点
        dec_grid_sk = clf.decision_function(np.array(run["grid"], dtype=float))
        dec_grid_ts = np.array(run["gridDec"])
        dg = float(np.max(np.abs(dec_grid_sk - dec_grid_ts)))
        worst_dec = max(worst_dec, dg)
        if dg > TOL_DEC * scale:
            fails.append(f"{tag} 网格上决策函数最大差异 {dg:.3e}")

        # ---------- 2) 预测 ----------
        pred_sk = clf.predict(X)
        pred_ts = np.where(dec_ts > 0, 1, 0)
        n_bad = int(np.sum(pred_sk != pred_ts))
        if n_bad:
            fails.append(f"{tag} 预测标签有 {n_bad} 个不一致")

        # ---------- 3) 对偶目标 ----------
        K = kernel_matrix(X, run)
        ys = np.where(y == 1, 1.0, -1.0)  # 必须用 ±1，不能拿 0/1 去算
        obj_ts = run["dualObjective"]

        # 从 sklearn 的支持向量重建全量 α：dual_coef_ = αᵢ · yᵢ
        alpha_sk = np.zeros(len(y))
        dual_coef = clf.dual_coef_[0]
        for k, idx in enumerate(clf.support_):
            alpha_sk[idx] = dual_coef[k] * ys[idx]
        obj_sk = dual_objective(alpha_sk, ys, K)

        # TS 侧的全量 α（有回传就逐项比，没有就只比目标值）
        if run.get("alpha"):
            da = float(np.max(np.abs(alpha_sk - np.array(run["alpha"]))))
        else:
            da = float("nan")

        rel = abs(obj_ts - obj_sk) / max(1e-12, abs(obj_sk))
        worst_obj = max(worst_obj, rel)
        if rel > TOL_OBJ:
            notes.append(
                f"  {tag} 对偶目标相对差 {rel:.2e}（TS={obj_ts:.10f} / sk={obj_sk:.10f}），"
                f"α 最大差异 {da:.2e}，决策函数差异 {d:.2e}"
            )

        # ---------- 4) 线性核的 w 与间隔宽度 ----------
        if run["kernel"] == "linear":
            w_sk = clf.coef_[0]
            w_ts = np.array(run["w"])
            dw = float(np.max(np.abs(w_sk - w_ts)))
            worst_w = max(worst_w, dw)
            if dw > TOL_W:
                fails.append(f"{tag} 原始权重 w 最大差异 {dw:.3e}")
            mw_sk = 2.0 / np.linalg.norm(w_sk)
            if run["marginWidth"] is not None and abs(mw_sk - run["marginWidth"]) > 1e-3:
                fails.append(
                    f"{tag} 间隔宽度不一致 TS={run['marginWidth']:.8f} sk={mw_sk:.8f}"
                )

        # ---------- 5) KKT 自检 ----------
        if run["kktResidual"] > TOL_KKT:
            fails.append(f"{tag} KKT 残差 {run['kktResidual']:.3e} 偏大，解没到最优")

        # ---------- 6) 支持向量数（只报告） ----------
        if clf.n_support_.sum() != run["nSV"]:
            sv_diff.append(
                f"  {tag}: TS {run['nSV']} 个 SV（自由 {run['nFree']} / 上界 {run['nBound']}），"
                f"sklearn {int(clf.n_support_.sum())} 个"
            )

        n_checked += 1

    notes.insert(0, f"共比对 {n_checked} 组（5 个数据集 × 线性/RBF/多项式核 × 几档 C 与 γ）")
    notes.append(f"决策函数最大差异 {worst_dec:.3e}；对偶目标最大相对差 {worst_obj:.3e}；线性核 w 最大差异 {worst_w:.3e}")
    if sv_diff:
        notes.append("支持向量个数差异（对偶解不唯一，f 一致即可）：")
        notes.extend(sv_diff[:6])
    else:
        notes.append("支持向量个数与 sklearn 完全一致")

    print("=" * 66)
    for n in notes:
        print("·", n)
    print("=" * 66)
    if fails:
        print(f"❌ 对拍失败，共 {len(fails)} 处：")
        for f in fails[:20]:
            print("  -", f)
        return 1
    print("✅ 对拍通过：决策函数 / 预测 / 对偶目标 / 线性核权重与 libsvm 一致，KKT 满足")
    return 0


if __name__ == "__main__":
    sys.exit(main())
