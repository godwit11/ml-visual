export type ModuleId = 'basic' | 'classic' | 'tree' | 'unsupervised' | 'nn'

export interface DemoMeta {
  id: string
  title: string
  subtitle: string
  module: ModuleId
  icon: string
  /**
   * 这一页对应的 sklearn 入口（类名或函数名）。
   *
   * 为什么要放进元数据：本站的差异化就是「参数 ↔ 代码」联动，
   * 把对应的 sklearn API 直接标在首页卡片上，能一眼看出
   * "这一页玩完，我拿到的是哪一行代码"。
   */
  api: string
  status: 'live' | 'soon'
  href: string
  requires: string[]
}

const ICON = {
  regression:
    '<path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/>',
  logistic: '<path d="M3 3v18h18"/><path d="M5 20c4 0 6-16 14-16"/>',
  evaluation: '<path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 8v4l3 2"/>',
  tree:
    '<rect x="9" y="3" width="6" height="4" rx="1"/><rect x="3" y="17" width="6" height="4" rx="1"/><rect x="15" y="17" width="6" height="4" rx="1"/><path d="M12 7v3M6 17v-2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/>',
  nn:
    '<circle cx="5" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 7l3 3M7 17l3-3M14 11l3-3M14 13l3 3"/>',
  svm:
    '<path d="M3 21L21 3"/><path d="M5 15L15 5" stroke-dasharray="2 3"/><circle cx="7.5" cy="7.5" r="2"/><circle cx="16.5" cy="16.5" r="2"/>',
  bayes:
    '<circle cx="12" cy="12" r="9"/><path d="M12 3c3.2 3.2 3.2 14.8 0 18M12 3c-3.2 3.2-3.2 14.8 0 18"/>',
  ensemble:
    '<rect x="3" y="4" width="7" height="6" rx="1"/><rect x="14" y="4" width="7" height="6" rx="1"/><rect x="8.5" y="15" width="7" height="6" rx="1"/><path d="M6.5 10v3h11v-3"/>',
  clustering:
    '<circle cx="7" cy="7" r="2"/><circle cx="11.5" cy="9" r="2"/><circle cx="8" cy="12.5" r="2"/><circle cx="17" cy="16" r="2"/><circle cx="19" cy="11.5" r="2"/><circle cx="14.5" cy="19" r="2"/>',
  pca:
    '<path d="M4 4l16 16"/><path d="M4 4l6.5 1M4 4l1 6.5"/><circle cx="9" cy="15" r="1.5"/><circle cx="13" cy="17" r="1.5"/><circle cx="17" cy="19" r="1.5"/>',
}

export const MODULES: { id: ModuleId; name: string; desc: string }[] = [
  { id: 'basic', name: '基础与评估', desc: '从一条直线开始，学会判断模型好坏' },
  { id: 'classic', name: '经典分类', desc: '最大间隔与贝叶斯，两条不同的分类思路' },
  { id: 'tree', name: '树与集成', desc: '把判断写成一棵树，再让很多棵树投票' },
  { id: 'unsupervised', name: '无监督学习', desc: '没有标签时，数据自己会说话' },
  { id: 'nn', name: '神经网络', desc: '层层叠加的非线性，与它的训练过程' },
]

export const DEMOS: DemoMeta[] = [
  {
    id: 'linear-regression',
    title: '线性回归',
    subtitle: '手动拖出一条直线，再看最小二乘怎么一步到位',
    module: 'basic',
    icon: ICON.regression,
    api: 'LinearRegression',
    status: 'live',
    href: 'demos/linear-regression/',
    requires: [],
  },
  {
    id: 'logistic-regression',
    title: 'Logistic 回归',
    subtitle: '把直线卷成 S 形，用它划出决策边界',
    module: 'basic',
    icon: ICON.logistic,
    api: 'LogisticRegression',
    status: 'live',
    href: 'demos/logistic-regression/',
    requires: ['linear-regression'],
  },
  {
    id: 'model-evaluation',
    title: '模型评估',
    subtitle: '混淆矩阵、ROC、交叉验证：准确率骗了你多少',
    module: 'basic',
    icon: ICON.evaluation,
    api: 'cross_val_score',
    status: 'live',
    href: 'demos/model-evaluation/',
    requires: ['logistic-regression'],
  },
  {
    id: 'svm',
    title: '支持向量机',
    subtitle: '最大间隔、软间隔与核技巧',
    module: 'classic',
    icon: ICON.svm,
    api: 'SVC',
    status: 'live',
    href: 'demos/svm/',
    requires: ['model-evaluation'],
  },
  {
    id: 'naive-bayes',
    title: '朴素贝叶斯',
    subtitle: '一条概率公式，加上"天真"的独立假设',
    module: 'classic',
    icon: ICON.bayes,
    api: 'MultinomialNB',
    status: 'live',
    href: 'demos/naive-bayes/',
    requires: ['model-evaluation'],
  },
  {
    id: 'decision-tree',
    title: '决策树',
    subtitle: '一步步看它怎么挑特征、怎么长出一棵树',
    module: 'tree',
    icon: ICON.tree,
    api: 'DecisionTreeClassifier',
    status: 'live',
    href: 'demos/decision-tree/',
    requires: ['model-evaluation'],
  },
  {
    id: 'ensemble-learning',
    title: '集成学习',
    subtitle: 'Bagging 与 Boosting，两种"三个臭皮匠"',
    module: 'tree',
    icon: ICON.ensemble,
    api: 'AdaBoostClassifier',
    status: 'live',
    href: 'demos/ensemble-learning/',
    requires: ['decision-tree'],
  },
  {
    id: 'clustering',
    title: '聚类分析',
    subtitle: 'K-means 的每一步：分派、更新、再分派',
    module: 'unsupervised',
    icon: ICON.clustering,
    api: 'KMeans',
    status: 'live',
    href: 'demos/clustering/',
    requires: [],
  },
  {
    id: 'pca',
    title: '降维技术',
    subtitle: 'PCA 怎么找到"信息量最大"的那个方向',
    module: 'unsupervised',
    icon: ICON.pca,
    api: 'PCA',
    status: 'live',
    href: 'demos/pca/',
    requires: ['clustering'],
  },
  {
    id: 'neural-network',
    title: '神经网络',
    subtitle: '前向传播、反向传播，以及激活函数的作用',
    module: 'nn',
    icon: ICON.nn,
    api: 'MLPClassifier',
    status: 'live',
    href: 'demos/neural-network/',
    requires: ['logistic-regression'],
  },
]

/** 推荐学习顺序（手工排定的拓扑序）。 */
const PATH_ORDER = [
  'linear-regression',
  'logistic-regression',
  'model-evaluation',
  'decision-tree',
  'ensemble-learning',
  'svm',
  'naive-bayes',
  'clustering',
  'pca',
  'neural-network',
]

export function demoById(id: string): DemoMeta | undefined {
  return DEMOS.find((d) => d.id === id)
}

export function learningPath(): DemoMeta[] {
  return PATH_ORDER.map(demoById).filter((d): d is DemoMeta => Boolean(d))
}

export function neighbors(id: string): { prev?: DemoMeta; next?: DemoMeta } {
  const path = learningPath()
  const i = path.findIndex((d) => d.id === id)
  if (i < 0) return {}
  return { prev: path[i - 1], next: path[i + 1] }
}

const PROGRESS_KEY = 'mlv-visited'

export function getVisited(): string[] {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

export function markVisited(id: string): void {
  const list = new Set(getVisited())
  list.add(id)
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify([...list]))
  } catch {
    /* ignore */
  }
}
