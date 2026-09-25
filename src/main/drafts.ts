// ─── 主进程：草稿（自动保存 / 崩溃恢复）─────────────────────────────────────
// 说明：这里只负责**草稿文件的读写**；「一份草稿该不该给某个窗口」的判定是纯逻辑，
// 放在 shared/drafts.ts 的 planUntitledDraft()（可单测，见 tests/drafts.test.mjs）。
//
// ─── 文件名为什么是哈希而不是"折叠键名" ──────────────────────────────────────
// 旧实现把键里所有非 `[A-Za-z0-9_-]` 折叠成 `_` 当文件名，而键本身是
// `file-` + encodeURIComponent(路径)：`a b.md` 与 `a_20b.md` 会折叠成**同一个文件名**，
// 后写覆盖先写 —— 两份文档的草稿互相顶掉，丢的是用户没保存过的正文。
// 现在文件名 = sha1(键) 前 16 位（不会撞），键本身存在 JSON 的 `key` 字段里。
// 旧文件（键名即文件名）仍然能读：`listDrafts` 对没有 `key` 字段的文件回退用文件名当键。
import fs from 'fs/promises'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { app } from 'electron'
import type { DraftInfo } from '../shared/types'
import {
  DRAFT_GC_MAX_AGE_MS,
  isOrphanDraftKey,
  nextOrphanDraftKey,
  ORPHAN_UNTITLED_DRAFT_KEY,
  planDraftGc,
  planUntitledDraft,
  type DraftGcEntry
} from '../shared/drafts'

const draftsDir = path.join(app.getPath('userData'), 'drafts')

/**
 * 键 → 文件名：sha1 前 16 位。
 * 为什么不用"把非法字符换成 `_`"：那会把不同键映射到同一个文件（见文件头说明）。
 */
function keyToFile(key: string): string {
  return path.join(draftsDir, `${createHash('sha1').update(key).digest('hex').slice(0, 16)}.json`)
}

/** 历史文件名规则（折叠键名）。只用于**读**旧文件，不再用于写。 */
function legacyKeyToFile(key: string): string {
  return path.join(draftsDir, `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
}

/**
 * 原子写一份草稿：临时文件 + rename。
 * 草稿是崩溃恢复的**唯一**依据，写到一半断电会留下截断的 JSON —— `loadDraft` 解析失败
 * 就返回 null，那份草稿等于失效。所以这里也要原子写（与文件保存同一套道理）。
 */
async function writeDraftFile(key: string, data: DraftInfo): Promise<void> {
  await fs.mkdir(draftsDir, { recursive: true })
  const target = keyToFile(key)
  const tmp = `${target}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(data), 'utf-8')
    await fs.rename(tmp, target)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

export async function saveDraft(
  key: string,
  content: string,
  filePath: string | null,
  ownerUid?: string | null
): Promise<void> {
  const data: DraftInfo = {
    key,
    path: filePath,
    content,
    savedAt: Date.now(),
    ...(ownerUid ? { ownerUid } : {})
  }
  await writeDraftFile(key, data)
}

export async function loadDraft(key: string): Promise<DraftInfo | null> {
  for (const file of [keyToFile(key), legacyKeyToFile(key)]) {
    try {
      const raw = await fs.readFile(file, 'utf-8')
      return JSON.parse(raw) as DraftInfo
    } catch {
      /* 试下一个命名规则 */
    }
  }
  return null
}

export async function removeDraft(key: string): Promise<void> {
  await fs.rm(keyToFile(key), { force: true })
  await fs.rm(legacyKeyToFile(key), { force: true })
}

/**
 * 目录里现存的草稿：`{ key, data }`。
 * 键取自 JSON 的 `key` 字段（新版文件名是哈希，推不出键）；旧文件没有该字段时用文件名兜底。
 */
async function listDrafts(): Promise<{ key: string; data: DraftInfo | null }[]> {
  let names: string[]
  try {
    names = await fs.readdir(draftsDir)
  } catch {
    return []
  }
  const out: { key: string; data: DraftInfo | null }[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    let data: DraftInfo | null = null
    try {
      data = JSON.parse(await fs.readFile(path.join(draftsDir, name), 'utf-8')) as DraftInfo
    } catch {
      data = null
    }
    const key = data?.key ?? name.slice(0, -'.json'.length)
    out.push({ key, data })
  }
  return out
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
  /** 本次运行已经分配出去的槽位（含启动时按恢复计划预留的），见 session.claimedSlots */
  plannedSlots?: number[]
  /** 本窗口的槽位是不是**恢复出来的**（决定"这一格里的旧草稿算不算我的"，见 shared/drafts） */
  mySlotRestored?: boolean
  /**
   * 本窗口是不是本次运行的**启动窗口**。只有它能认领「无主草稿」：
   * Ctrl+N / 新建窗口是用户明确要一篇空白，不该被上一次没保存的内容打断。
   */
  mayClaimOrphan: boolean
}

/**
 * 把一份「不是我的」草稿挪到停放键。两条铁律：
 *  1. **不覆盖别人**：停放键可以有多个（`untitled-orphan`、`-2`、`-3`…），
 *     找不到空位就往后排，绝不因为"已经有一份了"就去覆盖它；
 *  2. **先写后删**：内容落到新键之后才删源键。旧实现在"停放键里那份更新"时
 *     直接删源（`removeDraft(fromKey)` 在 if 之外），那一步丢掉的就是一个窗口里
 *     没保存过的正文 —— 多窗口重启时每个窗口都会走一次，于是只剩最新的一份。
 */
async function parkDraft(data: DraftInfo, fromKey: string): Promise<void> {
  const onDisk = await listDrafts()
  const used = new Set(onDisk.map((d) => d.key))
  let n = 1
  while (used.has(nextOrphanDraftKey(n))) n += 1
  const target = nextOrphanDraftKey(n)
  if (n > 20) {
    // 只会越来越多是设计使然（每份都是一份没保存的正文），但值得留一行证据便于排查
    console.warn(
      `[drafts] orphan drafts growing: ${onDisk.filter((d) => isOrphanDraftKey(d.key)).length}`
    )
  }
  await writeDraftFile(target, { ...data, key: target, path: null, ownerUid: undefined })
  await removeDraft(fromKey)
}

/**
 * 取本窗口该用的那份未命名草稿。三种来源，界限明确：
 *
 *  1. **我自己那份**（`ownerUid === myUid`）→ 直接给（窗口 reload 后正文照旧）；
 *  2. **我这一格上一次运行留下的**（uid 已不在，但槽位号就是我的）→ 也是我的正文，直接给
 *     （判定见 shared/drafts.planUntitledDraft 的说明：这是修掉"多窗口草稿互相覆盖"的关键）；
 *  3. **无主草稿**（停放键里的，或槽位已不在本次恢复计划里）→ **只有启动窗口**认领。
 *
 * 为什么认领必须只发生在**启动窗口**：未命名缓冲区**不进会话**（见 §4.29），草稿是它唯一的
 * 保护；窗口被单独关闭或崩溃后，那份正文必须还有人捡得起来。但 Ctrl+N / 新建窗口是用户明确
 * 要一篇空白，冒出一条「检测到上次未保存的内容」是错的（实测踩过）。
 *
 * 搬家（而不是复制）保证一份草稿只会被认领一次；空内容草稿直接清掉：旧版无条件写盘留下的
 * 就是这种噪声。槽位号被复用、而那一格还留着**活窗口**的正文时，先挪到停放键，绝不覆盖。
 */
export async function takeUntitledDraft(opts: TakeUntitledDraftOptions): Promise<DraftInfo | null> {
  // 判定是纯函数（shared/drafts.ts 的 planUntitledDraft，有单测）；这里只负责照做 I/O。
  const onDisk = await listDrafts()
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
        await writeDraftFile(opts.ownKey, adopted)
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

/** 停放键（诊断/排查用；导出给需要"还有几份没被认领"的地方） */
export async function countParkedDrafts(): Promise<number> {
  const onDisk = await listDrafts()
  return onDisk.filter((d) => isOrphanDraftKey(d.key) && (d.data?.content.trim() ?? '') !== '')
    .length
}

export interface DraftGcResult {
  /** 扫到多少个条目 */
  scanned: number
  /** 删掉多少个 */
  removed: number
  /** 删掉的字节数（写进日志，便于确认"目录只增不减"真的止住了） */
  bytes: number
}

/**
 * 草稿目录的垃圾回收（启动时跑一次，见 index.ts）。
 *
 * 判据全在纯函数 `planDraftGc` 里（有单测）；这里只负责列目录、解析、删文件。
 * 解析失败的条目**也要报给判据**（key = null）：那种文件本来就无法恢复，
 * 只是"过多久才清"的问题，而这条判断不该只活在主进程的 I/O 里。
 */
export async function gcDrafts(
  nowMs: number = Date.now(),
  maxAgeMs: number = DRAFT_GC_MAX_AGE_MS
): Promise<DraftGcResult> {
  let names: string[]
  try {
    names = await fs.readdir(draftsDir)
  } catch {
    return { scanned: 0, removed: 0, bytes: 0 } // 目录还不存在 = 没有草稿
  }
  const entries: DraftGcEntry[] = []
  for (const name of names) {
    try {
      const st = await fs.stat(path.join(draftsDir, name))
      if (!st.isFile()) continue
      let key: string | null = null
      if (name.endsWith('.json')) {
        try {
          const data = JSON.parse(
            await fs.readFile(path.join(draftsDir, name), 'utf-8')
          ) as DraftInfo
          // 旧文件没有 key 字段：文件名就是键（与 loadDraft 的兜底口径一致）
          key = typeof data.key === 'string' ? data.key : name.slice(0, -'.json'.length)
        } catch {
          key = null
        }
      }
      entries.push({ name, key, mtimeMs: st.mtimeMs, size: st.size })
    } catch {
      /* 读不到的条目跳过 */
    }
  }

  const plan = planDraftGc(entries, nowMs, maxAgeMs)
  let removed = 0
  let bytes = 0
  for (const item of plan) {
    try {
      await fs.rm(path.join(draftsDir, item.name), { force: true })
      removed += 1
      bytes += item.size
    } catch {
      /* 删不掉就下次再试：清理是尽力而为，不该影响启动 */
    }
  }
  // 主进程 console 一律 ASCII（tests/mainConsoleAscii.test.mjs）
  if (removed) {
    const by = plan.reduce<Record<string, number>>((acc, x) => {
      acc[x.reason] = (acc[x.reason] ?? 0) + 1
      return acc
    }, {})
    console.log(`[drafts] gc removed ${removed} (${JSON.stringify(by)})`)
  }
  return { scanned: entries.length, removed, bytes }
}

/** 主停放键（保留导出是为了兼容外部引用） */
export { ORPHAN_UNTITLED_DRAFT_KEY }
