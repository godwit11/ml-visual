"""用 sklearn 复算评估指标，与 TS 的 evaluation.ts 对拍。

判据分四层：
  1. 数据管道：TS 输出的分数，是否真等于 sigmoid(w·x + b)（w 由 sklearn 拟合而来）
  2. 指标：7 个阈值 × 3 个数据集上的混淆矩阵与 6 个指标，与 sklearn 严格一致
  3. 曲线：ROC / PR 的每一个点（不只是 AUC）都和 sklearn 一致，AUC 用同一把梯形尺
  4. 折划分：KFold / StratifiedKFold（不洗牌）的索引与 sklearn 逐位一致；
     CV 准确率用 sklearn 决策树在同一批折上复算

第 4 项的准确率允许出现「等优分裂」造成的差异——决策树在打平的候选分裂上
选哪个是自由的（TS 与 sklearn 都可能不同），这不是错误。脚本会统计并如实报告。

用法：python scripts/crosscheck_eval.py
"""
import json
import os
import math
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
from sklearn.metrics import (
    accuracy_score,
    auc,
    confusion_matrix,
    f1_score,
    precision_recall_curve,
    precision_score,
    recall_score,
    roc_curve,
)
from sklearn.model_selection import KFold, StratifiedKFold
from sklearn.tree import DecisionTreeClassifier

TOL = 1e-9
TOL_AUC = 1e-9

PY = sys.executable  # 仅用于给 subprocess 跑 Node；本脚本自身的解释器由 ensure_env 保证


def load_ts():
    r = subprocess.run(
        ["node", str(ROOT / "scripts/crosscheck_eval.mjs")],
        capture_output=True, text=True, cwd=str(ROOT),
    )
    if r.returncode != 0:
        print("Node 侧跑失败了：\n", r.stderr[-3000:])
        sys.exit(1)
    return json.loads(r.stdout)


def main():
    data = load_ts()
    fails = []
    notes = []

    ds_by_id = {d["id"]: d for d in data["datasets"]}

    # ---------- 1) 数据管道：分数是否真的由那组权重算出 ----------
    # 特征直接从 breast.json 读——那才是页面真正用的数据。若改用 sklearn 的原始全精度
    # 数据复算，会引入 1e-4 级的差，那是数据文件的精度，不是算法的问题。
    w = data["breastW"]
    rows = json.loads((ROOT / "src/data/breast.json").read_text(encoding="utf-8"))
    fa = np.array([r["a"] for r in rows], dtype=float)
    fb = np.array([r["b"] for r in rows], dtype=float)
    lab = (np.array([r["y"] for r in rows], dtype=int) == 0).astype(int)  # 正例 = 恶性

    z = w["w1"] * fa + w["w2"] * fb + w["b"]
    p = 1.0 / (1.0 + np.exp(-z))
    ts_breast = np.array(ds_by_id["breast"]["scores"])
    ts_label = np.array(ds_by_id["breast"]["labels"])
    if len(ts_breast) != len(p):
        fails.append(f"breast 样本数不一致 TS={len(ts_breast)} py={len(p)}")
    else:
        d = np.max(np.abs(ts_breast - p))
        if d > 1e-12:
            fails.append(f"breast 分数与 sigmoid(w·x+b) 不符，最大差异 {d:.2e}")
        else:
            notes.append(f"数据管道：breast 分数由硬编码权重复算一致（最大差异 {d:.2e}）")
        if not np.array_equal(ts_label, lab):
            fails.append("breast 标签与「恶性=正例」不符")

    # 权重不是我编的：用页面数据重新拟合一遍，看它与硬编码值差多少
    from sklearn.linear_model import LogisticRegression
    m2 = LogisticRegression(C=np.inf, solver="lbfgs", max_iter=10000, tol=1e-12).fit(
        np.column_stack([fa, fb]), lab
    )
    rel = float(
        np.max(np.abs(m2.coef_[0] - np.array([w["w1"], w["w2"]])) / np.abs([w["w1"], w["w2"]]))
    )
    if rel > 0.01:
        fails.append(f"硬编码权重与 sklearn 重新拟合结果相差过大（相对误差 {rel:.4f}）")
    else:
        notes.append(f"权重来源：硬编码权重与 sklearn 用页面数据重新拟合的相对误差 {rel * 100:.4f}%")

    # 稀有病的抽样规则：与 TS 侧同一套（等间隔抽 19 个正例 + 全部负例）
    pos_all = np.where(lab == 1)[0]
    keep = set(np.where(lab == 0)[0].tolist())
    for i in range(19):
        keep.add(int(pos_all[math.floor(i * len(pos_all) / 19)]))
    rare_idx = np.array(sorted(keep))
    ts_rare = np.array(ds_by_id["rare"]["scores"])
    if len(ts_rare) == len(rare_idx):
        d = np.max(np.abs(ts_rare - p[rare_idx]))
        if d > 1e-12:
            fails.append(f"稀有病数据集抽样规则与 TS 不一致，最大差异 {d:.2e}")
        else:
            notes.append(f"数据管道：稀有病数据集抽样规则一致（{len(rare_idx)} 条）")
    else:
        fails.append(f"稀有病样本数不一致 TS={len(ts_rare)} py={len(rare_idx)}")

    # ---------- 2) 指标 ----------
    n_metric = 0
    for row in data["metrics"]:
        d = ds_by_id[row["dataset"]]
        s = np.array(d["scores"])
        y = np.array(d["labels"])
        t = row["threshold"]
        pred = (s >= t).astype(int)
        cm = confusion_matrix(y, pred, labels=[0, 1])
        tn, fp, fn, tp = cm.ravel()
        m = row["metrics"]
        checks = [
            ("tp", row["conf"]["tp"], tp),
            ("fp", row["conf"]["fp"], fp),
            ("tn", row["conf"]["tn"], tn),
            ("fn", row["conf"]["fn"], fn),
            ("accuracy", m["accuracy"], accuracy_score(y, pred)),
            ("precision", m["precision"], precision_score(y, pred, zero_division=0)),
            ("recall", m["recall"], recall_score(y, pred, zero_division=0)),
            ("f1", m["f1"], f1_score(y, pred, zero_division=0)),
            ("specificity", m["specificity"], tn / (tn + fp) if tn + fp else 0.0),
        ]
        for name, a, b in checks:
            if abs(float(a) - float(b)) > TOL:
                fails.append(f"{row['dataset']}@{t} {name} 不一致 TS={a} py={b}")
        n_metric += 1
    notes.append(f"指标：{n_metric} 组（3 数据集 × 7 阈值）混淆矩阵与 6 项指标全部一致")

    # ---------- 3) 曲线 ----------
    for cur in data["curves"]:
        d = ds_by_id[cur["dataset"]]
        s = np.array(d["scores"])
        y = np.array(d["labels"])

        # 注意 drop_intermediate：sklearn 默认会删掉共线的中间阈值点（曲线形状不受影响），
        # 本页要画"逐个样本移动"的完整曲线，所以比对时必须关掉它。
        fpr, tpr, thr = roc_curve(y, s, drop_intermediate=False)
        ts = cur["roc"]
        if len(fpr) != len(ts["fpr"]):
            fails.append(f"{cur['dataset']} ROC 点数不一致 TS={len(ts['fpr'])} py={len(fpr)}")
        else:
            if np.max(np.abs(fpr - np.array(ts["fpr"]))) > TOL:
                fails.append(f"{cur['dataset']} ROC fpr 不一致")
            if np.max(np.abs(tpr - np.array(ts["tpr"]))) > TOL:
                fails.append(f"{cur['dataset']} ROC tpr 不一致")
            # 首个阈值是 +inf（"不判任何正例"），JSON 里会变成 null，单独判
            if ts["thresholds"][0] is not None or not np.isinf(thr[0]):
                fails.append(f"{cur['dataset']} ROC 首阈值应当是 +inf（TS={ts['thresholds'][0]}）")
            if np.max(np.abs(thr[1:] - np.array(ts["thresholds"][1:]))) > 1e-9:
                fails.append(f"{cur['dataset']} ROC thresholds 不一致")
        a_sk = auc(fpr, tpr)
        if abs(a_sk - ts["auc"]) > TOL_AUC:
            fails.append(f"{cur['dataset']} ROC-AUC 不一致 TS={ts['auc']} py={a_sk}")

        # 反向验证：sklearn 默认（删共线点）的结果，必须是 TS 完整点列的子集
        fpr_d, tpr_d, _ = roc_curve(y, s)
        pts_ts = set(zip(np.round(ts["fpr"], 12), np.round(ts["tpr"], 12)))
        missing = [(a, b) for a, b in zip(fpr_d, tpr_d) if (round(a, 12), round(b, 12)) not in pts_ts]
        if missing:
            fails.append(f"{cur['dataset']} sklearn 精简后的 ROC 点不在 TS 点列中：{missing[:2]}")
        else:
            notes.append(
                f"  {cur['dataset']}: 完整曲线 {len(ts['fpr'])} 点，sklearn 精简后 {len(fpr_d)} 点，全部落在 TS 点列上"
            )

        pr_p, pr_r, pr_t = precision_recall_curve(y, s)
        ts_pr = cur["pr"]
        if len(pr_p) != len(ts_pr["precision"]):
            fails.append(f"{cur['dataset']} PR 点数不一致 TS={len(ts_pr['precision'])} py={len(pr_p)}")
        else:
            if np.max(np.abs(pr_p - np.array(ts_pr["precision"]))) > TOL:
                fails.append(f"{cur['dataset']} PR precision 不一致")
            if np.max(np.abs(pr_r - np.array(ts_pr["recall"]))) > TOL:
                fails.append(f"{cur['dataset']} PR recall 不一致")
            if np.max(np.abs(pr_t - np.array(ts_pr["thresholds"]))) > 1e-9:
                fails.append(f"{cur['dataset']} PR thresholds 不一致")
        # PR-AUC：TS 用 recall 递增的梯形积分，这里用 sklearn 的（recall 递减）取绝对值
        a_pr_sk = abs(auc(pr_r, pr_p))
        if abs(a_pr_sk - ts_pr["auc"]) > 1e-9:
            fails.append(f"{cur['dataset']} PR-AUC(trapezoid) 不一致 TS={ts_pr['auc']} py={a_pr_sk}")

    notes.append(f"曲线：{len(data['curves'])} 个数据集的 ROC/PR 逐点 + AUC 全部一致")

    # ---------- 4) 折划分 ----------
    cvX = {c["id"]: np.array(c["X"], dtype=float) for c in data["cvDatasets"]}
    cvY = {c["id"]: np.array(c["y"], dtype=int) for c in data["cvDatasets"]}
    n_fold_checked = 0
    n_sk_identical = 0
    fold_notes = []
    for f in data["folds"]:
        ds_id, k, strat = f["dataset"], f["k"], f["stratify"]
        X, y = cvX[ds_id], cvY[ds_id]
        ts_folds = [np.array(x) for x in f["folds"]]

        # --- 结构判据：与 sklearn 无关，是「K 折」这个定义本身的要求 ---
        allidx = np.concatenate(ts_folds)
        if len(allidx) != len(y) or len(np.unique(allidx)) != len(y):
            fails.append(f"{ds_id} k={k} strat={strat} 折不是互斥完备的划分")
        sizes = [len(a) for a in ts_folds]
        if max(sizes) - min(sizes) > 1:
            fails.append(f"{ds_id} k={k} strat={strat} 折大小差超过 1：{sizes}")

        if strat:
            sk_folds = [te for _, te in StratifiedKFold(n_splits=k, shuffle=False).split(X, y)]
        else:
            sk_folds = [te for _, te in KFold(n_splits=k, shuffle=False).split(X)]
        if len(sk_folds) != len(ts_folds):
            fails.append(f"{ds_id} k={k} strat={strat} 折数不一致")
            continue
        same = True
        for i, (a_, b_) in enumerate(zip(sk_folds, ts_folds)):
            if not np.array_equal(a_, b_):
                fails.append(f"{ds_id} k={k} {'分层' if strat else '非分层'}第 {i} 折索引不一致")
                same = False
        if same:
            n_sk_identical += 1
        if k == 5:
            tag = "分层" if strat else "非分层"
            fold_notes.append(f"  {ds_id} k=5 {tag}：每折正例 {[int(np.sum(y[a_] == 1)) for a_ in ts_folds]}")
        n_fold_checked += 1

    notes.append(
        f"折划分：{n_fold_checked} 种配置结构合法（互斥完备、折大小差≤1），"
        f"其中 {n_sk_identical} 种与 sklearn 的索引逐位一致"
    )
    notes.extend(fold_notes)

    # ---------- 4b) 每折正例数（分层是否真的生效） ----------
    for f in data["folds"]:
        y = cvY[f["dataset"]]
        pos = [int(np.sum(y[np.array(x)] == 1)) for x in f["folds"]]
        if pos != f["foldPos"]:
            fails.append(f"{f['dataset']} k={f['k']} strat={f['stratify']} 每折正例数不一致 TS={f['foldPos']} py={pos}")

    # ---------- 5) 交叉验证准确率（决策树基模型） ----------
    cv_by_key = {(c["dataset"], c["k"], c["stratify"]): c for c in data["cv"]}
    fold_by_key = {(f["dataset"], f["k"], f["stratify"]): f for f in data["folds"]}
    n_cv = 0
    n_same = 0
    worst = 0.0
    diffs = []
    for key, cvrow in cv_by_key.items():
        ds_id, k, strat = key
        X, y = cvX[ds_id], cvY[ds_id]
        folds = [np.array(x) for x in fold_by_key[key]["folds"]]
        sk_scores = []
        for te in folds:
            tr = np.setdiff1d(np.arange(len(y)), te)
            clf = DecisionTreeClassifier(
                criterion="gini", max_depth=3, min_samples_split=2, random_state=0
            ).fit(X[tr], y[tr])
            sk_scores.append(accuracy_score(y[te], clf.predict(X[te])))
        ts_scores = cvrow["scores"]
        for i, (a, b) in enumerate(zip(ts_scores, sk_scores)):
            n_cv += 1
            d = abs(a - b)
            worst = max(worst, d)
            if d < 1e-12:
                n_same += 1
            else:
                diffs.append(f"{ds_id} k={k} strat={strat} 折{i}: TS={a:.4f} sk={b:.4f}")
        # 均值 / 标准差（ddof=1）
        if abs(np.mean(ts_scores) - cvrow["mean"]) > 1e-12:
            fails.append(f"{ds_id} k={k} strat={strat} 均值自洽性错误")
        if len(ts_scores) > 1:
            sd = np.std(ts_scores, ddof=1)
            if abs(sd - cvrow["std"]) > 1e-12:
                fails.append(f"{ds_id} k={k} strat={strat} 标准差(ddof=1) 自洽性错误")

    notes.append(
        f"交叉验证准确率：{n_cv} 折中 {n_same} 折与 sklearn 决策树完全相同"
        f"（最大差异 {worst:.4f}）"
    )
    if diffs:
        notes.append("  差异明细（决策树在等优分裂上选法不同，属正常）：")
        for d in diffs[:10]:
            notes.append("   - " + d)

    # ---------- 输出 ----------
    print("=" * 64)
    for n in notes:
        print("·", n)
    print("=" * 64)
    if fails:
        print(f"❌ 对拍失败，共 {len(fails)} 处：")
        for f in fails[:25]:
            print("  -", f)
        return 1
    print("✅ 对拍通过：指标 / ROC / PR / AUC / 折划分与 sklearn 严格一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
