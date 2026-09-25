/**
 * ─── 草稿键约定（主进程 / 渲染层共用同一份真相）──────────────────────────────
 *
 * 有路径的文档，草稿键由路径唯一决定；**未命名缓冲区没有路径**，它的草稿只能靠
 * 「窗口身份」区分。历史实现里全应用共用 `untitled` 一个键，于是：
 *
 *   - 关窗时无条件写草稿（哪怕缓冲区是空的、干净的）→ 盘上留下一条空草稿；
 *   - 新窗口的空白缓冲区去读这个键 → 把别人的（或上一次运行留下的）草稿当成自己的，
 *     弹出一条「检测到未保存的草稿」横幅。
 *
 * 现在的两级身份：
 *  1. **键**：`untitled-<会话槽位>` —— 每个窗口一个命名空间；
 *  2. **DraftInfo.ownerUid**：写这份草稿的**窗口实例**（主进程生成，见 index.ts 的
 *     `--lumin-window-uid`）。槽位号会被复用（某个关掉的窗口腾出索引后，后来的窗口可能
 *     拿到同一个号），光看键分不清「我自己上次写的那份」和「上一个住户留下的」；
 *     `ownerUid` 才答得准 —— 同一个窗口 reload 前后 uid 不变，所以自己那份仍认得出。
 *
 * 一份草稿只可能被两种窗口拿到：
 *  - **就是我写的**（uid 相同）→ 本窗口重新装载时弹横幅（reload 不丢内容）；
 *  - **无主的**（写它的窗口已经不在这个进程里 / 上一次运行留下的）→ 只有本次运行的
 *    **启动窗口**会认领（见 main/drafts.ts）。Ctrl+N / 新建窗口是用户明确要一篇空白，
 *    不该被上一次没保存的内容打断 —— 这正是「按 Ctrl+N 却冒出一条未保存内容」的来源。
 */

/** 历史版本里未命名草稿共用的键：升级后仍要能被认领一次，故保留为兼容键（不再写入） */
export const LEGACY_UNTITLED_DRAFT_KEY = 'untitled'

/** 未命名草稿的键前缀：`untitled-<slot>` */
export const UNTITLED_DRAFT_PREFIX = 'untitled-'

/**
 * 「无主草稿」的停放键。槽位号被复用、而那一格还留着**别人**的正文时，不能直接覆盖它
 * （那是用户没保存过的东西），先挪到这里；只有启动窗口会把它认领走。
 *
 * **停放键可以有多个**（`untitled-orphan`、`untitled-orphan-2`、…）：
 * 只保留一个键意味着"后停放的覆盖先停放的"，而每一份停放的都是某个窗口里没保存过的正文 ——
 * 那等于用一次覆盖永久丢掉用户的内容。见 main/drafts.ts 的 parkDraft。
 */
export const ORPHAN_UNTITLED_DRAFT_KEY = 'untitled-orphan'

/** 停放键前缀（带序号的形式是 `<prefix>-<n>`，n ≥ 2） */
export const ORPHAN_UNTITLED_DRAFT_PREFIX = 'untitled-orphan'

/** 该键是不是停放键（含带序号的） */
export function isOrphanDraftKey(key: string): boolean {
  return key === ORPHAN_UNTITLED_DRAFT_KEY || /^untitled-orphan-\d+$/.test(key)
}

/** 第 n 个停放键（n ≤ 1 → 主停放键） */
export function nextOrphanDraftKey(n: number): string {
  return n <= 1 ? ORPHAN_UNTITLED_DRAFT_KEY : `${ORPHAN_UNTITLED_DRAFT_PREFIX}-${n}`
}

/** 某个会话槽位（窗口）的未命名草稿键；宿主没有槽位概念时退到 0 号命名空间 */
export function untitledDraftKey(slot: number | null): string {
  const n = typeof slot === 'number' && Number.isInteger(slot) && slot >= 0 ? slot : 0
  return `${UNTITLED_DRAFT_PREFIX}${n}`
}

/** 该键是否为未命名草稿键（含停放键与历史键） */
export function isUntitledDraftKey(key: string): boolean {
  return (
    key === LEGACY_UNTITLED_DRAFT_KEY || isOrphanDraftKey(key) || untitledDraftSlot(key) !== null
  )
}

/** 未命名草稿键 → 会话槽位；停放键 / 历史键（或不认识的形式）→ null */
export function untitledDraftSlot(key: string): number | null {
  const m = /^untitled-(\d+)$/.exec(key)
  return m ? Number(m[1]) : null
}

// ─── 「这份草稿该不该给某个窗口」的判定（纯函数，可单测）──────────────────────
// 把判定从 I/O 里抽出来的理由：这块语义连续出过三次真 bug（见 manual §4.44/§4.45/§4.49），
// 而它原先埋在 main/drafts.ts 的文件读写里，只能靠 40 秒级的端到端套件验证。
// 现在：主进程只负责「列出盘上的草稿 → 问这个函数 → 照做」，逻辑本身毫秒级可测。

import type { DraftInfo } from './types'

/** 盘上的一份未命名草稿：键 + 解析结果（坏文件为 null） */
export interface UntitledDraftOnDisk {
  key: string
  data: DraftInfo | null
}

/** 判定需要的上下文（全部来自主进程的窗口注册表） */
export interface UntitledDraftContext {
  /** 本窗口自己的草稿键（`untitled-<slot>`） */
  ownKey: string
  /** 本窗口实例的 uid */
  myUid: string | null
  /** 还活着的窗口 uid：写草稿的窗口还活着 → 那份草稿不叫「无主」 */
  liveUids: readonly string[]
  /** 还活着的窗口槽位（旧草稿没有 uid，只能按槽位判断归属） */
  liveSlots: readonly number[]
  /**
   * 本次运行**已经分配出去**的槽位（含启动时按恢复计划预留的）。
   * 用它把"属于本次某个窗口的草稿"挡住，不让启动窗口抢走 ——
   * 窗口是错峰创建的，只看 liveSlots 会误判"还没建出来的那个窗口"的草稿为无主。
   */
  plannedSlots?: readonly number[]
  /**
   * 我这一格是不是**本次启动恢复出来的**。
   *
   * 同一个槽位号在两种情况下会留着一份"写它的窗口已经不在了"的草稿：
   *   * 恢复出来的老窗口 → 那是**我上次没保存的正文**，该还给用户（show）；
   *   * 用户新开的窗口（Ctrl+N / 新建窗口，槽位号被复用）→ 那是**上一个住户的**正文，
   *     绝不能弹给一个明确要空白的人（§4.49 的老 bug），该挪到停放键（park）。
   * uid 分不出这两种情况（两边都不是 liveUid），只能靠"槽位来源"这个信号。
   */
  mySlotRestored?: boolean
  /** 本窗口是不是本次运行的启动窗口（只有它能认领无主草稿） */
  mayClaimOrphan: boolean
}

/** 要执行的一步。`show` / `adopt` 至多出现一个：那是最终交给窗口的那份。 */
export type UntitledDraftStep =
  /** 就是我自己写的（uid 相同）→ 直接展示 */
  | { op: 'show'; draft: DraftInfo }
  /** 无主草稿 → 展示，并**搬**到自己的键下（搬家保证只被认领一次） */
  | { op: 'adopt'; from: string; draft: DraftInfo }
  /** 别人留在我这一格的正文 → 挪到停放键，绝不覆盖 */
  | { op: 'park'; from: string; draft: DraftInfo }
  /** 空草稿 / 坏数据 → 删掉（旧版无条件写盘留下的噪声） */
  | { op: 'purge'; key: string }

export function planUntitledDraft(
  ctx: UntitledDraftContext,
  onDisk: readonly UntitledDraftOnDisk[]
): UntitledDraftStep[] {
  const steps: UntitledDraftStep[] = []
  const liveUids = new Set(ctx.liveUids)
  const liveSlots = new Set(ctx.liveSlots)
  const plannedSlots = new Set(ctx.plannedSlots ?? [])
  const withContent = (d: DraftInfo | null): d is DraftInfo => !!d && d.content.trim() !== ''
  /** 写它的那个窗口实例还在这个进程里吗 */
  const ownerAlive = (data: DraftInfo): boolean => !!data.ownerUid && liveUids.has(data.ownerUid)

  /**
   * 无主 = 写它的窗口已经不在这个进程里 / 来自上一次运行。
   *
   * 「本次要恢复的槽位」一律不算无主：那些窗口只是**还没建出来**（错峰创建），
   * 抢在它们前面把草稿认领走，会让用户拿到别的窗口里没保存的正文
   * （实测症状：重启后第一个窗口弹出的是第二个窗口那次没存的内容）。
   */
  const ownerless = (key: string, data: DraftInfo): boolean => {
    if (key === ctx.ownKey) return false
    // 停放键里的草稿天然是"无主"的：它已经被搬出了任何槽位（parkDraft 也会清掉 ownerUid）
    if (isOrphanDraftKey(key) || key === LEGACY_UNTITLED_DRAFT_KEY) return true
    const slot = untitledDraftSlot(key)
    if (slot !== null && plannedSlots.has(slot)) return false
    if (data.ownerUid) return !liveUids.has(data.ownerUid)
    // 旧数据没有 uid：按「槽位还占着吗」判断
    return slot === null || !liveSlots.has(slot)
  }

  // ① 自己这一格
  const own = onDisk.find((x) => x.key === ctx.ownKey) ?? null
  if (own) {
    if (ctx.myUid && own.data?.ownerUid === ctx.myUid) {
      if (withContent(own.data)) {
        steps.push({ op: 'show', draft: own.data })
        return steps // 自己的那份优先，且不必再看别人的
      }
      steps.push({ op: 'purge', key: own.key }) // 空草稿没有任何恢复价值
    } else if (withContent(own.data) && !ownerAlive(own.data) && ctx.mySlotRestored) {
      /**
       * 上一次运行留下的、**就是我这一格**的正文，而且我这一格是**恢复出来的** → 就是我该恢复的东西。
       *
       * 这里原先是 `park`（"不是我写的就挪走"），而重启后 uid 必然全变，
       * 于是每个恢复出来的窗口都把自己的草稿挪去停放键、再让启动窗口去认领 —— 结果是
       * 「谁的正文活下来」取决于停放顺序，后面的窗口还会覆盖前面的（数据丢失）。
       * 槽位号在会话恢复里是**稳定的**（同一个窗口恢复回同一个槽位），
       * 所以"槽位相同 + 写它的窗口已不在 + 这一格是恢复来的"就是"这是我上次没保存的内容"。
       *
       * 反例（必须拦住）：用户按 Ctrl+N 新开的窗口，槽位号可能是被复用的旧号 ——
       * 那时这一格里的正文是**上一个住户**的，弹出来就是 §4.49 那个老 bug。
       */
      steps.push({ op: 'show', draft: own.data })
    } else if (withContent(own.data)) {
      // 写它的窗口**还活着**（槽位被复用给了另一个活窗口）→ 只能挪走，绝不覆盖
      steps.push({ op: 'park', from: own.key, draft: own.data })
    } else {
      steps.push({ op: 'purge', key: own.key })
    }
  }

  // ② 无主草稿：只有启动窗口认领（Ctrl+N / 新建窗口是明确要空白，不该被打断）
  if (!ctx.mayClaimOrphan) return steps
  let best: { key: string; data: DraftInfo } | null = null
  for (const item of onDisk) {
    if (item.key === ctx.ownKey || !isUntitledDraftKey(item.key)) continue
    if (!withContent(item.data)) {
      steps.push({ op: 'purge', key: item.key })
      continue
    }
    if (!ownerless(item.key, item.data)) continue
    if (!best || (item.data.savedAt ?? 0) > (best.data.savedAt ?? 0)) {
      best = { key: item.key, data: item.data }
    }
  }
  if (best) steps.push({ op: 'adopt', from: best.key, draft: best.data })
  return steps
}
