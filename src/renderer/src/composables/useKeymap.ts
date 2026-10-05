import { onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useUiStore } from '../stores/ui'
import { useSettingsStore } from '../stores/settings'
import { installKeymap, type KeymapCommand } from '../lib/keymap/service'
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
  const router = useRouter()
  const { handleMenu } = actions

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
      id: 'edit.globalSearch',
      titleKey: 'menu.globalSearch',
      groupKey: 'keymap.groupEdit',
      defaultKeys: 'Mod+Shift+P',
      run: () => handleMenu('global-search')
    },
    {
      id: 'app.settings',
      titleKey: 'menu.settings',
      groupKey: 'keymap.groupEdit',
      defaultKeys: 'Mod+,',
      run: () => handleMenu('settings')
    },

    // ── 视图 ──
    {
      id: 'view.toggleSidebar',
      titleKey: 'menu.toggleSidebar',
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
     * ⚠️ 这一条**收回了 `Mod+Shift+P`**：此前它绑在 `edit.globalSearch`（全局搜索）上。
     *
     * 按需求把 Ctrl+Shift+P 让给命令面板（VS Code / Typora 的通行键）。服务侧的冲突口径是
     * 「同一档里后注册者胜」（`lib/keymap/service.ts` 的 findMatch），所以把面板追加在
     * **命令表末尾**，两条默认键相同时由面板接管 —— 全局搜索本身**没有消失**：
     * 它仍在命令表里（设置 → 快捷键可改绑）、在「编辑」菜单里、也在命令面板里搜得到。
     * 这也让"用户自定义过的绑定优先"照常成立：谁改过 globalSearch 的键，那条仍然赢。
     */
    {
      id: 'app.commandPalette',
      titleKey: 'commandPalette.title',
      groupKey: 'keymap.groupView',
      defaultKeys: 'Mod+Shift+P',
      run: () => ui.toggleCommandPalette()
    }
  ]

  const handle = installKeymap(commands, () => settings.keybindings ?? {})
  onBeforeUnmount(() => handle.dispose())
}
