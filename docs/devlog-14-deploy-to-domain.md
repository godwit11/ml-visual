# ML 演示站 · 开发日志 14：上线到自有域名 godwit.asia

> **成果：<https://www.godwit.asia/>**
>
> 从"域名已经买了、代码都在本机、但谁也访问不到"到"输入域名就能打开"。
> 技术上没有多难，坑全在**权限归属**和**国内网络环境**上，所以这份日志记的主要是这两类。

---

## 1. 最终链路

```
本机源码 D:\奇迹学习\ml-visual
   │  git push
   ▼
GitHub 仓库 godwit11/ml-visual (main)          ← 代码的云端副本 + 版本历史
   │  Vercel 建立连接后自动拉取
   ▼
Vercel 构建服务器（东京节点）                    ← npm install → gen-sitemap → vite build
   │  产出 dist/
   ▼
Vercel 全球 CDN                                ← 存静态文件 + 管 HTTPS 证书
   │  域名解析（阿里云，早就指向 Vercel）
   ▼
https://www.godwit.asia/                       ← 用户输入的就是这个
```

**关键认知**：这是一个**纯静态站**。Vercel 不跑任何服务端代码，它只做两件事 ——
在云端帮你**构建**、把产物**分发**出去。所以整条链路里没有"服务器"要维护。

---

## 2. 三个阶段的坑（按踩到的顺序）

### 阶段一：代码上 GitHub

| 坑 | 现象 | 原因 / 解法 |
|---|---|---|
| 本机推不出去 | `git push` 挂住直到超时 | 无可用凭据。**必须用户在本机执行**，会弹 GitHub 登录窗（Git Credential Manager） |
| — | cmd 里 `cd /d/xxx` 报「命令语法不正确」 | `/d` 是 Git Bash 的写法，cmd 不认。无害，只要原本就在对的目录里 |

### 阶段二：Vercel 导入 —— ⚠️ 最反直觉的一关

**现象**：`Import Git Repository` 列表里只有旧仓库 `videomind`，**没有 `ml-visual`**。

**原因**：Vercel 通过一个 **GitHub App** 读你的仓库。安装时选的是
「**Only select repositories**」且只勾了 `videomind`。`ml-visual` 是后建的，从没被勾进去
→ Vercel 的接口读不到它。

> ### 💡 这条最值得记住
> **「公开仓库谁都能看」和「某个 App 能不能读」是两件独立的事。**
> `ml-visual` 是 public，但 GitHub App 的权限列表是它自己的白名单，
> 公开与否不影响。所以"仓库明明是公开的，为什么 Vercel 看不到"这个问题，
> 答案永远是去查 App 权限。

**解法**：`Import Git Repository` 面板**底部那行很小的灰字**
「Missing Git repository? **Adjust GitHub App Permissions**」（或直接去
`https://github.com/settings/installations` 找 Vercel → Configure），
在 `Repository access` 里把这个仓库勾上（保持 Only select 权限最小）→ Save → 回 Vercel 就有了。

### 阶段三：域名迁移 —— 域名被旧项目占着

**现象**：域名 `www.godwit.asia` 打开的是旧站（`videomind`），不是新部署的站点。

**排查**：先查 DNS，发现**早就指向 Vercel 了**：

```
godwit.asia      -> A 216.198.79.1
www.godwit.asia  -> CNAME aa676790e765de39.vercel-dns-017.com -> 216.198.79.1 / 64.29.17.1
```

所以问题不在阿里云，而在 **Vercel 侧"域名挂在哪个项目上"**。

**关键概念**：Vercel 里一个域名**同一时刻只能挂在一个项目上**。
所以顺序必须是：**先从旧项目摘掉 → 再挂到新项目**，反过来一定报"已被占用"。

**找到旧项目**：它的名字是 `videomind-kxy4` —— **不叫 `coze-xxx`**，
所以一开始按"coze"去搜是搜不到的。最后靠"哪个项目的 Domains 里写着 godwit.asia"
定位到（项目 Overview 页会直接列出绑定的域名）。

> 排查思路值得复用：**别猜项目名，去看哪个项目的 Domains 列表里有这个域名。**
> 另外注意 Vercel 的**空间切换器** —— 域名是账号/团队级资源，
> 不在同一个空间里的话，你看不到也删不掉。（本例很幸运：新旧项目在同一个 team 下。）

**解法**：
1. 旧项目 → Settings → Domains → Remove `www.godwit.asia`
2. 切到新项目 → Settings → Domains → Add `www.godwit.asia`
3. Add `godwit.asia`（apex），重定向方式选「跳到 www」
4. **不动阿里云** —— DNS 无需修改

---

## 3. ⚠️ 另一个必须知道的环境问题：`*.vercel.app` 在国内被 DNS 污染

**现象**：部署显示 `Ready`，但点 Vercel 给的 `xxx.vercel.app` 链接**打不开网页**。

**排查过程**：

```
本地解析 ml-visual-opin.vercel.app    -> 31.13.70.13            ← Facebook IP 段
阿里公共 DNS 223.5.5.5 查同一域名      -> 69.63.187.12
                                       + 2a03:2880:f130:83:face:b00c:0:25de
                                         （face:b00c = Facebook 标志性网段）
curl https://*.vercel.app              -> HTTP 000，10s 超时
对照 www.godwit.asia                   -> HTTP 200（真实 Vercel IP）
```

**结论**：整个 `*.vercel.app` 域名在国内被 DNS 投毒，**连国内公共 DNS 都返回假 IP**
（所以换 DNS 没用）。**不是站点坏了。**

**由此得出的操作规则**：

- ❌ **不能用 `xxx.vercel.app` 做验收**，也**不能把它分享给国内的人**。
- ✅ 对外一律用自有域名 `www.godwit.asia`（走真实 Vercel IP，可达）。
- ✅ 想确认部署是否成功：看 Vercel Dashboard 的 `Ready` 状态 + 自动生成的缩略图
  （它真的加载了一遍部署再截图，是"构建产物没问题"最硬的证据）。
- 本地预览的正道仍是 `npm run dev` / `npm run preview`。

> 试过用 `curl --resolve` 把 `.vercel.app` 强指到 `216.198.79.1` 想绕过 DNS —— **失败**。
> 但**不能**据此说站点有问题：`216.198.79.1` 是**自定义域名**的 anycast IP，
> `.vercel.app` 的部署由别的 IP 服务，指错 IP 本来就该失败。此路不通。

---

## 4. 上线后的验证（这一步别省）

### 用 curl 快速核对

```bash
curl -s https://www.godwit.asia/ | grep -oE "<title>[^<]*</title>"
curl -s -I https://godwit.asia/ | grep -iE "^(HTTP|location)"     # 应 308 -> www
```

实测结果：

| 检查项 | 结果 |
|---|---|
| `https://www.godwit.asia/` | 200 · `<title>奇迹学习 · 机器学习交互演示</title>` |
| apex `https://godwit.asia/` | 308 → `https://www.godwit.asia/` |
| 10 个演示页 | 全部 200 |
| `sitemap.xml` / `robots.txt` / `favicon.svg` / `404.html` | 全部 200 |
| 证书 | `CN=www.godwit.asia`，Let's Encrypt，自动续期 |

> **证书为什么立刻可用**：`notBefore` 是 8 月 24 日 —— 旧项目时期为**同一个域名**签发的，
> 域名在同 team 内换项目后证书被复用，所以没有等待签发的空窗期。

### 更有价值的一步：在生产域名上跑链接检查

```bash
node scripts/e2e.mjs --url https://www.godwit.asia/ --script scripts/tests/links.js
node scripts/e2e.mjs --url https://www.godwit.asia/demos/pca/ --script scripts/tests/links.js
```

`--url <线上地址>` 且**不加 `--serve`**，就会直接打线上，而不是起本地预览。

这一步等于把开发日志 13 里修的那个「点下一个跳到 404」在**生产环境**做了端到端复验：

```
首页     11 条链接全 200，无重复 /demos/ 路径
PCA 页   3 条全 200（首页 / clustering / neural-network）
```

---

## 5. 日常更新

```bash
git add -A && git commit -m "..." && git push
```

推送 `main` → 自动触发生产部署，约 1–2 分钟生效。
推送其它分支 → 得到**预览部署**（独立链接、不影响线上），可以先用它看效果再合并。

**这就是选 GitHub 自动部署而不是手动上传的价值**：以后改内容不用再碰部署流程。

---

## 6. 关键配置速查

| 项 | 值 | 位置 |
|---|---|---|
| Vercel 项目 | `ml-visual`，team `godwit-3-3310's` (Hobby) | Vercel Dashboard |
| 构建命令 | `node scripts/gen-sitemap.mjs && npm run build` | `vercel.json`（**不要**在网页上覆盖，否则以后改配置要两边同步） |
| 输出目录 | `dist` | `vercel.json` |
| 主域名 | `www.godwit.asia` | Vercel → Settings → Domains |
| apex | 308 → www | 同上 |
| DNS | 阿里云，`www` CNAME → `vercel-dns-017.com` | **不需要动** |
| 证书 | Let's Encrypt，自动续期 | 无需操作 |

---

## 7. 已知限制（未解决，是独立的决定）

- **Vercel 节点在海外**（实测 `x-vercel-id: hnd1` = 东京），
  **中国大陆访问速度不稳定**。指向海外服务器的域名**不需要 ICP 备案**。
  若日后要国内稳定快速访问：需要**备案 + 换国内托管**
  （阿里云 OSS / 轻量应用服务器 / EdgeOne 等）。当前未做。
- 旧项目 `videomind-kxy4` 还留着（域名已摘走）。想清理可以直接删项目。

---

## 8. 一句话总结

**技术上最难的其实不是"怎么部署"，而是搞清楚"权限归谁"** ——
GitHub App 只授权了一个仓库、域名被另一个项目占着。
两个问题都不会报出明确的错，只会表现为"东西不见了"和"打不开"。
所以排查这类问题时，**别猜，去找"哪个列表里写着它"**。
