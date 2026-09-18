/**
 * 零依赖的浏览器 e2e 驱动器。
 *
 * 为什么需要它：
 *   截图只能"看着像对"，而决策树这种页面必须真的点按钮、切数据集、等动画跑完才能验证。
 *   本机没有 puppeteer，但 Node 22 自带 WebSocket，可以直接讲 Chrome DevTools Protocol。
 *
 * 用法：
 *   node scripts/e2e.mjs --url http://127.0.0.1:4173/demos/decision-tree/ \
 *                        --script scripts/tests/decision-tree.js
 *
 * 被测脚本约定：
 *   一个 async 函数体（可直接用 await），返回值必须是可 JSON 序列化的对象。
 *   里面可以用 sleep(ms)、q(sel)、click(sel)、setSelect(sel, value) 这些预置helper。
 * 退出码：脚本返回 { ok: true } 且无 JS 异常 → 0，否则 1。
 */
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
// 端口随机化：固定端口在连续跑多个测试时会撞上"上一个 Edge 还没退干净"的情况，
// 表现为「DevTools 端口没起来」——本机偶发过两次，改成随机端口后从根上避免。
const PORT = 9300 + Math.floor(Math.random() * 600)
const SERVE_PORT = 4173

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}

const wantServe = process.argv.includes('--serve')
const shotPath = arg('shot', null)
/*
 * --clip <选择器>：只截某个元素的区域，并按 --clip-scale 放大。
 * 全页截图缩得厉害，看"决策边界铺得对不对"这种细节必须放大看。
 */
const clipSel = arg('clip', null)
const clipScale = Number(arg('clip-scale', '3'))
/*
 * --viewport：只截当前视口，不做整页捕获。
 * 整页捕获（captureBeyondViewport）会把 position:fixed 的背景层只画一次、
 * 且 clip 与 scale 的组合行为不稳定，量不准首屏的排版细节。看首屏就用这个。
 */
const viewportOnly = process.argv.includes('--viewport')
/*
 * --reduced-motion：用 CDP 模拟系统的"减少动态效果"。
 * 背景层承诺在这种环境下只画一帧静态图、不起循环、不接视差，
 * 光靠读代码看不出来，必须真的模拟一遍才算验证过。
 */
const reducedMotion = process.argv.includes('--reduced-motion')

/*
 * --dpr <n>：模拟高 DPI 屏幕。
 * 背景层把 DPR 上限压在 2，需要真的用 2 和 3 各跑一遍确认缓冲区没被放大。
 */
const emuDpr = Number(arg('dpr', '0'))
/*
 * --size 480x900：改窗口尺寸。
 * 用来验证移动端降级分支（背景层的 isMobile() 看的是 max-width: 768px）。
 */
const winSize = arg('size', '1440,1600')

const url = arg('url')
const scriptPath = arg('script')
if (!url || !scriptPath) {
  console.error('用法: node scripts/e2e.mjs --url <url> --script <file>')
  process.exit(2)
}
if (!existsSync(scriptPath)) {
  console.error('脚本不存在:', scriptPath)
  process.exit(2)
}
if (!existsSync(EDGE)) {
  console.error('找不到 Edge:', EDGE)
  process.exit(2)
}

const body = readFileSync(scriptPath, 'utf-8')

/* ---------- （可选）自己起一个预览服务 ---------- */
let server = null
async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${SERVE_PORT}/`)
      if (r.ok) return true
    } catch {
      /* 还没起来 */
    }
    await delay(300)
  }
  return false
}
if (wantServe) {
  // 直接调本地 vite 的入口，不走 npx / shell：更稳也更快
  // （曾用 `spawn('npx', ..., {shell:true})`，在 Windows 上偶发起不来）
  server = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', 'preview', '--port', String(SERVE_PORT), '--host', '127.0.0.1'],
    { cwd: process.cwd(), stdio: 'ignore' },
  )
  if (!(await waitForServer())) {
    console.error('预览服务没起来，先跑 npm run build')
    server.kill('SIGKILL')
    process.exit(2)
  }
}

/* ---------- 浏览器用户数据目录 ---------- */
/*
 * 为什么必须自己管这个目录：
 *   Edge 会把上百 M 的配置/缓存写进 --user-data-dir 指向的位置。
 *   早先这里只拼了个 `mlv-e2e-${Date.now()}` 却**从不删除** ⇒ 每跑一次 e2e
 *   就在 Temp 里留 47M。2026-09-17 实测攒了 1801 个目录、58.92G，把 C 盘
 *   吃掉一大块 —— 而 cleanmgr 根本扫不出来（文件数过百万，它超时后直接放弃）。
 *   现在两头都堵：正常退出时删自己那个；启动时顺手清掉崩溃留下的残骸。
 */
const userDataDir = join(tmpdir(), `mlv-e2e-${process.pid}-${Date.now()}`)

/** 删目录；Windows 上进程没死透时文件还被占着会 EPERM，所以轮询重试 */
async function removeProfile(dir, tries = 25) {
  for (let i = 0; i < tries; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return true
    } catch {
      await delay(200)
    }
  }
  return false
}

/*
 * 崩溃 / 被 SIGKILL 时来不及清理，所以每次启动兜一遍。
 * 只清超过 6 小时的（正在跑的实例不动），且一次最多清 cap 个，
 * 免得扫上千个目录把测试本身拖慢 —— 要一次性清干净跑 `npm run clean:temp`。
 */
function sweepStaleProfiles(maxAgeMs = 6 * 3600 * 1000, cap = 20) {
  let removed = 0
  try {
    for (const name of readdirSync(tmpdir())) {
      if (removed >= cap) break
      if (!name.startsWith('mlv-e2e-')) continue
      const p = join(tmpdir(), name)
      try {
        if (Date.now() - statSync(p).mtimeMs < maxAgeMs) continue
        rmSync(p, { recursive: true, force: true })
        removed++
      } catch {
        /* 被占用，留给下次 */
      }
    }
  } catch {
    /* Temp 读不到就算了，不能因此让测试挂掉 */
  }
  return removed
}
const sweptCount = sweepStaleProfiles()
if (sweptCount) console.log(`顺手清掉 ${sweptCount} 个过期的浏览器数据目录`)

/* ---------- 启动浏览器 ---------- */
const proc = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=' + userDataDir,
    `--window-size=${winSize}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)

async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) return await r.json()
    } catch {
      /* 还没起来 */
    }
    await delay(300)
  }
  throw new Error('DevTools 端口没起来')
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.logs = []
    this.exceptions = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
        return
      }
      if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
        this.logs.push(
          `[${msg.params.type}] ` + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '),
        )
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails
        this.exceptions.push(d.exception?.description || d.text)
      }
    })
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    this.ws.send(JSON.stringify(payload))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      /*
       * 超时给到 90s。默认 30s 对一般页面够用，但神经网络页首屏要一次性建
       * 5184 个自定义图元（`progressive: false`，见 neuralNetwork.ts 里的说明），
       * 冷启动 + 训练 300 轮 + 多次重训，偶尔会顶到 30s 边界。
       */
      const timeout = Number(arg('timeout', '90000'))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`${method} 超时`))
        }
      }, timeout)
    })
  }
}

let exitCode = 1
try {
  const version = await waitForDevtools()
  const ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  const cdp = new Cdp(ws)

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })

  await cdp.send('Runtime.enable', {}, sessionId)
  await cdp.send('Page.enable', {}, sessionId)
  /* 模拟类设置必须在导航之前，否则首屏已经按默认值跑完了 */
  if (reducedMotion) {
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId)
  }
  if (emuDpr > 0) {
    // 先读当前视口尺寸再覆盖，避免用 0 把布局搞塌
    const m = await cdp.send('Page.getLayoutMetrics', {}, sessionId)
    const vw = Math.round(m.cssLayoutViewport?.clientWidth || 1440)
    const vh = Math.round(m.cssLayoutViewport?.clientHeight || 1200)
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: vw, height: vh, deviceScaleFactor: emuDpr, mobile: false },
      sessionId,
    )
  }

  await cdp.send('Page.navigate', { url }, sessionId)
  await delay(2500)

  /* ---------- 在页面里执行被测脚本 ---------- */
  const expr = `(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const q = (s) => document.querySelector(s);
    const qa = (s) => Array.from(document.querySelectorAll(s));
    const click = (s) => { const el = q(s); if (!el) throw new Error('找不到元素 ' + s); el.click(); };
    const setSelect = (s, v) => {
      const el = q(s); if (!el) throw new Error('找不到下拉框 ' + s);
      el.value = v; el.dispatchEvent(new Event('change'));
    };
    // 滑杆通常没有 id，允许直接传元素，也可以传选择器
    const setRange = (s, v) => {
      const el = typeof s === 'string' ? q(s) : s;
      if (!el) throw new Error('找不到滑杆 ' + String(s));
      el.value = String(v); el.dispatchEvent(new Event('input'));
    };
    ${body}
  })()`

  const res = await cdp.send(
    'Runtime.evaluate',
    { expression: expr, awaitPromise: true, returnByValue: true },
    sessionId,
  )

  if (res.exceptionDetails) {
    console.error('页面抛异常:', res.exceptionDetails.exception?.description || res.exceptionDetails.text)
  } else {
    const out = res.result.value
    if (shotPath) {
      await cdp.send('Runtime.evaluate', { expression: 'window.scrollTo(0,0)' }, sessionId)
      await delay(300)
      let clip = undefined
      if (clipSel) {
        const r = await cdp.send(
          'Runtime.evaluate',
          {
            expression: `(() => { const e = document.querySelector(${JSON.stringify(clipSel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height } })()`,
            returnByValue: true,
          },
          sessionId,
        )
        const box = r.result.value
        if (!box) {
          console.error('--clip 找不到元素:', clipSel)
        } else {
          clip = { ...box, scale: clipScale }
        }
      }
      const shot = await cdp.send(
        'Page.captureScreenshot',
        {
          format: 'png',
          captureBeyondViewport: !viewportOnly,
          ...(clip ? { clip } : {}),
        },
        sessionId,
      )
      writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
      console.log(
        '截图已保存:',
        shotPath,
        clip ? `（区域 ${clipSel}，放大 ${clipScale}x）` : viewportOnly ? '（视口）' : '（全页）',
      )
    }
    console.log(JSON.stringify(out, null, 2))
    exitCode = out && out.ok === true ? 0 : 1
  }

  if (cdp.exceptions.length) {
    console.error('\n页面 JS 异常:')
    cdp.exceptions.forEach((e) => console.error('  -', e.split('\n')[0]))
    exitCode = 1
  }
  if (cdp.logs.length) {
    console.error('\n控制台告警/错误:')
    cdp.logs.slice(0, 10).forEach((l) => console.error('  -', l))
  }
} catch (err) {
  console.error('驱动失败:', err.message)
  exitCode = 1
} finally {
  proc.kill('SIGKILL')
  if (server) server.kill('SIGKILL')
  // 等 Edge 真的退出再删：Windows 上进程没死透时目录被占着，rmSync 会 EPERM
  await removeProfile(userDataDir)
  process.exit(exitCode)
}
