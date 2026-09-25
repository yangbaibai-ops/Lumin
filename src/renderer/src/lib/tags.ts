// ─── 标签：解析与匹配的**纯函数**（可单测）────────────────────────────────────
//
// 标签在 SQLite 里是 `documents.tags` 的 JSON 数组（`tags: string[]`），此前只有 DB 与 IPC
// 存在、**界面一处都没有**（审计 §7 第 19 条）。这里只放"怎么把用户输入变成标签数组"
// 与"某篇文档是否命中标签过滤"这两件纯逻辑，界面与 store 只管调用。

/** 单个标签的上限（长标签会把状态栏与列表挤坏） */
export const TAG_MAX_LEN = 24
/** 单篇文档的标签数上限 */
export const TAG_MAX_COUNT = 20

/**
 * 规范化一个标签：去首尾空白、去掉开头的 `#`（用户习惯打 `#工作`）、
 * 把内部空白折成一个空格、裁到上限。
 * 返回空串 = 这个标签无效（调用方丢弃）。
 */
export function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, TAG_MAX_LEN)
}

/**
 * 把用户输入解析成标签数组：
 *   * 分隔符支持逗号（中英文）、分号、顿号、换行（用户打什么都有）；
 *   * 每个标签走 `normalizeTag`；
 *   * **去重**按大小写不敏感（`Work` 与 `work` 是同一个标签，保留先出现的写法）；
 *   * 最多 `TAG_MAX_COUNT` 个。
 */
export function parseTagsInput(raw: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of String(raw ?? '').split(/[,，;；、\n\r]+/)) {
    const tag = normalizeTag(part)
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= TAG_MAX_COUNT) break
  }
  return out
}

/** 标签数组 → 输入框里的初始文本（与 `parseTagsInput` 往返一致） */
export function formatTagsInput(tags: string[]): string {
  return (tags ?? []).join(', ')
}

/**
 * 某篇文档是否命中过滤词：文件名 / 相对路径 / 预览 / **标签** 任一处包含即可
 * （大小写不敏感）。空过滤词 = 全命中。
 *
 * 抽成纯函数是为了让"按标签过滤"这件事有单测 —— 它是用户找文档的主要路径。
 */
export function docMatchesFilter(
  doc: { name: string; relPath: string; preview: string; tags?: string[] },
  filter: string
): boolean {
  const q = (filter ?? '').trim().toLowerCase()
  if (!q) return true
  if (doc.name.toLowerCase().includes(q)) return true
  if (doc.relPath.toLowerCase().includes(q)) return true
  if (doc.preview.toLowerCase().includes(q)) return true
  return (doc.tags ?? []).some((tag) => tag.toLowerCase().includes(q))
}
