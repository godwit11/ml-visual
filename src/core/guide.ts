/**
 * 入门引导层 —— 给「完全没学过机器学习」的读者用的三个零件。
 *
 * 为什么要有这个模块：
 *   站点的定位是「把机器学习拖着玩明白」，但页面的组织逻辑原本是
 *   **教科书章节**式的（先定义 → 再公式 → 最后习题）。零基础的人进来，
 *   第一眼撞到的是「最小二乘」「OLS 最优」「R²」这些未定义的术语，
 *   于是停在门口。
 *
 *   正确的顺序是**现象 → 动手 → 术语**：先让他看到一件生活里的事，
 *   再让他动手改变它，最后才告诉他「你刚才做的事，书上叫某某」。
 *
 * 三个零件（对应设计里的 A / B / D 层）：
 *   intro   页面开头的场景开场 + 动手三步（A）
 *   term    指标格里「术语 + 一句人话」（B）
 *   recap   收尾的「你刚才学到的」（D）
 *
 * 全部做成函数而不是各页手写 HTML，理由和 `pager.ts` 一样：
 *   之前「上一个/下一个」是 10 份拷贝，同一个 bug 要改 10 处，注定会漏。
 *   引导层要在 10 个页面出现，更不能各抄一份。
 *
 * ⚠️ 文案原则（改文案时请守住，否则这个模块就白做了）：
 *   1. 开场**不出现任何未解释的术语**。出现「最小二乘」的地方，
 *      一定紧跟着一句人话。
 *   2. 术语解释只说「这是什么」，不展开「为什么」—— 为什么留给「原理」页。
 *   3. 每个数字都要是页面上真实存在的量，不写「大约」「可能是」。
 */

/** 动手三步里的一步 */
export interface IntroStep {
  /** 动作描述。写成祈使句：「把斜率拖到最右边」 */
  do: string
  /** 可选：做完了会看到什么。不写则只显示动作 */
  see?: string
}

export interface IntroOptions {
  /**
   * 开场第一句：一句生活场景，把人拉进来。
   * 例：「你在看房子的广告，上面写着『4 个房间，卖 25 万美元』。」
   */
  lead: string
  /** 场景说明段落，每段一句话。可以有 2–3 段 */
  body: string[]
  /** 动手三步 */
  steps?: IntroStep[]
  /** 挂载点 */
  host: HTMLElement
}

/**
 * A 层：场景开场 + 动手三步。
 *
 * 直接 append 到 host，不返回句柄 —— 内容是静态的，不需要后续更新。
 */
export function mountIntro(opts: IntroOptions): void {
  const box = document.createElement('div')
  box.className = 'intro'

  const lead = document.createElement('p')
  lead.className = 'intro-lead'
  lead.textContent = opts.lead
  box.append(lead)

  for (const text of opts.body) {
    const p = document.createElement('p')
    /* 允许文案里用 `**强调**` 标出重点，但不引入完整 Markdown */
    p.innerHTML = strongify(text)
    box.append(p)
  }

  if (opts.steps && opts.steps.length > 0) {
    const list = document.createElement('div')
    list.className = 'intro-steps'
    opts.steps.forEach((s, i) => {
      const row = document.createElement('div')
      row.className = 'intro-step'

      const no = document.createElement('span')
      no.className = 'intro-step-no'
      no.textContent = String(i + 1).padStart(2, '0')

      const p = document.createElement('p')
      p.innerHTML = s.see
        ? `${strongify(s.do)} <span class="term-note">${strongify(s.see)}</span>`
        : strongify(s.do)

      row.append(no, p)
      list.append(row)
    })
    box.append(list)
  }

  opts.host.append(box)
}

/**
 * B 层：术语说明表。
 *
 * ⚠️ 为什么不做成「塞进指标格」：
 *   `.metric-grid` 是 `minmax(120px, 1fr)` 的自动网格，在演示页右栏
 *   （约 200px 宽）里会排成**两列各约 100px**。100px 塞不下一句解释 ——
 *   实测文字被挤成竖排、和原有 hint 重叠，完全读不了。
 *   这是布局容量的硬约束，不是把文案写短就能绕过的。
 *
 *   所以改成：指标格保持原样，解释集中在它的**下方**，一列纵排，
 *   拿到整栏宽度。既读得清，又不用动指标格的 DOM（e2e 断言按
 *   `.metric-value` 定位，动结构会牵连一批断言）。
 *
 * @param host 容器元素
 * @param items 术语条目，按页面上出现的顺序给
 * @param title 小标题
 */
export function mountTerms(
  host: HTMLElement,
  items: { name: string; say: string }[],
  title = '这些数字什么意思',
): void {
  const box = document.createElement('div')
  box.className = 'terms'

  const t = document.createElement('p')
  t.className = 'terms-title'
  t.textContent = title
  box.append(t)

  const list = document.createElement('dl')
  list.className = 'terms-list'

  for (const it of items) {
    const dt = document.createElement('dt')
    dt.className = 'term-name'
    dt.textContent = it.name

    const dd = document.createElement('dd')
    dd.className = 'term-say'
    dd.innerHTML = strongify(it.say)

    list.append(dt, dd)
  }

  box.append(list)
  host.append(box)
}

export interface RecapRow {
  /** 左侧标签，如「书上叫」 */
  label: string
  /**
   * 右侧内容。支持 `**强调**` 与 `` `代码` `` 两种标记。
   * 例：`` `LinearRegression().fit(X, y)` —— 就一行 ``
   */
  value: string
}

/**
 * D 层：收尾的「这一页学到了什么」。
 *
 * 三行式（书上叫 / 代码里 / 用来做），也可以只给一两行。
 * 放在 pager 之前，让「总结 → 下一篇」是一个连贯的收束动作。
 */
export function mountRecap(host: HTMLElement, rows: RecapRow[], title = '这一页学到了什么'): void {
  const box = document.createElement('div')
  box.className = 'recap'

  const t = document.createElement('p')
  t.className = 'recap-title'
  t.textContent = title
  box.append(t)

  for (const r of rows) {
    const row = document.createElement('div')
    row.className = 'recap-row'

    const label = document.createElement('span')
    label.className = 'recap-label'
    label.textContent = r.label

    const val = document.createElement('span')
    val.className = 'recap-val'
    val.innerHTML = codeify(strongify(r.value))

    row.append(label, val)
    box.append(row)
  }

  host.append(box)
}

/* ------------------------------------------------------------------ *
 * 极简标记解析
 *
 * 只需要两种：`**粗体**` 和 `` `代码` ``。
 * 不引入 Markdown 库 —— 为一个展示层加依赖不划算，而且解析范围越小
 * 越不容易出安全问题（这里的内容全部来自我们自己的源码，不是用户输入）。
 * ------------------------------------------------------------------ */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function strongify(s: string): string {
  return escapeHtml(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

function codeify(s: string): string {
  return s.replace(/`([^`]+)`/g, '<code>$1</code>')
}
