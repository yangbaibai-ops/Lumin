import { defineStore } from 'pinia'
import type { AppSettings, EffectiveTheme, Language, ThemeMode } from '../../../shared/types'
import { defaultSettings } from '../../../shared/defaults'
import { setLanguage } from '../i18n'

export const useSettingsStore = defineStore('settings', {
  state: (): AppSettings => ({ ...defaultSettings }),
  actions: {
    /**
     * 当前生效的主题（light / dark / sepia）。
     *
     * **故意是方法而不是 getter**：getter 是缓存的计算值，而它的依赖只有 `state.theme`——
     * 「跟随系统」时系统偏好变化**不改 state.theme**，于是缓存会把主题钉死在进入 auto 的那一刻。
     * 实测症状：`useAppActions` 明明监听了 `prefers-color-scheme` 并在变化时调 `applyAll()`，
     * 但 applyAll 取到的是旧值，CSS 主题不跟着翻（只有下一次写设置、theme 真的变了才会刷新）。
     * 现算就没有这个坑，`applyAll()` / mermaid / 导出三处都拿得到实时值。
     */
    resolveTheme(): EffectiveTheme {
      if (this.theme === 'auto') {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      }
      return this.theme
    },
    async init(): Promise<void> {
      const remote = await window.luminAPI.settings.getAll()
      this.$patch(remote)
      this.applyAll()
    },
    /**
     * 主进程侧改了设置（原生菜单的主题项、备份目录选择…）→ 就地把 store 对齐。
     *
     * 报告 §3.2 P0-1：设置此前是"两处真相" —— 主进程可以直接写 kv 而不通知渲染层，
     * 界面就会显示旧值直到重启；反过来 store 的 `persist()` 会把整份设置回写、把主进程
     * 那一步打回去。现在主进程只走 `services/appSettings.ts` 的写入口并广播
     * `settings:changed`，这里订阅它 —— 谁写的都一样，两侧永远同源。
     */
    applyRemote(next: AppSettings): void {
      this.$patch(next)
      this.applyAll()
    },
    /** 应用主题/语言到 DOM */
    applyAll(): void {
      const theme = this.resolveTheme()
      document.documentElement.classList.remove('theme-light', 'theme-dark', 'theme-sepia')
      document.documentElement.classList.add(`theme-${theme}`)
      document.documentElement.classList.toggle('dark', theme === 'dark')
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
        await window.luminAPI.settings.update(
          JSON.parse(JSON.stringify(this.$state)) as AppSettings
        )
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
    /**
     * 应用导入的设置（**整体替换**语义，见主进程 `settings:applyImport` 的说明）：
     * 落库成功后把主进程归一过的整份设置 `$patch` 回来，主题/语言/字体立刻生效。
     * 校验（信封、白名单、隐私字段）不在这里 —— 见 `shared/settingsFile.ts`。
     */
    async applyImport(patch: Partial<AppSettings>): Promise<void> {
      const merged = await window.luminAPI.settings.applyImport(patch)
      this.$patch(merged)
      this.applyAll()
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
