/*
 * 链接可达性检查：把页面上所有同源 <a href> 真的 fetch 一遍。
 *
 * 为什么需要它（真实教训）：
 *   演示页底部的「下一个」曾经跳到 `/demos/linear-regression/demos/logistic-regression/`，
 *   也就是 404。根因是 `DEMOS` 里的 href 写成 `demos/xxx/` 这种**文档相对路径** ——
 *   在首页（`/`）下正好对，在演示页（`/demos/xxx/`）下就会多套一层。
 *
 *   这个 bug 有两个特点，决定了光靠现有测试抓不住：
 *     ① 链接**看起来**完全正常（文字、样式、href 属性都是对的），
 *        只有「点下去会去哪」是错的；读代码/看截图都发现不了；
 *     ② 它是**位置相关**的 —— 同一个 href 在首页对、在演示页错。
 *        所以在首页跑的测试永远绿。
 *
 *   唯一的办法是真的解析 + 请求一次。这个脚本就干这件事。
 *
 * 跑在哪个页面就检查哪个页面，所以首页和演示页都要跑一遍
 * （见 package.json 的 e2e:links:home / e2e:links:demo）。
 */
await sleep(600)

const anchors = Array.from(document.querySelectorAll('a[href]'))

const seen = new Map()
for (const a of anchors) {
  const raw = a.getAttribute('href')
  if (!raw) continue

  // 纯锚点（同一页内跳转）不需要请求
  if (raw.startsWith('#')) continue
  // 外部链接不在本站的保证范围内（也不该由 e2e 去打别人的服务器）
  if (/^[a-z]+:/i.test(raw) && !/^https?:/i.test(raw)) continue

  let url
  try {
    url = new URL(raw, location.href)
  } catch {
    continue
  }
  if (url.origin !== location.origin) continue

  const key = url.pathname
  if (seen.has(key)) {
    seen.get(key).count++
    continue
  }
  seen.set(key, { raw, path: url.pathname, count: 1, elems: [] })
}

const results = []
for (const [path, info] of seen) {
  let ok = false
  let status = 0
  try {
    const r = await fetch(path, { method: 'GET' })
    ok = r.ok
    status = r.status
  } catch (e) {
    status = String(e).slice(0, 60)
  }
  results.push({ href: info.raw, path, status, ok })
}

const bad = results.filter((r) => !r.ok)

/*
 * 追加一条结构性检查：文档相对路径从嵌套页面解析时会多套一层，
 * 症状就是 path 里出现两次 `/demos/`。即使偶然 200 了也说明路径写错了。
 */
const doubled = results.filter((r) => (r.path.match(/\/demos\//g) || []).length > 1)

const passed = bad.length === 0 && doubled.length === 0
return {
  ok: passed,
  当前页: location.pathname,
  检查了: results.length,
  不可达: bad.map((b) => ({ href: b.href, resolved: b.path, status: b.status })),
  路径重复demos: doubled.map((d) => ({ href: d.href, resolved: d.path })),
  全部: results.map((r) => `${r.status} ${r.path}`),
}
