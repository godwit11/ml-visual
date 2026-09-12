await sleep(1200)
const links = Array.from(document.querySelectorAll('.pager a, .pager .pager-link, .pager *[href]'))
const info = links.map((a) => ({
  text: (a.textContent || '').trim().slice(0, 30),
  attrHref: a.getAttribute('href'),
  resolved: a.href,
}))
const all = Array.from(document.querySelectorAll('a[href]')).filter((a) => /上一个|下一个/.test(a.textContent || ''))
return {
  ok: true,
  当前页: location.href,
  pager链接: info,
  带上下篇文字的所有链接: all.map((a) => ({ text: a.textContent.trim(), attrHref: a.getAttribute('href'), resolved: a.href })),
}
