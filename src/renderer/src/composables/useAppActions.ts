import { onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useFilesStore } from '../stores/files'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { useExport } from './useExport'
import { useEditorMode } from './useEditorMode'
import { flushSession } from '../lib/session'
import { openExternalFile } from '../lib/openFile'
import type { MenuAction } from '../../../shared/types'
import i18n from '../i18n'

/** 未保存更改确认 */
export async function confirmIfDirty(): Promise<boolean> {
  const files = useFilesStore()
  const ui = useUiStore()
  if (!files.dirty) return true
  return ui.confirm({
    title: i18n.global.t('editor.dirtyConfirmTitle'),
    body: i18n.global.t('editor.dirtyConfirmBody'),
    danger: true
  })
}

export function useAppActions(): {
  handleMenu: (action: string) => void
  requestClose: () => void
} {
  const router = useRouter()
  const files = useFilesStore()
  const ui = useUiStore()
  const settings = useSettingsStore()
  const { runExport } = useExport()
  const { setMode, cycleMode } = useEditorMode()

  async function newDoc(): Promise<void> {
    if (!(await confirmIfDirty())) return
    await files.newDocInWorkspace()
    await router.push('/editor')
  }

  async function openFileDialog(): Promise<void> {
    if (!(await confirmIfDirty())) return
    const path = await window.luminAPI.file.chooseOpenFile()
    if (!path) return
    // 落点规则（本窗口无工作区 → 就本窗口打开并把侧栏切到它的文件夹；
    // 已有工作区 → 新窗口打开）统一在 lib/openFile.ts 里
    await openExternalFile(path)
    await router.push('/editor')
  }

  async function openFolderDialog(): Promise<void> {
    if (!(await confirmIfDirty())) return
    await files.openFolder()
    ui.toast(i18n.global.t('toast.folderOpened'), 'success')
  }

  async function saveDoc(): Promise<void> {
    if (await files.save()) ui.toast(i18n.global.t('toast.saved'), 'success')
  }

  async function saveAsDoc(): Promise<void> {
    if (await files.saveAs()) ui.toast(i18n.global.t('toast.saved'), 'success')
  }

  /** 编辑器内核 / 导出随渲染层剥离：保留入口，占位提示 */
  function pendingRefactor(feature: string): void {
    ui.toast(`${feature}: ${i18n.global.t('common.pending')}`, 'info')
  }

  function handleMenu(action: string): void {
    const a = action as MenuAction
    switch (a) {
      case 'new':
        void newDoc()
        break
      case 'new-window':
        window.luminAPI.app.newWindow()
        break
      case 'cycle-mode':
        cycleMode()
        break
      case 'open':
        void openFileDialog()
        break
      case 'open-folder':
        void openFolderDialog()
        break
      case 'save':
        void saveDoc()
        break
      case 'save-as':
        void saveAsDoc()
        break
      case 'export-pdf':
        void runExport('pdf')
        break
      case 'export-html':
        void runExport('html')
        break
      case 'export-word':
        void runExport('word')
        break
      case 'export-epub':
        void runExport('epub')
        break
      case 'find':
        pendingRefactor('查找替换')
        break
      case 'global-search':
        ui.openGlobalSearch()
        break
      case 'toggle-sidebar':
        ui.sidebarVisible = !ui.sidebarVisible
        settings.set('sidebarVisible', ui.sidebarVisible)
        break
      case 'mode-wysiwyg':
        setMode('wysiwyg')
        break
      case 'mode-source':
        setMode('source')
        break
      case 'mode-split':
        setMode('split')
        break
      case 'toggle-focus':
        ui.focusMode = !ui.focusMode
        break
      case 'toggle-typewriter':
        pendingRefactor('打字机模式')
        break
      case 'settings':
        ui.openSettings()
        break
      case 'about':
        void router.push('/about')
        break
      case 'theme-changed':
        void settings.init()
        break
    }
  }

  // ── 全局快捷键 ──
  // 已迁移到命令注册表 + keybinding 服务（composables/useKeymap.ts + lib/keymap/）：
  // 键位集中声明、用户可在「设置 → 快捷键」里改，且与原生菜单共用同一份 handleMenu 实现，
  // 因此这里不再保留任何硬编码按键判断（避免两套真相/重复触发）。

  // ── 关闭守卫：保存全部并放行 ──
  async function requestClose(): Promise<void> {
    await files.flushAll()
    // 会话位置（光标/滚动）也补一次：窗口销毁前最后的状态
    await flushSession()
    await window.luminAPI.app.confirmClose()
  }

  // ── 事件绑定 ──
  const offMenu = window.luminAPI.events.on('menu:action', (payload) => handleMenu(String(payload)))
  const offClose = window.luminAPI.events.on('app:before-close', () => void requestClose())
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const onSystemTheme = (): void => {
    if (settings.theme === 'auto') settings.applyAll()
  }
  media.addEventListener('change', onSystemTheme)

  onBeforeUnmount(() => {
    offMenu()
    offClose()
    media.removeEventListener('change', onSystemTheme)
  })

  return { handleMenu, requestClose }
}
