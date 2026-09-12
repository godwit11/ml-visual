"""用 sklearn 的 BernoulliNB / MultinomialNB 复算，与 TS 手写的朴素贝叶斯对拍。

判据（从模型参数到最终预测，逐层比对）：
  1. **类先验** class_log_prior_ —— 两边一模一样
  2. **特征对数概率** feature_log_prob_ —— 逐元素一致（这是平滑公式有没有写对的判据）
  3. **预测标签** —— 5574 条全部一致
  4. **对数后验概率** predict_log_proba —— 前 300 条逐元素一致（归一化有没有写对）
  5. **评估指标** —— 准确率 / 精确率 / 召回率 / F1 / 混淆矩阵

8 组配置 = 2 种模型 × 4 档平滑系数 α。
注意 α 不能取 0（sklearn 会报错，而且 0 本身就是错的做法），最小取 0.01。

用法：python scripts/crosscheck_nb.py
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

TOL = 1e-10

PY = sys.executable  # 仅用于给 subprocess 跑 Node；本脚本自身的解释器由 ensure_env 保证


def load_ts():
    r = subprocess.run(
        ["node", str(ROOT / "scripts/crosscheck_nb.mjs")],
        capture_output=True, text=True, cwd=str(ROOT),
    )
    if r.returncode != 0:
        print("Node 侧跑失败了：\n", r.stderr[-3000:])
        sys.exit(1)
    return json.loads(r.stdout)


def main():
    from sklearn.metrics import (
        accuracy_score, confusion_matrix, f1_score,
        precision_score, recall_score,
    )
    from sklearn.naive_bayes import BernoulliNB, MultinomialNB

    data = load_ts()
    meta = data["meta"]
    n, d = meta["n"], meta["d"]
    print(f"· 语料：{meta['source']}")
    print(f"· {n} 条短信 × 词表 {d} 个，spam {meta['nSpam']} 条（{meta['nSpam'] / n * 100:.2f}%）")

    # 重建 X（Node 侧给的是稀疏文本）
    X = np.zeros((n, d), dtype=float)
    for i, s in enumerate(data["samples"]):
        if not s:
            continue
        for pair in s.split(" "):
            j, v = pair.split(":")
            X[i, int(j)] = float(v)
    nz = int(np.count_nonzero(X))
    print(f"· 矩阵非零项 {nz}（密度 {nz / (n * d) * 100:.2f}%）")

    y = np.array([int(c) for c in data["y"]], dtype=int)

    fails = []
    notes = []
    worst_feat = 0.0
    worst_proba = 0.0
    n_checked = 0

    if int(y.sum()) != meta["nSpam"]:
        fails.append(f"标签里的 spam 数（{int(y.sum())}）与 meta 声称的 {meta['nSpam']} 不一致")

    for run in data["runs"]:
        model = run["model"]
        alpha = run["alpha"]
        tag = f"{model}(α={alpha})"

        clf = (
            BernoulliNB(alpha=alpha, binarize=0.0, fit_prior=True)
            if model == "bernoulli"
            else MultinomialNB(alpha=alpha, fit_prior=True)
        )
        clf.fit(X, y)

        # ---------- 1) 类先验 ----------
        lp_ts = np.array(run["classLogPrior"])
        if np.max(np.abs(clf.class_log_prior_ - lp_ts)) > TOL:
            fails.append(f"{tag} 类先验不一致")

        # ---------- 2) 特征对数概率 ----------
        flp_ts = np.array(run["featureLogProb"])
        if flp_ts.shape != clf.feature_log_prob_.shape:
            fails.append(f"{tag} feature_log_prob 形状不一致 {flp_ts.shape} vs {clf.feature_log_prob_.shape}")
            continue
        df = float(np.max(np.abs(clf.feature_log_prob_ - flp_ts)))
        worst_feat = max(worst_feat, df)
        if df > TOL:
            fails.append(f"{tag} feature_log_prob 最大差异 {df:.3e}")

        # ---------- 3) 预测 ----------
        pred_sk = clf.predict(X)
        pred_ts = np.array([int(c) for c in run["preds"]], dtype=int)
        n_bad = int(np.sum(pred_sk != pred_ts))
        if n_bad:
            fails.append(f"{tag} 预测有 {n_bad} 条不一致")

        # ---------- 4) 对数后验概率 ----------
        proba_sk = clf.predict_log_proba(X[: len(run["logProba"])])
        proba_ts = np.array(run["logProba"])
        dp = float(np.max(np.abs(proba_sk - proba_ts)))
        worst_proba = max(worst_proba, dp)
        if dp > 1e-8:
            fails.append(f"{tag} 对数后验概率最大差异 {dp:.3e}")

        # ---------- 5) 评估指标 ----------
        ev = run["eval"]
        acc = accuracy_score(y, pred_sk)
        prec = precision_score(y, pred_sk, zero_division=0)
        rec = recall_score(y, pred_sk, zero_division=0)
        f1 = f1_score(y, pred_sk, zero_division=0)
        tn, fp, fn, tp = confusion_matrix(y, pred_sk, labels=[0, 1]).ravel()
        checks = [
            ("accuracy", ev["accuracy"], acc),
            ("precision", ev["precision"], prec),
            ("recall", ev["recall"], rec),
            ("f1", ev["f1"], f1),
            ("tp", ev["confusion"]["tp"], tp),
            ("fp", ev["confusion"]["fp"], fp),
            ("tn", ev["confusion"]["tn"], tn),
            ("fn", ev["confusion"]["fn"], fn),
        ]
        for name, a, b in checks:
            if abs(float(a) - float(b)) > 1e-12:
                fails.append(f"{tag} {name} 不一致 TS={a} sk={b}")

        notes.append(
            f"  {tag:<22} 准确率 {acc * 100:6.2f}%  精确 {prec:.4f}  召回 {rec:.4f}  "
            f"F1 {f1:.4f}  误报 {fp}  漏报 {fn}"
        )
        n_checked += 1

    # 词表几率比（顺带核对一下特征排序）
    notes.append("")
    notes.append("· 最像垃圾短信的词（log 几率比，伯努利 α=1）：")
    top = data["demo"]["alpha1Bernoulli"]["topSpam"]
    notes.append("   " + "  ".join(f"{w}({v:.2f})" for w, v in top[:8]))

    print("\n".join(notes))
    print("=" * 70)
    print(f"· 共比对 {n_checked} 组配置")
    print(f"· 特征对数概率最大差异 {worst_feat:.3e}；对数后验概率最大差异 {worst_proba:.3e}")
    print("=" * 70)
    if fails:
        print(f"❌ 对拍失败，共 {len(fails)} 处：")
        for f in fails[:20]:
            print("  -", f)
        return 1
    print("✅ 对拍通过：类先验 / 特征对数概率 / 预测 / 对数后验概率 / 指标与 sklearn 一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
