// ─── 图片资源路径与命名的**纯函数**（可单测）─────────────────────────────────
//
// 从 `lib/insertImage.ts` 拆出来：那个模块要读 Pinia store 与 i18n（`node --test`
// 解析不了渲染层的目录导入），而"放哪儿、叫什么名字"这半边是纯字符串逻辑 ——
// 拆开后单测能直接钉住它（见 `tests/imageAsset.test.mjs`），也顺手避免了
// `path` 依赖（渲染层不引 node:path）。

/** 允许插入的图片扩展名（与主进程对话框过滤器保持一致） */
export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i

/** 图片资源目录名（工作区下 / 文档同级） */
export const ASSET_DIR = 'assets'

/** 纯字符串拼接（分隔符跟随传入的路径：Windows 反斜杠、POSIX 正斜杠） */
export function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  return `${dir.replace(/[\\/]+$/, '')}${sep}${name}`
}

/** 取目录部分（不含末尾分隔符）；没有分隔符时返回空串 */
export function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i < 0 ? '' : p.slice(0, i)
}

/** 取文件名主干（去掉最后一个扩展名） */
export function stemOf(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

/** 资源目录：优先工作区，其次文档所在目录；都没有则 null（调用方提示用户先保存） */
export function assetDirFor(root: string | null, docPath: string | null): string | null {
  if (root) return joinPath(root, ASSET_DIR)
  if (docPath) return joinPath(dirOf(docPath), ASSET_DIR)
  return null
}

/**
 * 资源文件名：`<原名主干>-<时间戳>.<ext>`。
 *
 * 为什么带时间戳：同一张图粘两次不能互相覆盖；同时名字仍然认得出来源
 * （`clipboard-20260924-153012.png`）。主进程还会再查一次重名并自动编号
 * （`fileOps.uniqueName`），所以这里的唯一性只是"通常足够"，不是正确性依赖。
 */
export function assetNameFor(sourceName: string, now: number = Date.now()): string {
  const safeStem =
    stemOf(sourceName || 'image')
      .replace(/[^\w\u4e00-\u9fff-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'image'
  const ext = (sourceName.match(/\.[a-z0-9]+$/i)?.[0] ?? '.png').toLowerCase()
  const d = new Date(now)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `${safeStem}-${stamp}${ext}`
}
