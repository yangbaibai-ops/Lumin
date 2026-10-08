import { defineStore } from 'pinia'
import type { AppSettings, EffectiveTheme, Language, ThemeMode } from '../../../shared/types'
import { defaultSettings } from '../../../shared/defaults'
import { setLanguage } from '../i18n'
// 行内标记字符的显隐开关 ⇄ 编辑器内核：走**零依赖桥**（store 一侧不认识 ProseMirror，
// 否则整份 PM 会被钉进首屏 entry chunk —— 见 lib/editor/markerVisibility.ts 与 findBridge.ts）
import { setInlineMarkersHidden } from '../lib/editor/markerVisibility'

/**
 * 取消挂起的那次节流写入（`persist()` 排的 250ms 定时器）。
 *
 * 为什么每个"立刻写"的入口都要先取消它：节流队列里那一份携带的是**更早的整份 state**，
 * 它晚到一步就会把刚写下去的新值覆盖回去（实测例子：点「恢复默认设置」后，250ms 前排队的那次
 * 写入带着旧的自定义键位落地 → 盘上又成了自定义）。取消 = 让"最后一次写入"永远是最后发生的。
 */
function cancelPendingPersist(store: unknown): void {
  const holder = store as { _t?: ReturnType<typeof setTimeout> }
  if (holder._t) {
    clearTimeout(holder._t)
    holder._t = undefined
  }
}

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
      // 行内标记字符的显隐（用户口径：默认显示；打开后所见即所得里永不显形）。
      // 放在 applyAll 里是因为它被**五条路径**共用：启动 init / 本地 set / 主进程改了设置
      // (applyRemote) / 导入设置 (applyImport) / 恢复默认 (reset) —— 少一条就会出现
      // "设置页显示已打开、正文里标记还在闪"的不一致。内核收到通知后自己重算显隐装饰，
      // 所以改完立刻生效、不用重开文档（值没变时桥里早退，不惊动内核）。
      setInlineMarkersHidden(this.hideInlineMarkers)
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
    /**
     * 改一条快捷键（spec = null 表示解绑）：立即生效 + 节流落库。
     *
     * ⚠️ **必须用 `$patch(函数)` 换成一个新对象，不能走 `set('keybindings', {...})`**：
     * `$patch(对象)` 对嵌套的普通对象是**深合并**（就地改同一个引用），于是：
     *   * 依赖 `settings.keybindings` 这个**顶层字段**的消费者（设置页的 computed 就是）
     *     不会被通知 —— 引用没变、Vue 的 setter 不 trigger；
     *   * 而运行时那条链（`installKeymap` 的 getter）读的是同一个对象，**键已经生效**。
     * 结果就是用户实测的那句「显示的快捷键和实际使用中依然是默认的」：第一次改绑时
     * 设置页显示旧键、按键却按新键走（同一根因也会让 `applyRemote` 整份 `$patch` 时
     * 页面停在改前的键位）。函数形式会整体替换引用，任何消费者都能收到通知。
     * 同理见下面的 `resetKeybinding` / `resetAllKeybindings`（它们一直是函数形式）。
     */
    setKeybinding(commandId: string, spec: string | null): void {
      this.$patch((s) => {
        s.keybindings = { ...s.keybindings, [commandId]: spec }
      })
      this.applyAll()
      // 键位是**离散动作**（点一下、录一次就完了），不是滑块那种连续输入 —— 没必要进节流队列，
      // 立刻落库才能保证"改完顺手关应用"不丢（见 flush() 的说明）。
      void this.flush()
    },
    /**
     * 恢复某条命令的默认键（删除覆盖项）。
     * 注意用 `$patch(函数)` 而不是对象形式：对象形式对嵌套对象是**深合并**，
     * 被删掉的键会被合并回来（`resetKeybinding` 会看起来没生效）。
     *
     * ⚠️ 光在 store 里删掉还不够：盘上那份旧表也得真的被换掉，否则重启后键位复活
     * （那是主进程侧的合并口径问题，见 `shared/settingsSchema.ts` 的 `mergeSettings`）。
     */
    resetKeybinding(commandId: string): void {
      this.$patch((s) => {
        const next = { ...s.keybindings }
        delete next[commandId]
        s.keybindings = next
      })
      this.applyAll()
      void this.flush()
    },
    /** 全部恢复默认（同上，必须用函数形式才能整体替换 + 立刻落库） */
    resetAllKeybindings(): void {
      this.$patch((s) => {
        s.keybindings = {}
      })
      this.applyAll()
      void this.flush()
    },
    /**
     * 应用导入的设置（**整体替换**语义，见主进程 `settings:applyImport` 的说明）：
     * 落库成功后把主进程归一过的整份设置 `$patch` 回来，主题/语言/字体立刻生效。
     * 校验（信封、白名单、隐私字段）不在这里 —— 见 `shared/settingsFile.ts`。
     */
    async applyImport(patch: Partial<AppSettings>): Promise<void> {
      // 先掐掉挂起的节流写入：它带着**导入前**的整份 state，若在导入落库之后到达，
      // 主进程的合并会把文件里刚写进去的值又打回本机旧值（深合并"后到者赢"）。
      cancelPendingPersist(this)
      const merged = await window.luminAPI.settings.applyImport(patch)
      this.$patch(merged)
      this.applyAll()
    },
    persist(): void {
      cancelPendingPersist(this)
      const t = setTimeout(() => {
        void this.flush()
      }, 250)
      ;(this as unknown as { _t?: ReturnType<typeof setTimeout> })._t = t
    },
    /**
     * **立刻**把整份设置写下去（并取消挂起的那次节流写入）。返回的 promise 可以 await。
     *
     * 谁需要它：
     *   * 键位修改（改绑 / 恢复默认 / 解绑）—— 离散动作，用户点完很可能顺手就关应用。
     *     250ms 的节流窗口 + "关窗不等设置写完"会让这一次修改彻底消失
     *     （用户实测：恢复默认 → 关闭应用 → 重开，键位又变回自定义）；
     *   * **关窗前**（`useAppActions.requestClose`）—— 把任何挂起的设置改动落盘。
     *     这条必须 await：窗口一旦销毁，IPC 与定时器都不再存在。
     *
     * 失败**不外抛**：退出路径上"设置没写成"不该拦住用户关应用（与节流那条老路一致 ——
     * 界面已经是对的，重启后最多回到上一次成功写入的那份，不会出现"显示与盘上不一致"的新状态）。
     */
    async flush(): Promise<void> {
      cancelPendingPersist(this)
      // Pinia state 含响应式代理，需转为纯对象后才能通过 IPC 结构化克隆
      const plain = JSON.parse(JSON.stringify(this.$state)) as AppSettings
      try {
        await window.luminAPI.settings.update(plain)
      } catch {
        /* 落库失败：界面已经是对的，重启后最多回到上一次成功写入的那份 */
      }
    },
    /**
     * 恢复默认设置（全量）。
     *
     * ⚠️ 必须**先掐掉挂起的节流写入**再写默认值：否则 250ms 前排队的那一份（旧的自定义键位等）
     * 会晚一步落地，把"刚恢复的默认值"重新打回自定义 —— 与用户报的"恢复默认后重启又变自定义"
     * 是同一个因果链的另一半。
     */
    async reset(): Promise<void> {
      cancelPendingPersist(this)
      this.$patch({ ...defaultSettings })
      this.applyAll()
      await window.luminAPI.settings.update({ ...defaultSettings })
    }
  }
})
