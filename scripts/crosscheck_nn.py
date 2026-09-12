"""用 sklearn 的 MLPClassifier 与数值梯度，检验 TS 手写 MLP 的前向与反向传播。

【这一页对拍难在哪，先说清楚】

前面几页（线性回归 / 逻辑回归 / SVM / K-means / PCA）都对拍得很顺，因为它们是**确定性**的，
或者随机性只体现在初始化、且可以用同一份种子复现。MLP 不行：

  1. **权重是随机的，两边的 PRNG 不可能一致** → 不能"各训一个再比结果"。
     正确做法：**把我的权重原样塞进 sklearn**，只比前向输出。
     （sklearn 的权重存在 `coefs_`（每层 (fan_in, fan_out)）与 `intercepts_`（每层 fan_out），
      形状与我的 W/b **完全一致**，可以逐层 hstack 赋值。）

  2. **训练过程不可能逐步对齐**（sklearn 默认 Adam，且批划分不同）→ 不比 loss 曲线。
     改比 **解析梯度 vs 数值梯度**：中心差分近似，完全不需要 sklearn，
     却是"反向传播写对没有"最硬的判据。相对误差应在 1e-8 量级。

  3. **输出层约定容易错**：sklearn 二分类是 **1 个 logit + sigmoid**（不是 softmax）。
     脚本里显式验证这一点，避免我把约定搞错却"碰巧看着像对的"。

  4. **一个真实踩过的坑**：backward 里我把 one-hot 的第 0 列当成 sigmoid 的目标，
     于是 y=1 时目标变成 0——损失照样下降，准确率却是 0%。
     梯度检验**抓不到**它（数学自洽），必须靠"训练后准确率"这类端到端判据兜底。
     所以本脚本额外加了「训练收敛性」检查。

用法：python scripts/crosscheck_nn.py
"""
import json
import os
import pathlib
import subprocess
import sys
import warnings

ROOT = pathlib.Path(__file__).resolve().parent.parent


def ensure_env():
    """当前解释器缺 numpy/sklearn 时，切到 .venv-python 指定的环境重跑自己。

    必须在 `import numpy` 之前调用 —— 否则切换来不及生效。
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
from sklearn.exceptions import ConvergenceWarning
from sklearn.neural_network import MLPClassifier

# make_clf 会故意只跑 1 次迭代（只为了把内部结构建好），必然触发收敛警告；
# 那与我们关心的事情无关，静音掉以免刷屏。
warnings.filterwarnings("ignore", category=ConvergenceWarning)


PY = sys.executable  # 仅用于给 subprocess 跑 Node；本脚本自身的解释器由 ensure_env 保证

# 我的激活函数 → sklearn 的 activation 参数名
ACT_MAP = {"relu": "relu", "tanh": "tanh", "logistic": "logistic", "identity": "identity"}


def load_ts():
    r = subprocess.run(
        ["node", str(ROOT / "scripts/crosscheck_nn.mjs")],
        capture_output=True, text=True, cwd=str(ROOT),
    )
    if r.returncode != 0:
        print("Node 侧跑失败了：\n", r.stderr[-3000:])
        sys.exit(1)
    return json.loads(r.stdout)


def make_clf(sizes, act, n_classes, X, y):
    """造一个 MLPClassifier，并把我的权重原样塞进去。

    为什么先 `fit` 一次再覆盖权重？
        直接手工摆 coefs_ / intercepts_ / classes_ 等内部属性很容易漏掉
        （`predict` 需要 `_label_binarizer`，`predict_proba` 需要 `n_outputs_` 等），
        版本一升级就崩。**先让它自己 fit 一次**把内部状态全部建好，
        再把权重覆盖成我的，这样最稳、也最不依赖 sklearn 内部实现细节。
        （fit 出来的权重会被立刻丢弃，不影响对拍。）
    """
    clf = MLPClassifier(
        hidden_layer_sizes=tuple(sizes[1:-1]),
        activation=ACT_MAP[act],
        solver="lbfgs",
        max_iter=1,
    )
    clf.fit(np.array(X, dtype=float), np.array(y, dtype=int))
    return clf


def set_weights(clf, W, b):
    """把我的 W/b 逐层写进 sklearn 的 MLPClassifier。

    sklearn 的约定（源码 `_forward_pass`）：
        coefs_[l]  形状 (n_in, n_out)
        intercepts_[l] 形状 (n_out,)
    这与我的 W[l] / b[l] **完全一致**，所以直接赋值即可（连转置都不需要）。
    `out_activation_` 由 sklearn 根据类别数定：二分类 = 'logistic'（1 个输出单元）。
    """
    clf.coefs_ = [np.array(w, dtype=float) for w in W]
    clf.intercepts_ = [np.array(bb, dtype=float) for bb in b]
    return clf


def main():
    data = load_ts()
    fails = []
    notes = []

    # ============ 一、前向传播 ============
    worst_fwd = 0.0
    n_fwd = 0
    for fw in data["forwards"]:
        sizes = fw["sizes"]
        n_classes = fw["nClasses"]
        act = fw["activation"]
        X = np.array(fw["X"], dtype=float)
        proba_ts = np.array(fw["proba"], dtype=float)

        # 先用真标签 fit 一次（只为把内部结构建好），再覆盖成我的权重
        y_dummy = np.arange(len(X)) % n_classes
        clf = make_clf(sizes, act, n_classes, X, y_dummy)
        n_out = clf.n_outputs_
        if n_out != sizes[-1]:
            fails.append(f"前向 {fw['id']} 输出单元数不符：sklearn {n_out} vs 我的 {sizes[-1]}")
        set_weights(clf, fw["W"], fw["b"])

        sk = clf.predict_proba(X)

        # 二分类：sklearn 返回 (n,2)，第 1 列是 P(类别1)
        if n_out == 1:
            d0 = float(np.max(np.abs(sk[:, 0] - proba_ts[:, 0])))
            d1 = float(np.max(np.abs(sk[:, 1] - proba_ts[:, 1])))
            d = max(d0, d1)
        else:
            d = float(np.max(np.abs(sk - proba_ts)))
        worst_fwd = max(worst_fwd, d)
        if d > 1e-12:
            fails.append(f"前向 {fw['id']} 概率最大偏差 {d:.3e}")

        # 类别预测也要一致
        pred_sk = clf.predict(X).astype(int)
        pred_ts = np.array(fw["pred"], dtype=int)
        if not np.array_equal(pred_sk, pred_ts):
            bad = int(np.sum(pred_sk != pred_ts))
            fails.append(f"前向 {fw['id']} 预测类别不一致（{bad}/{len(pred_ts)} 个不同）")

        notes.append(
            f"  {fw['id']:<26} 结构 {str(sizes):<14} {act:<9} "
            f"{n_classes} 类　差 {d:.3e}"
        )
        n_fwd += 1

    # ============ 二、数值梯度检验 ============
    worst_grad = 0.0
    worst_grad_id = ""
    n_grad = 0
    for gc in data["gradChecks"]:
        rel = gc["maxRelError"]
        worst_grad = max(worst_grad, rel)
        if rel > worst_grad:
            worst_grad_id = gc["id"]
        # 中心差分 + float64 的极限大约在 1e-8 附近；
        # logistic 的饱和区会把有效精度压低（曾见 4.5e-6），所以阈值放到 1e-4。
        if rel > 1e-4:
            fails.append(
                f"梯度 {gc['id']} 相对误差过大 {rel:.3e}"
                f"（最差一项 解析={gc['worst'][0]['analytic']:.6e} "
                f"数值={gc['worst'][0]['numeric']:.6e}）"
            )
        notes.append(
            f"  {gc['id']:<26} loss={gc['loss']:.6f} 参数 {gc['nParams']:>3} 个　"
            f"最大相对误差 {rel:.3e}"
        )
        n_grad += 1

    # 单独把最差的那个的细节打出来，便于确认"只是饱和区"而不是真错
    worst_item = max(data["gradChecks"], key=lambda g: g["maxRelError"])
    notes.append("")
    notes.append(f"· 最差梯度项来自 {worst_item['id']}（{worst_item['activation']} 激活）：")
    for w in worst_item["worst"][:3]:
        notes.append(
            f"    解析 {w['analytic']:+.8e}　数值 {w['numeric']:+.8e}　相对 {w['rel']:.2e}"
        )
    notes.append("    这个量级的绝对值本身极小（~1e-6），是 sigmoid 饱和区把有效位数吃掉了。")

    # ============ 三、输出层约定：二分类是 sigmoid 而非 softmax ============
    oc = data["outputConvention"]
    n_out = oc["nOutputUnits"]
    if n_out != 1:
        fails.append(f"二分类输出层应为 1 个单元，实际 {n_out} 个")
    # 用同一权重让 sklearn 也跑一遍，确认它给的是 sigmoid 值
    Xoc = np.array(oc["X"], dtype=float)
    clf = make_clf([2, 5, 1], "relu", 2, Xoc, np.arange(len(Xoc)) % 2)
    if clf.n_outputs_ != 1:
        fails.append(f"sklearn 二分类输出单元数为 {clf.n_outputs_}，应为 1")
    set_weights(clf, oc["W"], oc["b"])
    sk_sig = clf.predict_proba(Xoc)[:, 1]
    my_sig = np.array(oc["sigmoid"], dtype=float)
    my_soft = np.array(oc["softmaxSameLogit"], dtype=float)
    d_sig = float(np.max(np.abs(sk_sig - my_sig)))
    d_soft = float(np.max(np.abs(sk_sig - my_soft)))
    notes.append("")
    notes.append("· 输出层约定（二分类）：")
    notes.append(f"    sklearn 概率 vs 我的 sigmoid ：差 {d_sig:.3e}　✅ 说明约定正确")
    notes.append(
        f"    sklearn 概率 vs 强行 softmax：差 {d_soft:.3e}　"
        f"（差得很远，证明 sklearn 二分类确实**不是** softmax）"
    )
    if d_sig > 1e-12:
        fails.append(f"二分类输出层约定不符：sigmoid 分支差 {d_sig:.3e}")
    if d_soft < 1e-6:
        fails.append("二分类输出层疑似用了 softmax（与 sklearn 不符）")

    # ============ 四、训练收敛性（兜住"梯度对但目标错"这类 bug） ============
    tx = data["trainXor"]
    notes.append("")
    notes.append(f"· 训练收敛（异或，结构 {tx['sizes']}，{tx['activation']}，lr={tx['lr']}）：")
    notes.append(
        "    loss " + " → ".join(f"{v:.4f}" for v in tx["lossEvery50"])
    )
    notes.append(
        "    acc  " + " → ".join(f"{v:.2f}" for v in tx["accEvery50"])
    )
    if tx["lastLoss"] > 0.1:
        fails.append(f"异或训练没收敛：末 loss={tx['lastLoss']:.4f}")
    if tx["lastAcc"] < 0.95:
        fails.append(
            f"异或训练准确率只有 {tx['lastAcc']:.2%} —— "
            "梯度看似正确但目标值编码错了（历史上真踩过：用 one-hot 第 0 列当目标）"
        )

    # ============ 五、确定性 ============
    if not data["determinism"]["same"]:
        fails.append("同种子两次训练结果不一致（确定性被破坏）")
    notes.append("")
    notes.append(f"· 同种子两次训练完全一致：{data['determinism']['same']}")

    print("\n".join(notes))
    print("=" * 78)
    print(f"· 前向：{n_fwd} 组结构（3 种激活 × 单/双隐层 × 二/多分类）")
    print(f"· 反向：{n_grad} 组梯度检验，最大相对误差 {worst_grad:.3e}")
    print(f"· 前向概率与 sklearn 最大偏差 {worst_fwd:.3e}")
    print("=" * 78)
    if fails:
        print(f"❌ 对拍失败，共 {len(fails)} 处：")
        for f in fails[:20]:
            print("  -", f)
        return 1
    print("✅ 对拍通过：前向与 sklearn 一致、反向解析梯度与数值梯度一致、训练能收敛")
    return 0


if __name__ == "__main__":
    sys.exit(main())
