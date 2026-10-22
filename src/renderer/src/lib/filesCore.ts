/**
 * ─── `stores/files.ts` 的纯判据核心（纯函数，可单测）────────────────────────────
 *
 * **职责**：把「当前文档」这台状态机里**只靠入参就能算出来**的那几段判定收在这里 ——
 *   ① 保存成功后的收尾（快照语义：保存期间又输入了，就绝不许标成"已保存"）；
 *   ② 草稿写入时机（尾沿防抖 1.2s + 最大等待 10s）；
 *   ③ 同一路径重开的分支（脏确认 / 短路 / 正常读盘）；
 *   ④ 目录改名/搬家时「当前文档路径怎么搬」的路径算术；
 *   ⑤ 写盘失败的退避延时。
 *
 * **为什么是纯的**（这三条决定了它能不能被 `node --test` 毫秒级钉住）：
 *   1. 不 import Vue / Pinia / `window.luminAPI`，也不 import store —— 只引**纯字符串**
 *      的 `shared/paths`（无扩展名的相对 import 这里显式写成 `.ts`，Node 的 ESM 解析器
 *      才认得，这也是 `tests/closeGuard.test.mjs` 那类测试能直接跑的原因）；
 *   2. 时间与 IO 一律**注入**：`now`（当前时刻）、`lastDraftAt`（上次写草稿的时刻）、
 *      `diskMtimeMs`（磁盘 mtime 探测结果）都由调用方传进来 —— 判据里不出现 `Date.now()`、
 *      不出现 `await`；
 *   3. 不读也不写 store 的字段：入参是值的形状（见 `DocSnapshot`），返回的是**决定的形状**
 *      （`SaveOutcome` / `DraftAction` / `SamePathOpen` / `RenameFixup`），副作用（清草稿、
 *      排定时器、弹确认框）仍旧留在 store 里执行。
 *
 * ⚠️ 这里的判定是从 store 里**逐字搬**出来的，语义必须保持一致：
 * `tests/filesCore.test.mjs` 的每条断言都对着"曾经出过的那个 bug 的形态"写，
 * 改这里之前先看一眼那几条测试名。
 *
 * ─── 没搬进来的部分（不要硬拆）────────────────────────────────────────────────
 *   * `save()` 的并发闸门（`savePromise` 串行化）：判据是"上一次的 Promise 还在不在"，
 *     本身就是异步编排，不是纯判定；
 *   * `saveNow` 里冲突→确认→强制覆盖的那一串：每一步都夹着 IPC 与模态框；
 *   * 编码 `reopenedWithEncoding` 的两处：决策都与 `i18n` / toast / confirm 耦合；
 *   * `flushEditorBeforeReplace`：直接依赖编辑器实例（DOM）。
 * 它们留在 store 里，是因为纯化只能靠把 IPC 也注入进来 —— 那样"纯函数"就成了一个
 * 假的壳，测不到真行为，反而把真实调用点藏得更深。
 */

import { isInside, samePath } from './pathUtils.ts'
import { sameDocumentText } from '../../../shared/documentText.ts'

// ─── 共有形状与常量 ───────────────────────────────────────────────────────────

/**
 * 「当前文档」里判据用得到的那几个字段。
 *
 * `content` / `savedContent` 只在这里参与**相等比较**，所以按最宽的类型收
 * （`unknown`），这样诊断用的小对象也能直接传进来；`path` / `mtimeMs` 是路径工具的入参，
 * 必须保持精确类型（`CurrentDoc` 结构上就满足它）。
 */
export interface DocSnapshot {
  path: string | null
  content: unknown
  savedContent: unknown
  mtimeMs: number | null
}

/**
 * 脏判定需要的三个文本口径（都是 `string`，纯比较）。
 *
 * `canonicalContent` = **编辑器把磁盘原文解析后重新序列化**得到的规范 Markdown
 * （见 store 的 `noteCanonicalContent`）。它只在“用户还没改过”时记录一次。
 */
export interface DirtyDocSnapshot {
  content: string
  savedContent: string
  canonicalContent?: string | null
}

/**
 * 「这份文档有没有用户改动」的**唯一判定**。
 *
 * 两个基线，任何一个相等都算干净：
 *  1. `savedContent`（磁盘上/上次保存的那一份）；
 *  2. `canonicalContent`（打开时编辑器归一化后的规范形态）。
 *
 * 为什么需要第二个基线（本轮用户报障的后半段）：setext 标题、`~~~` 围栏、缩进代码、
 * `__粗体__`、表格对齐这类语法的**序列化结果与磁盘字节不同**。打开时不写回 store
 * 只是让"没改过"保持干净；但用户一旦敲一个字再**撤销**，编辑器序列化出来的就是
 * 规范形态 —— 与磁盘原文仍不相等。没有规范基线的话，"改了又撤销"会留下脏标记与草稿，
 * 关窗提示、下次启动的假草稿横幅又回来了。
 *
 * 归一化比较（`sameDocumentText`）仍旧是口径：只差尾随换行/CRLF 不算修改。
 */
export function isDocumentDirty(doc: DirtyDocSnapshot | null | undefined): boolean {
  if (!doc) return false
  if (sameDocumentText(doc.content, doc.savedContent)) return false
  if (doc.canonicalContent && sameDocumentText(doc.content, doc.canonicalContent)) return false
  return true
}

/**
 * 草稿的**最大等待**（ms）：只有尾沿防抖的话，连续打字（间隔 < 1.2s）会把定时器无限推迟
 * —— 实测「每 200ms 改一次、持续 12s」期间一份草稿都没写，而用户最投入的连续写作
 * 恰恰是最不希望丢稿的时候。加上限后最坏 10s 必有一份。
 */
export const DRAFT_MAX_WAIT_MS = 10_000

/** 草稿的**尾沿防抖**（ms）：停止输入 1.2s 后写一份 */
export const DRAFT_DEBOUNCE_MS = 1200

// ─── ① 保存成功后的收尾（快照语义）─────────────────────────────────────────

/**
 * 保存成功之后该做什么：
 *   * `clear-draft` —— 缓冲区里就是刚写进磁盘的那一份（快照与当前内容相同）⇒ 草稿没有
 *     恢复价值，可以清掉；
 *   * `reschedule` —— 写盘是异步的，`await` 期间用户又输入了（`current.content !== snapshot`）
 *     ⇒ **保持脏**，重排一次保存与草稿。绝不能把新内容标成"已保存"：那会连草稿一起删掉，
 *     新内容永久丢失（这正是本轮修掉的那个缺陷）。
 */
export type SaveOutcome = 'clear-draft' | 'reschedule'

/**
 * 快照这一份账是不是「**恰恰**对应磁盘上的内容」。
 *
 * 为什么不是只比 `content === snapshot`（快照语义的第二半）：保存期间可能**撤回**到与
 * 快照相同的文本，此时 `content === snapshot` 但 `savedContent` 还是旧值 —— 这是干净的，
 * 可以清草稿。少比这一项，"撤销回原样"就会被当成脏而反复重排保存（每 1.2s 一次）。
 *
 * @param current 保存收尾时**仍是**当前文档的那一份（调用方已按引用比过 `this.current === doc`）
 * @param snapshot 发起这次写盘时抓下的内容
 */
export function snapshotIsSaved(current: DocSnapshot, snapshot: unknown): boolean {
  return current.content === snapshot && current.savedContent === snapshot
}

/**
 * 保存成功后收尾的决定：该清草稿，还是该重排下一轮（见 `SaveOutcome`）。
 *
 * ⚠️ 前提是「它仍然是当前文档」（`currentIsStillDoc`）。保存期间用户**换了文档**时，
 * 两个分支的实际动作都不做：旧文档的保存结果不该去改写新文档的草稿。这种组合必须落在
 * `clear-draft` 上而不是 `reschedule` —— `reschedule` 会重排保存，而那时 `current`
 * 已经是另一份文档了（把别人的文档拖进一次无谓的写盘）。
 */
export function planSaveOutcome(currentIsStillDoc: boolean, snapshotIsDisk: boolean): SaveOutcome {
  return currentIsStillDoc && !snapshotIsDisk ? 'reschedule' : 'clear-draft'
}

// ─── ② 草稿写入时机 ─────────────────────────────────────────────────────────

/** 这一次「排草稿」的决定：立即写 / 起一个尾沿防抖定时器 / 清掉旧草稿 / 不排 */
export type DraftAction = 'write-now' | 'debounce' | 'clear' | 'skip'

/**
 * 脏文档现在就该立刻写草稿吗（最大等待已到）。
 *
 * 边界取 `>=`（**恰好等于** 10_000 也算到点）—— 与原先 store 里的 `>=` 逐字一致：
 * 「距上一份草稿满 10s」时用户已经连续输入 10 秒没有任何副本了。
 */
export function shouldWriteDraftNow(input: {
  dirty: boolean
  lastDraftAt: number
  now: number
}): boolean {
  return input.dirty && input.now - input.lastDraftAt >= DRAFT_MAX_WAIT_MS
}

/**
 * 排草稿的完整决定：
 *   * 脏 + 距上次写草稿 ≥ 10s ⇒ `write-now`（**不是**再等 1.2s：连续输入期间尾沿永远等不到）；
 *   * 脏 + 其余 ⇒ `debounce`，1.2s 后由 store 起定时器写；
 *   * **干净 + 本会话写过草稿 ⇒ `clear`**：撤销回基线是最常见的路径，盘上那份草稿
 *     此刻与磁盘一致、没有任何恢复价值；不主动清的话，崩溃/被结束后下次打开就会被
 *     当成「未保存的草稿」（用户报障的另一半）。`lastDraftAt === 0` 说明本会话根本没写过，
 *     没什么可清 ⇒ `skip`（避免每次干净输入都发一次无意义的删除 IPC）。
 *
 * 写盘那一步（`writeDraft`）仍然是最终闸门：它自己会用 `isDocumentDirty` 再判一次，
 * 干净时只删不写。
 */
export function planDraftWrite(input: {
  dirty: boolean
  lastDraftAt: number
  now: number
}): DraftAction {
  if (!input.dirty) return input.lastDraftAt > 0 ? 'clear' : 'skip'
  return shouldWriteDraftNow(input) ? 'write-now' : 'debounce'
}

// ─── ③ 同一路径再次打开 ─────────────────────────────────────────────────────

/**
 * 「同一路径再次打开」这一段的决定（审计 §3 P1：同一路径重开会静默回滚）：
 *   * `proceed` —— 照常往下重新读盘。**同路径不一定短路**：磁盘被外部改过（mtime 变了）、
 *     或生效的默认编码变了（设置里换成别的编码）时，重开才是"载入最新内容"，
 *     后者还是"改了默认编码想对当前文件生效"的唯一路径；
 *   * `ask` —— 同路径 + 脏 + 调用方没有显式说"这次就是要放弃改动" ⇒ 先问一次。
 *     **不能因为同路径就放行**：那正是"我刚写的自己没了"的入口。调用方拿到确认之后
 *     必须**再判一次**（`askedPathStillCurrent`），因为问的期间文档可能已被换掉；
 *   * `short-circuit` —— 同路径 + 干净 + 重开确实什么都不会变 ⇒ 直接当成功返回，
 *     连读盘都不做。唯一前提见 `contentWouldChangeOnReopen`。
 */
export type SamePathOpen = 'proceed' | 'ask' | 'short-circuit'

/**
 * 同路径重开的**前置**判定（同步的那一半，问之前的那一次）。
 *
 * 注意 `discardChanges` 的作用：调用入口明确说"这次重开就是要放弃缓冲区里的修改"时，
 * 连问都不问（只有**用户刚刚点过**的入口才该传：外部改动冲突通知里的「重新打开（放弃我的改动）」）。
 *
 * 只返回 `'ask'` 或 `'proceed'`：`'short-circuit'` 需要磁盘 mtime / 生效编码（异步探测），
 * 由 `planReopenWhenClean` 在拿到结果之后再判 —— 两半合起来才是完整的三分支。
 */
export function decideSamePathReopen(input: {
  currentPath: string | null
  path: string
  dirty: boolean
  discardChanges: boolean
}): Exclude<SamePathOpen, 'short-circuit'> {
  if (!samePath(input.currentPath, input.path)) return 'proceed'
  if (input.dirty && !input.discardChanges) return 'ask'
  return 'proceed'
}

/**
 * 同路径 + 干净时的短路判定（异步探测回来之后的那一次）。
 *
 * ⚠️ 调用点的条件必须与 store 里逐字一致：只有当**缓冲区干净**（不是"刚问过所以放行"）
 * 且调用方没有强制放弃改动时，才允许短路 —— 脏文档就算用户刚确认过，也仍然要真读一次盘
 * （那正是他点「放弃我的改动」想要的结果）。
 */
export function planReopenWhenClean(input: {
  dirty: boolean
  discardChanges: boolean
  defaultEncoding: string
  currentEncoding: string
  currentMtimeMs: number | null
  diskMtimeMs: number | null
}): SamePathOpen {
  if (input.dirty || input.discardChanges) return 'proceed'
  return contentWouldChangeOnReopen(input) ? 'proceed' : 'short-circuit'
}

/**
 * 确认框回来之后，问的还是不是原来那一份文档。
 *
 * 浮层是模态的，但这条入口不止一处 ⇒ `await` 期间 `current` 可能被换掉，
 * 这时既不能继续按"用户同意了"往下读盘，也不能报成功：原样返回、内容一个字不动。
 */
export function askedPathStillCurrent(currentPath: string | null, path: string): boolean {
  return samePath(currentPath, path)
}

/**
 * 同路径 + 干净时，重开会**带来变化**吗。
 *
 * 两件事会带来变化，任一成立就必须放行去读盘：
 *   1. **生效的默认编码变了**（`defaultEncoding !== 'auto' && !== 当前文档编码`）
 *      —— 重开才会按新编码重新解释（实测：`_verify-encoding.js` 的
 *      `default-encoding-1252-applies` 靠这条才不是红的）；
 *   2. **磁盘被外部改过**（`|diskMtime - mtimeMs| > 1`，留 1ms 容差：文件系统时间戳
 *      与本地时钟本就不完全同源）。拿不到磁盘 mtime（`null`）时**不敢短路** ——
 *      宁可多读一次盘，也不能把用户看不到的外部改动当成"没变"。
 *
 * @param currentMtimeMs 当前文档记着的 mtime（`null` = 未落盘/读不到）
 * @param diskMtimeMs 刚探到的磁盘 mtime（`null` = 探测失败、文件已不在）
 */
export function contentWouldChangeOnReopen(input: {
  defaultEncoding: string
  currentEncoding: string
  currentMtimeMs: number | null
  diskMtimeMs: number | null
}): boolean {
  const encodingWillChange =
    input.defaultEncoding !== 'auto' && input.defaultEncoding !== input.currentEncoding
  const diskUnchanged =
    input.diskMtimeMs !== null &&
    input.currentMtimeMs !== null &&
    Math.abs(input.diskMtimeMs - input.currentMtimeMs) <= 1
  return encodingWillChange || !diskUnchanged
}

// ─── ④ 改名/搬家时当前文档的路径算术 ────────────────────────────────────────

/** 一次路径搬迁：换整条 `path`，并给出跟着变的文件名 */
export interface RenameFixup {
  path: string
  /** 该文档的新文件名（`path` 的最后一段）。只有"改的就是它"这一支会变，目录改名时为空串 */
  name: string
}

/**
 * 目录/文件改名（或搬家、撤销改名）之后，**当前文档**要不要跟着走、怎么走。
 *
 * 为什么必须判（实测那正是"保存后生成一份幽灵副本"的成因）：不搬的话，继续编辑会写回旧
 * 路径 —— 旧目录还在时就会在旧位置悄悄长出一份；旧目录没了就整段丢掉。
 *
 * 两条分支的顺序不能换，判据也不能用 `===`：
 *   1. **改的就是它**（`samePath(curPath, oldPath)`，大小写/分隔符不敏感）⇒ 路径换成
 *      `newPath`，文件名取新路径的最后一段（取不到时保持原文件名，与旧实现一致）；
 *   2. **改的是它所在的目录**（`isInside(oldPath, curPath)`，按目录边界比较，
 *      `D:\ws\sub` 不会把 `D:\ws\sub2\x.md` 算成内部）⇒ 按 `newPath` + **原后缀**拼
 *      （`curPath.slice(oldPath.length)` 保住了原路径自己的大小写/分隔符）。
 *      刻意不用 `replace(oldPath, newPath)`：那会把 `sub2` 也一起改掉。
 * * @param currentName 当前文档名。只有"改的就是它"时才会用到 —— 与旧实现一样，路径取不到
 *   最后一段时保持原名不变，所以这里作为兜底入参而不是从 curPath 硬猜。
 * @returns `null` 表示这次改名与当前文档无关（调用方什么都不做）
 */
export function renameCurrentDocFixup(
  oldPath: string,
  newPath: string,
  curPath: string | null,
  currentName: string
): RenameFixup | null {
  if (!curPath) return null
  if (samePath(curPath, oldPath)) {
    return { path: newPath, name: newPath.split(/[\\/]/).pop() ?? currentName }
  }
  if (isInside(oldPath, curPath)) {
    return { path: newPath + curPath.slice(oldPath.length), name: '' }
  }
  return null
}

/**
 * 键盘焦点行（roving tabindex 的单一真相）在路径搬迁之后该落在哪。
 *
 * 不搬的后果：旧路径那一行没了以后，整棵树没有一个 `tabindex=0` 的行 —— Tab 进来方向键
 * 全都没反应。判定与 `renameCurrentDocFixup` 的第二条同源（按目录边界 + 原后缀原样拼）。
 *
 * @returns `null` 表示焦点行不在被搬的子树里，保持不动
 */
export function focusPathAfterMove(
  fromPath: string,
  toPath: string,
  focused: string | null
): string | null {
  if (!focused || !isInside(fromPath, focused)) return null
  return toPath + focused.slice(fromPath.length)
}

// ─── ⑤ 写盘失败的退避 ───────────────────────────────────────────────────────

/** 写盘失败的首次退避延时（ms），之后每次 ×2 */
export const SAVE_RETRY_BASE_MS = 5000
/** 退避封顶（ms）：再久也不超过一分钟试一次 */
export const SAVE_RETRY_MAX_MS = 60_000

/**
 * 下一次重试的退避延时：`0 → 5000`，之后 `×2`，封顶 60s。
 *
 * 为什么要退避而不是立即重试：失败原因多半是磁盘满 / 只读 / 被占用，立刻重试只会把同一个
 * 错误打满 IPC；而完全不重试就更糟 —— 用户一停手就再也不会尝试落盘（只靠草稿兜）。
 *
 * 边界：`0`（没在退避）走首次值；`NaN` 这类坏值会落进 `Math.min(NaN, 60000) = NaN`，
 * 与旧实现一致（那是调度器早就被别处拦掉的情形，这里不额外发明行为）。
 */
export function nextSaveRetryDelay(prevDelay: number): number {
  return Math.min(prevDelay ? prevDelay * 2 : SAVE_RETRY_BASE_MS, SAVE_RETRY_MAX_MS)
}
