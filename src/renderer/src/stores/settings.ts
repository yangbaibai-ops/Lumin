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
    setTheme(theme: ThemeMode): void {
      this.set('theme', theme)
    },
    setLanguage(lang: Language): void {
      this.set('language', lang)
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
