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

export interface FormatCommand {
  id: number
  action:
    | 'bold'
    | 'italic'
    | 'strike'
    | 'inlineCode'
    | 'heading'
    | 'quote'
    | 'ul'
    | 'ol'
    | 'task'
    | 'codeBlock'
    | 'link'
    | 'image'
    | 'table'
    | 'hr'
    | 'math'
    | 'undo'
    | 'redo'
  payload?: string
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
    formatCmd: null as FormatCommand | null,
    findTick: 0,
    scrollToHeadingTick: 0,
    headingToScroll: null as number | null,
    activeHeading: -1,
    exportTick: 0,
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
    sendFormat(action: FormatCommand['action'], payload?: string): void {
      this.formatCmd = { id: idSeq++, action, payload }
    },
    requestFind(): void {
      this.findTick++
    },
    scrollToHeading(index: number): void {
      this.headingToScroll = index
      this.scrollToHeadingTick++
    },
    setActiveHeading(index: number): void {
      this.activeHeading = index
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
    },
    requestExport(): void {
      this.exportTick++
    }
  }
})
