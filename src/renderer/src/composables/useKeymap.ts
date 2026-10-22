import { onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useUiStore } from '../stores/ui'
import { useSettingsStore } from '../stores/settings'
import { useEditorMenuStore } from '../stores/editorMenu'
import { disposeKeymap, installKeymap, type KeymapCommand } from '../lib/keymap/service'
import { EXPORT_FORMATS } from '../../../shared/exportFormats'
import type { useAppActions } from './useAppActions'

/**
 * ─── 应用级命令表（快捷键的唯一声明处）─────────────────────────────────────
 * 每一项 = 一条可被快捷键触发的命令：
 *   - `titleKey` 尽量复用菜单里的同一批 i18n 键，设置界面与菜单文案天然一致；
 *   - `run` 统一走 `handleMenu(action)`（原生菜单也走它），因此**同一条命令只有一份实现**；
 *   - `defaultKeys` 是默认键；用户改过的以用户设置为准（见 lib/keymap/service.ts）。
 *
 * 新增一条快捷键 = 在下面加一项即可：默认键、设置界面、冲突检测、恢复默认全部自动生效。
 *
 * 范围说明：这里管**应用级**命令。编辑器内部的排版键（Ctrl+B/I/U、Ctrl+Z/Y 等）由
 * ProseMirror / CodeMirror 自己的 keymap 处理，属于编辑器内核语义，不在此表内。
 */
export function useKeymap(actions: ReturnType<typeof useAppActions>): void {
  const ui = useUiStore()
  const settings = useSettingsStore()
  const editorMenu = useEditorMenuStore()
  const router = useRouter()
  const { handleMenu } = actions

  /**
   * 插入类命令统一转给编辑器右键菜单的动作目录（lib/editor/menu/actions.ts）：
   * 表格 / 分割线 / 图片 / 链接 / 代码块 / 公式 / Mermaid 的实现只有那一份，
   * 快捷键只是"多一个入口"。动作返回 false（用户取消 / 没有编辑器）时什么都不做。
   */
  const runInsert = (id: string) => () => void editorMenu.runById(id)

  const commands: KeymapCommand[] = [
    // ── 文件 ──
    {
      id: 'file.new',
      titleKey: 'menu.new',
      groupKey: 'keymap.groupFile',
      defaultKeys: 'Mod+N',
      run: () => handleMenu('new')
    },
    {
      id: 'file.newWindow',
      titleKey: 'menu.newWindow',
      groupKey: 'keymap.groupFile',
      defaultKeys: 'Mod+Shift+N',
      run: () => handleMenu('new-window')
    },
    {
      id: 'file.open',
      titleKey: 'menu.openFile',
      groupKey: 'keymap.groupFile',
      defaultKeys: 'Mod+O',
      run: () => handleMenu('open')
    },
    {
      id: 'file.openFolder',
      titleKey: 'menu.openFolder',
      groupKey: 'keymap.groupFile',
      defaultKeys: 'Mod+Shift+O',
      run: () => handleMenu('open-folder')
    },
    {
      id: 'file.save',
      titleKey: 'menu.save',
      groupKey: 'keymap.groupFile',
      defaultKeys: 'Mod+S',
      run: () => handleMenu('save')
    },
    {
      id: 'file.saveAs',
      titleKey: 'menu.saveAs',
      groupKey: 'keymap.groupFile',
      defaultKeys: 'Mod+Shift+S',
      run: () => handleMenu('save-as')
    },
    // 四个导出命令从**唯一清单**派生（审计 §6 P2）：加一种格式只改 shared/exportFormats.ts
    ...EXPORT_FORMATS.map((f) => ({
      id: f.commandId,
      titleKey: f.labelKey,
      groupKey: 'keymap.groupExport',
      defaultKeys: f.defaultKeys,
      run: () => handleMenu(f.menuAction)
    })),
    {
      // 打印（审计 §7 第 18 条）：**不属于导出格式**（不落盘、没有输出文件），
      // 所以它不在上面那张清单里，只有这一条独立命令。
      // Ctrl+P 是各家的打印键；已核对整张表：Mod+P 此前无人占用
      // （Mod+Shift+P 是全局搜索，两者不同）。
      id: 'file.print',
      titleKey: 'menu.print',
      groupKey: 'keymap.groupExport',
      defaultKeys: 'Mod+P',
      run: () => handleMenu('print')
    },
    {
      id: 'file.closeWindow',
      titleKey: 'keymap.closeWindow',
      groupKey: 'keymap.groupWindow',
      defaultKeys: 'Mod+W',
      run: () => window.luminAPI.app.close()
    },

    // ── 编辑 ──
    {
      /**
       * 粘贴为纯文本：用户自救入口的键盘版（菜单/右键菜单/通知按钮走同一个 handleMenu）。
       * `Mod+Shift+V` 与浏览器/其他编辑器一致；此前全仓没有这条绑定。
       * 不设 `when: 'notInInput'`：源码模式的 textarea 也是编辑面，快捷键必须在里面生效。
       */
      id: 'edit.pastePlain',
      titleKey: 'editorMenu.pastePlain',
      groupKey: 'keymap.groupEdit',
      defaultKeys: 'Mod+Shift+V',
      run: () => handleMenu('paste-plain')
    },
    {
      id: 'edit.findReplace',
      titleKey: 'menu.findReplace',
      groupKey: 'keymap.groupEdit',
      defaultKeys: 'Mod+F',
      // 打开查找栏（替换行收起；要替换用 Ctrl+H 或栏里的折叠三角）。
      // 不再限制 `when: 'notInInput'`：Ctrl+F 在各家编辑器里都是「就地查找」，
      // 在查找框里再按一次也应该把它关掉，而不是漏给输入框。
      run: () => handleMenu('find')
    },
    {
      id: 'edit.replace',
      titleKey: 'menu.replace',
      groupKey: 'keymap.groupEdit',
      defaultKeys: 'Mod+H',
      run: () => handleMenu('replace')
    },
    {
      /**
       * 全局搜索（全文索引）。
       *
       * ⚠️ `defaultKeys` 是 **null**（出厂不绑键），这是有条理的口径而不是"忘了写"：
       * `Mod+Shift+P` 已经被下面的命令面板拿走（VS Code / 主流编辑器的通行键），而**同一张表里
       * 两条命令写同一个默认键**会同时坏两件事（用户实测的"改绑了但没用"）：
       *   1. 设置页对这两条永久显示「冲突」徽标；
       *   2. 改绑其中一条后，旧键会被**另一条**接管 —— 用户按旧键仍看到默认行为，
       *      于是判定"我改的这个快捷键根本没生效"（`findMatch` 的「用户自定义优先」只在
       *      同一个键上比高低，它不会把另一条命令的默认键一起让出来）。
       * 现在这条键只属于命令面板：改绑面板 = 真的把 Ctrl+Shift+P 让出去。
       * 全局搜索本身**没有消失**：它在「编辑」菜单、命令面板里，也仍可在设置里重新绑一个键。
       */
      id: 'edit.globalSearch',
      titleKey: 'menu.globalSearch',
      groupKey: 'keymap.groupEdit',
      defaultKeys: null,
      run: () => handleMenu('global-search')
    },
    {
      id: 'app.settings',
      titleKey: 'menu.settings',
      groupKey: 'keymap.groupEdit',
      defaultKeys: 'Mod+,',
      run: () => handleMenu('settings')
    },

    // ── 插入（默认键避开已有注册表：Mod+K 属快捷键设置，故链接用 Mod+Alt+K）──
    {
      id: 'insert.table',
      titleKey: 'editorMenu.table',
      groupKey: 'keymap.groupInsert',
      defaultKeys: 'Mod+Alt+T',
      run: runInsert('insert.table')
    },
    {
      id: 'insert.hr',
      titleKey: 'editorMenu.hr',
      groupKey: 'keymap.groupInsert',
      defaultKeys: 'Mod+Alt+H',
      run: runInsert('insert.hr')
    },
    {
      id: 'insert.image',
      titleKey: 'editorMenu.image',
      groupKey: 'keymap.groupInsert',
      // macOS 的 Cmd+Alt+I 是 Chromium 的 DevTools（既有契约必须保留），
      // 因此按用户给的"冲突就换"口径加 Shift
      defaultKeys: 'Mod+Alt+Shift+I',
      run: runInsert('insert.image')
    },
    {
      id: 'insert.link',
      titleKey: 'editorMenu.link',
      groupKey: 'keymap.groupInsert',
      // Ctrl/Cmd+K 已被 help.keymap（打开快捷键设置）占用 ⇒ 按用户给的备选落到 Alt+K
      defaultKeys: 'Mod+Alt+K',
      run: runInsert('insert.link')
    },
    {
      id: 'insert.codeBlock',
      titleKey: 'editorMenu.codeBlock',
      groupKey: 'keymap.groupInsert',
      // 同「插入图片」：macOS 的 Cmd+Alt+C 是 DevTools，加 Shift 避开
      defaultKeys: 'Mod+Alt+Shift+C',
      run: runInsert('paragraph.codeBlock')
    },
    {
      id: 'insert.math',
      titleKey: 'editorMenu.math',
      groupKey: 'keymap.groupInsert',
      defaultKeys: 'Mod+Alt+M',
      run: runInsert('insert.math')
    },
    {
      id: 'insert.mermaid',
      titleKey: 'editorMenu.mermaid',
      groupKey: 'keymap.groupInsert',
      defaultKeys: 'Mod+Alt+G',
      run: runInsert('insert.mermaid')
    },
    // 上/下插入段落：`Mod+Alt+↑/↓` 此前未被任何命令占用（APP_OWNED_COMBOS 里已登记）
    {
      id: 'insert.paragraphAbove',
      titleKey: 'editorMenu.paragraphAbove',
      groupKey: 'keymap.groupInsert',
      defaultKeys: 'Mod+Alt+ArrowUp',
      run: runInsert('insert.paragraphAbove')
    },
    {
      id: 'insert.paragraphBelow',
      titleKey: 'editorMenu.paragraphBelow',
      groupKey: 'keymap.groupInsert',
      defaultKeys: 'Mod+Alt+ArrowDown',
      run: runInsert('insert.paragraphBelow')
    },

    // ── 视图 ──
    {
      /**
       * 侧边栏显隐：用户点名的 **Ctrl/Cmd+Shift+L**（已核对整张表，此前无占用）。
       * 旧键 Ctrl/Cmd+Shift+B 保留为下一条独立命令，老用户按原来的键仍然有效；
       * 两条是同一个动作（同一个 handleMenu），只是键位不同、不会互相抢。
       */
      id: 'view.toggleSidebar',
      titleKey: 'menu.toggleSidebar',
      groupKey: 'keymap.groupView',
      defaultKeys: 'Mod+Shift+L',
      run: () => handleMenu('toggle-sidebar')
    },
    {
      id: 'view.toggleSidebarLegacy',
      titleKey: 'menu.toggleSidebarLegacy',
      groupKey: 'keymap.groupView',
      defaultKeys: 'Mod+Shift+B',
      run: () => handleMenu('toggle-sidebar')
    },
    {
      id: 'view.focusMode',
      titleKey: 'menu.focus',
      groupKey: 'keymap.groupView',
      defaultKeys: 'Mod+Shift+F',
      run: () => handleMenu('toggle-focus')
    },
    {
      // 大纲位置（左栏 ⇄ 编辑区右侧）：与鼠标入口同一动作，出厂**不绑键**
      // （与三条模式命令同一处理：功能可用，但不必占用一个全局键位）
      id: 'view.outlineSide',
      titleKey: 'menu.outlineSide',
      groupKey: 'keymap.groupView',
      defaultKeys: null,
      run: () => handleMenu('outline-side')
    },
    {
      id: 'view.modeWysiwyg',
      titleKey: 'editor.wysiwyg',
      groupKey: 'keymap.groupView',
      defaultKeys: null,
      run: () => handleMenu('mode-wysiwyg')
    },
    {
      id: 'view.modeSplit',
      titleKey: 'editor.split',
      groupKey: 'keymap.groupView',
      defaultKeys: null,
      run: () => handleMenu('mode-split')
    },
    {
      id: 'view.modeSource',
      titleKey: 'editor.source',
      groupKey: 'keymap.groupView',
      defaultKeys: null,
      run: () => handleMenu('mode-source')
    },
    {
      id: 'view.cycleMode',
      titleKey: 'keymap.cycleMode',
      groupKey: 'keymap.groupView',
      defaultKeys: 'Mod+/',
      run: () => handleMenu('cycle-mode')
    },

    // ── 窗口 ──
    // Ctrl+Tab：应用内快速切换窗口（Alt+Tab 的「应用内版本」）；主进程按窗口顺序循环
    {
      id: 'window.next',
      titleKey: 'keymap.nextWindow',
      groupKey: 'keymap.groupWindow',
      defaultKeys: 'Mod+Tab',
      run: () => window.luminAPI.app.cycleWindow(1)
    },
    {
      id: 'window.prev',
      titleKey: 'keymap.prevWindow',
      groupKey: 'keymap.groupWindow',
      defaultKeys: 'Mod+Shift+Tab',
      run: () => window.luminAPI.app.cycleWindow(-1)
    },
    {
      id: 'window.minimize',
      titleKey: 'keymap.minimizeWindow',
      groupKey: 'keymap.groupWindow',
      defaultKeys: null,
      run: () => window.luminAPI.app.minimize()
    },

    // ── 帮助 ──
    {
      id: 'help.about',
      titleKey: 'menu.about',
      groupKey: 'keymap.groupHelp',
      defaultKeys: null,
      run: () => void router.push('/about')
    },
    {
      id: 'help.keymap',
      titleKey: 'keymap.openKeymapSettings',
      groupKey: 'keymap.groupHelp',
      defaultKeys: 'Mod+K',
      run: () => ui.openSettings('keymap')
    },

    // ── 命令面板 ──
    /**
     * ⚠️ `Mod+Shift+P` 的**唯一**主人（VS Code / 主流编辑器的通行键）。
     *
     * 这条键原先在 `edit.globalSearch` 上，迁移时曾经"两条命令都保留这个默认键、靠
     * `findMatch` 的后注册者胜来定胜负"——那是**隐性第二真相**：表面能用，但设置页会永久
     * 报「冲突」，而且用户改绑面板之后旧键会被 globalSearch 的默认键接管（看着像"改绑没生效"）。
     * 现在全局搜索的默认键是 null（见上面的说明），这条键只属于面板：
     * 「改绑面板 = 真的让出 Ctrl+Shift+P」。
     * 全局搜索没有消失 —— 「编辑」菜单、命令面板里都在，也仍可在设置里绑一个新键。
     */
    {
      id: 'app.commandPalette',
      titleKey: 'commandPalette.title',
      groupKey: 'keymap.groupView',
      defaultKeys: 'Mod+Shift+P',
      run: () => ui.toggleCommandPalette()
    }
  ]

  /**
   * 单一真相源（改这里之前先读）：
   *   * **键位**只有两份数据 —— 上面这张命令表的 `defaultKeys`（代码）+ `settings.keybindings`
   *     （用户覆盖，SQLite）；`lib/keymap/service.ts` 把它们解析成"当前生效键"，设置界面与
   *     全局键盘分发读的都是这一份；
   *   * **不许再出现第三份**：不在组件里写 `addEventListener('keydown')` 抢应用级组合键
   *     （审计 D10 的 GlobalSearch 硬编码 Ctrl+Shift+P 就是反例），也不在别处抄一张默认键表。
   *     否则「设置里显示什么 / 按下去走什么」必然分叉 —— 用户看到的就是"快捷键是假的"。
   *     需要新键位 = 在这张表里加一条命令（设置界面 / 冲突检测 / 恢复默认 / 持久化全都自动有）。
   */
  installKeymap(commands, () => settings.keybindings ?? {})
  // 用 disposeKeymap（而不是 install 返回的 handle）：改键位时 service 会**同步重建**监听，
  // 旧 handle 已经不是当前那一份了；按模块单例收尾才不会在卸载后留下一个孤儿监听。
  onBeforeUnmount(disposeKeymap)
}
