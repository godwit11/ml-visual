export type Theme = 'light' | 'dark'

const KEY = 'mlv-theme'
const listeners = new Set<(t: Theme) => void>()

export function currentTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

export function applyTheme(t: Theme): void {
  document.documentElement.setAttribute('data-theme', t)
  try {
    localStorage.setItem(KEY, t)
  } catch {
    /* 隐私模式下忽略 */
  }
  listeners.forEach((fn) => fn(t))
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark'
  applyTheme(next)
  return next
}

export function initTheme(): void {
  let saved: string | null = null
  try {
    saved = localStorage.getItem(KEY)
  } catch {
    /* ignore */
  }
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  const t: Theme = saved === 'dark' || saved === 'light' ? saved : prefersDark ? 'dark' : 'light'
  document.documentElement.setAttribute('data-theme', t)
}

export function onThemeChange(fn: (t: Theme) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
