import { mountSlider } from '../core/slider'

const host = document.getElementById('host')!
const out: string[] = []
let current = 0

const h = mountSlider(host, {
  label: '测试量',
  min: -10,
  max: 10,
  step: 0.5,
  precision: 2,
  value: 0,
  onInput: (v) => {
    current = v
  },
})

const range = h.el.querySelector('input[type="range"]') as HTMLInputElement
const num = h.el.querySelector('input[type="number"]') as HTMLInputElement
const btns = h.el.querySelectorAll<HTMLButtonElement>('.ctrl-step')
const minus = btns[0]
const plus = btns[1]

const log = (name: string, ok: boolean, detail: string) => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
}

// 1. 初始值
log('初始值显示', num.value === '0.00', `num=${num.value}`)

// 2. 点击 + 三次
plus.click()
plus.click()
plus.click()
log('连续 +3 次', Math.abs(current - 1.5) < 1e-9, `onInput=${current}, num=${num.value}, range=${range.value}`)

// 3. 点击 − 一次
minus.click()
log('− 一次', Math.abs(current - 1.0) < 1e-9, `onInput=${current}, num=${num.value}`)

// 4. 数字框输入合法值（不在 step 网格上也必须保留，不能被浏览器吸附）
num.value = '7.25'
num.dispatchEvent(new Event('change'))
log('输入框 7.25 不被吸附', Math.abs(current - 7.25) < 1e-9 && num.value === '7.25', `onInput=${current}, num=${num.value}`)

// 5. 数字框输入超上限 → clamp
num.value = '999'
num.dispatchEvent(new Event('change'))
log('超上限 clamp', current === 10 && num.value === '10.00', `onInput=${current}, num=${num.value}`)

// 6. 到上限后 + 按钮禁用
log('上限时 + 禁用', plus.disabled, `plus.disabled=${plus.disabled}`)

// 7. 数字框输入非法值 → 回退（number input 会把 'abc' 变成空串）
num.value = ''
num.dispatchEvent(new Event('change'))
log('空值回退', current === 10 && num.value === '10.00', `onInput=${current}, num=${num.value}`)

// 8. 数字框输入超下限 → clamp
num.value = '-999'
num.dispatchEvent(new Event('change'))
log('超下限 clamp', current === -10, `onInput=${current}, num=${num.value}`)
log('下限时 − 禁用', minus.disabled, `minus.disabled=${minus.disabled}`)

// 9. 外部 set 同步（silent）
h.set(3.5, true)
log('set silent 同步', num.value === '3.50' && range.value === '3.5', `num=${num.value}, range=${range.value}`)
log('set silent 不回调', current === -10, `onInput 仍为 ${current}`)

// 10. 外部 set 非 silent
h.set(-2.25)
log('set 触发回调', current === -2.25, `onInput=${current}`)

// 11. 两位小数精度不被 step 舍掉
num.value = '1.13'
num.dispatchEvent(new Event('change'))
log('保留两位小数', Math.abs(current - 1.13) < 1e-9, `输入 1.13 → ${current}`)

// 12. 滑杆拖动
range.value = '5'
range.dispatchEvent(new Event('input'))
log('滑杆 input 事件', current === 5 && num.value === '5.00', `onInput=${current}, num=${num.value}`)

// 13. 连点 + 不应出现 0.30000000000000004 之类的浮点噪声
h.set(0, true)
for (let i = 0; i < 6; i++) plus.click()
log('无浮点噪声', current === 3 && num.value === '3.00', `6 次 +0.5 → ${current}`)

document.getElementById('out')!.textContent = out.join('\n')
