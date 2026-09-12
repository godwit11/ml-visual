/**
 * 模型评估演示用到的数据集。
 *
 * 三类，各有分工：
 *   1. **合成**：分数由两团高斯生成，能调「正例占比」和「区分度」，用来讲清
 *      「AUC 与阈值无关、准确率与阈值强相关」这件事。
 *   2. **乳腺癌（真实）**：569 例，分数来自 sklearn 拟合出的真实模型（见下）。
 *   3. **稀有病筛查**：把乳腺癌的正例抽稀到 5%，**模型分数完全不变**，
 *      但同一个模型在这个场景下的表现判若两人——这是"准确率陷阱"最好的演示。
 *
 * 关于真实数据的权重：
 *   下面 BREAST_W 不是我编的，是用
 *     LogisticRegression(C=np.inf, solver='lbfgs').fit(X[['worst perimeter','worst concave points']], y)
 *   拟合出来的（正例 = 恶性）。Python 侧对拍脚本用同一组权重重算，两边分数逐位一致。
 */

import { mulberry32, gaussian } from './prng'
import breastRaw from './breast.json'

export interface EvalPoint {
  /** 模型输出的概率分数，∈ (0, 1) */
  score: number
  /** 1 = 正例 */
  label: 0 | 1
}

export interface EvalDataset {
  id: string
  name: string
  desc: string
  positiveName: string
  negativeName: string
  points: EvalPoint[]
  /** 合成数据才有：分离度 d 对应的理论 AUC = Φ(d/√2) */
  theoryAuc?: number
}

/** 交叉验证用的二维分类数据（基模型是决策树，所以必须有特征而不是只有分数） */
export interface CvDataset {
  id: string
  name: string
  desc: string
  featureNames: [string, string]
  classNames: [string, string]
  X: [number, number][]
  y: number[]
}

export const BREAST_W = {
  w1: 0.13867486211336955, // worst perimeter
  w2: 39.39061894552877, // worst concave points
  b: -20.369976698747852,
}

function sigmoid(z: number): number {
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z))
}

/** 标准正态 CDF（A&S 7.1.26 近似，|误差| < 1.5e-7），用来算理论 AUC */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2)
  const p =
    d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return x >= 0 ? 1 - p : p
}

/**
 * 合成打分数据。
 * 负类 z ~ N(0, 1)，正类 z ~ N(d, 1)，score = σ(z)。
 * 这样 AUC 的理论值就是 Φ(d/√2)，可以拿来和图上算出来的对照。
 */
export function synthScores(n: number, prevalence: number, separation: number, seed = 20240910): EvalPoint[] {
  const rnd = mulberry32(seed)
  const nPos = Math.max(1, Math.min(n - 1, Math.round(n * prevalence)))
  const out: EvalPoint[] = []
  for (let i = 0; i < n; i++) {
    const pos = i < nPos
    const z = (pos ? separation : 0) + gaussian(rnd)
    out.push({ score: sigmoid(z), label: pos ? 1 : 0 })
  }
  return out
}

/** 乳腺癌：正例定义为「恶性」（符合医学语境），分数用 sklearn 拟合出的真实权重算 */
function breastPoints(): EvalPoint[] {
  const rows = breastRaw as { a: number; b: number; y: number }[]
  return rows.map((r) => ({
    score: sigmoid(BREAST_W.w1 * r.a + BREAST_W.w2 * r.b + BREAST_W.b),
    label: r.y === 0 ? 1 : 0,
  }))
}

/**
 * 稀有病筛查：模型分数原样不动，只把正例等间隔抽稀到 target 个。
 * 现实中就是「同一个模型被拿去跑一个患病率低得多的筛查场景」。
 */
function rarePoints(targetPos = 19): EvalPoint[] {
  const all = breastPoints()
  const posIdx: number[] = []
  const negIdx: number[] = []
  all.forEach((p, i) => (p.label === 1 ? posIdx : negIdx).push(i))
  const keep = new Set<number>(negIdx)
  for (let i = 0; i < Math.min(targetPos, posIdx.length); i++) {
    keep.add(posIdx[Math.floor((i * posIdx.length) / targetPos)])
  }
  return all.filter((_, i) => keep.has(i))
}

export function buildEvalDatasets(): EvalDataset[] {
  const breast = breastPoints()
  const rare = rarePoints()
  const nPosB = breast.filter((p) => p.label === 1).length
  const nPosR = rare.filter((p) => p.label === 1).length
  return [
    {
      id: 'synth',
      name: '合成数据（可调）',
      desc: '两团高斯生成的分数，可自由调整正例占比与区分度。想看清"阈值怎么影响指标"、以及"只改患病率会发生什么"，用它最直观。',
      positiveName: '正例',
      negativeName: '负例',
      points: synthScores(600, 0.3, 1.5),
      theoryAuc: normalCdf(1.5 / Math.SQRT2),
    },
    {
      id: 'breast',
      name: '乳腺癌（真实 569 例）',
      desc: `sklearn 逻辑回归在「最大周长 / 最大凹点数」上的真实输出，恶性 ${nPosB} 例（${(
        (nPosB / breast.length) *
        100
      ).toFixed(1)}%），ROC-AUC 0.986。`,
      positiveName: '恶性',
      negativeName: '良性',
      points: breast,
    },
    {
      id: 'rare',
      name: '稀有病筛查（恶性仅 5%）',
      desc: `同一个模型（权重完全不变），但从同一份数据里把恶性病例抽稀到 ${nPosR} 例，模拟 ${(
        (nPosR / rare.length) *
        100
      ).toFixed(1)}% 患病率的筛查场景。注意 ROC-AUC 也会掉一点（抽掉一部分病例后，剩下的更难分），但真正垮掉的是精确率与 PR。`,
      positiveName: '患病',
      negativeName: '健康',
      points: rare,
    },
  ]
}

/** 交叉验证用：有特征、有标签，能真的训练一棵决策树 */
export function buildCvDatasets(): CvDataset[] {
  const rows = breastRaw as { a: number; b: number; y: number }[]
  const all: [number, number][] = rows.map((r) => [r.a, r.b])
  const yAll: number[] = rows.map((r) => (r.y === 0 ? 1 : 0)) // 1 = 恶性

  const allIdx = all.map((_, i) => i)
  const posIdx = allIdx.filter((i) => yAll[i] === 1)
  const keep = new Set<number>(allIdx.filter((i) => yAll[i] === 0))
  const targetPos = 19
  for (let i = 0; i < targetPos; i++) keep.add(posIdx[Math.floor((i * posIdx.length) / targetPos)])
  const rareIdx = allIdx.filter((i) => keep.has(i))

  const pick = (idx: number[]): CvDataset['X'] => idx.map((i) => all[i])
  const pickY = (idx: number[]): number[] => idx.map((i) => yAll[i])

  return [
    {
      id: 'breast',
      name: '乳腺癌（恶性 37.3%）',
      desc: '类别还算均衡，分层与非分层的差别不大——先看清楚 K 折在干什么。',
      featureNames: ['最大周长', '最大凹点数'],
      classNames: ['良性', '恶性'],
      X: pick(allIdx),
      y: pickY(allIdx),
    },
    {
      id: 'rare',
      name: '稀有病（恶性 5.1%）',
      desc: '极端不平衡。切到非分层 K 折，看看会不会有某一折一个正例都分不到。',
      featureNames: ['最大周长', '最大凹点数'],
      classNames: ['健康', '患病'],
      X: pick(rareIdx),
      y: pickY(rareIdx),
    },
  ]
}
