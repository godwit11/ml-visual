/**
 * 决策树演示用的数据集。
 *
 * 三条原则：
 * 1. 可复现 —— 用自己的 PRNG（mulberry32）+ 固定种子，绝不使用 Math.random，
 *    否则每次刷新数据都变，也没法和 sklearn 对拍。
 * 2. Node/浏览器共用 —— 对拍脚本直接 import 这里，保证两侧喂的是同一份数据。
 * 3. 真实数据不手打 —— 鸢尾花来自 sklearn.datasets.load_iris 原样导出（src/data/iris.json）。
 */

import { mulberry32, gaussian } from './prng'

export { mulberry32, shuffle } from './prng'

export interface Sample {
  x: [number, number]
  y: number
}

export interface TreeDataset {
  id: string
  name: string
  desc: string
  featureNames: [string, string]
  classNames: string[]
  samples: Sample[]
}

function linspace(a: number, b: number, n: number): number[] {
  if (n <= 1) return [a]
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(a + ((b - a) * i) / (n - 1))
  return out
}

/** 两弯月牙，非线性可分（对齐 sklearn.make_moons 的构造方式） */
export function makeMoons(n = 240, noise = 0.16, seed = 7): Sample[] {
  const rnd = mulberry32(seed)
  const nOut = Math.floor(n / 2)
  const nIn = n - nOut
  const t = Math.PI
  const outX = linspace(0, t, nOut).map(Math.cos)
  const outY = linspace(0, t, nOut).map(Math.sin)
  const inX = linspace(0, t, nIn).map((v) => 1 - Math.cos(v))
  const inY = linspace(0, t, nIn).map((v) => 1 - Math.sin(v) - 0.5)

  const samples: Sample[] = []
  for (let i = 0; i < nOut; i++) {
    samples.push({ x: [outX[i] + noise * gaussian(rnd), outY[i] + noise * gaussian(rnd)], y: 0 })
  }
  for (let i = 0; i < nIn; i++) {
    samples.push({ x: [inX[i] + noise * gaussian(rnd), inY[i] + noise * gaussian(rnd)], y: 1 })
  }
  return samples
}

/** 同心圆（对齐 sklearn.make_circles） */
export function makeCircles(n = 240, noise = 0.09, factor = 0.55, seed = 11): Sample[] {
  const rnd = mulberry32(seed)
  const nOut = Math.floor(n / 2)
  const nIn = n - nOut
  const out = linspace(0, 2 * Math.PI, nOut)
  const inn = linspace(0, 2 * Math.PI, nIn)

  const samples: Sample[] = []
  for (const a of out) {
    samples.push({ x: [Math.cos(a) + noise * gaussian(rnd), Math.sin(a) + noise * gaussian(rnd)], y: 0 })
  }
  for (const a of inn) {
    samples.push({
      x: [factor * Math.cos(a) + noise * gaussian(rnd), factor * Math.sin(a) + noise * gaussian(rnd)],
      y: 1,
    })
  }
  return samples
}

/** 异或：四块对角，必须至少两层分裂才能分开 */
export function makeXor(n = 240, spread = 0.28, seed = 3): Sample[] {
  const rnd = mulberry32(seed)
  const centers: [number, number, number][] = [
    [0.25, 0.25, 0],
    [0.75, 0.75, 0],
    [0.25, 0.75, 1],
    [0.75, 0.25, 1],
  ]
  const per = Math.floor(n / 4)
  const samples: Sample[] = []
  for (const [cx, cy, label] of centers) {
    for (let i = 0; i < per; i++) {
      samples.push({ x: [cx + spread * gaussian(rnd), cy + spread * gaussian(rnd)], y: label })
    }
  }
  return samples
}

export function buildDatasets(iris: { pl: number; pw: number; y: number }[]): TreeDataset[] {
  return [
    {
      id: 'moons',
      name: '月牙',
      desc: '两道交错的月牙，任何一条直线都切不开，得靠多次轴平行切分逼近。',
      featureNames: ['x₁', 'x₂'],
      classNames: ['上弦', '下弦'],
      samples: makeMoons(),
    },
    {
      id: 'circles',
      name: '同心圆',
      desc: '内圈与外圈。决策树只能用方框把中间"抠"出来，看它要切几刀。',
      featureNames: ['x₁', 'x₂'],
      classNames: ['外圈', '内圈'],
      samples: makeCircles(),
    },
    {
      id: 'xor',
      name: '异或',
      desc: '对角线同类。这是决策树最擅长、而线性模型完全没辙的结构。',
      featureNames: ['x₁', 'x₂'],
      classNames: ['同为小/同为大', '一小一大'],
      samples: makeXor(),
    },
    {
      id: 'iris',
      name: '鸢尾花（真实数据）',
      desc: '150 朵真实鸢尾花的花瓣长与花瓣宽，三个品种。数据取自 sklearn 自带的 Fisher 数据集。',
      featureNames: ['花瓣长 (cm)', '花瓣宽 (cm)'],
      classNames: ['setosa', 'versicolor', 'virginica'],
      samples: iris.map((d) => ({ x: [d.pl, d.pw], y: d.y })),
    },
  ]
}
