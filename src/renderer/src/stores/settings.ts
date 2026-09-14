import { defineStore } from 'pinia'
import type { AppSettings, EffectiveTheme, Language, ThemeMode } from '../../../shared/types'
import { defaultSettings } from '../../../shared/defaults'
import { setLanguage } from '../i18n'

export const useSettingsStore = defineStore('settings', {
  state: (): AppSettings => ({ ...defaultSettings }),
  getters: {
    effectiveTheme(state): EffectiveTheme {
      if (state.theme === 'auto') {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      }
      return state.theme
    }
  },
  actions: {
    async init(): Promise<void> {
      const remote = await window.luminAPI.settings.getAll()
      this.$patch(remote)
      this.applyAll()
    },
    /** 应用主题/语言到 DOM */
    applyAll(): void {
      document.documentElement.classList.remove('theme-light', 'theme-dark', 'theme-sepia')
      document.documentElement.classList.add(`theme-${this.effectiveTheme}`)
      document.documentElement.classList.toggle('dark', this.effectiveTheme === 'dark')
      document.documentElement.style.setProperty('--editor-size', `${this.fontSize}px`)
      document.documentElement.style.setProperty('--editor-lh', String(this.lineHeight))
      document.documentElement.style.setProperty('--editor-font', this.fontFamily)
      setLanguage(this.language)
    },
    /** 更新设置：立即应用（主题/语言/字体）并节流持久化 */
    set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
      this.$patch({ [key]: value } as Partial<AppSettings>)
      this.applyAll()
      this.persist()
    },
    async setTheme(theme: ThemeMode): Promise<void> {
      this.$patch({ theme } as Partial<AppSettings>)
      // auto 主题依赖渲染层的 prefers-color-scheme，而它反映主进程 nativeTheme.themeSource。
      // 若直接 applyAll，切到 auto 时会沿用上一个显式主题（如 dark）的 themeSource，
      // 导致 CSS 仍停留深色、只有原生标题栏（nativeTheme）更新为系统浅色。
      // 因此先 await settings:update（主进程同步 themeSource：auto→system），
      // 等媒体查询传播后再重算主题，auto 才能正确跟随系统。
      try {
        await window.luminAPI.settings.update(JSON.parse(JSON.stringify(this.$state)) as AppSettings)
        await new Promise<void>((resolve) => setTimeout(resolve, 60))
      } finally {
        this.applyAll()
      }
    },
    setLanguage(lang: Language): void {
      this.set('language', lang)
    },
    /** 改一条快捷键（spec = null 表示解绑）；走 set 以便立即生效 + 节流落库 */
    setKeybinding(commandId: string, spec: string | null): void {
      this.set('keybindings', { ...this.keybindings, [commandId]: spec })
    },
    /**
     * 恢复某条命令的默认键（删除覆盖项）。
     * 注意用 `$patch(函数)` 而不是对象形式：对象形式对嵌套对象是**深合并**，
     * 被删掉的键会被合并回来（`resetKeybinding` 会看起来没生效）。
     */
    resetKeybinding(commandId: string): void {
      this.$patch((s) => {
        const next = { ...s.keybindings }
        delete next[commandId]
        s.keybindings = next
      })
      this.applyAll()
      this.persist()
    },
    /** 全部恢复默认（同上，必须用函数形式才能整体替换） */
    resetAllKeybindings(): void {
      this.$patch((s) => {
        s.keybindings = {}
      })
      this.applyAll()
      this.persist()
    },
    persist(): void {
      clearTimeout((this as unknown as { _t?: ReturnType<typeof setTimeout> })._t)
      const t = setTimeout(() => {
        // Pinia state 含响应式代理，需转为纯对象后才能通过 IPC 结构化克隆
        const plain = JSON.parse(JSON.stringify(this.$state)) as AppSettings
        window.luminAPI.settings.update(plain).catch(() => {})
      }, 250)
      ;(this as unknown as { _t?: ReturnType<typeof setTimeout> })._t = t
    },
    async reset(): Promise<void> {
      this.$patch({ ...defaultSettings })
      this.applyAll()
      await window.luminAPI.settings.update({ ...defaultSettings })
    }
  }
})
