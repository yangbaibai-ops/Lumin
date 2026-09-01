// ─── 主进程：草稿（自动保存/崩溃恢复）─────────────────────────────────────
import fs from 'fs/promises'
import path from 'path'
import { app } from 'electron'
import type { DraftInfo } from '../shared/types'

const draftsDir = path.join(app.getPath('userData'), 'drafts')
const crashFlag = path.join(app.getPath('userData'), '.crash-flag')

function keyToFile(key: string): string {
  return path.join(draftsDir, `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
}

export function markRunning(): void {
  fs.writeFile(crashFlag, String(Date.now()), 'utf-8').catch(() => {})
}

export function markClean(): void {
  fs.rm(crashFlag, { force: true }).catch(() => {})
}

export async function wasCrashed(): Promise<boolean> {
  try {
    await fs.access(crashFlag)
    return true
  } catch {
    return false
  }
}

export async function saveDraft(key: string, content: string, filePath: string | null): Promise<void> {
  await fs.mkdir(draftsDir, { recursive: true })
  const data: DraftInfo = { key, path: filePath, content, savedAt: Date.now() }
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
