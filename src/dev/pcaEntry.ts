/**
 * 对拍用的聚合入口：Node 侧一次拿到 PCA + 数据集。
 * 只被 scripts/crosscheck_pca.mjs 使用，不参与页面构建。
 */
export {
  fitPCA,
  center,
  project,
  inverseTransform,
  reconstructionError,
  svdViaEigen,
  loadings,
  reduceTo,
  reduceRows,
  fitProjectReconstruct,
} from '../algorithms/pca'
export type { Matrix } from '../algorithms/pca'
export { buildPcaDatasets } from '../data/pcaDatasets'
export type { PcaDataset } from '../data/pcaDatasets'
export { default as irisRaw } from '../data/iris4.json'
