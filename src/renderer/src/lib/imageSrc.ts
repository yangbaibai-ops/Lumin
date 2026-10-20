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
 * 把 Markdown 里写的图片 src 解析成**当前上下文里可直接加载**的 URL。
 *
 * 与 `imageSrcForDoc(src, docDir)` 是同一条纯解析，只是基准目录由宿主注入。
 * 相对路径 ⇒ `lumin-file:///...` 绝对 URL；绝对路径 ⇒ 同样走协议；http/https/data 原样。
 * 任何要写进 `<img src>` 的地方（节点渲染 / 原文 widget）都必须经过它——这是
 * 「点击不改变可加载性」的守卫点（tests/imageSrc.test.mjs 有纯函数用例）。
 */
export function resolveImageSrc(src: string): string {
  return imageSrcForDoc(src, documentDirProvider())
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
 * 图片 src → 实际可用的 URL。
 * @param src     Markdown 里写的路径
 * @param docDir  当前文档所在目录（未命名文档 / 无文档时为 null）
 */
export function imageSrcForDoc(src: string, docDir: string | null): string {
  if (isExternalImageSrc(src)) return src
  const abs = isAbsolutePath(src) ? joinDocPath('', src) : docDir ? joinDocPath(docDir, src) : null
  if (!abs) return src // 没有基准目录可解析：保持原样（与旧行为一致）
  // 逐段转义（encodeURIComponent 会连盘符的冒号一起转义，主进程 decode 后照样还原）：
  // 空格、中文、`#`、`?` 都不会把 URL 拆坏
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
