import './styles/index.css'

export { mountChrome } from './core/chrome'
export { mountPager, siteUrl } from './core/pager'
export { mountIntro, mountTerms, mountRecap } from './core/guide'
export type { IntroStep, IntroOptions, RecapRow } from './core/guide'
export { mountNya, provideNyaState, provideNyaStateFromPage, samplePageState } from './core/nya'
export { mountFeedback } from './core/feedback'
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
