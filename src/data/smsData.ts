/**
 * 短信语料（真实数据）。
 *
 * 数据来源：SMS Spam Collection v.1（UCI），5574 条真实短信，标注 ham / spam。
 * 由 scripts/prepare_sms.py 处理成固定词表 + 稀疏词频表示（src/data/sms.json）。
 *
 * 这里做三件事：
 *   1. 把稀疏表示展开成扁平 Float64Array（5574×150 用嵌套数组太吃内存）
 *   2. 提供与 Python 侧完全一致的分词函数（页面上的"亲手试一条"要用）
 *   3. 保留每条短信命中的词，用于展示"这条短信是怎么被判定的"
 */

import raw from './sms.json'

export interface SmsCorpus {
  source: string
  vocab: string[]
  /** 样本数 */
  n: number
  /** 词表大小 */
  d: number
  /** 扁平的 n×d 词频矩阵：第 i 条短信第 j 个词的次数在 X[i*d+j] */
  X: Float64Array
  /** 0 = ham（正常），1 = spam（垃圾） */
  y: number[]
  nSpam: number
  /** 每条短信命中的词表词（保持词表下标升序） */
  tokensOf: string[][]
}

let cached: SmsCorpus | null = null

export function loadSmsCorpus(): SmsCorpus {
  if (cached) return cached
  const r = raw as unknown as { source: string; vocab: string[]; docs: string; labels: string }
  const vocab = r.vocab
  const d = vocab.length
  const labels = r.labels.split(' ').map(Number)
  const n = labels.length
  const docParts = r.docs.split('|')

  const X = new Float64Array(n * d)
  const tokensOf: string[][] = new Array(n)
  for (let i = 0; i < n; i++) {
    const toks: string[] = []
    const part = docParts[i]
    if (part) {
      for (const pair of part.split(' ')) {
        const c = pair.indexOf(':')
        const j = Number(pair.slice(0, c))
        X[i * d + j] = Number(pair.slice(c + 1))
        toks.push(vocab[j])
      }
    }
    tokensOf[i] = toks
  }

  cached = {
    source: r.source,
    vocab,
    n,
    d,
    X,
    y: labels,
    nSpam: labels.reduce((a, b) => a + b, 0),
    tokensOf,
  }
  return cached
}

/** 与 prepare_sms.py 里同一个正则：小写后取字母数字串 */
export function tokenizeSms(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

/** 几条真实样例，给页面做"一键试一条" */
export const SMS_SAMPLES: { text: string; label: 0 | 1 }[] = [
  {
    text: 'WINNER!! As a valued network customer you have been selected to receive a £900 prize reward! To claim call 09061701461. Claim code KL341. Valid 12 hours only.',
    label: 1,
  },
  {
    text: 'Free entry in 2 a wkly comp to win FA Cup final tkts 21st May 2005. Text FA to 87121 to receive entry question(std txt rate)T&C apply',
    label: 1,
  },
  {
    text: 'Sorry, I will call you later. I am in a meeting right now.',
    label: 0,
  },
  {
    text: 'Ok lar... Joking wif u oni...',
    label: 0,
  },
]
