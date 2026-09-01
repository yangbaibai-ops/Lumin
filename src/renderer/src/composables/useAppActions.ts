import { onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useFilesStore } from '../stores/files'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { useExport } from './useExport'
import type { MenuAction } from '../../../shared/types'

/** 未保存更改确认 */
export async function confirmIfDirty(): Promise<boolean> {
  const files = useFilesStore()
  const ui = useUiStore()
  if (!files.dirty) return true
  return ui.confirm({
    title: '有未保存的更改',
    body: '当前文档有未保存的更改，确定要离开吗？',
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
    ui.toast('已打开文件夹', 'success')
  }

  async function saveDoc(): Promise<void> {
    if (await files.save()) ui.toast('已保存', 'success')
  }

  async function saveAsDoc(): Promise<void> {
    if (await files.saveAs()) ui.toast('已保存', 'success')
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
        ui.requestFind()
        break
      case 'global-search':
        ui.openGlobalSearch()
        break
      case 'toggle-sidebar':
        ui.sidebarVisible = !ui.sidebarVisible
        settings.set('sidebarVisible', ui.sidebarVisible)
        break
      case 'mode-wysiwyg':
        ui.editorMode = 'wysiwyg'
        settings.set('editorMode', 'wysiwyg')
        break
      case 'mode-source':
        ui.editorMode = 'source'
        settings.set('editorMode', 'source')
        break
      case 'toggle-focus':
        ui.focusMode = !ui.focusMode
        break
      case 'toggle-typewriter':
        ui.typewriterMode = !ui.typewriterMode
        break
      case 'settings':
        void router.push('/settings')
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
    const mod = e.ctrlKey || e.metaKey
    if (!mod) return
    const target = e.target
    // 在源码编辑器内时交给 CodeMirror 处理
    if (target instanceof Element && target.closest('.cm-editor')) return
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
      ui.typewriterMode = !ui.typewriterMode
    } else if (e.shiftKey && key === 'o') {
      e.preventDefault()
      void openFolderDialog()
    } else if (key === 's') {
      e.preventDefault()
      void saveDoc()
    } else if (key === 'n') {
      e.preventDefault()
      void newDoc()
    } else if (key === 'o') {
      e.preventDefault()
      void openFileDialog()
    } else if (key === 'f' && tagName !== 'INPUT' && tagName !== 'TEXTAREA') {
      e.preventDefault()
      ui.requestFind()
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
