const de = document.documentElement
const hero = document.querySelector('.hero')
const cs = getComputedStyle(hero)
/* 找出所有右边界超出视口的元素 */
const bad = []
document.querySelectorAll('body *').forEach((el) => {
  const r = el.getBoundingClientRect()
  if (r.width > 0 && r.right > window.innerWidth + 1) {
    bad.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 34), right: Math.round(r.right), w: Math.round(r.width) })
  }
})
return {
  ok: true,
  视口: window.innerWidth + 'x' + window.innerHeight,
  文档scrollWidth: de.scrollWidth,
  横向溢出: de.scrollWidth > window.innerWidth,
  hero_padding: cs.padding,
  hero_maxWidth: cs.maxWidth,
  hero_width: Math.round(hero.getBoundingClientRect().width),
  溢出的元素: bad.slice(0, 12),
  溢出元素数: bad.length,
}
