// ─── 主进程：草稿（自动保存 / 崩溃恢复）─────────────────────────────────────
// 说明：这里只负责**草稿文件的读写**；「一份草稿该不该给某个窗口」的判定是纯逻辑，
// 放在 shared/drafts.ts 的 decideUntitledDraft()（可单测，见 tests/drafts.test.mjs）。
import fs from 'fs/promises'
import path from 'path'
import { app } from 'electron'
import type { DraftInfo } from '../shared/types'
import { ORPHAN_UNTITLED_DRAFT_KEY, planUntitledDraft } from '../shared/drafts'

const draftsDir = path.join(app.getPath('userData'), 'drafts')

function keyToFile(key: string): string {
  return path.join(draftsDir, `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
}

export async function saveDraft(
  key: string,
  content: string,
  filePath: string | null,
  ownerUid?: string | null
): Promise<void> {
  await fs.mkdir(draftsDir, { recursive: true })
  const data: DraftInfo = {
    key,
    path: filePath,
    content,
    savedAt: Date.now(),
    ...(ownerUid ? { ownerUid } : {})
  }
  await fs.writeFile(keyToFile(key), JSON.stringify(data), 'utf-8')
}

export async function loadDraft(key: string): Promise<DraftInfo | null> {
  try {
    const raw = await fs.readFile(keyToFile(key), 'utf-8')
    return JSON.parse(raw) as DraftInfo
  } catch {
    return null
  }
}

export async function removeDraft(key: string): Promise<void> {
  await fs.rm(keyToFile(key), { force: true })
}

/** 目录里现存的草稿键（读不到目录 = 还没有草稿） */
async function listDraftKeys(): Promise<string[]> {
  try {
    const names = await fs.readdir(draftsDir)
    return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -'.json'.length))
  } catch {
    return []
  }
}

export interface TakeUntitledDraftOptions {
  /** 本窗口自己的草稿键（`untitled-<slot>`） */
  ownKey: string
  /** 本窗口实例的 uid（主进程生成，见 index.ts） */
  myUid: string | null
  /** 本进程里还活着的窗口 uid：写草稿的窗口还活着 → 那份草稿不叫「无主」 */
  liveUids: string[]
  /** 本进程里还活着的窗口槽位（旧草稿没有 uid，只能按槽位判断归属） */
  liveSlots: number[]
  /**
   * 本窗口是不是本次运行的**启动窗口**。只有它能认领「无主草稿」：
   * Ctrl+N / 新建窗口是用户明确要一篇空白，不该被上一次没保存的内容打断。
   */
  mayClaimOrphan: boolean
}

/** 把一份「不是我的」草稿挪到停放键（不覆盖它，也不让它继续占着别人的槽位号） */
async function parkDraft(data: DraftInfo, fromKey: string): Promise<void> {
  const existing = await loadDraft(ORPHAN_UNTITLED_DRAFT_KEY)
  if (!existing || (data.savedAt ?? 0) > (existing.savedAt ?? 0)) {
    await fs.mkdir(draftsDir, { recursive: true })
    await fs.writeFile(
      keyToFile(ORPHAN_UNTITLED_DRAFT_KEY),
      JSON.stringify({ ...data, key: ORPHAN_UNTITLED_DRAFT_KEY, path: null }),
      'utf-8'
    )
  }
  await removeDraft(fromKey)
}

/**
 * 取本窗口该用的那份未命名草稿。两种来源，界限明确：
 *
 *  1. **我自己那份**（`ownerUid === myUid`）→ 直接给（窗口 reload 后正文照旧）；
 *  2. **无主草稿**（写它的窗口已经不在这个进程里，或来自上一次运行）→ **只有启动窗口**认领。
 *
 * 为什么需要第 2 条：未命名缓冲区**不进会话**（见 §4.29），草稿是它唯一的保护；窗口被
 * 单独关闭或崩溃后，那份正文必须还有人捡得起来。但认领必须只发生在**启动窗口**：
 * 用户按 Ctrl+N 要的是一篇空白，冒出一条「检测到上次未保存的内容」是错的（实测踩过）。
 *
 * 搬家（而不是复制）保证一份草稿只会被认领一次；空内容草稿直接清掉：旧版无条件写盘留下的
 * 就是这种噪声。槽位号被复用、而那一格还留着别人的正文时，先挪到停放键，绝不覆盖。
 */
export async function takeUntitledDraft(opts: TakeUntitledDraftOptions): Promise<DraftInfo | null> {
  // 判定是纯函数（shared/drafts.ts 的 planUntitledDraft，有单测）；这里只负责照做 I/O。
  const onDisk = await Promise.all(
    (await listDraftKeys()).map(async (key) => ({ key, data: await loadDraft(key) }))
  )
  let result: DraftInfo | null = null
  for (const step of planUntitledDraft(opts, onDisk)) {
    switch (step.op) {
      case 'purge':
        await removeDraft(step.key)
        break
      case 'park':
        await parkDraft(step.draft, step.from)
        break
      case 'adopt': {
        const adopted: DraftInfo = {
          ...step.draft,
          key: opts.ownKey,
          path: null,
          ownerUid: opts.myUid ?? undefined
        }
        await fs.mkdir(draftsDir, { recursive: true })
        await fs.writeFile(keyToFile(opts.ownKey), JSON.stringify(adopted), 'utf-8')
        await removeDraft(step.from)
        result = adopted
        break
      }
      case 'show':
        result = step.draft
        break
    }
  }
  return result
}
