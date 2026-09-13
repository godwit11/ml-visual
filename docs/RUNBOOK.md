# 本机启动与验证手册（ml-visual）

> 所有命令都在这台机器上**实测过**（2026-09-11）。带 ⚠️ 的地方是踩过的坑，别跳过。
> 工作目录一律是 `D:\奇迹学习\ml-visual`。

---

## 0. 环境（本机实际版本）

| 项 | 值 |
|---|---|
| Node | `v22.22.2`（托管版，位于 `C:\Users\Redmi\.workbuddy\binaries\node\versions\22.22.2-2\`） |
| npm | `10.9.7` |
| e2e 用的浏览器 | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`（路径写死在 `scripts/e2e.mjs`，换机器要改） |
| 对拍用的 Python | `C:/Users/Redmi/.workbuddy/binaries/python/envs/default/Scripts/python.exe`（sklearn 1.9.0、numpy 2.5.3） |

Python 解释器路径记在项目根的 `.venv-python` 文件里，对拍脚本靠它 + `os.execv`
自动切换解释器。**不需要手动激活任何 venv。**

```bash
cd /d/奇迹学习/ml-visual
node -v && npm -v        # v22.22.2 / 10.9.7
```

首次拉代码（或 `node_modules` 被删）之后先装依赖：

```bash
npm install
```

---

## 1. 开发：起本地服务

```bash
npm run dev
```

输出：

```
  VITE v5.4.21  ready in 814 ms
  ➜  Local:   http://localhost:5173/
```

### ⚠️ 必须用 `localhost`，不能用 `127.0.0.1`

实测 Vite 5 在这台机器上**只监听 IPv6**：

```
TCP    [::1]:5173    [::]:0    LISTENING
```

所以：

| 地址 | 结果 |
|---|---|
| `http://localhost:5173/` | ✅ HTTP 200 |
| `http://127.0.0.1:5173/` | ❌ 连不上（curl 返回 000） |

如果一定要用 `127.0.0.1` 访问，加 `--host 127.0.0.1`：

```bash
npx vite --host 127.0.0.1
```

### 主要入口

```
http://localhost:5173/                              首页
http://localhost:5173/demos/linear-regression/      线性回归
http://localhost:5173/demos/logistic-regression/    Logistic 回归
http://localhost:5173/demos/model-evaluation/       模型评估
http://localhost:5173/demos/decision-tree/          决策树
http://localhost:5173/demos/svm/                    支持向量机
http://localhost:5173/demos/naive-bayes/            朴素贝叶斯
http://localhost:5173/demos/ensemble-learning/      集成学习
http://localhost:5173/demos/clustering/             聚类分析
http://localhost:5173/demos/pca/                    降维技术
http://localhost:5173/demos/neural-network/         神经网络
```

`demos/_selftest/` 是开发期自测页，不进生产构建，但 dev 模式下可以直接访问。

---

## 2. 构建与本地预览

```bash
npm run build      # 先 tsc --noEmit 类型检查，再 vite build → dist/
npm run preview    # 用 dist/ 起静态服务
```

`preview` 同样只监听 `[::1]`，所以是 **`http://localhost:4173/`**（注意是 **4173**，不是 5173）。

### ⚠️ `preview` 占用 4173，会和 e2e 撞端口

所有 e2e / verify 脚本内部都会自己起一个 `vite preview --host 127.0.0.1`（端口 **4173**），
跑完自动关掉。所以跑验证之前，**先关掉手动开的 `npm run preview`**，否则会撞端口。

强制释放端口（PowerShell，比 `pkill` 可靠）：

```powershell
Get-NetTCPConnection -LocalPort 4173,5173 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

---

## 3. 一条命令跑完整回归（最常用）

```bash
npm run verify:all
```

23 步，按「快 → 慢」串行执行，任何一步失败都不中断，最后统一汇总并给出退出码
（全通过 `0`，有失败 `1`）。

| 层 | 步骤 |
|---|---|
| 类型与单测 | `typecheck`、`unit:renderer` |
| 页面 e2e | 首页 + 10 个演示页（11 步） |
| 算法对拍 | 10 套 `crosscheck:*` |

常用变体：

```bash
npm run verify:all -- --list           # 只列出会跑什么，不执行
npm run verify:all -- --only=unit      # 只跑类型检查 + 单测（约 3 秒）
npm run verify:all -- --only=e2e       # 只跑 11 个页面断言
npm run verify:all -- --only=crosscheck # 只跑十套对拍
npm run verify:fast                    # 跳过对拍（改样式时够用）
```

> 全量跑一次大约 **4 分钟**（其中神经网络页 e2e 和十套对拍占大头）。
> 只改 CSS / 文案时用 `--only=e2e` 或 `verify:fast` 就够了。

### 首页那个断言数字会自动校验

首页 hero 上会显示「N 项页面断言全绿」，N 取自 `src/data/siteStats.json`
的 `pageAssertions`。`verify:all` 会把实际跑出来的断言数加起来对一遍，
**对不上就判失败并告诉你该改成多少**：

```
  ✅ 11/11 步通过
  ❌ 首页断言数不一致：实际 328，src/data/siteStats.json 里写的是 319
```

所以增删断言之后不用记得手动改 —— 忘了跑一次回归就会红。这是为了让
「页面上每个数字都能追溯」这条约定有机器保证，而不是靠自觉。

改动步骤：

1. 在 `scripts/tests/*.js` 里加/删断言
2. 跑 `npm run verify:all -- --only=e2e`
3. 按提示把 `src/data/siteStats.json` 的 `pageAssertions` 改成实际值

---

## 4. 单跑某一层

### 类型检查

```bash
npm run typecheck        # tsc --noEmit
```

### 页面 e2e（CDP 驱动无头 Edge）

```bash
npm run e2e:home         # 首页
npm run e2e:links:home   # 首页所有链接可达性
npm run e2e:links:demo   # 演示页所有链接可达性（选中间的 PCA，prev/next 都有）
npm run e2e:lr           # 线性回归
npm run e2e:logistic     # Logistic 回归
npm run e2e:eval         # 模型评估
npm run e2e:svm          # SVM
npm run e2e:nb           # 朴素贝叶斯
npm run e2e:ens          # 集成学习
npm run e2e:km           # 聚类
npm run e2e:pca          # PCA
npm run e2e:tree         # 决策树
npm run e2e:nn           # 神经网络
```

#### 链接检查为什么必须存在

演示页底部「下一个」曾经跳到 `/demos/linear-regression/demos/logistic-regression/`（404），
根因是 `DEMOS` 里的 `href` 是**站点根相对**路径，直接赋给 `a.href` 只在首页碰巧成立。
这类 bug 有两个特点：链接**看起来完全正常**（文字/样式/href 属性都对），
而且**位置相关**（同一个 href 在首页对、在演示页错）—— 在首页跑的测试永远绿。

所以 `scripts/tests/links.js` 会把页面上所有同源 `<a href>` 真的 `fetch()` 一遍，
并且额外检查「解析后的 path 里 `/demos/` 出现两次」。

⚠️ **那条结构检查是必需的**：实测 vite preview 对未知路径会**回退到 200**
（返回首页 HTML），所以只判状态码发现不了路径写错。

```bash
# 想手动看某个页面的链接情况
node scripts/e2e.mjs --serve --url http://127.0.0.1:4173/demos/svm/ \
  --script scripts/tests/links.js
```

⚠️ `npm run e2e`（不带后缀）**是决策树页**（历史遗留命名，等价于 `e2e:tree`）。
想要全站请用 `npm run verify:all -- --only=e2e`。

直接调驱动器（带额外开关）：

```bash
node scripts/e2e.mjs --serve \
  --url http://127.0.0.1:4173/demos/neural-network/ \
  --script scripts/tests/neural-network.js
```

驱动器的可选开关：

| 开关 | 作用 |
|---|---|
| `--serve` | 自己起 `vite preview`（127.0.0.1:4173） |
| `--shot <path>` | 顺带出截图 |
| `--clip <选择器>` + `--clip-scale <n>` | 只截某个元素并放大 |
| `--viewport` | 只截视口（看首屏排版用这个） |
| `--reduced-motion` | 模拟系统的「减少动态效果」 |
| `--dpr <n>` | 模拟高 DPI 屏幕 |
| `--size <W,H>` | 改窗口尺寸（验证移动端降级） |
| `--timeout <ms>` | 单条 CDP 命令超时，默认 90000 |

### 算法对拍（TS 手写 ↔ numpy 复算 ↔ sklearn）

```bash
npm run crosscheck           # 线性回归
npm run crosscheck:logistic
npm run crosscheck:eval
npm run crosscheck:svm
npm run crosscheck:nb
npm run crosscheck:ens
npm run crosscheck:km
npm run crosscheck:pca
npm run crosscheck:tree
npm run crosscheck:nn
```

### 背景层专项验证（改背景后必跑）

```bash
npm run verify:bg          # 帧率、canvas 是否在动、视差层 transform
npm run verify:bg:motion   # prefers-reduced-motion：canvas 应静止、动画 none、帧率回升
npm run verify:bg:dpr      # DPR=3：canvas 缓冲区倍率应精确等于 2
npm run verify:bg:mobile   # 420×900：视差关闭、背景仍正常绘制
```

---

## 5. 截图

```bash
npm run shot:home                                    # 首页（暗色、视口）
node scripts/e2e.mjs --serve --url <url> --script <脚本> --shot <路径> [--viewport|--clip…]
```

截图统一落在 `.shots/`（已在 `.gitignore` 里）。

---

## 6. ⚠️ 本机踩过的坑

| 现象 | 原因 / 处理 |
|---|---|
| `http://127.0.0.1:5173/` 打不开 | Vite 只监听 `[::1]`，改用 `localhost` |
| e2e 报「预览服务没起来」 | 手动开的 `preview` 占着 4173，先释放端口 |
| e2e 报「找不到 Edge」 | `scripts/e2e.mjs` 里的 `EDGE` 路径写死，换机器要改 |
| `npm run crosscheck` 报缺 sklearn | 检查 `.venv-python` 指向的路径是否存在且装了依赖 |
| `pkill -f vite` 杀不掉 | Windows 上用 PowerShell 的 `Stop-Process -Id <PID> -Force`（PID 从 `netstat -ano` 取） |
| Git Bash 里 `taskkill /F /PID` 报「无效参数」 | 路径被 Git Bash 转换，用 `//F` 也不行；改用 PowerShell |

---

## 7. 部署（GitHub → Vercel → 自有域名）

**线上地址：<https://www.godwit.asia/>**（2026-09-12 上线）

### 链路

```
本机源码 → git push → GitHub godwit11/ml-visual (main) → Vercel 自动构建 → 全球 CDN
                                                                    ↑
                                          www.godwit.asia 的 DNS 已指向 Vercel
```

### 日常更新：只需 push

```bash
git add -A && git commit -m "..." && git push
```

推送到 `main` 会**自动触发生产部署**，约 1–2 分钟。推送到其它分支会得到**预览部署**
（独立链接，不影响线上）。

### 关键配置

| 项 | 值 | 位置 |
|---|---|---|
| Vercel 项目 | `ml-visual`，team `godwit-3-3310's` (Hobby) | Vercel Dashboard |
| 构建命令 | `node scripts/gen-sitemap.mjs && npm run build` | `vercel.json`（**不要**在网页上覆盖） |
| 输出目录 | `dist` | `vercel.json` |
| 主域名 | `www.godwit.asia` | Vercel → Settings → Domains |
| apex `godwit.asia` | 308 → `www.godwit.asia` | 同上 |
| DNS | 阿里云，`www` 是 CNAME → `vercel-dns-017.com` | **不需要动** |
| 证书 | Let's Encrypt，Vercel 自动续期 | 无需操作 |

### ⚠️ 坑：`*.vercel.app` 在国内被 DNS 污染

Vercel 免费送的 `ml-visual-opin.vercel.app` 之类地址，**在国内解析不到真 IP**
（实测本地 DNS 和阿里 223.5.5.5 都返回 Facebook 的 IP 段）。

后果：
- **不能用它来验收**，也不能把它分享给国内的人。**对外一律用 `www.godwit.asia`。**
- 想确认部署是否成功，看 Dashboard 的 `Ready` 状态和缩略图。

### 验证线上是否正常

```bash
# 站点在线 & 内容对不对
curl -s https://www.godwit.asia/ | grep -oE "<title>[^<]*</title>"

# 在真实域名上跑链接可达性检查（会真开浏览器、真请求每条链接）
node scripts/e2e.mjs --url https://www.godwit.asia/ --script scripts/tests/links.js
node scripts/e2e.mjs --url https://www.godwit.asia/demos/pca/ --script scripts/tests/links.js
```

> 用 `--url <线上地址>` 且**不加 `--serve`**，就会直接打线上，而不是起本地预览。

### 已知限制

- Vercel 节点在海外（实测 `x-vercel-id: hnd1` = 东京），**中国大陆访问速度不稳定**。
  指向海外服务器的域名**不需要 ICP 备案**。
  若日后要国内稳定快速访问，需要：备案 + 换国内托管（阿里云 OSS / 轻量服务器 / EdgeOne 等）。
  这是个独立决定，当前未做。

---

## 8. 最短上手路径

```bash
cd /d/奇迹学习/ml-visual
npm install
npm run dev          # 打开 http://localhost:5173/
# 改完代码
npm run verify:fast  # 类型 + 单测 + 11 个页面断言（约 3 分钟）
npm run verify:all   # 提交前跑全量（约 5 分钟，含十套对拍）
```
