// ─── 主进程：应用菜单（三语）───────────────────────────────────────────────
//
// 为什么之前是硬编码中文：菜单栏默认被隐藏（autoHideMenuBar=false + 自绘顶栏），
// 只有系统级可访问性（Alt 唤出、屏幕阅读器、Windows 的菜单键）才用到它，于是被当成"没人看"。
// 但**非中文用户按 Alt 看到一整屏中文**是实打实的可用性问题，而且语言切换后菜单不跟着变。
//
// 做法：
//   * 语言包与渲染层**共用同一份**（`src/shared/i18n/*.json`）—— 一处维护，两个进程一致；
//   * 语言取持久化设置（SQLite kv 的 settings.language）；
//   * `settings:update` 里语言变了就重建菜单（见 ipc.ts），不然要重启才生效。
//
// 注意：这里**故意不设 accelerator**。应用级快捷键由渲染层的命令注册表统一接管
// （renderer/src/lib/keymap/），用户可以在「设置 → 快捷键」里改；若原生菜单也绑一份，
// 就会出现「用户改了键但原生那份照旧触发」的两套真相 + 重复触发。
import { app, BrowserWindow, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { settingsStore } from './store'
import { mainLanguage, mainT } from './i18n'
import { EXPORT_FORMATS } from '../shared/exportFormats'

function send(action: string): void {
  const win = BrowserWindow.getFocusedWindow()
  if (win) win.webContents.send('menu:action', action)
}

/**
 * 取菜单文案：语言包与「当前语言」的判定都收在 `main/i18n.ts`（进程内唯一入口）。
 * 这里只负责补上 `menu.` 前缀 —— 菜单键在语言包里就是 `menu.*` 那一块。
 */
function t(key: string): string {
  return mainT(`menu.${key}`)
}

export function installMenu(): void {
  const isMac = process.platform === 'darwin'
  const T = t

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const, label: T('about') },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const, label: T('hide') },
              { role: 'unhide' as const, label: T('unhide') },
              { type: 'separator' as const },
              { role: 'quit' as const, label: T('quit') }
            ]
          }
        ]
      : []),
    {
      label: T('file'),
      submenu: [
        { label: T('new'), click: () => send('new') },
        { label: T('openFile'), click: () => send('open') },
        { label: T('openFolder'), click: () => send('open-folder') },
        { type: 'separator' },
        { label: T('save'), click: () => send('save') },
        { label: T('saveAs'), click: () => send('save-as') },
        { type: 'separator' },
        {
          label: T('export'),
          // 导出子菜单从**唯一清单**派生（审计 §6 P2）：加一种格式不用再来这里补一行
          submenu: EXPORT_FORMATS.map((f) => ({
            label: T(f.labelKey),
            click: () => send(f.menuAction)
          }))
        },
        // 「打印」紧挨着导出，但**不来自** EXPORT_FORMATS：那份清单是"导出格式的唯一清单"，
        // 而打印不落盘、没有输出路径（审计 §7 第 18 条：此前只有 PDF 导出，没有真打印机）。
        { label: T('print'), click: () => send('print') },
        { type: 'separator' },
        isMac
          ? { role: 'close' as const, label: T('closeWindow') }
          : { role: 'quit' as const, label: T('quit') }
      ]
    },
    {
      label: T('edit'),
      submenu: [
        { role: 'undo', label: T('undo') },
        { role: 'redo', label: T('redo') },
        { type: 'separator' },
        { role: 'cut', label: T('cut') },
        { role: 'copy', label: T('copy') },
        { role: 'paste', label: T('paste') },
        { role: 'selectAll', label: T('selectAll') },
        { type: 'separator' },
        { label: T('findReplace'), click: () => send('find') },
        { label: T('replace'), click: () => send('replace') },
        { label: T('globalSearch'), click: () => send('global-search') }
      ]
    },
    {
      label: T('view'),
      submenu: [
        { label: T('toggleSidebar'), click: () => send('toggle-sidebar') },
        { label: T('toggleToolbar'), click: () => send('toggle-toolbar') },
        // 大纲位置（左栏 ⇄ 编辑区右侧）。原生菜单这份文案是**静态**的（菜单在语言/设置变化时才重建），
        // 所以用中性名词「大纲位置（左/右）」而不是「移到右侧」这种带方向的动词 —— 方向取决于当前状态。
        { label: T('outlineSide'), click: () => send('outline-side') },
        { type: 'separator' },
        {
          label: T('editorMode'),
          submenu: [
            { label: T('wysiwyg'), click: () => send('mode-wysiwyg') },
            { label: T('split'), click: () => send('mode-split') },
            { label: T('source'), click: () => send('mode-source') }
          ]
        },
        { label: T('focus'), click: () => send('toggle-focus') },
        // 「打字机模式」已摘掉：它此前只弹一句「功能待接入」（审计 §7）
        { type: 'separator' },
        {
          label: T('theme'),
          submenu: [
            {
              label: T('themeAuto'),
              click: () => {
                settingsStore.set('theme', 'auto')
                send('theme-changed')
              }
            },
            {
              label: T('themeLight'),
              click: () => {
                settingsStore.set('theme', 'light')
                send('theme-changed')
              }
            },
            {
              label: T('themeDark'),
              click: () => {
                settingsStore.set('theme', 'dark')
                send('theme-changed')
              }
            },
            {
              label: T('themeSepia'),
              click: () => {
                settingsStore.set('theme', 'sepia')
                send('theme-changed')
              }
            }
          ]
        },
        { type: 'separator' },
        { role: 'reload', label: T('reload') },
        { role: 'toggleDevTools', label: T('devtools') }
      ]
    },
    {
      label: T('help'),
      submenu: [
        { label: T('settings'), click: () => send('settings') },
        { label: T('about'), click: () => send('about') }
        // 这里原来有一项「主页」→ `shell.openExternal('https://github.com')`：
        // 打开的是 **GitHub 首页**，不是本项目的仓库（`package.json` 的 homepage 也还是
        // electron-vite 脚手架模板值）。指向一个无关站点比没有这一项更糟 —— 用户点了会以为
        // 自己走错了地方。等仓库地址确定后再加回来：
        //   { label: T('homepage'), click: () => shell.openExternal(<真实仓库地址>) }
        // 同时记得把 `package.json` 的 homepage/repository 补上。
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  // 自检日志（**ASCII**，便于脚本 grep）：验收脚本读实例 stdout 就能确认
  // 「原生菜单确实按新语言重建了」—— 菜单栏默认隐藏，页面侧看不到它，这是唯一可自动验证的观察点。
  console.log(`[menu] rebuilt lang=${mainLanguage()} top=${template.length}`)
}
