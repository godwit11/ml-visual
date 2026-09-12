export interface SliderOptions {
  label: string
  min: number
  max: number
  step: number
  value: number
  hint?: string
  /** 输入框保留的小数位，默认由 step 推断 */
  precision?: number
  format?: (v: number) => string
  onInput: (v: number) => void
}

export interface SliderHandle {
  el: HTMLElement
  get: () => number
  set: (v: number, silent?: boolean) => void
}

function decimalsOf(step: number): number {
  const s = String(step)
  const i = s.indexOf('.')
  return i < 0 ? 0 : s.length - i - 1
}

export function round(v: number, digits = 2): number {
  const p = 10 ** digits
  return Math.round(v * p) / p
}

/** 消掉浮点累加噪声（0.1+0.2 之类），但不改变用户能感知的精度 */
function tidy(v: number): number {
  return Math.round(v * 1e6) / 1e6
}

/**
 * 带数值输入框与 ± 微调按钮的滑杆。
 * 滑杆负责粗调，输入框负责精确定位，两者始终同步。
 */
export function mountSlider(host: HTMLElement, o: SliderOptions): SliderHandle {
  const digits = o.precision ?? Math.max(2, decimalsOf(o.step))
  const clamp = (v: number) => Math.min(o.max, Math.max(o.min, v))

  const wrap = document.createElement('div')
  wrap.className = 'ctrl'

  const head = document.createElement('div')
  head.className = 'ctrl-head'
  const label = document.createElement('label')
  label.textContent = o.label

  /* 数值区：− 按钮 / 可输入数字 / + 按钮 */
  const numBox = document.createElement('div')
  numBox.className = 'ctrl-num'

  const mkStepBtn = (dir: -1 | 1) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'ctrl-step'
    btn.textContent = dir < 0 ? '−' : '+'
    btn.title = `${dir < 0 ? '减' : '加'} ${o.step}`
    btn.setAttribute('aria-label', `${o.label} ${dir < 0 ? '减少' : '增加'} ${o.step}`)
    return btn
  }
  const minus = mkStepBtn(-1)
  const plus = mkStepBtn(1)

  const num = document.createElement('input')
  num.type = 'number'
  num.className = 'ctrl-input'
  // 用 any 而不是 step：否则浏览器会把 7.25 这种不在网格上的值直接吸附掉
  num.step = 'any'
  num.min = String(o.min)
  num.max = String(o.max)
  num.value = round(o.value, digits).toFixed(digits)
  num.setAttribute('aria-label', `${o.label} 数值输入`)

  numBox.append(minus, num, plus)
  head.append(label, numBox)
  wrap.append(head)

  const range = document.createElement('input')
  range.type = 'range'
  range.min = String(o.min)
  range.max = String(o.max)
  range.step = String(o.step)
  range.value = String(round(o.value, digits))
  wrap.append(range)

  let hint: HTMLElement | null = null
  if (o.hint) {
    hint = document.createElement('div')
    hint.className = 'ctrl-hint'
    hint.textContent = o.hint
    wrap.append(hint)
  }

  /* 内部只存一个真值；range 只是粗调的手柄，它的 step 吸附不影响这个真值 */
  let value = clamp(tidy(o.value))

  const fmt = o.format ?? ((v: number) => round(v, digits).toFixed(digits))
  /** number 输入框只接受纯数字，format 万一返回带单位的串就回退 */
  const shown = (v: number) => {
    const s = fmt(v)
    return Number.isFinite(Number(s)) ? s : round(v, digits).toFixed(digits)
  }
  const paint = () => {
    if (document.activeElement !== num) num.value = shown(value)
    range.value = String(value)
    minus.disabled = value <= o.min
    plus.disabled = value >= o.max
  }

  const emit = (v: number) => {
    value = clamp(tidy(v))
    paint()
    o.onInput(value)
    return value
  }

  range.addEventListener('input', () => emit(Number(range.value)))

  /* 输入框：回车或失焦生效；空值/非法值回退到当前值 */
  const commitNum = () => {
    const raw = num.value.trim()
    if (raw === '' || !Number.isFinite(Number(raw))) {
      paint()
      return
    }
    emit(Number(raw))
  }
  num.addEventListener('change', commitNum)
  num.addEventListener('blur', commitNum)
  num.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitNum()
      num.blur()
    }
  })

  minus.addEventListener('click', () => emit(value - o.step))
  plus.addEventListener('click', () => emit(value + o.step))

  paint()
  host.append(wrap)

  return {
    el: wrap,
    get: () => value,
    set: (v: number, silent = false) => {
      value = clamp(tidy(v))
      paint()
      if (!silent) o.onInput(value)
    },
  }
}
