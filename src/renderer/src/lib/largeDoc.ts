// ─── 大文档降级闸（本轮新增）──────────────────────────────────────────────────
//
// 实测（同一实例逐个打开，见桌面《待优化清单》F 项与性能实测）：
//   * **纯散文**很健康：572,262 字符 → 打开 2.24s、每键中位 2.9ms（60fps 预算是 16.7ms）；
//     按斜率外推 1M 字符约 4–5s 打开 / 5ms 每键，仍可用。
//   * **代码围栏**是悬崖：36,005 字符 / 500 块 → 打开 **22.8 秒**；108,005 字符 / 1500 块 →
//     打开 **超过 185 秒**（放弃）、进程常驻从 399MB 涨到 **1,384MB**。
// 根因是结构性的：每个代码块一个独立的 CodeMirror `EditorView`（挂载 + StyleModule + 语法加载），
// 成本随块数线性、常数极大 —— 这也正是与主流编辑器差距的那"一个点"。
//
// 在把代码块改成「按需挂载 / 视口内才挂」之前（清单 F 项），这里先立一道**闸**：
// 打开时按「围栏块数」与「字符数」判定，超阈值就直接进**源码模式**（不建任何 CM NodeView），
// 并明确告诉用户为什么。这样"打开一篇文档把内存吃到 1.4GB"不会再发生。
//
// ⚠️ **阈值已按 F 项 P3 从 200 抬到 800**（施工图 §6 的取舍，用户已拍板）。理由：
// 虚拟化之后「每块一个 CM」这个悬崖没了 —— 实测（`_probe-cb-scale.js`，每尺寸一个全新隔离实例）
// 500 围栏的文档**渲染面可用 1157ms**（CM 实例峰值 10 个，虚拟化前是 500 个）、
// 1500 围栏 3013ms。所以 200 这道闸拦下来的文档，现在能正常进实时渲染了。
// 为什么停在 800 而不是更高：1500 围栏时打开后常驻内存仍是 **1030MB**（验收线 <600MB），
// 自动把它开进实时渲染等于默认吃掉 1GB；800 以下的文档按斜率仍在 2s 量级内。
//
// ═══ 波次 2（2026-10）复测后的**重新标定**（`tools/_probe-bigprose.js`）═══════════
// 上一版把「散文」这一侧的阈值定在 **1M 字符**，依据是旧审计里那句"572,262 字符 → 打开 2.24s"。
// 复测发现那句话量的是**打开**（`openPath` 返回，读盘 + 解析），而用户真正能用的时刻是
// **DOM 稳定**（`open` + `render`）。新增的散文探针（真文件、每档一个全新隔离实例）实测：
//
//   | 文档 | open | render | 可用合计 | RSS |
//   | --- | --- | --- | --- | --- |
//   | 977 KB（373,185 字符，中文散文） | 1.97 s | 4.37 s | **6.34 s** | 505→**1272 MB** |
//   | 1.1 MB（420,312 字符） | 2.40 s | 5.42 s | **8.59 s** | 503→**1247 MB** |
//
// 也就是说：**这两档都从 1M 这道闸下面漏了过去**（373k / 420k 字符 ≪ 1M），代价是
// 6–9 秒不可用 + 1.2 GB 常驻 —— 正是报告里"打开一篇长文吃掉 1.4GB"那条。
// CPU 采样（同一探针 `LUMIN_PROBE_PROFILE=1`）显示这 4.4 秒里：markdown-it `ParserBlock.tokenize`
// 717ms、prosemirror-markdown `atBlank` 1168ms、PM 内部 `nodesBetween`/`nodeSize`/`isLeaf` 约 490ms、
// GC 411ms、我们自己的滚动恢复 `applyScrollRatio` 356ms，其余零散 —— **解析与 PM 建 DOM 是第三方常数**，
// 不是我们能在一次改动里消掉的。所以按同一套办法（进源码模式 + 明确告知）把阈值标定到
// **实测的 5 秒线**：总耗时 ≈ 17 µs/字符（open 5.3 + render 11.7）⇒ 5 s ≈ 290k 字符。
export const HEAVY_FENCES = 800
/** 字符数阈值：按实测「open + render ≤ 5s」推得（≈17µs/字符 ⇒ 约 290k），取整 300k */
export const HEAVY_CHARS = 300_000

export interface DocLoad {
  /** 字符数（含所有空白） */
  chars: number
  /** 代码围栏块数（``` 或 ~~~ 成对计数；未闭合的也算一块） */
  fences: number
}

/** 量一下这份文档的"负载" */
export function docLoad(content: string): DocLoad {
  const chars = content.length
  const opens = (content.match(/^\s{0,3}(`{3,}|~{3,})/gm) || []).length
  // 成对计数：奇数个围栏说明最后一个没闭合，仍按一块算（它同样会建一个 CM）
  const fences = Math.ceil(opens / 2)
  return { chars, fences }
}

/**
 * 该降级的**原因**（纯函数，供提示文案区分开）：
 *   * `'fences'` —— 代码块太多（每块一个 CM 的历史悬崖，虚拟化后仍要防内存）；
 *   * `'chars'`  —— 文档太长（解析 + PM 建 DOM 的常数摆在那儿，实测 17µs/字符）。
 * 两者都不成立时返回 `null`。
 */
export function heavyReason(content: string): 'fences' | 'chars' | null {
  const { chars, fences } = docLoad(content)
  if (fences >= HEAVY_FENCES) return 'fences'
  if (chars >= HEAVY_CHARS) return 'chars'
  return null
}

/** 是否该走降级（源码模式）—— 两条阈值任一超过 */
export function isHeavyDoc(content: string): boolean {
  return heavyReason(content) !== null
}
