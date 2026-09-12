/**
 * 对拍用的聚合入口：Node 侧一次拿到 MLP + 数据集。
 * 只被 scripts/crosscheck_nn.mjs 使用，不参与页面构建。
 */
export {
  ACTIVATIONS,
  initNet,
  forward,
  backward,
  predict,
  predictProba,
  softmaxRows,
  oneHot,
  train,
  decisionGrid,
  layerActivations,
  transpose,
  sigmoid,
} from '../algorithms/neuralNetwork'
export type { Matrix, Net, Activation, NetConfig } from '../algorithms/neuralNetwork'
export { buildNnDatasets, makeXor, makeSpiral } from '../data/nnDatasets'
export type { NnDataset } from '../data/nnDatasets'
export { default as irisRaw } from '../data/iris4.json'
