import { defineStore } from 'pinia'
import type { EditorMode, SearchResult } from '../../../shared/types'

export interface ToastItem {
  id: number
  message: string
  type: 'info' | 'success' | 'error'
}

export interface ConfirmOptions {
  title: string
  body: string
  danger?: boolean
}

export interface ContextMenuItem {
  label: string
  icon?: string
  danger?: boolean
  action: string
  disabled?: boolean
}

export interface ContextMenuState {
  x: number
  y: number
  items: ContextMenuItem[]
  onSelect: (action: string) => void
}

let idSeq = 1

// ─── UI 状态壳子 ──────────────────────────────────────────────────────────
// 编辑器命令通道（formatCmd/findTick/大纲跳转等）随渲染内核剥离，
// 保留界面状态与全局组件状态，供后续重构接入新内核。
export const useUiStore = defineStore('ui', {
  state: () => ({
    sidebarVisible: true,
    sidebarTab: 'files' as 'files' | 'outline',
    editorMode: 'wysiwyg' as EditorMode,
    focusMode: false,
    typewriterMode: false,
    toasts: [] as ToastItem[],
    confirmState: null as (ConfirmOptions & { resolve: (v: boolean) => void }) | null,
    promptState: null as
      | { title: string; placeholder: string; value: string; resolve: (v: string | null) => void }
      | null,
    contextMenu: null as ContextMenuState | null,
    cursor: { line: 1, col: 1 },
    booting: true,
    globalSearch: {
      open: false,
      query: '',
      results: [] as SearchResult[],
      loading: false,
      docs: 0,
      fts: 0
    }
  }),
  actions: {
    toast(message: string, type: ToastItem['type'] = 'info', duration = 2600): void {
      const id = idSeq++
      this.toasts.push({ id, message, type })
      setTimeout(() => {
        this.toasts = this.toasts.filter((t) => t.id !== id)
      }, duration)
    },
    confirm(options: ConfirmOptions): Promise<boolean> {
      return new Promise((resolve) => {
        this.confirmState = { ...options, resolve }
      })
    },
    resolveConfirm(v: boolean): void {
      this.confirmState?.resolve(v)
      this.confirmState = null
    },
    prompt(title: string, placeholder: string, value = ''): Promise<string | null> {
      return new Promise((resolve) => {
        this.promptState = { title, placeholder, value, resolve }
      })
    },
    resolvePrompt(v: string | null): void {
      this.promptState?.resolve(v)
      this.promptState = null
    },
    openContextMenu(state: ContextMenuState): void {
      this.contextMenu = state
    },
    closeContextMenu(): void {
      this.contextMenu = null
    },
    openGlobalSearch(): void {
      this.globalSearch.open = true
      this.globalSearch.query = ''
      this.globalSearch.results = []
      void window.luminAPI.db.stats().then((s) => {
        this.globalSearch.docs = s.docs
        this.globalSearch.fts = s.fts
      })
    },
    closeGlobalSearch(): void {
      this.globalSearch.open = false
      this.globalSearch.results = []
      this.globalSearch.loading = false
    }
  }
})
