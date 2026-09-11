// ─── 打开链接（渲染层编排）────────────────────────────────────────────────
// 主进程只提供「解析 + 文件系统 + 系统调用」三件原子能力，这里负责把它们编成
// 用户可见的流程：解析 → （目标不存在时按设置询问用户）→ 创建 → 打开 → 落库 → 提示。
// 之所以放在渲染层：确认弹窗、通知都属于 UI；main 里不该出现交互决策。
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
import { useUiStore } from '../stores/ui'
import type { LinkOpenAction, LinkResolveResult } from '../../../shared/types'

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

/**
 * 打开一个链接目标（Ctrl/Cmd+左键触发）。
 * 所有失败路径都以通知中心的形式告知用户，不抛异常到编辑器事件里。
 */
export async function openLinkTarget(rawTarget: string): Promise<void> {
  const target = (rawTarget ?? '').trim()
  if (!target) return
  const notifications = useNotificationsStore()
  const settings = useSettingsStore()
  const ui = useUiStore()
  const fail = (title: string, body?: string): void => {
    void notifications.notify({ level: 'error', title, body, mergeKey: `links:${title}` })
  }

  let res: LinkResolveResult
  try {
    res = await window.luminAPI.links.resolve(target, await resolveBaseDir())
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

  const absPath = res.path as string

  // ② 目标不存在：按设置询问 / 直接创建 / 放弃
  let created = false
  if (res.exists === false) {
    if (!res.createType) {
      fail(t('links.errCannotCreate'), absPath)
      await record(res, 'declined', false)
      return
    }
    const mode = settings.linkCreateMode
    let allowed = mode === 'always'
    if (mode === 'ask') {
      const body =
        t(res.createType === 'directory' ? 'links.confirmDir' : 'links.confirmFile', {
          path: absPath
        }) +
        ' ' +
        t(res.action === 'window' ? 'links.afterWindow' : 'links.afterDefault')
      allowed = await ui.confirm({ title: t('links.confirmTitle'), body })
    }
    if (!allowed) {
      await record(res, 'declined', false)
      if (mode === 'never') fail(t('links.errNeverCreate'), absPath)
      return
    }
    const result = await window.luminAPI.links.create(absPath, res.createType)
    if (!result.ok) {
      fail(t('links.errCreate'), absPath + (result.error ? ` (${result.error})` : ''))
      await record(res, 'declined', false)
      return
    }
    created = true
    const name = await window.luminAPI.file.basename(absPath).catch(() => absPath)
    void notifications.notify({
      level: 'success',
      title: t('links.created'),
      body: name,
      mergeKey: 'links:created'
    })
  }

  // ③ 打开
  if (res.action === 'window') {
    window.luminAPI.app.openInNewWindow(absPath)
  } else {
    const err = await window.luminAPI.shell.openPath(absPath).catch((e: unknown) => String(e))
    if (err) {
      fail(t('links.errOpen'), `${absPath}\n${err}`)
      await record(res, res.action, created)
      return
    }
  }
  await record(res, res.action, created)
}
