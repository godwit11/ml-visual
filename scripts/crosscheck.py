"""用 Python（sklearn，若可用）复算同一组指标，与 TS 实现对拍。

用法：python scripts/crosscheck.py
若当前解释器没有 sklearn，会自动切到 `.venv-python` 里记录的环境重跑。
"""
import json
import os
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def ensure_env():
    """当前解释器缺 sklearn 时，切到 .venv-python 指定的环境重跑"""
    try:
        import sklearn  # noqa: F401

        return
    except ImportError:
        pass
    marker = ROOT / ".venv-python"
    if marker.exists():
        alt = marker.read_text(encoding="utf-8").strip()
        if alt and pathlib.Path(alt).exists() and os.path.abspath(alt) != os.path.abspath(sys.executable):
            print(f"当前解释器无 sklearn，切换到：{alt}")
            os.execv(alt, [alt, str(pathlib.Path(__file__).resolve()), *sys.argv[1:]])
    print("⚠️  未找到 sklearn，本次只做纯 Python 复算（无第三方交叉验证）")


ensure_env()


def py_compute():
    """在同一进程里用纯 Python 复算（sklearn 可选，仅作交叉验证）"""
    data = json.loads((ROOT / "src/data/housing.json").read_text(encoding="utf-8"))
    xs = [p["rm"] for p in data]
    ys = [p["medv"] for p in data]
    n = len(xs)
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    den = sum((x - mx) ** 2 for x in xs)
    w = num / den
    b = my - w * mx

    def mae(w, b):
        return sum(abs(y - (w * x + b)) for x, y in zip(xs, ys)) / n

    def mse(w, b):
        return sum((y - (w * x + b)) ** 2 for x, y in zip(xs, ys)) / n

    ybar = my
    sst = sum((y - ybar) ** 2 for y in ys)

    def r2(w, b):
        return 1 - mse(w, b) * n / sst

    out = {
        "n": n,
        "best": {"w": w, "b": b},
        "metrics_at_best": {"mae": mae(w, b), "mse": mse(w, b), "r2": r2(w, b)},
        "probes": [],
        "predictions": [],
    }
    for f in [
        (0, 22.5),
        (9.1, -34.67),
        (5, 0),
        (-3.25, 40),
        (15.75, -60),
        (9.1021, -34.6706),
    ]:
        out["probes"].append(
            {"w": f[0], "b": f[1], "mae": mae(*f), "mse": mse(*f), "r2": r2(*f)}
        )
    for x in [3.561, 5.0, 6.575, 8.78]:
        out["predictions"].append({"x": x, "y": w * x + b})
    return out


def sklearn_check(ts_best):
    """若装了 sklearn，用 LinearRegression 独立验证闭式解"""
    try:
        import numpy as np
        from sklearn.linear_model import LinearRegression
        from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
    except ImportError:
        return None

    data = json.loads((ROOT / "src/data/housing.json").read_text(encoding="utf-8"))
    X = np.array([[p["rm"]] for p in data])
    y = np.array([p["medv"] for p in data])
    model = LinearRegression().fit(X, y)
    pred = model.predict(X)
    return {
        "coef": float(model.coef_[0]),
        "intercept": float(model.intercept_),
        "mae": float(mean_absolute_error(y, pred)),
        "mse": float(mean_squared_error(y, pred)),
        "r2": float(r2_score(y, pred)),
    }


def main():
    node = shutil.which("node")
    if not node:
        print("找不到 node，无法运行 TS 侧算法")
        return 1
    node_out = subprocess.run(
        [node, str(ROOT / "scripts/crosscheck.mjs")],
        capture_output=True,
        text=True,
        cwd=str(ROOT),
    )
    if node_out.returncode != 0:
        print("node 侧失败：", node_out.stderr[:2000])
        return 1
    ts = json.loads(node_out.stdout)
    py = py_compute()

    def diff(a, b):
        return abs(a - b)

    tol = 1e-9
    fails = []

    if ts["n"] != py["n"]:
        fails.append(f"样本数不一致 {ts['n']} vs {py['n']}")

    for k in ("w", "b"):
        d = diff(ts["best"][k], py["best"][k])
        print(f"OLS {k}: TS={ts['best'][k]:.10f}  PY={py['best'][k]:.10f}  Δ={d:.2e}")
        if d > tol:
            fails.append(f"OLS {k} 差异 {d}")

    for k in ("mae", "mse", "r2"):
        d = diff(ts["metrics_at_best"][k], py["metrics_at_best"][k])
        print(f"最优处 {k}: TS={ts['metrics_at_best'][k]:.10f}  PY={py['metrics_at_best'][k]:.10f}  Δ={d:.2e}")
        if d > tol:
            fails.append(f"最优处 {k} 差异 {d}")

    for i, (a, b) in enumerate(zip(ts["probes"], py["probes"])):
        for k in ("mae", "mse", "r2"):
            d = diff(a[k], b[k])
            if d > tol:
                fails.append(f"探针#{i} (w={a['w']},b={a['b']}) {k} 差异 {d}")
    print(f"探针 {len(ts['probes'])} 组：全部比对完成")

    for a, b in zip(ts["predictions"], py["predictions"]):
        d = diff(a["y"], b["y"])
        if d > tol:
            fails.append(f"预测 x={a['x']} 差异 {d}")
    print(f"单点预测 {len(ts['predictions'])} 个：全部比对完成")

    sk = sklearn_check(ts["best"])
    if sk is None:
        print("sklearn 未安装，跳过第三方交叉验证（纯 Python 复算已通过）")
    else:
        print(
            f"sklearn: coef={sk['coef']:.10f} intercept={sk['intercept']:.10f} "
            f"mae={sk['mae']:.10f} mse={sk['mse']:.10f} r2={sk['r2']:.10f}"
        )
        for k, v in (("w", sk["coef"]), ("b", sk["intercept"])):
            d = diff(ts["best"][k], v)
            if d > 1e-8:
                fails.append(f"sklearn {k} 与 TS 差异 {d}")
        for k in ("mae", "mse", "r2"):
            d = diff(ts["metrics_at_best"][k], sk[k])
            if d > 1e-8:
                fails.append(f"sklearn {k} 与 TS 差异 {d}")

    print()
    if fails:
        print("❌ 对拍失败：")
        for f in fails:
            print("  -", f)
        return 1
    if sk is None:
        print("✅ 对拍通过：TS 实现与 Python 独立复算一致")
        print("   （注意：sklearn 未安装，本次未做第三方库交叉验证）")
    else:
        print("✅ 对拍通过：TS 实现与 Python 复算、sklearn 三者一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
