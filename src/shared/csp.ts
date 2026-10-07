/**
 * ─── 内容安全策略（CSP）：**唯一真相源** ────────────────────────────────────────
 *
 * 为什么要有这个文件：CSP 此前写在**两处**，而且两处内容不一致 ——
 *   * `src/renderer/index.html` 的 `<meta http-equiv="Content-Security-Policy">`
 *     （含 `lumin-file:` 与 `media-src`，也就是本地图片/音视频能加载）；
 *   * `src/main/index.ts` 的响应头（`img-src` 少了 `lumin-file:`、没有 `media-src`，
 *     且只在 `!is.dev` 时注册）。
 * 后果有两层：① 打包态到底哪一份生效没人说得清（`webRequest` 对 `file://` 是否生效本身
 * 就依赖 Electron 版本与加载方式）；② 两份不一致时，"安全边界"取决于谁赢 —— 这不是能靠
 * 注释说清的东西。
 *
 * 现在：常量只有这一份。
 *   * 渲染层的 `<meta>` 由构建期插件从本常量注入（`index.html` 里只有占位注释）；
 *   * 主进程的**响应头**用它里面"meta 里无效的那几条"（见 `CSP_HEADER_ONLY`）。
 * 守卫见 `tests/guards.test.mjs`（断言 index.html 不再硬编码 CSP、两处引用同一常量、
 * 以及 `<meta>` 版里不许出现 meta 无效指令）与 `tools/_verify-csp.js`（真窗口里读响应头/控制台）。
 */

/** 允许的图片来源：自身 / data: / 远程 https（受"远程图片闸门"控制）/ 本地文件与 lumin-file:// */
const IMG_SRC = "img-src 'self' data: https: file: lumin-file:"

/** 媒体（音视频）：与图片同一套来源口径，另加 blob:（导出/预览用） */
const MEDIA_SRC = "media-src 'self' data: blob: file: lumin-file:"

/**
 * ⚠️ **在 `<meta>` 里会被浏览器直接忽略**的指令（CSP 规范明文：
 * `frame-ancestors` / `report-uri` / `sandbox` 通过 `<meta>` 下发时不生效，
 * Chromium 还会在控制台打一条 `The Content Security Policy directive '…' is ignored when
 * delivered via a <meta> element.`）。所以：
 *   * 它们**不许**写进 `PROD_CSP`（那份是要被塞进 `<meta>` 的）；
 *   * 需要时只能走**响应头** —— 见 `CSP_HEADER_ONLY` 与主进程的 `onHeadersReceived`。
 * `tests/guards.test.mjs` 会遍历这份清单，断言 `PROD_CSP` 里一条都没有（防止有人再写回去）。
 */
export const META_IGNORED_CSP_DIRECTIVES = ['frame-ancestors', 'report-uri', 'sandbox'] as const

/**
 * **只能走响应头**的那部分 CSP（`<meta>` 里会被忽略的指令）。
 *
 * 为什么单独一份而不是把 `PROD_CSP` 整串塞进响应头：HTTP 头与 `<meta>` 是**两份独立策略**，
 * 浏览器对同一次响应会**取交集**执行 —— 两份一旦漂移（哪怕只差一条），实际生效的就是
 * 谁都没完整表达过的第三份策略。所以这里只放"meta 里必然无效"的那几条，其余仍由 `<meta>`
 * 独自承载（唯一真相源 `PROD_CSP`）。
 *
 * 目前只用作响应头：`frame-ancestors 'none'`（本应用永远不该被嵌进 iframe/frame）。
 */
export const CSP_HEADER_ONLY = "frame-ancestors 'none'"

/**
 * 生产环境的 CSP（**进 `<meta>` 的那份**）。
 *
 * 逐条理由：
 *  * `default-src 'self'` —— 兜底；
 *  * `script-src 'self'` —— 不允许任何内联脚本；
 *  * `style-src 'self' 'unsafe-inline'` —— Vue 的 `:style` 绑定与动态主题变量需要内联样式，
 *    这是本项目唯一无法去掉的 `unsafe-inline`（不引入 nonce 机制是因为没有服务器端注入点）；
 *  * `connect-src 'self'` —— **不含 `ws:`/`wss:`**：打包态不需要 HMR 的 WebSocket，
 *    放开 scheme 等于给"万一被注入"留了一条数据外发通道。dev 态由 Vite 自己注入 HMR 客户端，
 *    本 CSP 只在打包态生效（`index.html` 的 meta 在生产构建里注入，dev 下 Vite 用自己的）。
 *  * `object-src 'none'` / `base-uri 'none'` / `form-action 'none'` / `frame-src 'none'`
 *    —— 这四样本应用一个都不用，直接关掉收窄面；
 *  * `worker-src 'self' blob:` —— CodeMirror / 高亮可能用到 worker。
 *
 * ⚠️ **不要**把 `frame-ancestors`（或 `report-uri` / `sandbox`）加回来：`<meta>` 里它们会被
 * 静默忽略，"以为设了其实没设"。要下发就去改 `CSP_HEADER_ONLY`（响应头那条路）。
 */
export const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  IMG_SRC,
  MEDIA_SRC,
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'"
].join('; ')

/** `index.html` 里的占位注释（构建期被替换成真的 meta 标签）。两处必须一致，测试守着。 */
export const CSP_PLACEHOLDER = '<!--LUMIN_CSP-->'

/** 构建期注入的 meta 标签（dev 与 prod 用同一份；dev 下 Vite 的 HMR 需要 ws，见下） */
export function cspMetaTag(csp: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${csp}" />`
}

/**
 * 开发态 CSP：在 `PROD_CSP` 基础上做两处放行，**各自改各自的指令**（别把 eval 塞进 connect-src）：
 *   * `script-src` 加 `'unsafe-eval'` —— Vite dev 的 sourcemap/HMR 需要；
 *   * `connect-src` 加 `ws: wss:` —— HMR 的 WebSocket。
 * 只有 dev server 场景会用到；打包产物永远是 `PROD_CSP`。
 */
export function devCsp(): string {
  return PROD_CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'").replace(
    "connect-src 'self'",
    "connect-src 'self' ws: wss:"
  )
}
