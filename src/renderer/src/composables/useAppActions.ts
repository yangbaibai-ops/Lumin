import { onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useFilesStore } from '../stores/files'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { useExport } from './useExport'
import { useEditorMode } from './useEditorMode'
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
    if (await files.openPath(path)) await router.push('/editor')
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
  function onKeydown(e: KeyboardEvent): void {
    // Alt+F/E/V/H：交由 Windows 原生菜单助记键处理（顶级菜单已用 `文件(&F)`
    // 写法，位置由操作系统精确摆放）；不做渲染层浮层兜底，避免双开/错位
    const mod = e.ctrlKey || e.metaKey
    if (!mod) return
    const target = e.target
    const tagName = target instanceof Element ? target.tagName : ''
    const key = e.key.toLowerCase()
    if (e.shiftKey && key === 'e') {
      e.preventDefault()
      void runExport('pdf')
    } else if (e.shiftKey && key === 'b') {
      e.preventDefault()
      handleMenu('toggle-sidebar')
    } else if (e.shiftKey && key === 'f') {
      e.preventDefault()
      ui.focusMode = !ui.focusMode
    } else if (e.shiftKey && key === 't') {
      e.preventDefault()
      pendingRefactor('打字机模式')
    } else if (e.shiftKey && key === 'o') {
      e.preventDefault()
      void openFolderDialog()
    } else if (key === 's') {
      e.preventDefault()
      void saveDoc()
    } else if (key === '/') {
      // Typora 同款：Ctrl+/ 循环切换 实时渲染 → 分屏对比 → 源码
      e.preventDefault()
      cycleMode()
    } else if (key === 'n') {
      e.preventDefault()
      void newDoc()
    } else if (key === 'o') {
      e.preventDefault()
      void openFileDialog()
    } else if (key === 'f' && tagName !== 'INPUT' && tagName !== 'TEXTAREA') {
      e.preventDefault()
      pendingRefactor('查找替换')
    }
  }

  // ── 关闭守卫：保存全部并放行 ──
  async function requestClose(): Promise<void> {
    await files.flushAll()
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
  window.addEventListener('keydown', onKeydown)

  onBeforeUnmount(() => {
    offMenu()
    offClose()
    media.removeEventListener('change', onSystemTheme)
    window.removeEventListener('keydown', onKeydown)
  })

  return { handleMenu, requestClose }
}
