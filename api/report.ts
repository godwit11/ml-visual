/**
 * Vercel 函数入口 —— 部署到线上后，这个文件变成
 * `https://www.godwit.asia/api/report`。
 *
 * 和 `api/chat.ts` 一样**刻意什么逻辑都不写**，只把请求转给
 * `report-handler.ts`。原因也一样：同一份逻辑还要给本地开发用
 * （见 vite.config.ts 的中间件），逻辑放两份就一定会走偏。
 *
 * ==================================================================
 * 这个目录里的文件布局是被 Vercel 的规则**逼**出来的
 * ==================================================================
 *
 * 【一句话】`report-handler.ts` 必须待在 `/api` 下、**而且名字不能带下划线**。
 *
 *   · Vercel 只处理 `/api` 目录下**不带 `_` / `.` 前缀**的 `.ts`，
 *     其他的一律既不编译也不打包；
 *   · 所以"给共享文件加下划线前缀让它别成为公开路由"这个**看起来最自然**
 *     的做法是错的 —— 它确实不成为路由，但**也不会被编译**。
 *
 * 【还有一条】`package.json` 里有 `"type": "module"` ⇒ 产物是 ESM，
 * 而 **ESM 解析器不猜扩展名**，所以 import 要写 `'./report-handler.js'`
 * —— 哪怕源文件名是 `.ts`（编译之后存在的是 `.js`）。
 *
 * 【本地全测不出来】`npm run dev` 走 Vite 中间件，用的是 bundler 那套解析；
 * `npm run typecheck` 也接受省略扩展名的写法。⇒ 专门有 `npm run check:vercel`
 * 在本地复刻 Vercel 的加载环境（编译成独立 .js 后用 ESM 真加载一遍），
 * **每次动 `/api` 里的文件都跑它。** 完整的事故复盘写在 `api/chat.ts` 顶部。
 * ==================================================================
 */
import { handleReport } from './report-handler.js'

export default {
  fetch(request: Request): Promise<Response> {
    return handleReport(request)
  },
}
