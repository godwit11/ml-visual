/**
 * Vercel 函数入口 —— 部署到线上后，这个文件变成
 * `https://www.godwit.asia/api/chat`。
 *
 * 这里**刻意什么逻辑都不写**，只把请求转给 chat/handler.ts。
 * 原因：同一份逻辑还要给本地开发用（见 vite.config.ts 的中间件），
 * 逻辑放两份就一定会走偏 —— 这也是这个项目「上一个/下一个」修过
 * 一次 10 份拷贝之后的教训。
 *
 * Vercel 的「Web 标准」写法：默认导出一个带 fetch 方法的对象，
 * 收 Request、回 Response。Node 22 下 Request/Response 都是内建的。
 */
import { handleChat } from '../chat/handler'

export default {
  fetch(request: Request): Promise<Response> {
    return handleChat(request)
  },
}
