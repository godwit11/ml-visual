"""一次性维护脚本：修复 7 个对拍脚本的解释器切换 bug。

问题：这些脚本把「读 .venv-python 取解释器」写在了 `import numpy` 之后，
      可 import 早就执行了，切换永远不生效 —— 从命令行直接 `python xxx.py`
      （用的是无 numpy 的裸解释器）必然 ModuleNotFoundError。
      crosscheck.py / crosscheck_tree.py 用的是正确的 ensure_env() 模式。

修法：在 `import numpy as np` 之前插入 ensure_env() 定义与调用，
      通过 os.execv 原地换成带 sklearn 的解释器再重跑自己。
      保留原有的 PY 变量（它是给 subprocess 跑 Node 用的）。

用法：python scripts/fix_crosscheck_bootstrap.py
"""
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent

TARGETS = [
    "crosscheck_logistic",
    "crosscheck_eval",
    "crosscheck_svm",
    "crosscheck_nb",
    "crosscheck_ensemble",
    "crosscheck_kmeans",
    "crosscheck_pca",
]

BLOCK = '''
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

'''


def main():
    changed = []
    for name in TARGETS:
        path = ROOT / "scripts" / f"{name}.py"
        src = path.read_text(encoding="utf-8")
        if "def ensure_env" in src:
            print(f"跳过（已有 ensure_env）：{path.name}")
            continue

        # 1) 保证 import os 存在
        if re.search(r"^import os$", src, re.M) is None:
            src = src.replace("import json\n", "import json\nimport os\n", 1)

        # 2) ROOT 必须先定义好，ensure_env 里要用
        #    把 ROOT 定义提到 import numpy 之前
        root_def = re.search(r"^ROOT = pathlib\.Path\(__file__\)\.resolve\(\)\.parent\.parent\n", src, re.M)
        if not root_def:
            print(f"⚠️ 找不到 ROOT 定义，跳过：{path.name}")
            continue
        src = src[: root_def.start()] + src[root_def.end():]

        # 3) 在 import numpy 那一行前插入 ROOT + ensure_env 块
        anchor = re.search(r"^import numpy as np\n", src, re.M)
        if not anchor:
            print(f"⚠️ 找不到 import numpy，跳过：{path.name}")
            continue
        head = "ROOT = pathlib.Path(__file__).resolve().parent.parent\n" + BLOCK
        src = src[: anchor.start()] + head + src[anchor.start():]

        # 4) 删掉原先失效的那段解释器检查（现在 ensure_env 接管了）
        src = re.sub(
            r"(?:# 定位带 sklearn 的解释器[^\n]*\n)?PY = sys\.executable\n"
            r"cfg = ROOT / \"\.venv-python\"\n"
            r"if cfg\.exists\(\):\n"
            r"    cand = cfg\.read_text\(encoding=\"utf-8\"\)\.strip\(\)\n"
            r"    if cand and pathlib\.Path\(cand\)\.exists\(\):\n"
            r"        PY = cand\n",
            "PY = sys.executable  # 仅用于给 subprocess 跑 Node；本脚本自身的解释器由 ensure_env 保证\n",
            src,
        )

        path.write_text(src, encoding="utf-8")
        changed.append(path.name)

    print("\n已修复：", ", ".join(changed) if changed else "（无）")


if __name__ == "__main__":
    main()
