// ─── 「一次打开请求该落到哪个窗口」的**纯决策**（从 main/index.ts 抽出，审计 §6 P2 拆分第三刀）──
//
// 为什么值得单独一个文件：这段落点规则是**第二实例**（任务栏跳转列表 / 双击文件 / 再点一次图标）
// 与 macOS `open-file` 的共同入口，也是「一个文件只开一个窗口」这条承诺的**唯一实现**。
// 它此前是一条 if 链写在 `main/index.ts` 的 644 行编排里，只能靠"真的双击两次文件"来验；
// 抽成纯函数之后，四条优先级（要新窗口 / 打开文件 / 打开目录 / 都没有）都能穷举。
//
// ⚠️ 这里不做任何 Electron 调用：调用方先去 `openDocs.findWindowWithDoc(file)` 问一句
// "有没有别的窗口已经开着它"，把结果当 `docAlreadyOpen` 传进来。
// 这样决策本身可以 `node --test` 直接跑（tests/openRequest.test.mjs）。

/** 打开请求（`shared/launchIntent.ts` 解出来的意图的子集：只关心落点相关的三个字段） */
export interface OpenIntent {
  /** 用户显式要求新窗口（任务栏「新建窗口」、`--lumin-open` 之外的新窗口路径） */
  newWindow?: boolean
  /** 要打开的文件（绝对路径） */
  openFile?: string | null
  /** 要作为工作区打开的目录（绝对路径） */
  openFolder?: string | null
}

/** 决策结果：调用方照着做，不再自己判断 */
export type OpenPlan =
  | {
      kind: 'new-window'
      openFile?: string
      openFolder?: string
      /** 是否开一个"不继承当前工作区"的干净窗口 */
      noWorkspace: boolean
    }
  | { kind: 'focus-doc' } // 已有窗口开着这个文件 → 聚焦它（绝不重复开窗）
  | { kind: 'focus-any' } // 没有目标 → 聚焦任一已有窗口

/**
 * 顺序即优先级（与既有实现逐字一致）：
 *  ① 要新窗口 → 开新窗口（同时带的文件/目录一并装进去，不丢参数）；
 *  ② 打开文件 → **已在别的窗口开着就聚焦过去**，否则新窗口打开它；
 *  ③ 打开目录 → 新窗口以它为工作区；
 *  ④ 都没有 → 聚焦已有窗口。
 *
 * `docAlreadyOpen` 只在第 ② 步被用到：调用方用 `openDocs.findWindowWithDoc` 的结果回答。
 */
export function planOpenRequest(
  intent: OpenIntent,
  opts: { docAlreadyOpen?: boolean } = {}
): OpenPlan {
  const file = intent.openFile ?? undefined
  const folder = intent.openFolder ?? undefined
  if (intent.newWindow) {
    return {
      kind: 'new-window',
      openFile: file,
      openFolder: folder,
      // 只有「纯新窗口」才是干净窗口；带了目标就按目标的落点规则走
      noWorkspace: !file && !folder
    }
  }
  if (file) {
    if (opts.docAlreadyOpen) return { kind: 'focus-doc' }
    return { kind: 'new-window', openFile: file, noWorkspace: false }
  }
  if (folder) return { kind: 'new-window', openFolder: folder, noWorkspace: false }
  return { kind: 'focus-any' }
}
