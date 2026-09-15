/**
 * Vercel 函数入口 —— 部署到线上后，这个文件变成
 * `https://www.godwit.asia/api/chat`。
 *
 * 这里**刻意什么逻辑都不写**，只把请求转给 `handler.ts`。
 * 原因：同一份逻辑还要给本地开发用（见 vite.config.ts 的中间件），
 * 逻辑放两份就一定会走偏 —— 这也是这个项目「上一个/下一个」修过
 * 一次 10 份拷贝之后的教训。
 *
 * Vercel 的「Web 标准」写法：默认导出一个带 fetch 方法的对象，
 * 收 Request、回 Response。Node 22 下 Request/Response 都是内建的。
 *
 * ==================================================================
 * 🔴 这个目录里的文件布局是被 Vercel 的规则**逼**出来的，别随手改
 * ==================================================================
 *
 * 【事故】2026-09-15，线上 /api/chat 一直是 500，Vercel 日志里是：
 *
 *     Error [ERR_MODULE_NOT_FOUND]: Cannot find module
 *     '/var/task/chat/handler' imported from /var/task/api/chat.js
 *
 * 【表层原因】当时 `handler.ts` / `nya.ts` 放在**项目根的 `chat/` 目录**。
 * `api/chat.ts` 被编译成了 `api/chat.js`，而 `chat/` 整个目录
 * **没进函数包** —— 函数一执行就崩，对外表现为纯文本 500
 * `FUNCTION_INVOCATION_FAILED`。
 *
 * 【深层原因，两条规则叠加，缺一条都踩不到】
 *
 *   规则一：Vercel 只处理 **`/api` 目录下**的文件。`/api` 之外
 *          的 TS 既不编译也不打包（它不知道那是不是函数的一部分）。
 *
 *   规则二（**反直觉的那一条**）：在 `/api` 目录里，
 *          **不带 `_` / `.` 前缀的 `.ts` 文件会被当作函数入口 ⇒ 会被编译成 `.js`**；
 *          而**以 `_` 开头的文件会被 Vercel 忽略 ⇒ 也就不会被编译**。
 *
 *   所以"给共享文件加下划线前缀让它别成为公开路由"这个**看起来最自然
 *   的做法是错的**：它确实不成为路由，但**也不会被编译**，
 *   于是 `chat.js` 要 import 的 `handler.js` 根本不存在 —— 照样 500。
 *
 *   ⇒ 想让 `handler.ts` 被编译，就**必须**让它待在 `/api` 下、
 *     **而且不能加下划线**。代价是它会顺带成为一个可访问的路由，
 *     所以它自己导出了一个返回 404 的 default handler 兜着。
 *
 *   （这不是我一个人的教训：社区里有人把 `api/_lib/`、`api/shared/`、
 *     `vercel.json` 的 `includeFiles` 全试了一遍，都以
 *     ERR_MODULE_NOT_FOUND 收场 —— 因为那些都在**子目录**里。
 *     同目录 + 不带下划线，才是 Vercel 设计里走得通的那条路。）
 *
 * 【还有一条】`package.json` 里有 `"type": "module"` ⇒ 产物都是 ESM，
 * 而 **ESM 的解析器不猜扩展名**（CommonJS 才猜 .js/.json/index.js）。
 * 所以导入必须写 `'./handler.js'`，**哪怕源文件名是 `handler.ts`**
 * —— 因为编译之后存在的是 `.js`。
 *
 * 【这些坑本地全都测不出来】`npm run dev` 走 Vite 的中间件，用的是
 * bundler 那套解析（会猜扩展名、也不在乎文件在哪个目录）；
 * `npm run typecheck` 同样接受省略扩展名的写法。所以**本地全绿、
 * 线上全崩**。⇒ 专门加了 `npm run check:vercel`，它在本地复刻
 * Vercel 的加载环境（编译成独立 .js 后用 ESM 真加载一遍），
 * 在推送之前就能拦住。**每次动服务端文件，跑它。**
 * ==================================================================
 */
import { handleChat } from './handler.js'

export default {
  fetch(request: Request): Promise<Response> {
    return handleChat(request)
  },
}
