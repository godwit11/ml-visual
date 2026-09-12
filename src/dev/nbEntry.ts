/**
 * 对拍用的聚合入口：Node 侧一次拿到朴素贝叶斯 + 短信语料。
 * 只被 scripts/crosscheck_nb.mjs 使用，不参与页面构建。
 */
export * from '../algorithms/naiveBayes'
export { loadSmsCorpus, tokenizeSms, SMS_SAMPLES } from '../data/smsData'
