/**
 * 伪随机数发生器。
 *
 * 为什么不用 Math.random：演示站的数据集必须**每次刷新都一样**，
 * 否则「同样的参数、不同的结果」，既没法讲也没法跟 sklearn 对拍。
 *
 * mulberry32：32 位整型状态，短小、分布够好，足矣。
 */

/** 给定种子，返回一个 [0, 1) 的确定性序列 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Box–Muller 标准正态；u 取开区间避免 log(0) */
export function gaussian(rnd: () => number): number {
  let u = 0
  let v = 0
  while (u === 0) u = rnd()
  while (v === 0) v = rnd()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** 用给定种子原地洗牌（Fisher–Yates），可复现 */
export function shuffle<T>(arr: T[], seed = 1): T[] {
  const rnd = mulberry32(seed)
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
