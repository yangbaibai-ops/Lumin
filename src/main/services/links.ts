// ─── 主进程：链接目标解析与创建 ────────────────────────────────────────────
// 职责边界：这里只做「分类 + 路径解析 + 最小文件系统探测 / 创建」，**不打开任何东西**。
// 打开动作（系统默认浏览器 / Lumin 新窗口 / 系统默认应用）由渲染层按解析结果编排——
// 因为「目标不存在时是否创建」需要询问用户，而 UI 归渲染层。
//
// 分类规则（与 docs/wysiwyg-manual.md 一致）：
//   url      网址（http/https/mailto）→ 系统默认浏览器
//   file     不含量分隔符的文件名 → 相对当前文档所在目录，Lumin 新窗口打开
//   relative 含分隔符的相对路径（./a/b.md、../x）→ 系统默认应用
//   absolute 绝对路径（C:\a\b、\\server\share、/home/a）→ 系统默认应用
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { TEXT_FILE_EXT_RE } from '../../shared/textFiles'
import type { LinkResolveResult, LinkTargetKind } from '../../shared/types'

/**
 * 允许交给系统默认浏览器/邮件客户端的协议白名单。
 * 其余协议一律拒绝：shell.openExternal 会把任意 scheme 交给系统注册的处理器
 * （javascript:、ms-msdt:、smb: 等都是历史上有名的危险面），文档里的链接不可信。
 */
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

/** Windows 盘符绝对路径：new URL() 会把 `C:\x` 误判成 scheme 为 `c:` 的 URL */
const WIN_DRIVE_RE = /^[a-zA-Z]:[\\/]/

/**
 * **绝不交给系统「用默认应用打开」的扩展名**：这些是可执行文件 / 脚本 / 快捷方式，
 * 「打开」它们等于**运行**它们。
 *
 * 为什么必须在这里拦：文档内容是**不可信输入**（可能来自网络、别人发来的 .md）。
 * 此前 `[点我](C:\Windows\System32\calc.exe)` 这样的链接会一路走到 `shell.openPath` ——
 * 用户点一下链接就执行了本地程序，而链接在 Markdown 里通常只被当作普通内容。
 * 这类"文档 → 本地代码执行"是 Markdown 编辑器最经典的攻击面（同类编辑器出过同类 CVE）。
 *
 * 口径是"**只列明确危险的**"：pdf / 图片 / 文本 / office 文档等仍然照旧交给系统默认应用 ——
 * 那是产品的正常能力（`[x](../other/file.pdf)`）。黑名单不可能穷尽，所以配套的口径是：
 * **可执行类一律拒绝 + 其余保持原行为**，而不是"只允许白名单里的扩展名"（那会砍掉正常用法）。
 */
const UNSAFE_TARGET_EXT = new Set([
  '.exe',
  '.com',
  '.bat',
  '.cmd',
  '.ps1',
  '.psm1',
  '.psd1',
  '.vbs',
  '.vbe',
  '.js',
  '.jse',
  '.wsf',
  '.wsh',
  '.ws',
  '.msi',
  '.msp',
  '.msix',
  '.lnk',
  '.url',
  '.reg',
  '.hta',
  '.cpl',
  '.jar',
  '.pif',
  '.gadget',
  '.application',
  '.appref-ms',
  '.chm',
  '.msc',
  '.dll',
  '.scr',
  '.inf',
  '.job',
  '.shb',
  '.sys',
  '.ocx',
  '.grp',
  '.settingcontent-ms'
])

/** 该路径是不是「打开即执行」的类型（导出给套件与 resolver 共用同一份口径） */
export function isUnsafeOpenTarget(p: string): boolean {
  return UNSAFE_TARGET_EXT.has(path.extname(p).toLowerCase())
}

/** 含路径分隔符（用于区分「文件名」与「相对路径」） */
const HAS_SEP_RE = /[\\/]/

/** 按目标形态判断「不存在时该创建文件还是文件夹」：尾部分隔符 → 文件夹 */
function creationType(p: string): 'file' | 'directory' {
  return /[\\/]$/.test(p) ? 'directory' : 'file'
}

/** Lumin 自己能渲染编辑的文本类目标（可打开的文本清单在 shared/textFiles.ts；无扩展名如 README） */
function isLuminOpenable(p: string): boolean {
  return path.extname(p) === '' || TEXT_FILE_EXT_RE.test(p)
}

/** stat 探类型；不存在或不可访问 → null */
async function statType(p: string): Promise<'file' | 'directory' | null> {
  try {
    const st = await fs.stat(p)
    if (st.isDirectory()) return 'directory'
    if (st.isFile()) return 'file'
    return null
  } catch {
    return null
  }
}

function baseResult(target: string, kind: LinkTargetKind): LinkResolveResult {
  return {
    target,
    kind,
    path: null,
    exists: null,
    entryType: null,
    createType: null,
    action: 'external',
    blocked: null
  }
}

/**
 * 解析链接目标。baseDir 为当前文档所在目录（未保存文档由调用方给工作区根，仍无则 null）。
 * 相对链接没有 baseDir 时返回 blocked='missing-base'，由渲染层提示「请先保存文档」。
 */
export async function resolveLinkTarget(
  rawTarget: string,
  baseDir: string | null
): Promise<LinkResolveResult> {
  const target = (rawTarget ?? '').trim()
  if (!target) return { ...baseResult(target, 'url'), blocked: 'invalid' }

  // file:// URL → 本地路径（Markdown 里偶见），之后按路径规则处理
  let raw = target
  if (/^file:\/\//i.test(target)) {
    try {
      raw = fileURLToPath(target)
    } catch {
      return { ...baseResult(target, 'url'), blocked: 'invalid' }
    }
  }

  // 带协议 → 网址（盘符路径除外）
  if (!WIN_DRIVE_RE.test(raw)) {
    const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw)
    if (schemeMatch) {
      const scheme = `${schemeMatch[1].toLowerCase()}:`
      if (EXTERNAL_SCHEMES.has(scheme)) {
        return { ...baseResult(target, 'url'), action: 'external' }
      }
      return { ...baseResult(target, 'url'), blocked: 'unsupported-scheme' }
    }
  }

  // 路径类：绝对 / 相对 / 同级文件名
  const isAbs = path.isAbsolute(raw)
  const kind: LinkTargetKind = isAbs ? 'absolute' : HAS_SEP_RE.test(raw) ? 'relative' : 'file'
  const result = baseResult(target, kind)
  result.createType = creationType(raw)

  if (!isAbs && !baseDir) return { ...result, blocked: 'missing-base' }

  const abs = isAbs ? path.resolve(raw) : path.resolve(baseDir as string, raw)
  const entryType = await statType(abs)
  const openable = isLuminOpenable(abs)
  result.path = abs
  result.exists = entryType !== null
  result.entryType = entryType
  if (entryType !== null) result.createType = null
  /**
   * 可执行 / 脚本类：**一律不交给系统打开**（见 UNSAFE_TARGET_EXT 的说明）。
   * 判据只看扩展名，不看是否存在 —— 不存在的 .exe 也不允许"创建并打开"。
   */
  if (entryType !== 'directory' && isUnsafeOpenTarget(abs)) {
    result.action = 'external'
    result.createType = null
    return { ...result, blocked: 'unsafe-target' }
  }
  // 同级文件名交给 Lumin 新窗口（Lumin 只吃文本类；其余格式交系统默认应用更合适）；
  // 路径类一律交系统默认应用（文件夹由资源管理器/访达打开）
  result.action =
    kind === 'file' && entryType !== 'directory' && openable ? 'window' : 'default-app'
  // 不存在时：只有「文件夹」或「Lumin 能编辑的文本类」才允许新建——
  // 凭空造一个空的 .png/.pdf 之类没有意义，交给渲染层提示「该类型无法新建」
  if (entryType === null && result.createType === 'file' && !openable) result.createType = null
  return result
}

/**
 * 创建链接指向的文件或文件夹。
 * - 父目录缺失时一并创建（`[x](./sub/a.md)` 这种写法常见）；
 * - 文件用 'wx' 打开：已存在则失败，绝不覆盖用户已有内容；
 * - 路径必须来自 resolve 的结果（渲染层不会凭空构造）。
 */
export async function createLinkTarget(
  abs: string,
  type: 'file' | 'directory'
): Promise<{ ok: boolean; error?: string }> {
  if (!abs || !path.isAbsolute(abs)) return { ok: false, error: 'invalid-path' }
  // 纵深防御：即便渲染层绕过了 resolve 的判定，也不许在盘上凭空造出可执行文件
  if (type === 'file' && isUnsafeOpenTarget(abs)) return { ok: false, error: 'unsafe-target' }
  if (await statType(abs)) return { ok: false, error: 'exists' }
  try {
    if (type === 'directory') {
      await fs.mkdir(abs, { recursive: true })
      return { ok: true }
    }
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, '', { encoding: 'utf-8', flag: 'wx' })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'create-failed' }
  }
}

/**
 * 取 URL 的 scheme（小写、带冒号；解析不出来时返回 `'invalid'`）。
 *
 * 用途：被白名单拦下时打**一行 ASCII 日志**（`[links] refused openExternal scheme=javascript:`）——
 * 日志里只出现 scheme，不出现用户/文档给的完整 URL（那可能是任意文本，还可能非 ASCII，
 * 主进程 console 在 Windows 上会乱码，见 singleInstance.ts 的输出纪律）。
 */
export function schemeOf(url: string): string {
  try {
    return new URL((url ?? '').trim()).protocol.toLowerCase() || 'invalid'
  } catch {
    return 'invalid'
  }
}

/** 校验并整理交给 shell.openExternal 的网址；不支持则返回 null */
export function safeExternalUrl(url: string): string | null {
  const t = (url ?? '').trim()
  if (!t) return null
  try {
    const parsed = new URL(t)
    return EXTERNAL_SCHEMES.has(parsed.protocol) ? parsed.href : null
  } catch {
    return null
  }
}
