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
 *   * 主进程的响应头也用它（同一份字符串，不会再漂）。
 * 守卫见 `tests/guards.test.mjs`（断言 index.html 不再硬编码 CSP、两处引用同一常量）。
 */

/** 允许的图片来源：自身 / data: / 远程 https（受"远程图片闸门"控制）/ 本地文件与 lumin-file:// */
const IMG_SRC = "img-src 'self' data: https: file: lumin-file:"

/** 媒体（音视频）：与图片同一套来源口径，另加 blob:（导出/预览用） */
const MEDIA_SRC = "media-src 'self' data: blob: file: lumin-file:"

/**
 * 生产环境的 CSP。
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
  "frame-src 'none'",
  "frame-ancestors 'none'"
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
