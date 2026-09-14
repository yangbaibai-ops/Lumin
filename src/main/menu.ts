// ─── 主进程：应用菜单 ──────────────────────────────────────────────────────
import { app, BrowserWindow, Menu, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { settingsStore } from './store'

function send(action: string): void {
  const win = BrowserWindow.getFocusedWindow()
  if (win) win.webContents.send('menu:action', action)
}

export function installMenu(): void {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const, label: '关于 Lumin' },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const, label: '隐藏' },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const, label: '退出' }
            ]
          }
        ]
      : []),
    {
      label: '文件(F)',
      // 注意：这里**故意不设 accelerator**。应用级快捷键由渲染层的命令注册表统一接管
      // （renderer/src/lib/keymap/），用户可以在「设置 → 快捷键」里改；若原生菜单也绑一份，
      // 就会出现「用户改了键但原生那份照旧触发」的两套真相 + 重复触发。菜单项保留是为了
      // 系统级可访问性（菜单栏本身由 autoHideMenuBar=false 隐藏）。
      submenu: [
        { label: '新建文档', click: () => send('new') },
        { label: '打开…', click: () => send('open') },
        { label: '打开文件夹…', click: () => send('open-folder') },
        { type: 'separator' },
        { label: '保存', click: () => send('save') },
        { label: '另存为…', click: () => send('save-as') },
        { type: 'separator' },
        {
          label: '导出',
          submenu: [
            { label: '导出为 PDF', click: () => send('export-pdf') },
            { label: '导出为 HTML', click: () => send('export-html') },
            { label: '导出为 Word (.doc)', click: () => send('export-word') },
            { label: '导出为 EPUB', click: () => send('export-epub') }
          ]
        },
        { type: 'separator' },
        isMac ? { role: 'close' as const, label: '关闭窗口' } : { role: 'quit' as const, label: '退出' }
      ]
    },
    {
      label: '编辑(E)',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        { label: '查找 / 替换', click: () => send('find') },
        { label: '全局搜索（全文索引）', click: () => send('global-search') }
      ]
    },
    {
      label: '视图(V)',
      submenu: [
        { label: '切换侧边栏', click: () => send('toggle-sidebar') },
        { type: 'separator' },
        {
          label: '编辑器模式',
          submenu: [
            { label: '所见即所得（实时渲染）', click: () => send('mode-wysiwyg') },
            { label: '分屏对比（渲染 + 源码）', click: () => send('mode-split') },
            { label: '源码模式', click: () => send('mode-source') }
          ]
        },
        { label: '专注模式', click: () => send('toggle-focus') },
        { label: '打字机模式', click: () => send('toggle-typewriter') },
        { type: 'separator' },
        {
          label: '主题',
          submenu: [
            {
              label: '跟随系统',
              click: () => {
                settingsStore.set('theme', 'auto')
                send('theme-changed')
              }
            },
            {
              label: '浅色',
              click: () => {
                settingsStore.set('theme', 'light')
                send('theme-changed')
              }
            },
            {
              label: '深色',
              click: () => {
                settingsStore.set('theme', 'dark')
                send('theme-changed')
              }
            },
            {
              label: '羊皮纸',
              click: () => {
                settingsStore.set('theme', 'sepia')
                send('theme-changed')
              }
            }
          ]
        },
        { type: 'separator' },
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' }
      ]
    },
    {
      label: '帮助(H)',
      submenu: [
        { label: '设置', click: () => send('settings') },
        { label: '关于 Lumin', click: () => send('about') },
        {
          label: '在浏览器中打开项目主页',
          click: () => shell.openExternal('https://github.com')
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
