// ─── 「哪些文件算一篇文本文档」：**唯一真相源**（这一段是本项目的可打开类型清单）──
//
// 背景：这条清单以前散在 **五处**，各自抄一遍正则/数组：
//   ① `main/fileOps.ts` 扫描工作区（什么进文件树）
//   ② `main/services/links.ts` 链接目标算不算"本应用能打开"
//   ③ `main/services/workspaceIndex.ts` + `main|shared/workspaceReplace.ts` 全文索引与跨文件替换
//   ④ `main/ipc.ts` 「打开文件」对话框的 filters（硬编码数组）
//   ⑤ `renderer/components/TreeNode.vue`（重命名时保留哪段后缀）、`renderer/composables/useExport.ts`（导出标题去后缀）
// 抄出来的副本必然漂移：加一种类型要改六处，漏一处就变成"能拖进来打开、树里却看不见"
// 或者"对话框能选、拖进来提示不支持"。**新增可打开类型只改本文件的扩展名数组。**
// （历史上还有一处 `renderer/lib/droppedPath.ts` 的拖入白名单：拖拽整体禁用后该模块已删除，
//   不再可能成为第六份副本。）
//
// ⚠️ 只加**纯文本族**。判断标准是"这份内容在纯文本语义下不会被曲解"：
//   * 已经支持：`md` / `markdown` / `mdown` / `mkd`（Markdown 家族）与 `txt`；
//   * 本轮新增：`text`（与 txt 同一 MIME 家族 text/plain）、
//     `log`（Windows/macOS 都把 .log 归为 text/plain）、
//     `ini` / `cfg`（纯文本配置，同样在 text/plain 注册表类里；它们没有任何标记语言语义）；
//   * **故意不加**（写了理由，免得以后有人"顺手补全"）：
//     - `json/jsonc/yaml/yml/toml/csv/tsv` —— 结构化数据，不是散文；而且 `.json` 在本项目里
//       已经承担了"设置导入导出"的角色，混进文本文档白名单会让对话框/索引把配置当文章；
//     - `html/htm/xml/svg` —— 标记语言。编辑器的 Markdown 解析开了 `html: true`，会把裸 HTML
//       当块级原文；`svg` 更是本项目的**图片**类型（`shared/media.ts` 的 IMAGE_EXT_RE），
//       同一后缀两种含义必然出事；
//     - 源码文件（`js/ts/py/go/rs/...`）—— 整篇代码不是散文，本项目的代码语义在代码块里；
//     - `rst/adoc/org/tex` 等**别的标记语言** —— 按 Markdown 解析就是曲解，宁可不支持。
//
// ⚠️ 「纯文本族」（plain text family）= 除 Markdown 家族之外的那些。它们在渲染面会被
//   Markdown 语义重新解释（实测：`1. one\n1. two` 被重编号、裸 URL 变成 `<url>`、
//   `__init__` 被当成强调插进 `**`、两行散文被并成一行）—— 所以渲染层对它们**默认用源码模式
//   打开**（见 `stores/files.ts` 的 openPath）；`.md` 家族的行为一个字没动。
//
// 纯函数、不依赖 electron / node:path，主进程与渲染层共用（因此可被单测直接覆盖）。

/** Markdown 家族（渲染面按 Markdown 解释的那一批） */
export const MARKDOWN_EXTENSIONS = ['md', 'markdown', 'mdown', 'mkd'] as const

/** 纯文本族（除 Markdown 家族之外的可打开类型） */
export const PLAIN_TEXT_EXTENSIONS = ['txt', 'text', 'log', 'ini', 'cfg'] as const

/** 全部可打开的文本文档扩展名（小写、不含点）。**要加类型只改这里。** */
export const TEXT_FILE_EXTENSIONS = [...MARKDOWN_EXTENSIONS, ...PLAIN_TEXT_EXTENSIONS] as const

/** 正则由上面那份数组派生（不手写第二份清单） */
function extRe(exts: readonly string[]): RegExp {
  return new RegExp(`\\.(${exts.join('|')})$`, 'i')
}

/** 这个文件名是不是 Markdown 家族（决定"渲染面还是源码面"） */
export const MARKDOWN_EXT_RE = extRe(MARKDOWN_EXTENSIONS)

/** 这个文件名是不是一篇可打开的文本文档（树/索引/链接/拖入/对话框共用） */
export const TEXT_FILE_EXT_RE = extRe(TEXT_FILE_EXTENSIONS)

/** 取扩展名（小写、不含点）。没有扩展名或只有前导点（`.env`）→ 空串（与 node:path.extname 同口径） */
export function fileExtension(name: string | null | undefined): string {
  if (!name) return ''
  const base = name.replace(/^.*[\\/]/, '')
  const i = base.lastIndexOf('.')
  if (i <= 0) return ''
  return base.slice(i + 1).toLowerCase()
}

/** 这个扩展名（不含点）是不是可打开的文本类型 */
export function isTextExtension(ext: string): boolean {
  return (TEXT_FILE_EXTENSIONS as readonly string[]).includes(ext.toLowerCase())
}

/** 这个扩展名是不是纯文本族（非 Markdown 家族） */
export function isPlainTextExtension(ext: string): boolean {
  return (PLAIN_TEXT_EXTENSIONS as readonly string[]).includes(ext.toLowerCase())
}

/** 这个文件名是不是一篇可打开的文本文档 */
export function isTextFileName(name: string | null | undefined): boolean {
  return !!name && TEXT_FILE_EXT_RE.test(name)
}

/** 这个文件名是不是 Markdown 家族 */
export function isMarkdownName(name: string | null | undefined): boolean {
  return !!name && MARKDOWN_EXT_RE.test(name)
}

/** 这个文件名是不是纯文本族（非 Markdown）—— 渲染层据此决定要不要走源码模式 */
export function isPlainTextName(name: string | null | undefined): boolean {
  return isPlainTextExtension(fileExtension(name))
}

/**
 * 去掉可打开文本类型的扩展名（`.md`/`.txt`/`.log`…）；不是已知文本类型就原样返回。
 * 用在：重命名时只选中文件名主干、导出标题去后缀。
 */
export function stripTextExtension(name: string): string {
  const ext = fileExtension(name)
  if (!ext || !isTextExtension(ext)) return name
  return name.slice(0, name.length - ext.length - 1)
}

/**
 * 「另存为」的默认文件名与扩展名：**保留原扩展名**（`a.txt` → 仍是 `a.txt`，绝不悄悄变成
 * `a.txt.md`；`b.log` → `b.log`）。没有已知文本后缀时按 `.md` 补（未命名缓冲区 `Untitled-1.md`
 * 本来就有后缀，走的是保留分支；这条兜底只服务"名字里确实没有后缀"的极端情况）。
 */
export function saveDefaultName(name: string): { name: string; ext: string } {
  const ext = fileExtension(name)
  if (ext && isTextExtension(ext)) return { name, ext }
  return { name: `${name}.md`, ext: 'md' }
}

/**
 * 「打开文件」对话框的过滤器（派生自同一份清单；`label` 是本语言里的"文本文档"文案）。
 * 调用方再补一条"所有文件"即可 —— 于是"对话框里能选"与"扫描/树/拖入认"永远同一套。
 */
export function openFileDialogFilters(label: string): { name: string; extensions: string[] }[] {
  return [{ name: label, extensions: [...TEXT_FILE_EXTENSIONS] }]
}
