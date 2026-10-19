/**
 * ─── 按文档路径记住「崩溃 / 无响应」事故（本地设置）────────────────────────────
 *
 * 用户口径：同一份文档**连续两次**崩溃/无响应 ⇒ 下次打开默认源码模式并提示。
 *
 * 为什么记在主进程的 kv 里（而不是渲染层的 localStorage）：
 *   * 渲染进程崩溃后它自己写不了任何东西 —— 事故只能由主进程记；
 *   * 下次打开发生在渲染层启动时，读同一份 kv 即可，多窗口也天然一致。
 *
 * 判据（连续几次、多久衰减）全在 `shared/freeze.ts` 的纯函数里，这里只做读写。
 * 路径键做大小写/分隔符归一：Windows 上 `C:\a\b.md` 与 `c:/a/b.md` 是同一份文档。
 */
import path from 'path'
import { db } from './database'
import {
  emptyDocRisk,
  liveDocRisk,
  noteDocIncident,
  type DocIncidentKind,
  type DocRiskRecord
} from '../../shared/freeze'

const KV_KEY = 'docRisk'
/** 记录的文档数上限：只清最旧的，绝不让这张表无限长 */
const MAX_ENTRIES = 500

type RiskMap = Record<string, DocRiskRecord>

/** 路径键：resolve + 小写（Windows 大小写不敏感；其余平台也按同一键存储，行为稳定） */
export function riskKey(filePath: string): string {
  try {
    return path.resolve(filePath).replace(/\//g, '\\').toLowerCase()
  } catch {
    return filePath.replace(/\//g, '\\').toLowerCase()
  }
}

function readMap(): RiskMap {
  const raw = db.kvGet<unknown>(KV_KEY, {})
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: RiskMap = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const v = value as Partial<DocRiskRecord>
    out[key] = {
      at: Number(v.at) || 0,
      incidents: Math.max(0, Math.floor(Number(v.incidents) || 0)),
      safeMode: v.safeMode === true,
      lastKind: v.lastKind === 'unresponsive' ? 'unresponsive' : 'crash'
    }
  }
  return out
}

function writeMap(map: RiskMap): void {
  const entries = Object.entries(map)
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => b[1].at - a[1].at)
    db.kvSet(KV_KEY, Object.fromEntries(entries.slice(0, MAX_ENTRIES)))
    return
  }
  db.kvSet(KV_KEY, map)
}

/** 读一份文档的风险（过期记录按空记录返回，并顺手清掉） */
export function getDocRisk(filePath: string): DocRiskRecord {
  if (!filePath) return emptyDocRisk()
  const key = riskKey(filePath)
  const map = readMap()
  const stored = map[key]
  const live = liveDocRisk(stored, Date.now())
  if (stored && !live.at) {
    delete map[key]
    writeMap(map)
  }
  return live
}

/** 记一次事故：返回记完之后的那条（调用方据此知道是否刚跨过"连续两次"） */
export function noteDocIncidentFor(filePath: string, kind: DocIncidentKind): DocRiskRecord {
  if (!filePath) return emptyDocRisk()
  const key = riskKey(filePath)
  const map = readMap()
  const next = noteDocIncident(liveDocRisk(map[key], Date.now()), kind, Date.now())
  map[key] = next
  writeMap(map)
  // 主进程 console 一律 ASCII（tests/mainConsoleAscii.test.mjs）
  console.log(
    `[freeze] doc risk kind=${kind} incidents=${next.incidents} safeMode=${next.safeMode ? 1 : 0}`
  )
  return next
}

/** 用户明确选择「仍然以富文本打开」/ 文档恢复正常：清零这份文档的事故计数 */
export function clearDocRisk(filePath: string): void {
  if (!filePath) return
  const key = riskKey(filePath)
  const map = readMap()
  if (!(key in map)) return
  delete map[key]
  writeMap(map)
  console.log('[freeze] doc risk cleared')
}
