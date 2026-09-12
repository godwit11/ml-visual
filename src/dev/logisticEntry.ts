/**
 * 对拍用的聚合入口：让 Node 侧一次拿到 Logistic 回归的算法 + 数据集。
 * 只被 scripts/crosscheck_logistic.mjs 使用，不参与页面构建。
 */
export * from '../algorithms/logisticRegression'
export { buildLogiDatasets } from '../data/logisticDatasets'
export { default as breastRaw } from '../data/breast.json'
