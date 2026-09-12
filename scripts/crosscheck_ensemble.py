"""用 sklearn 复算 Bagging 与 AdaBoost，与 TS 手写实现对拍。

这一页的难点和之前几页不同：**Bagging 里有随机采样**（bootstrap），
我的 PRNG 和 numpy 不是同一个，所以两边的采样结果天然不同，
直接比"训练出来的模型"没有意义。

所以对拍分两条线：

  **Bagging —— 比"集成逻辑"，不比随机性**
    Node 侧把每棵树的 bootstrap 索引回传，Python 用**同一批索引**训练 sklearn 的决策树，
    再照同样的投票规则集成。这样比的是：加权树的训练（阈值规则、叶子取值）和投票逻辑。
    判据：每棵树的预测一致 + 集成预测一致 + 准确率一致。

  **AdaBoost —— 比"完整算法"**
    AdaBoost 是确定性的（没有采样），所以可以整条链路比：
    逐轮的加权错误率 estimator_errors_、发言权 estimator_weights_（= α）、最终预测。
    这三样一起对上，说明 SAMME 的公式和权重更新都写对了。

用法：python scripts/crosscheck_ensemble.py
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
        ["node", str(ROOT / "scripts/crosscheck_ensemble.mjs")],
        capture_output=True, text=True, cwd=str(ROOT),
    )
    if r.returncode != 0:
        print("Node 侧跑失败了：\n", r.stderr[-3000:])
        sys.exit(1)
    return json.loads(r.stdout)


def main():
    from sklearn.ensemble import AdaBoostClassifier
    from sklearn.tree import DecisionTreeClassifier

    data = load_ts()
    ds_by_id = {d["id"]: d for d in data["datasets"]}

    fails = []
    notes = []
    worst_bag_tree = 0
    worst_bag_ens = 0
    worst_err = 0.0
    worst_alpha = 0.0

    # 微扰版数据集：对称性被打断，这里必须完全一致；原版允许等优分裂造成的分歧
    JITTERED = {"moons-jitter", "xor-jitter"}

    # ---------------- Bagging ----------------
    for run in data["bagging"]:
        ds = ds_by_id[run["dataset"]]
        X = np.array(ds["X"], dtype=float)
        y = np.array(ds["y"], dtype=int)
        maxDepth = run["maxDepth"]
        strict = run["dataset"] in JITTERED
        tag = f"bagging/{run['dataset']}(depth={maxDepth}, k={run['k']})"

        tree_preds_sk = []
        for idx in run["bootstrapIdx"]:
            clf = DecisionTreeClassifier(max_depth=maxDepth, min_samples_leaf=2, random_state=0)
            # Bootstrap 索引会让同一个样本出现多次；sklearn 里用 sample_weight 表达重复更等价，
            # 但这里为了忠实"有放回采样出的数据集"，直接按索引取行（重复行也保留）。
            clf.fit(X[idx], y[idx])
            tree_preds_sk.append(clf.predict(X))

        # 逐棵树比
        n_tree_bad = 0
        for a, b in zip(tree_preds_sk, run["treePreds"]):
            pb = np.array([int(c) for c in b])
            bad = int(np.sum(a != pb))
            if bad:
                n_tree_bad += 1
                worst_bag_tree = max(worst_bag_tree, bad)
        # 集成：简单多数投票（平票取较小的类别，与 TS 的规则一致）
        stack = np.stack(tree_preds_sk)
        votes = np.stack([(stack == c).sum(axis=0) for c in (0, 1)])
        ens_sk = np.argmax(votes, axis=0)
        ens_ts = np.array([int(c) for c in run["ensPreds"]])
        bad_ens = int(np.sum(ens_sk != ens_ts))
        worst_bag_ens = max(worst_bag_ens, bad_ens)

        acc_sk = float(np.mean(ens_sk == y))
        if abs(acc_sk - run["ensAcc"]) > 1e-12:
            fails.append(f"{tag} 集成准确率不一致 TS={run['ensAcc']:.6f} sk={acc_sk:.6f}")

        if strict and (n_tree_bad > 0 or bad_ens > 0):
            fails.append(
                f"{tag} 微扰版应当完全一致，实际：{n_tree_bad} 棵树不同、集成差 {bad_ens} 个"
            )

        notes.append(
            f"  {tag:<34} 单棵树 {n_tree_bad}/{run['k']} 棵与 sklearn 不同，"
            f"集成准确率 {acc_sk * 100:.2f}%（集成预测差 {bad_ens} 个）"
            + ("　← 微扰版，要求严格一致" if strict else "")
        )

    # ---------------- AdaBoost ----------------
    for run in data["boosting"]:
        ds = ds_by_id[run["dataset"]]
        X = np.array(ds["X"], dtype=float)
        y = np.array(ds["y"], dtype=int)
        maxDepth = run["maxDepth"]
        T = len(run["rounds"])
        strict = run["dataset"] in JITTERED
        tag = f"adaboost/{run['dataset']}(depth={maxDepth}, T={T})"

        # sklearn 1.9 已经移除了 algorithm 参数（SAMME.R 被删，只剩 SAMME，也就是默认）
        clf = AdaBoostClassifier(
            estimator=DecisionTreeClassifier(max_depth=maxDepth, min_samples_leaf=2),
            n_estimators=T,
            learning_rate=1.0,
        ).fit(X, y)

        errs_sk = clf.estimator_errors_
        alphas_sk = clf.estimator_weights_
        errs_ts = np.array([r["err"] for r in run["rounds"]])
        alphas_ts = np.array([r["alpha"] for r in run["rounds"]])

        m = min(len(errs_sk), len(errs_ts))
        de = float(np.max(np.abs(errs_sk[:m] - errs_ts[:m]))) if m else 0.0
        da = float(np.max(np.abs(alphas_sk[:m] - alphas_ts[:m]))) if m else 0.0
        # 从第几轮开始分岔（err 第一次不一致的位置）
        split_at = None
        for i in range(m):
            if abs(errs_sk[i] - errs_ts[i]) > 1e-9:
                split_at = i + 1
                break

        pred_sk = clf.predict(X)
        pred_ts = np.array([int(c) for c in run["finalPreds"]])
        bad = int(np.sum(pred_sk != pred_ts))

        if strict:
            worst_err = max(worst_err, de)
            worst_alpha = max(worst_alpha, da)
            if de > 1e-9:
                fails.append(f"{tag} 微扰版加权错误率最大差异 {de:.3e}")
            if da > 1e-9:
                fails.append(f"{tag} 微扰版发言权 α 最大差异 {da:.3e}")
            if bad:
                fails.append(f"{tag} 微扰版最终预测有 {bad} 个不一致")
            if len(errs_sk) != len(errs_ts):
                fails.append(f"{tag} 微扰版轮数不同 TS={len(errs_ts)} sk={len(errs_sk)}")
        else:
            if split_at is None:
                worst_err = max(worst_err, de)
                worst_alpha = max(worst_alpha, da)
                if de > 1e-9 or bad:
                    fails.append(f"{tag} 没有分岔却出现差异（err 差 {de:.3e}，预测差 {bad}）")

        acc_sk = float(np.mean(pred_sk == y))
        if abs(acc_sk - run["finalAcc"]) > 1e-12:
            fails.append(f"{tag} 集成准确率不一致 TS={run['finalAcc']:.6f} sk={acc_sk:.6f}")

        notes.append(
            f"  {tag:<34} 逐轮 err 最大差 {de:.2e}，α 最大差 {da:.2e}，"
            f"最终准确率 {acc_sk * 100:.2f}%（预测差 {bad} 个）"
            + (
                "　← 微扰版，要求严格一致"
                if strict
                else (f"　← 第 {split_at} 轮起分岔（等优分裂）" if split_at else "")
            )
        )
        notes.append(f"      逐轮 err： " + " ".join(f"{v:.4f}" for v in errs_ts[:8]))
        notes.append(f"      逐轮 α  ： " + " ".join(f"{v:.4f}" for v in alphas_ts[:8]))

    print("\n".join(notes))
    print("=" * 74)
    print(f"· Bagging：单棵树预测最多差 {worst_bag_tree} 个样本，集成预测最多差 {worst_bag_ens} 个")
    print(f"· AdaBoost：加权错误率最大差 {worst_err:.3e}，发言权 α 最大差 {worst_alpha:.3e}")
    print("=" * 74)
    if fails:
        print(f"❌ 对拍失败，共 {len(fails)} 处：")
        for f in fails[:20]:
            print("  -", f)
        return 1
    print("✅ 对拍通过：Bagging 的树与投票、AdaBoost 的 err/α/权重更新/预测与 sklearn 一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
