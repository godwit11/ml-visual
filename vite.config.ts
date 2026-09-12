import { defineConfig } from 'vite'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readdirSync } from 'node:fs'

const root = dirname(fileURLToPath(import.meta.url))

function demoEntries(): Record<string, string> {
  const dir = resolve(root, 'demos')
  const out: Record<string, string> = {}
  if (!existsSync(dir)) return out
  // `_` 开头的目录是开发期自测页，不进生产构建（dev 模式下仍可直接访问）
  for (const name of readdirSync(dir)) {
    if (name.startsWith('_')) continue
    const file = resolve(dir, name, 'index.html')
    if (existsSync(file)) out[name] = file
  }
  return out
}

export default defineConfig({
  base: './',
  server: { port: 5173, open: false },
  build: {
    target: 'es2019',
    outDir: 'dist',
    assetsDir: 'assets',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: { main: resolve(root, 'index.html'), ...demoEntries() },
    },
  },
})
