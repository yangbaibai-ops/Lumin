import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AppSettings, ExportPayload, EpubMeta, LuminAPI, MenuAction } from '../shared/types'

/** 解析主进程通过 additionalArguments 传入的「新窗口要打开的文件路径」 */
const startupFile: string | null = (() => {
  const arg = process.argv.find((a) => a.startsWith('--lumin-open='))
  if (!arg) return null
  return decodeURIComponent(arg.slice(arg.indexOf('=') + 1))
})()

/** 「新窗口要作为工作区打开的文件夹」（最近文件夹 → 新窗口） */
const startupFolder: string | null = (() => {
  const arg = process.argv.find((a) => a.startsWith('--lumin-open-folder='))
  if (!arg) return null
  return decodeURIComponent(arg.slice(arg.indexOf('=') + 1))
})()

/** 「新建窗口」的干净窗口标记：不继承当前工作区（见主进程 WindowOpenOptions.noWorkspace） */
const startupNoWorkspace: boolean = process.argv.includes('--lumin-no-workspace=1')

/** 本窗口的会话槽位（主进程分配；null = 不参与会话恢复） */
const sessionSlot: number | null = (() => {
  const arg = process.argv.find((a) => a.startsWith('--lumin-session-slot='))
  if (!arg) return null
  const n = Number(arg.slice(arg.indexOf('=') + 1))
  return Number.isInteger(n) && n >= 0 ? n : null
})()

/**
 * 「启动窗口」标记：槽位**延迟分配**（启动性能：窗口先建出来、库后开）。
 * 带这个标记的窗口在恢复会话前调一次 `app.claimStartupSlot` 拿自己的槽位
 * （恢复计划的 head，或新槽位）。见 main/index.ts 的 createWindow / ipc.ts 的同名通道。
 */
const startupRestoreHead: boolean = process.argv.includes('--lumin-startup-head=1')

/**
 * 启动验收用的「人为慢渲染」延迟（ms，默认 0）：主进程从 `LUMIN_BOOT_DELAY_MS` 读入，
 * 只经 additionalArguments 传给窗口（不落设置、不影响其它实例）。渲染层在 bootstrap
 * 最前面等这么久，用来验证「JS 迟迟挂不上时骨架仍然可见、不白屏」。
 */
const bootDelayMs: number = (() => {
  const arg = process.argv.find((a) => a.startsWith('--lumin-boot-delay-ms='))
  if (!arg) return 0
  const n = Number(arg.slice(arg.indexOf('=') + 1))
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 30000) : 0
})()

/**
 * 主进程 → 渲染层**出站通道白名单**（清单 §4 P2「`events.on(channel, cb)` 没有通道白名单」）。
 *
 * 为什么要有：`ipcRenderer.on` 本身不校验通道名，被注入的页面可以注册任意通道的监听 ——
 * 虽然当前没有任何"把敏感数据广播到任意通道"的发送点，但这条口子会让"以后随手加一个
 * 广播通道"变成静默的越权面。白名单是**唯一真相源**：新增出站通道必须同时加进这里，
 * `tests/i18nAndIpc.test.mjs` 会拿主进程真实的 `webContents.send(...)` 跟它对账
 * （少登记 = 渲染层收不到；多登记 = 死条目，两条都会被测试拦下）。
 */
const EVENT_CHANNELS = [
  'menu:action',
  'app:before-close',
  'workspace:changed',
  'workspace:indexProgress',
  /**
   * 「当前打开的文档被其他应用改了」（第一百零八轮）：主进程的目录监听 + stat 轮询发现
   * 外部改动后推这一条，渲染层据此弹「检测到内容已被修改，是否重新加载」。
   */
  'doc:externalChange',
  'notifications:changed',
  'update:status',
  /**
   * 正文右键时的拼写参数（`misspelledWord` / `dictionarySuggestions`）。
   * 正文的 DOM contextmenu 有意不 preventDefault，主进程拿到 Chromium 的参数后回发这一条；
   * 渲染层据此决定自绘菜单顶部是否出现「建议 / 添加到词典 / 忽略」。
   */
  'spell:context',
  /**
   * 主进程改了设置（原生菜单的主题项、备份目录选择…）→ 渲染层就地把 store patch 回来。
   * 这条是报告 §3.2 P0-1 的收口：设置曾经有"两处真相"（主进程直接写 kv、渲染层不知道），
   * 现在主进程只走 `services/appSettings.ts` 的写入口，写完广播这条。
   */
  'settings:changed',
  /**
   * 主进程的防卡死通知（第一百一十轮）：无响应/恢复，以及重载前的 `flush-draft`。
   * 渲染层只在收到 `flush-draft` 时落一次草稿并回 `freeze:draftAck`。
   */
  'app:freeze'
] as const

const EVENT_CHANNEL_SET: ReadonlySet<string> = new Set(EVENT_CHANNELS)

// Custom APIs for renderer
const api: LuminAPI = {
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getPlatform: () => ipcRenderer.invoke('app:getPlatform'),
    getAbout: () => ipcRenderer.invoke('app:getAbout'),
    // 诊断信息（纯文本，不含文档内容）与"打开日志目录"（不接受参数：固定打开我们自己的日志目录）
    getDiagnostics: () => ipcRenderer.invoke('app:getDiagnostics'),
    // 日志路径（状态栏/关于展示用）：主进程算好，不接受参数
    getLogPaths: () => ipcRenderer.invoke('app:getLogPaths'),
    // 「导出启动诊断」：主进程弹保存对话框并写文件（启动日志已脱敏）
    exportStartupDiagnostics: () => ipcRenderer.invoke('app:exportStartupDiagnostics'),
    /**
     * 启动打点上报（单向）：只在启动阶段发几条，主进程写 `<userData>/logs/startup.log`。
     * 载荷只有 stage 名与 performance mark 的毫秒数 —— 不包含文档内容或路径。
     */
    reportStartup: (payload) => ipcRenderer.send('startup:report', payload),
    openLogDir: () => ipcRenderer.invoke('app:openLogDir'),
    /**
     * 开发者工具（顶部工具栏那项）：F12 那条隐式入口已拆掉（见 main/index.ts 的显式快捷键表），
     * 这里是唯一由渲染层发起的入口 —— 主进程用 `mode: 'detach'` 开，返回值可观测。
     */
    openDevTools: () => ipcRenderer.invoke('app:openDevTools'),
    closeDevTools: () => ipcRenderer.invoke('app:closeDevTools'),
    confirmClose: () => ipcRenderer.invoke('app:confirmClose'),
    /** 关窗确认里点了「取消」：让主进程撤掉这一轮的兜底守卫（否则 2.5s/30s 到点仍会强关） */
    cancelClose: () => ipcRenderer.send('app:cancelClose'),
    /**
     * 关窗流程中的心跳：主进程据此延长兜底时限（见 main/ipc.ts 的 attachCloseGuard）。
     * `deciding: true` = 正等用户回答「是否保存更改？」：主进程会把这一段等待排除在
     * 30 秒总上限之外（用户在对话框前想多久都合法，卡死仍由"心跳停了"兜底）。
     */
    closeProgress: (opts?: { deciding?: boolean }) => ipcRenderer.send('app:closeProgress', opts),
    minimize: () => ipcRenderer.send('app:minimize'),
    toggleMaximize: () => ipcRenderer.send('app:toggleMaximize'),
    close: () => ipcRenderer.send('app:close'),
    /** 退出应用（应用菜单「文件 → 退出」）：走 app.quit()，每个窗口仍会经过关窗守卫 */
    quit: () => ipcRenderer.send('app:quit'),
    /**
     * 手动检查更新（「帮助 → 检查更新」）。返回是否真的发起了检查：
     * 开发态/未配置更新渠道时为 false，界面据此给出如实提示而不是假装在检查。
     */
    checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
    setMenuBar: (visible) => ipcRenderer.send('app:setMenuBar', visible),
    newWindow: () => ipcRenderer.send('app:newWindow'),
    openInNewWindow: (path) => ipcRenderer.send('app:openInNewWindow', path),
    openFolderInNewWindow: (path) => ipcRenderer.send('app:openFolderInNewWindow', path),
    /** 上报「本窗口当前打开的文档」：主进程据此避免同一个文件被两个窗口重复打开 */
    reportWindowDoc: (path) => ipcRenderer.send('window:docPath', path),
    /** 该文件若已开在别的窗口 → 把那个窗口唤到前面并返回 'focused'；否则 'not-open' */
    focusWindowByDoc: (path) => ipcRenderer.invoke('window:focusByDoc', path),
    /** 应用内切换窗口：delta = +1 下一个 / -1 上一个（默认 Ctrl+Tab / Ctrl+Shift+Tab） */
    cycleWindow: (delta) => ipcRenderer.invoke('window:cycle', delta),
    startupFile,
    startupFolder,
    startupNoWorkspace,
    sessionSlot,
    startupRestoreHead,
    bootDelayMs,
    /**
     * 启动窗口专用：向主进程认领会话槽位（恢复计划的 head / 新槽位）。
     * 非启动窗口返回 null；同一窗口重复调用幂等。
     */
    claimStartupSlot: () => ipcRenderer.invoke('app:claimStartupSlot')
  },
  file: {
    // opts.softDefault：encoding 只是「打开文件时的设置默认值」时传 true ——
    // 主进程会让该文件**已记录的编码**优先（见 ipc.ts 的 file:read 注释）
    read: (path, encoding, opts) => ipcRenderer.invoke('file:read', path, encoding, opts),
    // eol：文档记录的行尾（'lf'/'crlf'）。主进程在写盘前展开，见 shared/eol.ts
    // expectMtimeMs：我们上次读/写这份文件时的真实 mtime —— 主进程用它检测**外部改动**
    // （不一致就不写，回报 conflict；见 ipc.ts 的 file:write 与审计 §2 P1）
    write: (path, content, encoding, hadBom, eol, expectMtimeMs) =>
      ipcRenderer.invoke('file:write', path, content, encoding, hadBom, eol, expectMtimeMs),
    rememberEncoding: (path, encoding) =>
      ipcRenderer.invoke('file:rememberEncoding', path, encoding),
    readDir: (dir) => ipcRenderer.invoke('file:readDir', dir),
    scanWorkspace: (root) => ipcRenderer.invoke('file:scanWorkspace', root),
    createFile: (path) => ipcRenderer.invoke('file:createFile', path),
    createDir: (path) => ipcRenderer.invoke('file:createDir', path),
    remove: (path) => ipcRenderer.invoke('file:remove', path),
    rename: (oldPath, newPath) => ipcRenderer.invoke('file:rename', oldPath, newPath),
    exists: (path) => ipcRenderer.invoke('file:exists', path),
    /** 这个路径是不是目录（拖入的落点分流用：文件走打开文件、目录走打开文件夹） */
    isDirectory: (path) => ipcRenderer.invoke('file:isDirectory', path),
    /**
     * 两个路径是不是同一个位置（大小写 / 分隔符 / `.` `..` / 符号链接 / 8.3 短名都归一到一处比较）。
     * 判据在主进程（`pathGuard.sameResolvedPath` + `fileOps.isSamePath`），渲染层不手搓比较。
     */
    isSamePath: (a, b) => ipcRenderer.invoke('file:isSamePath', a, b),
    /** 只要 mtime（外部改动检测用；不必把整篇正文搬过来） */
    mtime: (path) => ipcRenderer.invoke('file:mtime', path),
    /**
     * 申报本窗口当前打开的文档，交给主进程做**外部改动监测**（第一百零八轮）。
     * `path = null` = 未命名文档/已关闭 ⇒ 停掉监测；`mtimeMs` = 起始基线（防止刚打开就误报）。
     */
    watchDocument: (path, mtimeMs) => ipcRenderer.invoke('file:watchDocument', path, mtimeMs),
    chooseOpenFile: () => ipcRenderer.invoke('file:chooseOpenFile'),
    chooseSaveFile: (name, ext, dir) => ipcRenderer.invoke('file:chooseSaveFile', name, ext, dir),
    chooseFolder: () => ipcRenderer.invoke('file:chooseFolder'),
    // 图片：二进制写（粘贴）与「把外部图片复制进工作区」（拖入 / 选文件）
    writeBinary: (path, bytes) => ipcRenderer.invoke('file:writeBinary', path, bytes),
    importImage: (source, dir, baseName) =>
      ipcRenderer.invoke('file:importImage', source, dir, baseName),
    chooseImage: () => ipcRenderer.invoke('file:chooseImage'),
    getPathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return null
      }
    },
    fileUrl: (path) => ipcRenderer.invoke('file:fileUrl', path),
    // 拖进窗口的文件：路径只有渲染层拿得到，由它登记一次只读授权（见 services/pathGrants）
    authorizeUserPath: (path) => ipcRenderer.invoke('file:authorizeUserPath', path),
    dirname: (path) => ipcRenderer.invoke('file:dirname', path),
    join: (dir, name) => ipcRenderer.invoke('file:join', dir, name),
    basename: (path) => ipcRenderer.invoke('file:basename', path)
  },
  settings: {
    getAll: () => ipcRenderer.invoke('settings:getAll'),
    update: (partial: Partial<AppSettings>) => ipcRenderer.invoke('settings:update', partial),
    /**
     * 设置的导出 / 导入（审计清单「设置/快捷键导入导出」）：
     * `exportFile` 与 `importFile` 只碰文件对话框与文件字节；信封校验、白名单过滤、
     * 隐私字段剔除全在 `shared/settingsFile.ts`（纯函数、有单测），渲染层解析成功并确认之后
     * 才调 `applyImport` 落库。三条通道缺一不可（主进程/渲染层两侧都要登记，见 tests/i18nAndIpc）。
     */
    exportFile: (settings: AppSettings) => ipcRenderer.invoke('settings:exportFile', settings),
    importFile: () => ipcRenderer.invoke('settings:importFile'),
    applyImport: (patch: Partial<AppSettings>) => ipcRenderer.invoke('settings:applyImport', patch)
  },
  /**
   * 拼写检查（Electron/Chromium 内置检查器）：
   *   * 开关与语言是设置项，走 `settings:update`（主进程同步 session，立即生效）；
   *   * 这里只有三个动作：问状态（available 语言清单）、添加到词典、忽略（本会话）。
   * 建议列表不在这里 —— 它由主进程的 `spell:context` 事件随每次右键下发。
   */
  spell: {
    getState: () => ipcRenderer.invoke('spell:getState'),
    addWord: (word) => ipcRenderer.invoke('spell:addWord', word),
    ignoreWord: (word) => ipcRenderer.invoke('spell:ignoreWord', word)
  },
  workspace: {
    getRoot: () => ipcRenderer.invoke('workspace:getRoot'),
    setRoot: (path) => ipcRenderer.invoke('workspace:setRoot', path),
    // 全文索引：状态查询 + 手动重建（后台索引在 setRoot 时自动起，见 services/workspaceIndex）
    indexStatus: () => ipcRenderer.invoke('workspace:indexStatus'),
    reindex: () => ipcRenderer.invoke('workspace:reindex'),
    // 跨文件（工作区级）替换：dryRun=true 只统计、不落盘（确认框那一趟）
    replaceAll: (req, dryRun) => ipcRenderer.invoke('workspace:replaceAll', req, dryRun),
    onIndexProgress: (fn) => {
      const handler = (_e: unknown, s: unknown): void => fn(s as never)
      ipcRenderer.on('workspace:indexProgress', handler)
      return () => ipcRenderer.removeListener('workspace:indexProgress', handler)
    }
  },
  drafts: {
    save: (key, content, path) => ipcRenderer.invoke('drafts:save', key, content, path),
    load: (key) => ipcRenderer.invoke('drafts:load', key),
    remove: (key) => ipcRenderer.invoke('drafts:remove', key),
    untitledDraft: () => ipcRenderer.invoke('drafts:untitledDraft')
  },
  db: {
    search: (query, limit) => ipcRenderer.invoke('db:search', query, limit),
    getDocument: (path) => ipcRenderer.invoke('db:getDocument', path),
    deleteDocument: (path) => ipcRenderer.invoke('db:deleteDocument', path),
    listRecent: (limit) => ipcRenderer.invoke('db:listRecent', limit),
    setPinned: (path, pinned) => ipcRenderer.invoke('db:setPinned', path, pinned),
    setTags: (path, tags) => ipcRenderer.invoke('db:setTags', path, tags),
    stats: () => ipcRenderer.invoke('db:stats'),
    // 数据库维护（审计 §2 P1：VACUUM / integrity_check / 重建索引此前全无入口）
    integrityCheck: () => ipcRenderer.invoke('db:integrityCheck'),
    rebuildIndex: () => ipcRenderer.invoke('db:rebuildIndex'),
    vacuum: () => ipcRenderer.invoke('db:vacuum')
  },
  // 本地历史（Wave 2 数据安全）：保存前留快照，可查看/回滚
  history: {
    list: (path, limit) => ipcRenderer.invoke('history:list', path, limit),
    get: (id) => ipcRenderer.invoke('history:get', id),
    clear: (path) => ipcRenderer.invoke('history:clear', path),
    stats: () => ipcRenderer.invoke('history:stats')
  },
  notifications: {
    list: (options) => ipcRenderer.invoke('notifications:list', options),
    add: (input) => ipcRenderer.invoke('notifications:add', input),
    update: (id, patch) => ipcRenderer.invoke('notifications:update', id, patch),
    close: (id) => ipcRenderer.invoke('notifications:close', id),
    closeAll: () => ipcRenderer.invoke('notifications:closeAll'),
    remove: (id) => ipcRenderer.invoke('notifications:remove', id),
    clearClosed: () => ipcRenderer.invoke('notifications:clearClosed')
  },
  export: {
    pdf: (payload: ExportPayload, settings) => ipcRenderer.invoke('export:pdf', payload, settings),
    html: (payload: ExportPayload) => ipcRenderer.invoke('export:html', payload),
    word: (payload: ExportPayload) => ipcRenderer.invoke('export:word', payload),
    epub: (meta: EpubMeta) => ipcRenderer.invoke('export:epub', meta)
  },
  /**
   * 真打印机打印（审计 §7 第 18 条）。
   * **不是导出格式**：不落盘、没有输出路径 —— 所以它没有进 `shared/exportFormats`
   * 那份「导出格式唯一清单」，而是单独一条通道。
   * 第二个参数就是设置里的 PDF 页面设置（打印没有独立设置：版式与 PDF 导出同源）。
   * 返回恒为一个结果对象（ok / cancelled / failed + Chromium 的 failureReason）。
   */
  print: {
    document: (payload: ExportPayload, settings) =>
      ipcRenderer.invoke('print:document', payload, settings),
    /**
     * 打印预览（第十一轮）：`Ctrl+P` 现在先开预览，不再直接弹系统对话框 ——
     * 后者只有系统对话框、没有 Chromium 那套预览 UI（平台限制，用户看到的
     * 「此应用不支持打印预览」就是它）。预览窗口里的「打印」由**它自己的 preload**
     * （`src/preload/printPreview.ts`）驱动，这边只负责生成预览。
     */
    preview: (payload: ExportPayload, settings) =>
      ipcRenderer.invoke('print:preview', payload, settings)
  },
  // 备份（审计 §2 P1）：库定时备份到指定目录 + 工作区快照 zip
  backup: {
    status: () => ipcRenderer.invoke('backup:status'),
    run: () => ipcRenderer.invoke('backup:run'),
    chooseDir: () => ipcRenderer.invoke('backup:chooseDir'),
    useDefaultDir: () => ipcRenderer.invoke('backup:useDefaultDir'),
    revealDir: () => ipcRenderer.invoke('backup:revealDir'),
    snapshotWorkspace: () => ipcRenderer.invoke('backup:snapshotWorkspace')
  },
  shell: {
    openExternal: (url) => ipcRenderer.send('shell:openExternal', url),
    openPath: (path) => ipcRenderer.invoke('shell:openPath', path)
  },
  session: {
    get: () => ipcRenderer.invoke('session:get'),
    save: (index, slot) => ipcRenderer.invoke('session:save', index, slot)
  },
  links: {
    resolve: (target, baseDir) => ipcRenderer.invoke('links:resolve', target, baseDir),
    create: (path, type) => ipcRenderer.invoke('links:create', path, type),
    record: (record) => ipcRenderer.invoke('links:record', record),
    history: (limit) => ipcRenderer.invoke('links:history', limit),
    forget: (target) => ipcRenderer.invoke('links:forget', target),
    clear: () => ipcRenderer.invoke('links:clear')
  },
  /**
   * 原生确认对话框：关闭未保存文件 / 外部修改。
   * 由主进程 `dialog.showMessageBox(win, …)` 弹出（原生、父窗口绑定），
   * 渲染层只拿语义结果（save/discard/cancel、reload/later）。
   */
  dialog: {
    confirmClose: () => ipcRenderer.invoke('dialog:confirmClose'),
    externalChange: () => ipcRenderer.invoke('dialog:externalChange')
  },
  /**
   * 防卡死兜底：心跳单向、状态/文档风险按需 invoke。
   * 通道名与主进程 `services/freezeGuard.ts`、`ipc.ts` 一一对应（tests/i18nAndIpc 会对账）。
   */
  freeze: {
    heartbeat: (payload) => ipcRenderer.send('freeze:heartbeat', payload),
    pause: () => ipcRenderer.send('freeze:pause'),
    resume: () => ipcRenderer.send('freeze:resume'),
    draftAck: () => ipcRenderer.send('freeze:draftAck'),
    state: () => ipcRenderer.invoke('freeze:state'),
    docRisk: (path) => ipcRenderer.invoke('freeze:docRisk', path),
    clearDocRisk: (path) => ipcRenderer.invoke('freeze:clearDocRisk', path),
    clipboardText: () => ipcRenderer.invoke('freeze:clipboardText')
  },
  events: {
    on: (channel, cb) => {
      // 非白名单通道：不注册、也不抛（抛会把整段初始化打断），留一条 ASCII 警告便于排查。
      // 返回一个 no-op 取消函数，调用方的 `off?.()` 写法不用改。
      if (!EVENT_CHANNEL_SET.has(channel)) {
        console.warn('[preload] refused non-whitelisted event channel:', channel)
        return () => {}
      }
      const listener = (_: unknown, payload?: unknown): void => cb(payload)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    }
  }
}

export type { MenuAction }

// 仅通过 contextBridge 暴露有限 API（contextIsolation 开启 + sandbox 模式）
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('luminAPI', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.luminAPI = api
}
