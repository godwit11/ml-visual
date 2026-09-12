/**
 * 对拍用的聚合入口：Node 侧一次拿到 K-means + 数据集。
 * 只被 scripts/crosscheck_kmeans.mjs 使用，不参与页面构建。
 */
export * from '../algorithms/kmeans'
export { buildClusterDatasets, makeBlobs, purityOf } from '../data/clusterDatasets'
export type { ClusterDataset } from '../data/clusterDatasets'
export { default as irisRaw } from '../data/iris.json'
export { default as breastRaw } from '../data/breast.json'
