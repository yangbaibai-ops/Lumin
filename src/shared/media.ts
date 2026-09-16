/**
 * ─── 媒体文件的访问规则（纯函数，主进程与单测共用）────────────────────────────
 * 用途：`lumin-file://` 协议只允许送出「媒体文件」，且只允许送出「位于当前工作区或
 * 某个已打开文档所在目录之内」的媒体文件（见 main/index.ts 的 protocol.handle）。
 *
 * 为什么放在 shared/ 而不是 main/fileOps.ts：这里是**纯字符串判定**，不依赖 electron / node:path，
 * 因此可以被 `node --test` 直接覆盖（tests/media.test.mjs）—— 安全规则必须能单测，
 * 否则只能靠人工点、点不出来就等于没有。
 */
const MEDIA_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico|mp4|webm|ogv|ogg|mp3|wav|m4a|pdf)$/i

/** 路径归一：统一分隔符、去掉尾部分隔符、Windows 大小写不敏感（与各进程的既有口径一致） */
export function normalizeMediaPath(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** 扩展名是否属于「可以经 lumin-file 送出的媒体」 */
export function isMediaExtension(p: string): boolean {
  return MEDIA_EXT_RE.test(p)
}

/** 路径是否落在任一允许的根之内（根为 null / 空则跳过；按目录边界比较，`C:\Docs` 不含 `C:\Docs2`） */
export function isWithinAnyRoot(p: string, roots: readonly (string | null | undefined)[]): boolean {
  const target = normalizeMediaPath(p)
  return roots.some((root) => {
    if (!root) return false
    const dir = normalizeMediaPath(root)
    return target === dir || target.startsWith(`${dir}\\`)
  })
}
