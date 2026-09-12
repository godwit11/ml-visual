import './styles/index.css'

export { mountChrome } from './core/chrome'
export { mountPager, siteUrl } from './core/pager'
export { mountSlider, round } from './core/slider'
export type { SliderHandle, SliderOptions } from './core/slider'
export { currentTheme, onThemeChange, toggleTheme, applyTheme, initTheme } from './core/theme'
export {
  DEMOS,
  MODULES,
  demoById,
  learningPath,
  neighbors,
  getVisited,
  markVisited,
} from './data/demos'
export type { DemoMeta, ModuleId } from './data/demos'
