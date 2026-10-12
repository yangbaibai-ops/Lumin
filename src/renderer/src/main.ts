import './assets/style.css'

import { createApp, nextTick } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import i18n from './i18n'
import { useSettingsStore } from './stores/settings'
import { useFilesStore } from './stores/files'
import { useUiStore } from './stores/ui'
import { useNotificationsStore } from './stores/notifications'
import { useEditorMenuStore } from './stores/editorMenu'
import { applySessionPosition, installSessionTracking, restoreSession } from './lib/session'
import { isInside, installOpenDocTracking } from './lib/openFile'
import { initExternalWatch } from './lib/externalWatch'

/**
 * 启动阶段打点（`performance.mark('lumin:*')`）：零开销、可在 DevTools Performance
 * 面板里直接看到，验收脚本也能通过 CDP 读到，用来对比启动优化前后。
 * 关心的关键点是 `lumin:doc-visible` —— 用户真正看到文档内容的时刻。
 *
 * ⚠️ **打点不许改变被测路径**：下面几处"字体就绪 / 首帧 / 入口 CSS 就位 / 编辑器绑定"
 * 一律用**回调**记（`document.fonts.ready.then` / `requestAnimationFrame`），绝不 `await`
 * —— 一旦在这里等，量到的就是"加了打点的启动"，而不是产品本身。
 */
const mark = (stage: string): void => {
  performance.mark(`lumin:${stage}`)
}

/** 入口脚本开始执行（模块图的模块级代码都跑完了、这里开始接手） */
mark('entry-exec')

/**
 * 首屏之外的三条零阻塞打点（都只记时刻，不做任何等待）：
 *   * `fonts-ready` —— 网页字体就绪（KaTeX 那 60 个字体文件若被首屏用到，会体现在这里）；
 *   * `css-ready`   —— 入口样式**真的生效**了（用主题令牌 `--paper` 探：`<link>` 元素进
 *     `document.styleSheets` 是立刻的，只有样式表解析完令牌才取得到值）；
 *   * `first-frame` —— 第一帧（能看到界面）。
 */
void document.fonts.ready.then(() => mark('fonts-ready'))
requestAnimationFrame(() => mark('first-frame'))
const cssProbe = (tries = 0): void => {
  const paper = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim()
  if (paper) {
    mark('css-ready')
    return
  }
  if (tries < 240) requestAnimationFrame(() => cssProbe(tries + 1))
}
requestAnimationFrame(() => cssProbe())

/** 首屏不需要的初始化（通知中心、右键菜单"最近使用"）丢到空闲时段 */
const whenIdle = (fn: () => void): void => {
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => number })
    .requestIdleCallback
  if (ric) ric(fn)
  else setTimeout(fn, 0)
}

async function bootstrap(): Promise<void> {
  mark('boot-start')
  // Pinia 必须先于 store 使用被安装
  const pinia = createPinia()

  // 主题/语言必须在挂载前就位，否则会闪一下默认主题
  const settings = useSettingsStore(pinia)
  await settings.init()
  settings.applyAll()
  mark('settings')

  const ui = useUiStore(pinia)
  ui.sidebarVisible = settings.sidebarVisible
  ui.editorMode = settings.editorMode

  const app = createApp(App)
  app.use(pinia)
  app.use(router)
  app.use(i18n)

  /**
   * ─── 先挂载、再等路由（第十二轮启动量化）────────────────────────────────────
   *
   * 量出来的事实（`tools/_probe-boot.js`，冷启动三轮中位）：
   *   settings(162ms) → decorations-first(239ms) 之间 **~75ms** 全是
   *   `router.isReady()` 在等 `/editor` 那条路由的懒加载 chunk（`EditorView-*.js` **2.5MB**）。
   *   而改前是 `await router.isReady()` **之后**才 `app.mount('#app')` —— 也就是说这 75ms 里
   *   渲染层**一帧都没画**（窗口已经 `ready-to-show` 显示了，但页面还是空的 #app），
   *   用户看到的是"窗口先出来、内容过一会儿才出现"。
   *
   * 现在顺序反过来：先把应用挂上（顶栏/侧栏/工具栏先画出来），让它真出一帧，再去等路由。
   * 路由没就绪时 `<RouterView>` 是空的 —— 这一帧显示的正是"壳"，用户感知上就是"应用开了"。
   *
   * ⚠️ 不许去掉下面这个 rAF：`app.mount()` 只是把 DOM 建出来，真正出帧要等下一次绘制；
   * 不等的话这里仍然是"同步跑完再去等路由"，省下的就只是调用顺序而不是可见时间。
   */
  app.mount('#app')
  await nextTick()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  mark('shell')

  await router.isReady()
  mark('router-ready')

  // 工作区目录树先就绪：它会设置「当前工作区根目录」，必须早于下面的打开文档 /
  // 会话恢复（否则并发 setRoot 会互相覆盖），所以这里保持顺序等待。
  // 「新建窗口」是干净窗口：不继承当前工作区（工作区根在 kv 里是全局的）。
  const files = useFilesStore(pinia)
  await files.init({ inheritWorkspace: !window.luminAPI.app.startupNoWorkspace })
  mark('files')

  /**
   * 外部改动监测（第一百零八轮）：监听主进程推来的 `doc:externalChange`（目录监听 +
   * stat 轮询在那边），命中当前文档就弹「检测到内容已被修改，是否重新加载」。
   * 装在 `files.init()` 之后：提示要读 `files.current`（会话恢复可能在 init 里开文档）。
   */
  initExternalWatch()

  // 通知中心 / 右键菜单「最近使用」：只影响卡片与菜单的次要分区，不阻塞文档显示
  // —— 空闲时再从 SQLite 恢复（各自独立，互不等待）。启动瞬间产生通知也没问题：
  // notify() 直接更新内存镜像，空闲 hydrate 会再与数据库对齐一次。
  whenIdle(() => {
    void useNotificationsStore(pinia)
      .hydrate()
      .then(() => mark('notifications'))
    void useEditorMenuStore(pinia)
      .hydrate()
      .then(() => mark('editor-menu'))
    mark('idle-tasks-started')
  })

  // 多窗口：本窗口由「在新窗口打开文件 / 打开文件夹」创建时，启动后直接打开目标
  const startupFile = window.luminAPI.app.startupFile
  const startupFolder = window.luminAPI.app.startupFolder
  if (startupFile) {
    if (await files.openPath(startupFile)) {
      // 侧栏必须能看见刚打开的文件：本窗口继承来的工作区若不包含它，就把工作区
      // 切到该文件所在文件夹（文件本来就在工作区里时保持原样，不做无谓的缩小）。
      // 规则同 lib/openFile.ts 的第 ③ 条（「已有文件夹 → 新窗口打开」）。
      if (!isInside(files.root, startupFile)) {
        await files.setRoot(await window.luminAPI.file.dirname(startupFile))
      }
      await router.push('/editor')
    }
  } else if (startupFolder) {
    // 「最近文件夹 → 新窗口」：该窗口以这个文件夹为工作区（空文档，等用户点开文件）
    await files.setRoot(startupFolder)
    await router.push('/editor')
  } else {
    // 会话恢复：先打开上次这个窗口的文档，路由挂载编辑器后再落光标与滚动位置
    const slot = await restoreSession()
    if (slot) {
      await router.push('/editor')
      mark('editor-mounted')
      await applySessionPosition(slot)
    } else if (files.root) {
      // 会话里只记着工作区文件夹（无文档）→ 也要进编辑器
      await router.push('/editor')
      mark('editor-mounted')
    }
  }

  // ⚠️ 会话恢复**之后**才决定「要不要一份空白缓冲」（用户报障的根因就在这个时序上）：
  // 以前是 EditorView 一挂载就 `openUntitled()` 占位，而会话恢复同时还在跑 —— 占位缓冲会去查
  // 一次「无主草稿」，把草稿弹窗拉起来；随后 openPath 打开真正的文档又把 draftRestore 清空，
  // 于是用户看到**闪一下就不见**的「未保存的草稿」。现在这里统一收口：
  // 会话/启动参数已经决定了文档就直接用，没决定才补空白缓冲（此时草稿弹窗才是该弹的）。
  if (!files.current) await files.openUntitled()

  // 会话跟踪：此后文档/光标/滚动变化会节流写回本窗口的会话槽位
  installSessionTracking()
  // 「本窗口当前文档」上报：供主进程做「一个文件只开一个窗口」判断
  installOpenDocTracking()

  // 初始化完成：把「已就绪」信号置位（启动打点与套件用它判断，界面本身不再有遮罩 ——
  // 骨架屏已按用户口径移除，初始化期间看到的就是正常界面）
  ui.booting = false
  // 打点等一帧：booting=false 只是改了状态，用户看到内容要等下一次绘制
  await nextTick()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  mark('doc-visible')
}

void bootstrap()
