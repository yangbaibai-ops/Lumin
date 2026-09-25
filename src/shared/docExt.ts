// ─── 文档扩展名：**一处定义**（主进程扫描 / 链接判定 / 全文索引都用它）──────────
//
// 以前这个正则在 `main/fileOps.ts` 里，链接（`services/links.ts`）和索引
// （`services/workspaceIndex.ts`）各自从 fileOps 拿 —— 而 `fileOps` 引了 electron，
// 于是"哪些文件算 Markdown"这条最简单的规则没法被单测直接覆盖。
// 抽到 shared 之后：一份定义、可单测、主进程各处共用。

/** Markdown / 纯文本文档的扩展名（大小写不敏感） */
export const MD_EXT_RE = /\.(md|markdown|mdown|mkd|txt)$/i

/** 这个文件名是不是一篇「文档」（扫描、索引、链接目标判定共用同一口径） */
export function isMarkdownFile(name: string): boolean {
  return MD_EXT_RE.test(name)
}
