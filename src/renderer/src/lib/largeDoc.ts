// ─── 大文档降级闸（本轮新增）──────────────────────────────────────────────────
//
// 实测（同一实例逐个打开，见桌面《待优化清单》F 项与性能实测）：
//   * **纯散文**很健康：572,262 字符 → 打开 2.24s、每键中位 2.9ms（60fps 预算是 16.7ms）；
//     按斜率外推 1M 字符约 4–5s 打开 / 5ms 每键，仍可用。
//   * **代码围栏**是悬崖：36,005 字符 / 500 块 → 打开 **22.8 秒**；108,005 字符 / 1500 块 →
//     打开 **超过 185 秒**（放弃）、进程常驻从 399MB 涨到 **1,384MB**。
// 根因是结构性的：每个代码块一个独立的 CodeMirror `EditorView`（挂载 + StyleModule + 语法加载），
// 成本随块数线性、常数极大 —— 这也正是与 Typora 差距的那"一个点"。
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
// 本模块是纯函数（不引 Vue / 不引 electron），有单测：`tests/largeDoc.test.mjs`。
/** 围栏块数阈值：虚拟化后 500 块实测 1.2s，抬到 800 仍留足余量 */
export const HEAVY_FENCES = 800
/** 字符数阈值：散文 600k 仍是秒级，1M 才开始进入"值得提醒"的区间 */
export const HEAVY_CHARS = 1_000_000

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

/** 是否该走降级（源码模式）—— 两条阈值任一超过 */
export function isHeavyDoc(content: string): boolean {
  const { chars, fences } = docLoad(content)
  return fences >= HEAVY_FENCES || chars >= HEAVY_CHARS
}
