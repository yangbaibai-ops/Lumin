// ─── 查找 / 替换纯逻辑：**实现已搬到 `src/shared/findReplace.ts`** ─────────────
//
// 搬家的理由只有一个：跨文件（工作区级）替换要在**主进程**里对磁盘上的正文做同一套
// 判定（`shared/workspaceReplace.ts`），而主进程不能反向 import 渲染层。放在 shared 之后
// 「匹配/替换语义」仍然只有一份 —— 渲染层与主进程漂移不会被任何门禁发现，重复实现正是
// 审计点名的问题。
//
// 保留这个文件是为了**历史调用点**（stores/find.ts、lib/editor/findInDoc.ts）与既有单测
// （tests/findReplace.test.mjs）不用改；与 `lib/utils/html.ts` 再导出 `shared/html.ts` 同一做法。
// 显式写 `.ts` 扩展名：单测用 `node --test` 直接加载（Node 的 ESM 解析不做扩展名补全）。
export * from '../../../shared/findReplace.ts'
