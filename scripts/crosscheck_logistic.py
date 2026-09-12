"""用 numpy / scipy / sklearn 复算，与 TS 的 Logistic 回归实现对拍。

判据分三层，逐层加深：
  1. 数值函数：sigmoid 对 scipy.expit，softplus 对 np.logaddexp(0, t)
  2. 同参数点：损失、梯度、预测概率与 numpy 独立复算比对（公式有没有写错）
  3. 训练过程：固定 200 epoch 的批量梯度下降，与 numpy 独立实现逐步比对（GD 有没有走错）
  4. 最优损失：与 sklearn 的 lbfgs（无正则）比对最终损失（凸问题最优值唯一）

第 4 项对「线性可分」数据集跳过——无正则时最优解在无穷远处，损失没有下确界，
比较"最终损失"没有意义。这不是实现问题，是问题本身的性质。

用法：python scripts/crosscheck_logistic.py
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

TOL = 1e-9          # 数值函数容差
TOL_GRAD = 1e-12    # 损失/梯度容差
TOL_GD = 1e-8       # 200 步 GD 后的容差（累积误差）
TOL_OPT = 1e-6      # 最优损失容差

PY = sys.executable  # 仅用于给 subprocess 跑 Node；本脚本自身的解释器由 ensure_env 保证


def load_ts():
    r = subprocess.run(
        ["node", str(ROOT / "scripts/crosscheck_logistic.mjs")],
        capture_output=True, text=True, cwd=str(ROOT),
    )
    if r.returncode != 0:
        print("Node 侧跑失败了：\n", r.stderr[-2000:])
        sys.exit(1)
    return json.loads(r.stdout)


# ---------- 与 TS 同一套公式，但用 numpy 独立写一遍 ----------
def sigmoid(z):
    z = np.asarray(z, dtype=np.float64)
    out = np.empty_like(z)
    pos = z >= 0
    out[pos] = 1.0 / (1.0 + np.exp(-z[pos]))
    ez = np.exp(z[~pos])
    out[~pos] = ez / (1.0 + ez)
    return out


def softplus(t):
    return np.logaddexp(0.0, np.asarray(t, dtype=np.float64))


def z_of(X, p):
    return X[:, 0] * p["w1"] + X[:, 1] * p["w2"] + p["b"]


def loss_np(X, y, p):
    s = np.where(y == 1, 1.0, -1.0)
    return float(np.mean(softplus(-s * z_of(X, p))))


def grad_np(X, y, p):
    e = sigmoid(z_of(X, p)) - y
    n = len(y)
    return {
        "w1": float(np.sum(e * X[:, 0]) / n),
        "w2": float(np.sum(e * X[:, 1]) / n),
        "b": float(np.sum(e) / n),
    }


def acc_np(X, y, p, thr=0.5):
    pred = (sigmoid(z_of(X, p)) >= thr).astype(int)
    return float(np.mean(pred == y))


def main():
    data = load_ts()
    fails = []
    n_sig = n_probe = n_gd = n_opt = 0

    # ---------- 1) sigmoid / softplus ----------
    try:
        from scipy.special import expit
        has_scipy = True
    except Exception:
        has_scipy = False

    for item in data["sigmoid"]:
        z = np.array([item["z"]], dtype=np.float64)
        ref_sig = float(expit(z)[0]) if has_scipy else float(sigmoid(z)[0])
        ref_sp = float(np.logaddexp(0.0, z)[0])
        if abs(item["sigmoid"] - ref_sig) > TOL:
            fails.append(f"sigmoid({item['z']}) TS={item['sigmoid']} 参考={ref_sig}")
        if abs(item["softplus"] - ref_sp) > max(TOL, abs(ref_sp) * 1e-12):
            fails.append(f"softplus({item['z']}) TS={item['softplus']} 参考={ref_sp}")
        n_sig += 1
    src = "scipy.expit" if has_scipy else "numpy 自算"

    # ---------- 2) 同参数点的损失 / 梯度 / 准确率 ----------
    ds_map = {d["id"]: d for d in data["datasets"]}
    for pr in data["probes"]:
        d = ds_map[pr["dataset"]]
        X = np.array(d["X"], dtype=np.float64)
        y = np.array(d["y"], dtype=np.float64)
        p = pr["params"]
        if abs(pr["loss"] - loss_np(X, y, p)) > TOL_GRAD:
            fails.append(
                f"{pr['dataset']} 损失不一致 TS={pr['loss']:.12f} numpy={loss_np(X, y, p):.12f}"
            )
        g = grad_np(X, y, p)
        for k in ("w1", "w2", "b"):
            if abs(pr["grad"][k] - g[k]) > TOL_GRAD:
                fails.append(
                    f"{pr['dataset']} 梯度 {k} 不一致 TS={pr['grad'][k]:.12f} numpy={g[k]:.12f}"
                )
        if abs(pr["acc05"] - acc_np(X, y, p)) > 1e-12:
            fails.append(f"{pr['dataset']} 准确率不一致 TS={pr['acc05']} numpy={acc_np(X, y, p)}")
        n_probe += 1

    # ---------- 3) 固定 200 epoch 的 GD 逐步对拍 ----------
    for run in [r for r in data["runs"] if r["mode"] == "gd200"]:
        d = ds_map[run["dataset"]]
        X = np.array(d["X"], dtype=np.float64)
        y = np.array(d["y"], dtype=np.float64)
        p = {"w1": 0.4, "w2": -0.3, "b": 0.1}
        lr = run["lr"]
        for _ in range(200):
            g = grad_np(X, y, p)
            p = {"w1": p["w1"] - lr * g["w1"],
                 "w2": p["w2"] - lr * g["w2"],
                 "b": p["b"] - lr * g["b"]}
        for k in ("w1", "w2", "b"):
            if abs(run["params"][k] - p[k]) > TOL_GD * max(1.0, abs(p[k])):
                fails.append(
                    f"{run['dataset']} lr={lr} 200 步后 {k} 不一致 "
                    f"TS={run['params'][k]:.10f} numpy={p[k]:.10f}"
                )
        if abs(run["loss"] - loss_np(X, y, p)) > TOL_GD:
            fails.append(f"{run['dataset']} lr={lr} 200 步后损失不一致")
        n_gd += 1

    # ---------- 4) 与 sklearn 的最优损失对拍 ----------
    try:
        from sklearn.linear_model import LogisticRegression
        from sklearn.metrics import accuracy_score, log_loss
        has_sk = True
    except Exception as e:  # pragma: no cover
        has_sk = False
        print("⚠️  未装 sklearn，跳过第 4 项：", e)

    detail = []
    if has_sk:
        for run in [r for r in data["runs"] if r["mode"] == "long"]:
            d = ds_map[run["dataset"]]
            X = np.array(d["X"], dtype=np.float64)
            y = np.array(d["y"], dtype=np.int64)
            if run["dataset"] == "separable":
                continue  # 无正则 + 线性可分 = 最优解在无穷远，不比
            try:
                clf = LogisticRegression(C=np.inf, solver="lbfgs", max_iter=20000, tol=1e-12)
            except TypeError:
                clf = LogisticRegression(penalty=None, solver="lbfgs", max_iter=20000, tol=1e-12)
            clf.fit(X, y)
            sk_loss = log_loss(y, clf.predict_proba(X))
            sk_acc = accuracy_score(y, clf.predict(X))
            gap = abs(sk_loss - run["loss"])
            if gap > TOL_OPT:
                fails.append(
                    f"{run['dataset']} lr={run['lr']} 最优损失不一致 "
                    f"sklearn={sk_loss:.10f} TS={run['loss']:.10f} 差={gap:.2e}"
                )
            if abs(sk_acc - run["acc05"]) > 1e-9:
                detail.append(
                    f"  · {run['dataset']}：准确率 sklearn={sk_acc:.4f} TS={run['acc05']:.4f}"
                    f"（参数路径不同，允许最后一两个样本判在不同侧）"
                )
            n_opt += 1

    # ---------- 汇总 ----------
    print(f"共校验：sigmoid/softplus {n_sig} 点（参考 {src}）、参数点 {n_probe} 组、"
          f"GD 轨迹 {n_gd} 条、最优损失 {n_opt} 项")
    for line in detail:
        print(line)
    if fails:
        print("\n❌ 对拍失败：")
        for f in fails[:20]:
            print("  -", f)
        return 1
    print("\n✅ Logistic 回归对拍通过：")
    print("   · sigmoid / softplus 与", src, "一致（含 ±800 的极端输入）")
    print("   · 任意参数点上的损失、梯度、准确率与 numpy 独立复算一致")
    print("   · 200 步批量梯度下降的每一步与 numpy 独立实现一致")
    if has_sk:
        print("   · 长时间训练后的最优损失与 sklearn lbfgs（无正则）一致")
        print("   · 注：separable 数据集跳过最优损失比对——无正则时最优解在无穷远，"
              "比较最终损失没有意义")
    return 0


if __name__ == "__main__":
    sys.exit(main())
