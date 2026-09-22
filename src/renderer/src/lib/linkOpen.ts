// ─── 打开链接（渲染层编排）────────────────────────────────────────────────
// 主进程只提供「解析 + 文件系统 + 系统调用」三件原子能力，这里负责把它们编成
// 用户可见的流程：解析 → （目标不存在时按设置询问用户）→ 创建 → 打开 → 落库 → 提示。
// 之所以放在渲染层：交互决策属于 UI；main 里不该出现「要不要问用户」这类判断。
//
// 询问方式（本次调整）：**融合进右下角通知中心的可交互卡片**（保留操作按钮），
// 不再弹模态对话框——不打断写作、可继续操作编辑器，答完自动收起，未作答时也能
// 用通知中心自带的关闭/切换管理。卡片与按钮随通知一起持久化在 SQLite，点击时按
// payload.kind 派发给本模块注册的处理器（见 installLinkNotificationActions）。
//
// 解析规则（实现见 src/main/services/links.ts）：
//   网址 http/https/mailto           → 系统默认浏览器
//   同级文件名 xxx.md（相对当前文档） → Lumin 新窗口打开；不存在则询问是否新建
//   相对/绝对路径                     → 系统默认应用（文件或文件夹）；不存在则询问是否新建
// 非文本目标（.png/.pdf…）交系统默认应用；凭空新建这类空文件没有意义，直接提示不支持。
import i18n from '../i18n'
import { useFilesStore } from '../stores/files'
import { useNotificationsStore } from '../stores/notifications'
import { useSettingsStore } from '../stores/settings'
import { registerNotificationActions } from './notificationActions'
import type { AppNotification, LinkOpenAction, LinkResolveResult } from '../../../shared/types'

/** 可交互通知的 kind（payload.kind） */
const LINK_CREATE_KIND = 'link-create'

const t = (key: string, params?: Record<string, unknown>): string =>
  i18n.global.t(key, params ?? {})

/** 当前文档所在目录；未保存的文档退回工作区根，两者都没有则 null（相对链接无法解析） */
async function resolveBaseDir(): Promise<string | null> {
  const current = useFilesStore().current?.path
  if (current) return window.luminAPI.file.dirname(current)
  return (await window.luminAPI.workspace.getRoot().catch(() => null)) ?? null
}

/** 记录一次链接动作（历史失败的记录不影响打开本身） */
async function record(
  res: LinkResolveResult,
  action: LinkOpenAction | 'declined',
  created: boolean
): Promise<void> {
  try {
    await window.luminAPI.links.record({
      target: res.target,
      kind: res.kind,
      path: res.path,
      action,
      created
    })
  } catch {
    /* 忽略：历史记录是辅助能力 */
  }
}

/** 统一的失败提示（同标题合并成一张卡片，反复失败不刷屏） */
function fail(title: string, body?: string): void {
  void useNotificationsStore().notify({
    level: 'error',
    title,
    body,
    mergeKey: `links:${title}`
  })
}

/** 目标不存在但允许创建时，按上表打开（path 类交默认应用，file 类进新窗口） */
async function openResolved(
  res: LinkResolveResult,
  action: LinkOpenAction,
  created: boolean
): Promise<void> {
  const absPath = res.path as string
  if (action === 'window') {
    window.luminAPI.app.openInNewWindow(absPath)
  } else {
    const err = await window.luminAPI.shell.openPath(absPath).catch((e: unknown) => String(e))
    if (err) {
      fail(t('links.errOpen'), `${absPath}\n${err}`)
      await record(res, action, created)
      return
    }
  }
  await record(res, action, created)
}

/**
 * 创建链接目标（含缺失的上级目录），成功后提示并打开。
 * 「设置里选了总是创建」与「通知卡片上点了创建并打开」共用这一条路径。
 */
async function createAndOpen(res: LinkResolveResult): Promise<void> {
  const absPath = res.path as string
  const type = res.createType ?? 'file'
  const result = await window.luminAPI.links.create(absPath, type)
  if (!result.ok) {
    fail(t('links.errCreate'), absPath + (result.error ? ` (${result.error})` : ''))
    await record(res, 'declined', false)
    return
  }
  // 不发「已创建」通知：文件已在目标位置、并且紧接着就被打开（新窗口或默认应用），
  // 结果就在眼前；同一次询问刚收起一条通知，再弹一条只会让人以为又出了事
  await openResolved(res, res.action, true)
}

/**
 * 通知卡片按钮的处理器：按 payload 里记录的「原始链接 + 当时的基准目录」重新解析。
 * 重新解析而不是复用旧结果，是为了让「等待期间文件已被别人创建」这类情况也能正确
 * 落到「直接打开」分支（exists 已变 true）。
 */
async function onLinkCreateAction(notification: AppNotification, actionId: string): Promise<void> {
  const payload = notification.payload as { target?: string; baseDir?: string | null } | null
  const target = typeof payload?.target === 'string' ? payload.target : ''
  if (!target) return
  const baseDir = typeof payload?.baseDir === 'string' ? payload.baseDir : null
  let res: LinkResolveResult
  try {
    res = await window.luminAPI.links.resolve(target, baseDir)
  } catch (e) {
    fail(t('links.errResolve'), e instanceof Error ? e.message : String(e))
    return
  }
  if (actionId !== 'create') {
    // 取消：明确记一笔，方便在「设置 → 链接」里回看
    await record(res, 'declined', false)
    return
  }
  if (res.blocked || !res.path) {
    fail(t('links.errResolve'), target)
    return
  }
  if (res.exists === true) {
    // 期间文件已经出现（别的程序/窗口创建）→ 直接打开
    await openResolved(res, res.action, false)
    return
  }
  if (!res.createType) {
    fail(t('links.errCannotCreate'), res.path)
    await record(res, 'declined', false)
    return
  }
  await createAndOpen(res)
}

/** 应用启动时调用一次：把「创建缺失目标」卡片接上处理器 */
export function installLinkNotificationActions(): void {
  registerNotificationActions(LINK_CREATE_KIND, onLinkCreateAction)
}

/**
 * 打开一个链接目标（Ctrl/Cmd+左键触发）。
 * 所有失败路径都以通知中心的形式告知用户，不抛异常到编辑器事件里。
 */
export async function openLinkTarget(rawTarget: string): Promise<void> {
  const target = (rawTarget ?? '').trim()
  if (!target) return
  const notifications = useNotificationsStore()
  const settings = useSettingsStore()
  const baseDir = await resolveBaseDir()

  let res: LinkResolveResult
  try {
    res = await window.luminAPI.links.resolve(target, baseDir)
  } catch (e) {
    fail(t('links.errResolve'), e instanceof Error ? e.message : String(e))
    return
  }

  if (res.blocked === 'unsupported-scheme') {
    fail(t('links.errScheme'), target)
    return
  }
  if (res.blocked === 'missing-base') {
    fail(t('links.errNoBase'))
    return
  }
  if (res.blocked === 'invalid') {
    fail(t('links.errInvalid'))
    return
  }

  // ① 网址：交系统默认浏览器（协议白名单在主进程再次校验）
  if (res.kind === 'url') {
    window.luminAPI.shell.openExternal(target)
    await record(res, 'external', false)
    return
  }

  // ② 目标已存在：直接打开
  if (res.exists === true) {
    await openResolved(res, res.action, false)
    return
  }

  // ③ 目标不存在
  if (!res.createType) {
    fail(t('links.errCannotCreate'), res.path as string)
    await record(res, 'declined', false)
    return
  }
  const mode = settings.linkCreateMode
  if (mode === 'always') {
    await createAndOpen(res)
    return
  }
  if (mode === 'never') {
    fail(t('links.errNeverCreate'), res.path as string)
    await record(res, 'declined', false) // 明确记一笔：目标不存在且按设置未创建
    return
  }

  // ④ 询问：右下角通知中心的可交互卡片（不打断编辑，答完自动收起）
  const body =
    t(res.createType === 'directory' ? 'links.confirmDir' : 'links.confirmFile', {
      path: res.path as string
    }) +
    ' ' +
    t(res.action === 'window' ? 'links.afterWindow' : 'links.afterDefault')
  void notifications.notify({
    level: 'warning',
    title: t('links.confirmTitle'),
    body,
    // 同一目标只占一张卡片：反复点同一个缺失链接不会堆叠
    mergeKey: `${LINK_CREATE_KIND}:${res.path as string}`,
    actions: [
      { id: 'create', label: t('links.actionCreate'), tone: 'primary' },
      { id: 'cancel', label: t('links.actionCancel'), tone: 'ghost' }
    ],
    payload: { kind: LINK_CREATE_KIND, target, baseDir }
  })
}
