/**
 * ─── Markdown 里的相对图片路径 → 可加载的 URL ────────────────────────────────
 * **原先的问题**：`![](img/a.png)` 是相对**文档**的路径，但渲染层页面在
 * `out/renderer/index.html`，原样交给 `<img src>` 会按页面目录解析 → 相对图片根本渲染不出来
 * （extensions.ts 里那个 `resolveLocalImageSrc` 两个分支都原样返回，是个空实现）。
 *
 * **做法**：把「文档目录 + 相对路径」规范化成绝对路径，再交给主进程的 `lumin-file://` 协议加载；
 * 主进程侧按「媒体扩展名白名单 + 位于工作区或已打开文档目录之内」校验（见 main/index.ts）。
 * http/https/data/blob/file 这些远程或内联图片原样返回，不掺和。
 *
 * 纯函数（无 electron / 无 node path），有单测：`tests/imageSrc.test.mjs`。
 * 覆盖点：路径拼接、`..` 上溯不越盘符/根、分隔符混用、盘符大小写、URL 转义（空格/中文/`#`）。
 */
const EXTERNAL_SCHEME = /^(https?|data|blob|file|lumin-file):/i

/**
 * 当前文档目录的**宿主注入**出口（默认 null = 不解析，与旧行为一致）。
 *
 * 为什么放在这个纯函数模块里：图片节点（extensions.ts 的 renderHTML）与
 * **点击后转成的原文 widget**（imageToolbar.ts）必须用**同一个**基准目录解析，
 * 否则会出现「首帧能显示、点一下图片就裂」——后者拿到的 src 是 Markdown 里写的
 * 相对串，浏览器按渲染页面（out/renderer/index.html）解析 ⇒ 404（见 imageToolbar
 * 的 `makeRawWidgetDeco`）。宿主在 buildEditorExtensions() 里注入一次即可。
 */
let documentDirProvider: () => string | null = () => null

/** 注入「当前文档所在目录」的提供者（读的时候现取：切换文档后自然正确） */
export function setDocumentDirProvider(provider: () => string | null): void {
  documentDirProvider = provider
}

/**
 * 当前**工作区根**的宿主注入出口：只在「没有文档目录」时兜底。
 *
 * 为什么需要：相对图片的基准在正常路径上是文档目录（`files.currentDir`），但有两种
 * 文档没有目录上下文 —— 未命名缓冲区、以及某些把正文直接塞进编辑器的路径（状态恢复 /
 * 只读预览）。这时退回工作区根仍能解析出用户预期的图（README 在仓库根、图在
 * `docs/screenshots/` 就是这种形态），比把相对串原样交给浏览器（会按 `out/renderer/`
 * 解析 ⇒ 必然 404）安全。没有工作区时仍保持旧行为（原样返回，不瞎猜）。
 */
let workspaceRootProvider: () => string | null = () => null

/** 注入「当前工作区根」的提供者（读的时候现取；仅作为无文档目录时的兜底） */
export function setWorkspaceRootProvider(provider: () => string | null): void {
  workspaceRootProvider = provider
}

/**
 * 把 Markdown 里写的图片 src 解析成**当前上下文里可直接加载**的 URL。
 *
 * 与 `imageSrcForDoc(src, docDir)` 是同一条纯解析，只是基准目录由宿主注入。
 * 相对路径 ⇒ `lumin-file:///...` 绝对 URL；绝对路径 ⇒ 同样走协议；http/https/data 原样。
 * 任何要写进 `<img src>` 的地方（节点渲染 / 原文 widget）都必须经过它——这是
 * 「点击不改变可加载性」的守卫点（tests/imageSrc.test.mjs 有纯函数用例）。
 */
export function resolveImageSrc(src: string): string {
  // 幂等第一道闸：已经解析好的可加载 URL（lumin-file / http(s) / data / blob / file）
  // **原样返回**。这是「点击前后 img.src 逐字符相同」的守卫点 —— 若把
  // `lumin-file:///D%3A/…` 再当相对路径拼一次，`%3A` 就会变成 `%253A`（协议侧 404）。
  if (isExternalImageSrc(src)) return src
  // 文档目录优先；没有文档目录（未命名 / 无路径上下文）时退回工作区根。
  const dir = documentDirProvider() ?? workspaceRootProvider()
  return imageSrcForDoc(src, dir)
}

/** 远程 / 内联图片（不参与本地路径解析） */
export function isExternalImageSrc(src: string): boolean {
  return !src || EXTERNAL_SCHEME.test(src) || src.startsWith('//')
}

/** Windows 绝对路径（`C:\x`、`C:/x`）或 UNC（`\\server\share`） */
export function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p)
}

/** 把 `dir + rel` 规范化：统一分隔符、消掉 `.` 与 `..`（`..` 不越过盘符 / 根） */
export function joinDocPath(dir: string, rel: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  // dir 为空时不能补前导 '/'：那会把 `C:\x` 变成 `/C:/x`（平台前缀丢了，URL 会多一层斜杠）
  const raw = dir ? `${dir.replace(/[\\/]+$/, '')}/${rel}` : rel
  const drive = /^([a-zA-Z]:)/.exec(raw)?.[1] ?? ''
  const rootedPosix = raw.startsWith('/') && !drive
  const out: string[] = []
  for (const part of raw.split(/[\\/]+/)) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length > (drive ? 1 : 0)) out.pop()
      continue
    }
    out.push(part)
  }
  const prefix = drive || (rootedPosix ? sep : '')
  const body = out.join(sep)
  return body.startsWith(prefix) ? body : prefix + body
}

/**
 * 把 Markdown 链接目标里**已经百分号编码**的路径逐段还原成真实路径。
 *
 * 为什么必须先 decode：markdown-it 按 URL 语义处理 `![]()` 的目标，会把空格 / 中文 /
 * `#` 等规范化成 `%XX` 再交给 ProseMirror（实测 `![](图 片/c 图.png)` 的节点 attrs
 * 是 `%E5%9B%BE%20%E7%89%87/c%20%E5%9B%BE.png`）。如果直接对这段字符串逐段
 * `encodeURIComponent`，`%` 会被再编码一次 ⇒ `%E5` 变 `%25E5`，主进程只 decode 一次，
 * 拿到的是字面量 `%E5…` 的路径 ⇒ 404（这正是「带空格/中文的图片永远裂」的真因）。
 *
 * 逐段处理（而不是整串 decode）保住分隔符，也避免 `%2F` 之外的字符改变路径结构；
 * 非法转义（例如文件名里真有个 `%`）原样保留，绝不因为 decode 失败把图弄丢。
 */
export function decodePathEscapes(p: string): string {
  if (!p.includes('%')) return p
  return p
    .split(/([\\/]+)/)
    .map((part, i) => {
      if (i % 2 === 1 || !part.includes('%')) return part
      try {
        return decodeURIComponent(part)
      } catch {
        return part
      }
    })
    .join('')
}

/**
 * 图片 src → 实际可用的 URL。
 * @param src     Markdown 里写的路径（可能是 URL 编码形态）
 * @param docDir  当前文档所在目录（未命名文档 / 无文档时为 null）
 */
export function imageSrcForDoc(src: string, docDir: string | null): string {
  // 已经是可加载的绝对 URL（含 lumin-file 自带 `%3A`）：逐字符原样返回，绝不二次包装。
  if (isExternalImageSrc(src)) return src
  const realPath = decodePathEscapes(src)
  const abs = isAbsolutePath(realPath)
    ? joinDocPath('', realPath)
    : docDir
      ? joinDocPath(docDir, realPath)
      : null
  if (!abs) return src // 没有基准目录可解析：保持原样（与旧行为一致）
  // 逐段转义（encodeURIComponent 会连盘符的冒号一起转义，主进程 decode 后照样还原）：
  // 空格、中文、`#`、`?` 都不会把 URL 拆坏；decode 过的路径在这里只编码**一次**。
  const urlPath = abs
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
  return `lumin-file:///${urlPath}`
}

/**
 * `fromDir` → `to` 的相对路径（要上溯时用 `..`，分隔符跟随 `fromDir`）。
 *
 * 为什么需要：插入图片时把文件放进**工作区的 `assets/`**，而 Markdown 里的相对路径是
 * **相对文档**解析的（见 `imageSrcForDoc`）—— 文档在 `notes/` 里时就得写 `../assets/x.png`，
 * 否则渲染层按 `notes/assets/x.png` 去找，图直接裂掉。
 *
 * 两个盘符不同时相对不了：原样返回绝对路径（`imageSrcForDoc` 认绝对路径）。
 * 纯函数（无 node path / 无 electron），有单测：`tests/imageSrc.test.mjs`。
 */
export function relativeDocPath(fromDir: string, to: string): string {
  if (!fromDir) return to
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const a = norm(fromDir)
  const b = norm(to)
  const driveA = /^([a-zA-Z]:)/.exec(a)?.[1]?.toLowerCase() ?? ''
  const driveB = /^([a-zA-Z]:)/.exec(b)?.[1]?.toLowerCase() ?? ''
  if (driveA !== driveB) return to
  const partsA = a.split('/').filter(Boolean)
  const partsB = b.split('/').filter(Boolean)
  let i = 0
  // Windows 盘符与路径大小写不敏感：比较时统一小写（但输出保留原文）
  while (
    i < partsA.length &&
    i < partsB.length &&
    partsA[i].toLowerCase() === partsB[i].toLowerCase()
  ) {
    i += 1
  }
  if (i === 0) return to
  const up = partsA.length - i
  const rest = partsB.slice(i)
  if (!up) return rest.length ? rest.join('/') : '.'
  return [...Array(up).fill('..'), ...rest].join('/')
}
