/**
 * 对拍用的聚合入口：Node 侧一次拿到集成学习算法 + 数据集。
 * 只被 scripts/crosscheck_ensemble.mjs 使用，不参与页面构建。
 */
export * from '../algorithms/ensemble'
export { makeMoons, makeCircles, makeXor } from '../data/treeDatasets'
export type { Sample } from '../data/treeDatasets'
