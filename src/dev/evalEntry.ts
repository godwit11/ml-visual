/**
 * 对拍用的聚合入口：让 Node 侧一次拿到评估指标算法 + 数据集 + 决策树（交叉验证的基模型）。
 * 只被 scripts/crosscheck_eval.mjs 使用，不参与页面构建。
 */
export * from '../algorithms/evaluation'
export * from '../algorithms/decisionTree'
export { buildEvalDatasets, buildCvDatasets, synthScores, normalCdf, BREAST_W } from '../data/evalDatasets'
export { default as breastRaw } from '../data/breast.json'
