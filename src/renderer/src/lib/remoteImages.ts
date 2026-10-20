// ─── 远程图片的隐私闸门（自查报告 H2）────────────────────────────────────────
//
// 问题：Markdown 里的 `![x](https://tracker/px.png)` 原来会**无条件加载** ——
// 打开别人的笔记 / 从网上下载的文档 / GitHub 上的 README，浏览器立刻向外部发起请求，
// 泄露「你在什么时间打开了这篇文档」与 IP。主流编辑器与 VS Code 的口径都是**默认不加载**。
//
// 做法（改到最小、且不碰文档）：
//   * `remoteImages` 设置：`click`（默认）＝ 点一下才加载；`always` ＝ 与旧行为一致；
//   * 渲染时把 `<img src>` 换成**占位元素**（第 55 轮起改用 `data-remote-src` 属性标识，
//     原先的 `.img-guard` 类已删除）：没有 `src` 属性就不会发请求（这是浏览器行为，不是我们的约定）；
//   * 点击占位 → 把该 src 记进**本次会话**的白名单，并在 DOM 上就地换成真 `<img>`；
//   * **导出 / getHTML() 必须放行**：那条路径要的是真实 HTML（否则导出的文档里图片全丢），
//     由 `beginExportRender()/endExportRender()` 开的一个同步窗口保证 —— `getHTML()` 是同步的。
//
// 本模块是纯逻辑（无 electron / 无 Vue），有单测：`tests/remoteImages.test.mjs`。
/** 远程图片加载策略 */
export type RemoteImagePolicy = 'click' | 'always'

/** 本会话里用户已放行的远程图片（点击占位后加入） */
const allowed = new Set<string>()

/** 导出渲染窗口：`getHTML()` 期间必须给真实 `<img src>` */
let exportRenderDepth = 0

/** http(s) 远程图片（`//host/x.png` 协议相对也算） */
export function isRemoteHttp(src: string): boolean {
  return /^https?:\/\//i.test(src) || src.startsWith('//')
}

/**
 * 是否要把这张图挡在占位后面。
 * 只有「远程 + 策略是 click + 用户还没放行 + 不在导出窗口里」四条同时成立才挡。
 */
export function needsRemotePermission(src: string, policy: RemoteImagePolicy): boolean {
  if (exportRenderDepth > 0) return false
  if (policy !== 'click') return false
  if (!isRemoteHttp(src)) return false
  return !allowed.has(src)
}

/** 用户点击占位：放行这张图（会话级，不落库 —— 换一篇文档重新来过更安全） */
export function allowRemoteImage(src: string): void {
  if (src) allowed.add(src)
}

/** 导出 / 复制 HTML 期间临时放行（成对使用；`getHTML()` 是同步的，所以用深度计数即可） */
export function beginExportRender(): void {
  exportRenderDepth++
}

export function endExportRender(): void {
  if (exportRenderDepth > 0) exportRenderDepth--
}

/** 仅供测试：清空会话白名单与导出窗口 */
export function resetRemoteImageState(): void {
  allowed.clear()
  exportRenderDepth = 0
}
