/**
 * 对拍用的聚合入口：让 Node 侧一次拿到算法 + 数据集。
 * 只被 scripts/crosscheck_tree.mjs 使用，不参与页面构建。
 *
 * 注意：两个模块都导出了 Sample，这里显式挑一个（数据集那个），
 * 算法侧的类型改名导出，避免 `export *` 撞名。
 */
export * from '../algorithms/decisionTree'
export type { Sample as TreeDatasetSample } from '../data/treeDatasets'
export {
  mulberry32,
  makeMoons,
  makeCircles,
  makeXor,
  shuffle,
  buildDatasets,
} from '../data/treeDatasets'
export type { TreeDataset } from '../data/treeDatasets'
export { default as irisRaw } from '../data/iris.json'
