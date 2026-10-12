/**
 * ─── 「当前打开的文档被其他应用改了」→ 弹提示（第一百零八轮）───────────────────
 *
 * 分工：**监测在主进程**（`src/main/services/externalWatch.ts`：目录监听 + stat 轮询 +
 * 去抖 + 自写抑制 + 按版去重），**提示与"要不要重载"在渲染层**（这里）。
 *
 * 用户口径（原话）：实时监测当前打开的文档的内容是否被其他应用修改了，如果被修改了，
 * 则弹出提示：**检测到内容已被修改，是否重新加载**。
 *
 * 两条出口：
 *   * **重新加载** → `files.reloadFromDisk()`：读盘 → 走既有单一数据源账本
 *     （`noteExternalReplace()`）让各编辑面按世代号重渲染。**不新开同步通道**。
 *   * **暂不**（含 Esc / 点背板）→ 什么都不改。这一版修订**已经在主进程记下**
 *     （`prompted`），所以不会再弹第二次；等它**真的又变了一版**才会再提示。
 *
 * 为什么对话框用 `ui.confirmTriple` 而不是 `lib/dialog.ts` 里那两个函数：那两个的语义是
 * 「未保存更改要不要丢弃」（二选一 / 关窗三选一），而这里是「重新加载 / 暂不」——
 * 同一个 ModalHost 通道与视觉，只是文案与出口不同；`lib/dialog.ts` 的注释写明它是
 * **未保存更改确认**的唯一实现，所以不往那里塞第三种语义，也不另造一套弹窗。
 */
import { useFilesStore } from '../stores/files'
import { useUiStore } from '../stores/ui'
import i18n from '../i18n'

export interface ExternalChangePayload {
  path: string
  mtimeMs: number
  size: number
  why?: 'watch' | 'poll'
}

/** 测试钩子（套件用）：提示/重载/暂不各发生了几次 */
interface ExternalWatchCounts {
  prompts: number
  reloads: number
  deferred: number
  lastBody: string | null
  lastPath: string | null
}
const counts: ExternalWatchCounts = {
  prompts: 0,
  reloads: 0,
  deferred: 0,
  lastBody: null,
  lastPath: null
}

function exposeCounts(): void {
  ;(window as unknown as { __luminExternalWatch?: ExternalWatchCounts }).__luminExternalWatch =
    counts
}

/** 同一时刻只允许一个提示（主进程已经按版去重，这里是渲染层的再保险） */
let prompting = false

export function initExternalWatch(): void {
  exposeCounts()
  window.luminAPI.events.on('doc:externalChange', (payload) => {
    void handleExternalChange(payload as ExternalChangePayload)
  })
}

async function handleExternalChange(payload: ExternalChangePayload): Promise<void> {
  const files = useFilesStore()
  const ui = useUiStore()
  const cur = files.current
  // 不是当前这一篇（换文档的竞态）⇒ 忽略：提示必须描述"你眼前这篇"
  if (!cur?.path || cur.path !== payload.path) return
  if (prompting) return
  prompting = true
  counts.prompts += 1
  counts.lastPath = payload.path
  try {
    const body = i18n.global.t('editor.externalChangeBody')
    counts.lastBody = body
    const choice = await ui.confirmTriple({
      title: i18n.global.t('editor.externalChangeTitle'),
      body,
      confirmLabel: i18n.global.t('editor.externalChangeReload'),
      // 「暂不」= 不改内容；主进程已记下这一版，不会再重复提示
      altLabel: i18n.global.t('editor.externalChangeLater')
    })
    if (choice === 'confirm') {
      // 读盘前先把编辑器里挂起的变更刷进 store：否则"重新加载"可能丢掉最后一拍输入
      // （用户点的是"重新加载"，本来就要求以磁盘为准）
      const ok = await files.reloadFromDisk()
      counts.reloads += 1
      if (!ok) ui.toast(i18n.global.t('toast.openFailed'), 'error')
    } else {
      counts.deferred += 1
    }
  } finally {
    prompting = false
  }
}
