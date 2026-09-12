/**
 * 对拍用的聚合入口：Node 侧一次拿到 SMO 实现 + 数据集。
 * 只被 scripts/crosscheck_svm.mjs 使用，不参与页面构建。
 */
export * from '../algorithms/svm'
export { buildSvmDatasets, makeLinearSeparable, makeOverlap } from '../data/svmDatasets'
export { makeMoons, makeCircles } from '../data/treeDatasets'
export type { Sample } from '../data/treeDatasets'
export { default as breastRaw } from '../data/breast.json'
