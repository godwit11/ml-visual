"""从 SMS Spam Collection 生成页面用的数据文件。

数据来源：SMS Spam Collection v.1（UCI Machine Learning Repository，5574 条真实短信）
  原始文件：https://raw.githubusercontent.com/justmarkham/pycon-2016-tutorial/master/data/sms.tsv
  格式：每行 `label<TAB>text`，label ∈ {ham, spam}

产出 src/data/sms.json：
  {
    "vocab": ["free", "txt", ...],           # 词表（按总频次取前 N）
    "docs": "0:1 5:2|3:1|...",               # 每条短信的词频，"|" 分隔文档，"idx:count" 空格分隔
    "labels": "0 1 1 0 ..."                  # 0 = ham, 1 = spam
  }

用稀疏表示的理由：5574 × 150 的稠密矩阵会让 JSON 大一个数量级，而每条短信真正命中的词
通常只有几个。页面加载后展开成数组即可。

用法：python scripts/prepare_sms.py [--top 150]
"""
import argparse
import collections
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT.parent / "_probe" / "sms_try_sms.tsv"
OUT = ROOT / "src" / "data" / "sms.json"

# 只保留字母数字（' 也去掉，避免 let's / don't 分裂出一堆低频词）
TOKEN = re.compile(r"[a-z0-9]+")


def tokenize(text):
    return TOKEN.findall(text.lower())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=150, help="词表大小（按总频次取前 N）")
    args = ap.parse_args()

    if not SRC.exists():
        print(f"找不到源文件：{SRC}")
        print("请先下载：curl -L -o _probe/sms_try_sms.tsv https://raw.githubusercontent.com/justmarkham/pycon-2016-tutorial/master/data/sms.tsv")
        return 1

    rows = []
    for line in SRC.read_text(encoding="utf-8").splitlines():
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        rows.append((parts[0].strip(), parts[1]))

    n_spam = sum(1 for l, _ in rows if l == "spam")
    n_ham = len(rows) - n_spam
    print(f"样本 {len(rows)} 条：ham {n_ham} / spam {n_spam}（spam 占比 {n_spam / len(rows) * 100:.2f}%）")

    # 全语料词频（用于挑词表）
    counter = collections.Counter()
    tokenized = []
    for _, text in rows:
        toks = tokenize(text)
        tokenized.append(toks)
        counter.update(toks)
    print(f"不同词 {len(counter)} 个；出现 ≥5 次的 {sum(1 for c in counter.values() if c >= 5)} 个")

    vocab = [w for w, _ in counter.most_common(args.top)]
    index = {w: i for i, w in enumerate(vocab)}
    print(f"词表前 {args.top} 个，覆盖 token 总量 "
          f"{sum(counter[w] for w in vocab) / sum(counter.values()) * 100:.1f}%")
    print("  前 20：", vocab[:20])

    docs = []
    labels = []
    hit_per_doc = 0
    for toks, (lab, _) in zip(tokenized, rows):
        counts = collections.Counter(index[t] for t in toks if t in index)
        docs.append(" ".join(f"{i}:{c}" for i, c in sorted(counts.items())))
        labels.append(1 if lab == "spam" else 0)
        hit_per_doc += len(counts)
    print(f"平均每条短信命中 {hit_per_doc / len(docs):.2f} 个词表词")

    payload = {
        "source": "SMS Spam Collection v.1 (UCI), 5574 real SMS messages",
        "vocab": vocab,
        "docs": "|".join(docs),
        "labels": " ".join(str(v) for v in labels),
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    size = OUT.stat().st_size
    print(f"已写入 {OUT}（{size / 1024:.1f} KB）")

    # 顺带报几个有区分度的词，方便写页面文案时对照
    spam_c = collections.Counter()
    ham_c = collections.Counter()
    for toks, (lab, _) in zip(tokenized, rows):
        for t in set(toks):
            (spam_c if lab == "spam" else ham_c).update([t])
    diff = []
    for w in vocab:
        s = (spam_c[w] + 0.5) / (n_spam + 1)
        h = (ham_c[w] + 0.5) / (n_ham + 1)
        diff.append((s / h, w, spam_c[w], ham_c[w]))
    diff.sort(reverse=True)
    print("\n最偏 spam 的 8 个词（出现该词的文档占比之比）：")
    for r, w, s, h in diff[:8]:
        print(f"  {w:<12} 比 {r:8.1f}   spam {s} / ham {h}")
    print("最偏 ham 的 8 个词：")
    for r, w, s, h in diff[-8:]:
        print(f"  {w:<12} 比 {r:8.3f}   spam {s} / ham {h}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
