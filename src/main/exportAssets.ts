// ─── 导出资产本地化：纯函数（无 electron / 无 fs）────────────────────────────
//
// 背景（审计 P1-1）：HTML/Word 导出把本地图片原样写成 `lumin-file:///C%3A/…`、
// 把 KaTeX 字体写成构建目录的 `file:///D:/…/out/renderer/assets/*.woff2`。文件离开
// 这台机器后图片全裂、公式字体回退 ——「导出成功」变成一次静默失败。
//
// 这里只放**判定与改写**：
//   * `localPathFromUrl` 把各种本地 URL 形态还原成磁盘路径（调用方负责读文件）；
//   * `inlineFontFaces` 把 `@font-face` 的 woff2/woff/ttf 换成 data URI；读不到就整块删掉
//     （公式改用系统字体，至少没有绝对路径）；
//   * `findNonPortableRefs` / `assertPortable` 是导出后自检：仍含 `lumin-file:` 或
//     `file://` 就报错，**绝不**静默产出一个坏文件。
//
// 文件读取留在主进程（`main/export.ts`）：那里有授权闸与体积预算。本模块因此能直接
// `node --test`（tests/exportAssets.test.mjs）。
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 单张图片内联上限（超过就报错，不产出坏文件；见 main/export.ts 的说明） */
export const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024
/** 单个字体文件内联上限（KaTeX 的 woff2 都远小于它） */
export const MAX_INLINE_FONT_BYTES = 2 * 1024 * 1024

/** 不是「可打包的本地资产」的 src：远程、内联、锚点、脚本协议 */
const NON_LOCAL_RE = /^(?:https?:|data:|blob:|mailto:|tel:|javascript:|about:|#|\/\/)/i

/** 这张图片/字体是不是需要本地化处理的「本地资产」 */
export function isLocalAssetSrc(src: string): boolean {
  const s = String(src ?? '').trim()
  if (!s) return false
  return !NON_LOCAL_RE.test(s)
}

/**
 * 本地 URL / 路径 → 磁盘绝对路径。不是本地形态（远程/data/空）返回 null。
 *
 * 支持：
 *   * `lumin-file:///C%3A/x.png`（渲染层的本地图片协议）
 *   * `file:///C:/x.png`、`file://server/share/x.png`（UNC）
 *   * `C:\x.png`、`C:/x.png`、`\\server\share\x.png`
 *   * 相对路径 + `baseDir`（渲染层已尽量把它们解析成绝对 URL；这里兜底）
 */
export function localPathFromUrl(src: string, baseDir?: string | null): string | null {
  let s = String(src ?? '').trim()
  if (!s) return null
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1)
  if (NON_LOCAL_RE.test(s)) return null
  // `#`/`?` 是 URL 片段/查询：本地文件路径里不会有（图片 URL 不会带）
  s = s.replace(/[?#].*$/, '')
  try {
    if (/^lumin-file:/i.test(s)) {
      const u = new URL(s)
      // lumin-file:///C%3A/… → pathname `/C%3A/…`；decode 一次拿到 `C:/…`
      return decodeURIComponent(u.pathname.replace(/^\//, ''))
    }
    if (/^file:/i.test(s)) {
      try {
        return fileURLToPath(s)
      } catch {
        return decodeURIComponent(s.replace(/^file:\/\//i, ''))
      }
    }
  } catch {
    return null
  }
  if (path.isAbsolute(s)) return path.normalize(s)
  if (baseDir) return path.resolve(baseDir, decodeURIComponent(s))
  return null
}

/** 图片扩展名 → data URI 的 MIME */
export function mimeForImagePath(p: string): string {
  const ext = path.extname(String(p ?? '')).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.svg') return 'image/svg+xml'
  if (ext === '.avif') return 'image/avif'
  if (ext === '.bmp') return 'image/bmp'
  if (ext === '.ico') return 'image/x-icon'
  return 'image/png'
}

/** 字体扩展名 → data URI 的 MIME */
export function mimeForFontPath(p: string): string {
  const ext = path.extname(String(p ?? '')).toLowerCase()
  if (ext === '.woff2') return 'font/woff2'
  if (ext === '.woff') return 'font/woff'
  if (ext === '.otf') return 'font/otf'
  if (ext === '.eot') return 'application/vnd.ms-fontobject'
  return 'font/ttf'
}

/** CSS `format()` 里该写什么 */
export function formatForFontPath(p: string): string {
  const ext = path.extname(String(p ?? '')).toLowerCase()
  if (ext === '.woff2') return 'woff2'
  if (ext === '.woff') return 'woff'
  if (ext === '.otf') return 'opentype'
  if (ext === '.eot') return 'embedded-opentype'
  return 'truetype'
}

/** 字节 → data URI（buffer 或 Uint8Array 都行） */
export function dataUriFromBytes(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
}

/**
 * 在 `@font-face` 的声明体里找 `src:` 的**完整**范围。
 *
 * 不能简单用 `/src\s*:\s*([^;]+)/`：data URI 本身就含分号
 * （`data:font/woff2;base64,…`）。Vite 会把小于阈值的字体直接内联，于是
 * `src:url(data:font/woff2;base64,AAAA),url(file:///…woff) format("woff")` 这种
 * 混合写法真实存在 —— 按分号切会把 data URI 切成两半，替换后残留后半段 + 后面的
 * 绝对路径（实测就是 Size3 那两条 file:// 泄漏）。
 */
function findSrcDeclaration(body: string): { start: number; end: number; value: string } | null {
  const m = /(^|;)([ \t]*)src\s*:\s*/i.exec(body)
  if (!m) return null
  const valueStart = m.index + m[0].length
  let i = valueStart
  let quote = ''
  let depth = 0
  for (; i < body.length; i += 1) {
    const ch = body[i]
    if (quote) {
      if (ch === quote && body[i - 1] !== '\\') quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ';' && depth === 0) break
  }
  return {
    // 声明起点包含可能在它前面的 `;` 之后的位置（保留前一个声明的分号）
    start: m.index + (m[1] ? 1 : 0),
    end: i,
    value: body.slice(valueStart, i)
  }
}

/**
 * 把 CSS 里所有 `@font-face` 的字体引用换成 data URI。
 *
 * 每个 `@font-face` 只保留**一个**来源（优先 woff2）：原来的 CSS 同时列
 * woff2/woff/ttf 三种格式给老浏览器兜底，内联三种等于把导出件放大三倍；
 * 现代 Chromium/Word/浏览器都吃 woff2。已经是 data URI 的来源直接复用
 * （Vite 会把小字体内联），同时清掉它后面那些 `file://` 的 woff/ttf 兜底。
 *
 * @param css      原始 CSS
 * @param resolve  字体路径 → data URI（读不到返回 null）
 */
export function inlineFontFaces(
  css: string,
  resolve: (fontPath: string) => string | null
): { css: string; inlined: number; dropped: number } {
  let inlined = 0
  let dropped = 0
  const out = String(css ?? '').replace(/@font-face\s*\{[^}]*\}/gi, (block) => {
    const open = block.indexOf('{')
    const body = block.slice(open + 1, -1)
    const decl = findSrcDeclaration(body)
    if (!decl) return block
    const entries = [
      ...decl.value.matchAll(
        /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]+))\s*\)\s*(?:format\(\s*["']?([^"')]+)["']?\s*\))?/gi
      )
    ]
    if (!entries.length) return block
    const pick =
      entries.find((m) => /woff2/i.test(m[4] ?? '')) ??
      entries.find((m) => /\.woff2($|[?#])/i.test(m[1] ?? m[2] ?? m[3] ?? '')) ??
      entries[0]
    const url = (pick[1] ?? pick[2] ?? pick[3] ?? '').trim()
    // Vite 已经内联的小字体：直接复用，不再读盘
    if (/^data:/i.test(url)) {
      const fmt = /woff2/i.test(pick[4] ?? '') ? 'woff2' : pick[4] || 'woff2'
      inlined += 1
      return (
        block.slice(0, open + 1) +
        body.slice(0, decl.start) +
        `src:url("${url}") format("${fmt}")` +
        body.slice(decl.end) +
        '}'
      )
    }
    const fontPath = localPathFromUrl(url)
    const dataUri = fontPath ? resolve(fontPath) : null
    if (!fontPath || !dataUri) {
      dropped += 1
      return ''
    }
    inlined += 1
    return (
      block.slice(0, open + 1) +
      body.slice(0, decl.start) +
      `src:url("${dataUri}") format("${formatForFontPath(fontPath)}")` +
      body.slice(decl.end) +
      '}'
    )
  })
  // 删除整块后可能留下多余空行：保持 CSS 可读，不影响语义
  return { css: out.replace(/\n{3,}/g, '\n\n'), inlined, dropped }
}

/** 导出后自检命中的一处非便携引用 */
export interface NonPortableRef {
  kind: 'lumin-file' | 'file-url'
  index: number
  sample: string
}

/**
 * 扫描最终产物里的 `lumin-file:` 与 `file://`。
 *
 * 验收口径就是这两个串出现 **0 次**：出现任一即说明有资产没本地化，
 * 文件离开本机必然裂图/丢字体。
 */
export function findNonPortableRefs(text: string): NonPortableRef[] {
  const s = String(text ?? '')
  const refs: NonPortableRef[] = []
  const patterns: { kind: NonPortableRef['kind']; re: RegExp }[] = [
    { kind: 'lumin-file', re: /lumin-file:/gi },
    // `lumin-file:///…` 里也含 `file://` 子串：排除掉，避免把同一处报两遍
    { kind: 'file-url', re: /(?<!lumin-)file:\/\//gi }
  ]
  for (const { kind, re } of patterns) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(s))) {
      refs.push({
        kind,
        index: m.index,
        sample: s
          .slice(Math.max(0, m.index - 24), Math.min(s.length, m.index + 80))
          .replace(/\s+/g, ' ')
      })
      if (refs.length >= 20) return refs
    }
  }
  return refs.sort((a, b) => a.index - b.index)
}

/** 自检失败时抛的错误：渲染层把 message 原样展示给用户 */
export class ExportNotPortableError extends Error {
  readonly refs: NonPortableRef[]
  readonly fileName: string

  constructor(refs: NonPortableRef[], fileName = '') {
    const list = refs
      .slice(0, 3)
      .map((r) => `${r.kind} @${r.index}: ${r.sample.slice(0, 90)}`)
      .join('; ')
    super(
      `EXPORT_NOT_PORTABLE${fileName ? ` (${fileName})` : ''}: ${refs.length} non-portable local reference(s) left (${list}); export cancelled, no file written`
    )
    this.name = 'ExportNotPortableError'
    this.refs = refs
    this.fileName = fileName
  }
}

/** 断言产物可移植；不通过就抛（调用方据此**不写盘**） */
export function assertPortable(text: string, fileName = ''): void {
  const refs = findNonPortableRefs(text)
  if (refs.length) throw new ExportNotPortableError(refs, fileName)
}
