// ─── 工作区全文索引：把**从未打开过**的文档也纳入搜索（审计 §7 第 17 条）────────
//
// 问题：`db.upsertDocument` 只在「打开」与「保存」时被调用，所以工作区里那些
// Lumin 从未打开过的 `.md` **搜不到** —— "全局搜索"的承诺大于实际。
//
// 做法（三条都为了"不卡主进程"）：
//   1. **后台增量**：打开工作区后台跑一遍，每篇读完 yield 一次，不阻塞 IPC/窗口事件
//      （`DatabaseSync` 是同步 API，一次写几千篇正文必然卡）；
//   2. **按 mtime 跳过**：索引行里记 `indexed_mtime`（复用 `modified_at`），文件没变就不重读；
//   3. **只读头部一段**（`MAX_INDEX_BYTES`）：FTS 侧本来也只索引前一段（见 database 的 FTS_CAP），
//      读全文只是浪费 IO。搜索仍能命中正文开头 —— 与既有口径一致。
//
// 另外：索引**不能**走 `upsertDocument` —— 那个方法会把 `last_opened` 设成 now，
// 于是"从未打开过的文件"会挤进「最近文档」列表。这里用专门的 `indexDocumentForSearch`。
import fs from 'fs/promises'
import path from 'path'
import { isMarkdownFile } from '../../shared/docExt'
import { db } from './database'

/** 每篇最多读多少字节进索引（与 database 的 FTS 正文上限同量级） */
const MAX_INDEX_BYTES = 96 * 1024
/** 每批之间让出事件循环的篇数 */
const BATCH = 8
/** 单次索引最多处理多少篇（极端工作区下别跑成无底洞；剩下的下次进入工作区再补） */
const MAX_FILES = 5000

export interface IndexStatus {
  /** 当前正在索引的根（null = 空闲） */
  root: string | null
  /** 本次已看过多少篇（含跳过） */
  scanned: number
  /** 本次真正写入索引多少篇 */
  indexed: number
  /** 本次对账删掉多少条"磁盘上已经没有了"的索引行（报告 §4.2 P1-1；没对账时省略） */
  pruned?: number
  /** 是否还在跑 */
  running: boolean
}

let status: IndexStatus = { root: null, scanned: 0, indexed: 0, running: false }
/** 世代号：换工作区/取消时自增，正在跑的循环看到变化就停 */
let generation = 0
let listeners: ((s: IndexStatus) => void)[] = []

/** 订阅进度（ipc 层转成 webContents.send） */
export function onIndexProgress(fn: (s: IndexStatus) => void): void {
  listeners.push(fn)
}
export function offIndexProgress(fn: (s: IndexStatus) => void): void {
  listeners = listeners.filter((f) => f !== fn)
}

export function indexStatus(): IndexStatus {
  return { ...status }
}

function emit(): void {
  const snapshot = indexStatus()
  for (const fn of listeners) {
    try {
      fn(snapshot)
    } catch {
      /* 监听者出错不影响索引 */
    }
  }
}

/** 这是不是一篇"该进索引"的 Markdown（与扫描/文件树同一套扩展名口径，定义在 shared/docExt） */
export function isIndexableFile(name: string): boolean {
  return isMarkdownFile(name)
}

/** 让出事件循环（同步 DB 写入之间必须给主进程喘气的机会） */
const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r))

/**
 * 该不该读这篇：没索引过、或文件比索引新。**纯函数**。
 * `indexedMtime` 为 0/undefined 表示从没索引过。
 *
 * ⚠️ 注释里原先写"有单测"，但 `tests/` 里既没有 `shouldIndex` 也没有覆盖这个模块的文件
 * （审计 §10 P1「≥80 行 src 文件零引用」那一类）。这条**不是**宣称已有覆盖 ——
 * 覆盖它的活归 `_verify-search-index.js`（端到端）或后续给这个纯函数补一条单测。
 */
export function shouldIndex(mtimeMs: number, indexedMtime: number | null | undefined): boolean {
  return !indexedMtime || mtimeMs > indexedMtime
}

/** 读一篇文档用于索引（只读头部一段；读不到返回 null，不抛） */
async function readForIndex(file: string): Promise<string | null> {
  try {
    const fh = await fs.open(file, 'r')
    try {
      const buf = Buffer.alloc(MAX_INDEX_BYTES)
      const { bytesRead } = await fh.read(buf, 0, MAX_INDEX_BYTES, 0)
      return buf
        .subarray(0, bytesRead)
        .toString('utf-8')
        .replace(/^\uFEFF/, '')
    } finally {
      await fh.close()
    }
  } catch {
    return null
  }
}

/**
 * 后台索引一个工作区。重复调用同一个根会**先取消上一轮**（世代号比对），
 * 这样快速切换工作区不会有两个循环同时写库。
 */
export async function indexWorkspace(root: string): Promise<IndexStatus> {
  const gen = ++generation
  status = { root, scanned: 0, indexed: 0, running: true }
  emit()

  /** 已索引过的 mtime 表（一次查全：逐篇查库在几千篇上又是几千次查询） */
  const indexedMtimes = db.indexedMtimes()
  const files: string[] = []

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (gen !== generation || files.length >= MAX_FILES || depth > 24) return
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (gen !== generation) return
      if (e.name.startsWith('.') || e.name.endsWith('.lumin-tmp')) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) await walk(p, depth + 1)
      else if (e.isFile() && isIndexableFile(e.name)) files.push(p)
    }
  }
  await walk(root, 0)
  if (gen !== generation) return indexStatus()

  for (const file of files) {
    if (gen !== generation) return indexStatus()
    status.scanned += 1
    let mtimeMs = 0
    try {
      mtimeMs = (await fs.stat(file)).mtimeMs
    } catch {
      continue
    }
    if (!shouldIndex(mtimeMs, indexedMtimes[file.toLowerCase()])) continue
    const content = await readForIndex(file)
    if (content === null) continue
    try {
      db.indexDocumentForSearch(file, path.basename(file), content, mtimeMs)
      status.indexed += 1
    } catch {
      /* 单篇写库失败不影响整轮 */
    }
    if (status.scanned % BATCH === 0) {
      emit()
      await yieldToLoop()
    }
  }
  if (gen === generation) {
    /**
     * ─── 对账：本工作区内**已经不在磁盘上**的索引行要删掉（报告 §4.2 P1-1）───────
     * 索引此前只有 upsert、没有 prune：外部删文件/删目录、或换了工作区之后，
     * `documents` / `documents_fts` / `documents_history` 里那一批**幽灵文档**会一直留着
     * （全局搜索能搜到、最近/标签里看得到、点开打不开）。
     * 判据只用"这一轮真实扫到的路径集合"：只在本工作区内对账，绝不越界删别的目录的索引；
     * 扫到 MAX_FILES 上限时**跳过对账**（没扫全就 prune，会把没来得及扫的文档误删）。
     */
    if (files.length < MAX_FILES) {
      try {
        const removed = db.pruneWorkspace(root, files)
        if (removed > 0) status = { ...status, pruned: removed }
      } catch {
        /* 对账失败不影响这一轮的索引结果 */
      }
    }
    status = { ...status, running: false }
    emit()
  }
  return indexStatus()
}

/**
 * 取消当前索引（世代号自增 → 正在跑的循环下次检查时退出）。
 * 关掉工作区、或立刻要重建索引时调用。
 */
export function cancelIndex(): void {
  generation += 1
  status = { root: null, scanned: 0, indexed: 0, running: false }
  emit()
}
