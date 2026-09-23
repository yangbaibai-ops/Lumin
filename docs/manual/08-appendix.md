<!-- 本文件由 docs/typora-wysiwyg-manual.md 按章拆出（清单 §2.H）；索引见该文件。 -->

## 8. 附录

### 附录 A：目录结构（编辑器相关）

```
src/
├─ main/                        # Electron 主进程
│  ├─ index.ts                  # 窗口/协议/生命周期
│  ├─ ipc.ts / fileOps.ts / drafts.ts / export.ts / menu.ts
│  └─ services/database.ts      # SQLite (WAL + FTS5)
├─ preload/index.ts             # contextBridge → window.luminAPI
├─ shared/                      # 三进程共享类型
└─ renderer/src/
   ├─ components/editor/
   │  ├─ TyporaEditor.vue       # useEditor + 防抖序列化（气泡菜单已于第 25 轮移除）
   │  └─ CodeBlockView.vue      # CodeMirror/Mermaid NodeView
   ├─ components/ToolbarTableButton.vue  # WPS 式表格网格选择器
   ├─ lib/editor/
   │  ├─ extensions.ts          # 扩展集装配
   │  ├─ inputRules.ts          # #、-、- [ ] 即时转换
   │  ├─ keymap.ts              # 分割线回车确认 / 标题行首退格降级
   │  ├─ markers.ts             # 光标感知标记符
   │  ├─ codeBlock.ts           # CodeBlock.extend(addNodeView)
   │  └─ markdownStorage.ts     # getMarkdown 桥
   ├─ stores/editor.ts          # 实例/大纲/activeHeading
   └─ assets/style.css          # .md-preview 渲染样式 + md-reveal 标记样式
tools/
├─ verify-tiptap.js             # 45 项 CDP 验收矩阵
└─ run-verify.ps1               # 置前窗口 + 执行验收
docs/typora-wysiwyg-manual.md   # 本文档
```

### 附录 B：关键依赖（package.json 实况）

- `@tiptap/vue-3`、`@tiptap/starter-kit`、`@tiptap/extension-table`、`@tiptap/extension-task-list`、`@tiptap/extension-task-item`、`@tiptap/extension-image`、`@tiptap/extension-placeholder`、`@tiptap/extension-underline`、`@tiptap/extension-horizontal-rule`、`@tiptap/pm` —— 均 `^3.31.0`
- `tiptap-markdown` `^0.9.0`（remark 系双向转换）
- `@codemirror/*` 六件套 `^6`
- `katex` `^0.18.5`、`mermaid` `^11.17.2`
- `electron` `^39.2.6`、`electron-vite` `^5.0.0`、`vite` `^7.2.6`、`vue` `^3.5.25`、`pinia` `^4.0.3`、`tailwindcss` `^4.3.3`、`typescript` `^5.9.3`

### 附录 C：验收矩阵速查

| 阶段 | 覆盖 |
|---|---|
| setup | 窗口可见、pinia 桥接、控制台零错误 |
| A | 15 项：打开文件 → 全格式渲染（标题/粗斜体/行内码/引用/列表/任务/表格/代码块/mermaid/无源码标记残留/大纲） |
| B | 10 项：Input Rules + 标记符浮现/隐藏 + 任务列表回车语义 + 往返一致 |
| C | 8 项：CodeMirror 编辑同步、围栏保持、文件保存、SQLite 落库搜索、重开渲染 |
| D | 10 项：表格单元格编辑、气泡菜单可见/加粗/保持、导出、主题切换、全局搜索 |
| E | 5 项：分割线回车确认（不即时转换/回车生效/`---你好` 保留与转义）、标题行首退格降级、设置 SQLite 持久化往返 |
| F | 24 项：表格按钮默认 3×3、悬停网格选择器 2×3、单元格宽度 CSS、表格占满写作区宽度、代码块真实键入（焦点保持/同步/大纲 DOM 稳定/Enter 换行）、Markdown 粘贴（块级节点/标题标记符/粘贴内容可编辑/标题去粗）、源码模式（进入/编辑/填满高度/切回重建）、分屏对比（进入/右→左/左→右/分隔条拖拽持久化/同步滚动开关与双向滚动映射）；另有 B 阶段行内标记显隐边界断言（真实文本标记模型，§4.13） |
| G | 3 项：构造边界打字不失粗（起点/终点打字后 `strong` 保留 + 移出折叠为纯粗体，§4.13 坑位 7） |
| H | 2 项：Ctrl/Cmd+左键退化为普通光标点击（不整选段落/节点、无主题色全选框）、普通左键不受影响（§4.14） |
| I | 3 项：链接普通点击原地展开（锚点消失、label/syntax 双形态、光标折叠不自动选中、md 不变）、光标移出自动折叠还原、Ctrl+点击保持链接不展开（§4.15） |
| J | 3 项：标记内回车切段后源码精确两段且首行 5 立即斜体（与刷新一致，零转义）、段首退格合并（单段 `**5**` + 粗体即时还原 + 无 `.ProseMirror-selectednode`）、合并后光标移开粗体保持（§4.13） |

运行方式：`$env:LUMIN_DEBUG_PORT='9222'; npm run dev` 后执行 `powershell -NoProfile -ExecutionPolicy Bypass -File tools/run-verify.ps1`。

---

*本手册随代码演进持续更新；任何涉及编辑器内核的改动（扩展装配、标记、输入规则、序列化桥）都必须先跑通附录 C 的验收矩阵。*

### 4.39 编码切换的两个加固：强制同步 + 构建自检（本次）

**用户反馈**：UTF-8 文档切成 GBK 成功，但再切回 UTF-8「切不回去」。

**排查结论（重要）**：在当前构建上我用四种方式复现，**全部通过、复现不出来** —— ① 直接调 `reopenWithEncoding`；② 走真实菜单两级点击；③ 两次点击间隔 <600ms 的快速切换；④ 先让编辑器 emit 过一次原文（`focus` → `blur` 触发 `flushSync`，使 `lastEmitted === 磁盘原文`）再切换。四条的编码、正文、磁盘字节都正确往返。

**但确实找到了一条「能产生完全相同症状」的代码路径**，并把它封掉了：

`src/renderer/src/components/editor/TyporaEditor.vue` 的外部同步 watch 有两条**回声过滤**（启发式）：
1. `if (nv === lastEmitted) return` —— 「store 内容 == 我上次 emit 的文本」当成自身回声；
2. `if (performance.now() - lastEmitTime < 600) return` —— 600ms 静默窗。

两条对「显式外部替换」都不成立：**按原编码切回来时，store 里的内容恰好就是原文**（= 编辑器上次 emit 的文本）→ 规则 1 把它当回声丢掉；若上次 emit 在 600ms 内 → 规则 2 丢掉。表现就是「状态栏编码变了、正文却没回来」。实测里之所以没咬到，是因为切成 GBK 后编辑器往往又 emit 了一次乱码文本、把 `lastEmitted` 顶掉了 —— 属于时序运气，不能依赖。

**改法**：`files` store 新增 `syncEpoch`（显式外部替换计数），`reopenWithEncoding` 替换内容后 `syncEpoch++`；TyporaEditor 把同步逻辑抽成 `applyExternalContent(nv, force)`，`force = true` 时**跳过两条过滤**、无条件 `setContent`。于是「重新解释编码」这类显式动作永远能落到编辑器上，不受任何回声启发式影响。

**顺带两处诊断加固**（这次排查最费时间的就是「不知道用户那边跑的是哪份构建」）：

- **构建自检**：开发态启动时往 `%TEMP%\lumin-build.log` 追加一行 —— 进程启动时间、app/Electron/Chrome 版本、**主进程 bundle 的 mtime**（这份代码什么时候构建的）、能力标记 `{encoding, taskbar}`。主进程不热更新，排查错配时第一眼看它。打包态不写（`src/main/services/buildStamp.ts`）。
- **失败不再沉默**：`reopenWithEncoding` 在「文档还没落盘」时给出提示（原先静默 `return false`，用户只会看到「点了没反应」）；失败提示里带上真实原因（`无法按该编码重新打开：<原因>`），console 里也留一条。

**验收**：`tools/_verify-encoding.js` 在开发渲染层下 34/34；`-NoDevServer`（生产渲染层）下 31/34，差的 3 条是既有的 `setupState` 内省（生产构建不暴露，套件里已注明 SKIP）。两个探针（快速切换、先 emit 再切换）在修复后仍 PASS，且**磁盘字节全程不变**（切换只重读、不写回）。`npm run typecheck` 两工程 0 error。

> 说明：第 1 条加固是**预防性**的 —— 我无法在当前构建上复现用户的现象，但它是代码里唯一能产生该现象的机制，封掉它之后该类时序问题不再可能发生。

### 4.40 图标统一到单一文件（本次）

**用户要求**：所有应用图标（窗口、任务栏等）都换成最新设计；删掉未使用的旧图标；**所有用到的地方引用同一个文件**，避免出现两种图标（除非确实需要别的图标类型）。

**排查发现的三个真问题**：

1. **窗口图标以前只在 Linux 设置**：`src/main/index.ts` 里是 `...(process.platform === 'linux' ? { icon } : {})` —— Windows 下等于没设，任务栏按钮退化用 electron.exe 自带的图标（开发态看着就是 Electron 的 logo）。所以之前换 `icon.png` 对 Windows 根本没生效。
2. **模板自带的旧图标还在，而且是打包默认读取的位置**：`build/icon.ico`（123 KB，**已删除**）、`build/icon.png`、`build/icon.icns` 是 electron-vite 模板的占位图（旧设计），而 electron-builder 默认就去读 `build/icon.ico` —— 一旦打包就会出现「开发态一个新图标、安装后一个旧图标」。
3. **同一个应用读两个文件**：窗口图标读 `resources/icon.png`，而开始菜单快捷方式与跳转列表读 `resources/icon.ico`。

**改法**：

- **Windows 运行时统一到一个文件**：窗口图标改成 `process.platform === 'win32' ? appIconIco : appIconPng`（`resources/icon.ico`）—— ICO 里本来就含 16/24/32/48/64/128/256 七档（**后来换成用户新设计后为 16/24/32/48/64/72/96/128/256 九档**，见 §4.36 的图标更换记录），Windows 会按场景（任务栏 / Alt+Tab / 标题栏 / 高 DPI）自己挑最合适的尺寸，比单张 PNG 更对；于是**窗口 + 任务栏 + 开始菜单快捷方式 + 跳转列表**读的都是 `resources/icon.ico`。
- **非 Windows 用 PNG**：macOS/Linux 不吃 ICO，这是「确实需要另一种图标类型」的那种例外，用同一份设计导出的 `resources/icon.png`。
- **删掉旧图标**：`build/icon.ico`、`build/icon.png`、`build/icon.icns` 全部删除（`build/` 只剩 mac 的 entitlements，与图标无关）。
- **打包也指到同一个文件**：当时在 `package.json` 里加了一段最小 `build` 配置（`appId: com.lumin.app`、`productName: Lumin`、`win.icon: resources/icon.ico`）—— 不写这段的话 electron-builder 会回去找 `build/icon.ico`（已被我们删掉），反而退化成 Electron 默认图标。**后来这段被移到 `electron-builder.yml` 里成为唯一配置源，`package.json` 的 `build` 字段已删除，见 §4.41。**
- **加守卫防复发**：`tools/build-app-icon.js` 自检里新增三条 —— 扫 `src/**` 里所有 `resources/icon*` 引用必须只有 `icon.ico`（或非 Windows 分支的 `icon.png`）、Windows 必须有 ≥2 处引用同一个 ico、`build/` 下不允许再出现 `icon.*`。

**验收**：`tools/build-app-icon.js` **14/14**（像素取样 + 三条单一来源守卫）；`_verify-taskbar-jumplist.js` 里快捷方式的 `IconLocation` 独立用 Windows COM 复核为 `D:\code_workspace\Lumin\resources\icon.ico,0`；`npm run typecheck` 0 error。

**需要重启才能看到**：窗口图标是在窗口创建时设置的，所以改完要重启应用（如今开发态 `npm run dev --watch` 会自动重启，见 §4.38）。

### 4.41 打包链路：单一配置源 + 打包态/开发态分层 + 打包验收（本次）

**先纠正一个说法**：此前把打包链路说成「空的」并不准确 —— `electron-builder.yml` 一直存在，`package.json` 里也有一段 `build`。准确的说法是：**它是 electron-vite 模板的原样默认值 + 三行手写配置，而且从来没有被验证过**（没人跑过 `build:win`/`build:unpack`，也没有任何针对打包产物的验收）。本次把它做成「可用、专业、可扩展」的形态。

#### 一、排查出的四个真实缺陷（含一处我先判断错、后经实测纠正的）

先说一个反直觉但**已实测确认**的事实：electron-builder 的配置解析顺序是

1. **先看 `package.json` 的 `build` 字段 —— 有它就只用它，`electron-builder.yml` 整份被忽略**；
2. 只有 `build` 字段不存在时，才按 `electron-builder.yml → .yaml → .json → .json5 → .toml → .js` 去找配置文件。

（读的是 `app-builder-lib/out/util/config/load.js` 的 `loadConfig()`；并写了个探针在同一目录下同时放 `package.json` 的 `build` 与 `electron-builder.yml` 验证：有 `build` 时读到的是 `FROM-PACKAGE-JSON`，删掉后读到 `FROM-YML`。**我最初按印象写反了**，是这两步把我拉回来的 —— 所以这条结论连同「为什么」一起写进 yml 注释，免得下次再猜。）

于是模板留下的真实状况是**反的**：

1. **`electron-builder.yml` 是一份完整的死配置**：它写着模板默认值 `appId: com.electron.app`、`productName: lumin`、`win.executableName: lumin`、`linux.maintainer: electronjs.org`、`category: Utility`、snap target……**而它一个字都没被读过**（因为 `package.json` 里有 `build`）。危险在于：这不是「配置写错了」，而是「配置看着很全、其实全是摆设」，且**一旦有人删掉 `package.json` 的 `build`（比如为了消除重复配置），应用身份会瞬间变成 `com.electron.app` / `lumin.exe`** —— 任务栏身份、快捷方式、跳转列表、通知归属一起崩。这类地雷比明显写错更难发现。
2. **真正生效的配置只有三行**：`package.json` 里的 `{appId: com.lumin.app, productName: Lumin, win.icon: resources/icon.ico}` —— 身份恰好是对的，纯属这三行**恰好**写对了；除此之外的一切都退回 electron-builder 的默认值，没人检查过默认值是否符合产品预期。
3. **默认安装行为不符合写作类应用**：`nsis.oneClick` 默认是 `true` —— **一键安装、不给选安装目录**。写作软件常被装到非系统盘，这个默认值不合适（现在的 yml 明确写 `oneClick: false` + `allowToChangeInstallationDirectory: true`）。
4. **没有文件关联**：`.md` 双击打不开（也就谈不上「Typora 平替」的入场体验）。顺带说，把 `publish` 的 `url` 留在 `https://example.com/auto-updates` 这种占位值上而运行时又不去识别它，也是同类问题（会在用户机器上冒网络失败），所以 `updater.ts` 会主动识别占位域名并跳过。

#### 二、比配置更致命的洞：裸路径 argv 根本没解析

旧版解析器（原在 `taskbar.ts`）只认自己造的两个开关：

```ts
const arg = argv.find((a) => a.startsWith(OPEN_FILE_PREFIX))   // --lumin-open=<encodeURIComponent(path)>
return { newWindow: argv.includes(NEW_WINDOW_SWITCH), openFile }
```

而**双击文件、`Lumin.exe x.md`、从别的程序拖进来**，argv 里是一个**裸路径**（Windows 还会附带 `--allow-file-access-from-files`、`--source-app-id`、`--secure-schemes=lumin-file` 等 Chromium 自己的开关）。旧代码对这些一律无视 —— 于是「双击 .md 没反应」是**必然**的，哪怕文件关联注册得再对。**文件关联 = 安装器注册 + 应用会解析裸路径，两件事缺一不可。**

#### 三、改法（六块，逐条讲为什么）

**① `electron-builder.yml` 成为唯一配置源**

`package.json` 的 `build` 字段已删除，配置全部集中到 yml：

- 身份对齐代码：`appId: com.lumin.app`（与 `taskbar.appId()` 打包分支一致）、`productName: Lumin`、`win.executableName: Lumin`；
- `win.icon: resources/icon.ico` —— 图标单一来源（§4.40），这里显式指过去，避免 electron-builder 回退去找已删除的 `build/icon.ico`；
- `win.target: nsis / x64`（只出 Windows 免安装版 + 安装包，不做跨架构幻想）；
- `nsis` 显式写全：`oneClick: false` + `allowToChangeInstallationDirectory: true`（可选安装目录，**不是**一路 next 的静默安装）、`perMachine: false`（装到当前用户，不需要管理员）、`createDesktopShortcut/ createStartMenuShortcut: true`、`shortcutName: Lumin`、`uninstallDisplayName: Lumin`、`artifactName: Lumin-${version}-setup.${ext}`、`runAfterFinish: true`；
- **`deleteAppDataOnUninstall: false`**：卸载**不删**用户数据（SQLite 里的会话、设置、编码记忆都在 `%APPDATA%\lumin`）—— 卸载重装不该把用户的偏好和草稿一起带走；
- `fileAssociations`：只注册 `.md` 与 `.markdown`（`name: Markdown`、`description: Markdown Document`、`role: Editor`、`icon: resources/icon.ico`）。不贪多：`.txt`/`.markdownx` 之类抢来只会惹人烦；
- `publish` 保留占位并写清启用步骤（见第五块）；
- 模板残留一并修掉：`linux.maintainer` 从 `electronjs.org` 改为 Lumin、`linux.category` 从 `Utility` 改为 `Office`、去掉 snap target（本产品是 Windows-only，留着 snap 只是噪音）、mac 的 entitlements 与 `notarize: false` 保留；
- `asarUnpack: resources/**` 与 `npmRebuild: false` 保持（前者保证运行时能按真实路径取图标文件、后者本工程没有原生模块要重建）；
- `files` 里补排除**开发期专属内容**：`docs/*`、`tools/*`、`{build-out.txt,typecheck-out.txt,dev-run.log}`。这条是解析 asar 顶层时发现的 —— 默认打包会把文档、验收脚本、构建日志一起塞进 `app.asar`（顶层能看到 `docs/`、`tools/`、`build-out.txt`、`typecheck-out.txt`、`dev-run.log`），既让安装包变大，也等于把开发脚本发给用户；已核对 `src` 里没有任何代码在运行时读这些路径。

> 关于「两处配置谁是权威」：不是「说不清」，而是一个**确定的、反直觉的**顺序（`package.json` 的 `build` 赢）。正确做法不是记住它，而是**不让它成为问题**：现在只剩 yml 一处，并且验收里有两条断言把这个状态钉住 —— `package-json-has-no-build-field`（`package.json` 不许再长出 `build`）与 `builder-config-comes-from-yml`（用 electron-builder 自己的解析函数算出「有效配置」，再核对它等于 yml 里写的值；`nsis.oneClick` 默认 `true` 而 yml 写 `false`，读出 `false` 就证明 yml 真的在生效，而不是躺着的死配置）。实测产物 `Lumin.exe` / `Lumin-1.0.0-setup.exe` / 开始菜单名 `Lumin` 也全部严格来自 yml。

**② 新增纯函数 `src/main/services/launchIntent.ts`**

把「命令行 → 启动意图」从主进程里剥出来，做成**无副作用纯函数**（唯一依赖 `fs.existsSync/statSync` 与注入的 `cwd/appPath`），因为这段逻辑是文件关联、跳转列表、第二实例转发三条路径的共同入口，值得独立：

```ts
export interface LaunchIntent {
  openFile: string | null
  openFolder: string | null
  newWindow: boolean
  noWorkspace: boolean
  ignored: string[]        // 被忽略的参数（诊断用）
}
parseLaunchIntent(argv, { appPath, cwd }): LaunchIntent
```

解析规则（每条都对应一个真实踩法）：

- 跳过 `argv[0]`（可执行文件自身）与 `appPath`（开发态 `electron .` 就是这条，否则一定被当成「打开文件夹」）；
- `--` 之后一律不解释（POSIX 约定，避免把用户数据当成开关）；
- 认识自己的开关：`--lumin-open=`、`--lumin-open-folder=`、`--lumin-new-window`、`--lumin-no-workspace=1`；
- 其它 `-` 开头的参数**一律忽略并记进 `ignored`**（Chromium/Squirrel 会塞 `--allow-file-access-from-files`、`--source-app-id`、`--secure-schemes=…` 等，不忽略就会被当成文件路径去 stat）；
- 剩下的是裸路径：**相对路径按 cwd 解析**（从命令行敲 `Lumin.exe ..\a.md` 必须能用），`existsSync` + `statSync` 判定文件还是目录，不存在的记进 `ignored`（而不是静默丢掉）。

`ignored` 不是为了好看，而是为了「双击没反应」这类反馈能一眼定位。

**③ `src/main/index.ts` 接线：三条入口收敛到一个函数**

三个来源原本各写一套逻辑：冷启动 argv、`second-instance`（第二实例把 argv 转发给已运行实例）、macOS 的 `open-file` 事件。现在统一成：

- 冷启动：`parseLaunchIntent(process.argv, { appPath, cwd })` → `recordLaunchIntent(...)` 落一行日志 → 合并 `pendingOpenPaths`（macOS `open-file` 早于 ready 时的暂存，这里保留为跨平台正确性）→ 首个窗口按意图携带 `openFile`/`openFolder`/`noWorkspace`；
- `app.on('open-file')`：ready 前入 `pendingOpenPaths`，ready 后直接 `handleOpenRequest`；
- `app.on('second-instance', (_e, argv, cwd))`：解析 + 落日志 + `handleOpenRequest`；
- **`handleOpenRequest(intent)` 是唯一分发点**：`newWindow` → 新窗口（带目标就带上，没带目标才是「干净窗口」）；`openFile` → 先用 `openDocs.findWindowWithDoc` 找已打开它的窗口，找到就聚焦（**不重复开**），否则新窗口；`openFolder` → 新窗口；什么都没有 → `focusExistingWindow()`。

**④ 打包态与开发态明确分层**（之前是混着来的，两个身份互相污染）：

| 行为 | 开发态 | 打包态 |
|---|---|---|
| 开始菜单快捷方式 | 启动时写（`ensureAppShortcut()`） | **不写**，早退并记日志 `shortcut skipped (packaged; installer owns it)` —— 快捷方式归安装器所有，运行时不越权 |
| 窗口 `icon` | 传 `runtimeIconPath()`（内容寻址副本） | **不传**：图标已内嵌进 `Lumin.exe`（验收 B 段就是证明），再传一次只会多一条路径依赖 |
| 跳转列表图标 | `runtimeIconPath()`（按内容换路径，规避 Windows 按路径缓存，§4.35） | `process.execPath`（即 `Lumin.exe`，系统直接取 exe 内嵌图标） |

**⑤ 新增 `src/main/services/updater.ts`：更新能力「装好但默认关闭」**

- 只在**打包态**且**真有发布通道**时才是可用状态：`updateChannelConfigured()` 要求打包产物里的 `app-update.yml`（electron-builder 生成，仓库里没有这个文件）存在、且 url 主机不是 `example.com/example.org/example.net/localhost` 这类占位值 —— 否则「检查更新」只会永远失败；
- `autoDownload = false`：**不偷偷下 100MB 安装包**；`autoInstallOnAppQuit = true` 只在用户已选择下载后才在退出时安装；
- 检查条件是 `app.isPackaged && settings.autoCheckUpdate && updateChannelConfigured()`，即默认设置（`autoCheckUpdate: false`）下**一条网络请求都不发**；
- 状态经 `update:status` 推给渲染层，渲染层用通知中心呈现（文案在 i18n 里，主进程只传数据 —— 与既有约定一致，§4.32）。
- **与规格的一处有意偏差**：只有 `available` / `downloaded` / `error` 三种状态发通知，`checking` / `not-available` 只 `console.info`。原因是本应用的通知中心是**持久通知**而不是自动消失的 toast（§4.32），「没找到更新」这种一次性的中间态做成持久通知会一直躺在那里等人手动关。

**⑥ 新增 `tools/_verify-packaging.js`（24 项，本次的重点）**

打包链路以前最大的问题不是配置，而是**没人验证**。这个套件把「打包产物真的能用」变成可重复的事实：

- **A** **构建前先清场**（`no-packaged-instance-holds-dist-before-build` + `dist-cleared-before-build`：不许有 `Lumin.exe` 占着 `dist\`，且上一轮产物必须删得掉，原因见三点五），然后 `npm run build:unpack`（内含 typecheck）成功、`dist/win-unpacked/Lumin.exe` 存在；
- **A2** **产物冒烟启动**：真起一次、等首页就绪；起不来就自动重建一次再试（`packaged-artifact-boots-after-rebuild`）—— 这条是本轮的血泪（见三点五）；
- **B** **exe 里真的内嵌了我们的图标**：解析 `resources/icon.ico` 的目录项，断言 7 个尺寸（16/24/32/48/64/128/256）的字节**全部**能在 `Lumin.exe` 里找到，且 **electron.exe 里一个都找不到**（对照组）；再用 `ExtractAssociatedIcon` 取出 32×32 证明「取出来能渲染」；**（⚠️ 这条已改成按目录项动态取档数，因为图标换成新设计后是 9 档；此处的 7/7 数字只对旧图标成立，新图标待复验）**
- **C** **裸路径打开文件**：用打包后的 exe 直接启动 `Lumin.exe <临时目录>\甲-中文名.md`（隔离 `--user-data-dir` + CDP），断言 `files.current.path`、正文开头 `# 甲文档标题`、内存里的编码是 `utf-8`；
- **D** **第二实例转发 + 去重**：再启动一次同一个 exe（另一个文件 `乙-第二篇.md`）→ 窗口数 1→2 且新窗口里是乙文件；同一文件再开一次 → 2→2（不会开出第三个窗口）；
- **E** **打包运行不碰开始菜单**：整段测试前后对 `开始菜单\Programs` 做快照对比（含 mtime），必须完全不变，且不得出现 `Lumin.lnk`；
- **F** `npm run build:win` 出 NSIS 安装包，只检查大小与 SHA256，**绝不运行安装包**（见第六节）；
- **G** **配置单一来源 + 身份一致**（这一段是排查出「死配置」之后补的，防止复发）：`package.json` 不得有 `build` 字段；用 electron-builder **自己的解析函数**算出有效配置并核对它确实等于 yml 里写的（`appId`/`productName`/`executableName`/`win.icon`/`nsis.oneClick === false`/`allowToChangeInstallationDirectory === true`/`deleteAppDataOnUninstall === false`）；`appId` 必须等于代码里 `taskbar.ts` 用的那个；文件关联必须恰好是 `md` + `markdown`（不许顺手抢 `.txt`）。

#### 三点五、「打包产物启动即静默退出」——本次踩得最贵的一个坑（必须留档）

这一节建议优先读：它说明**「产物存在 + 图标字节都对」也可能整个产物是坏的**，验收里「真的把它跑起来」这一步不能省。

**现象**：一轮完整验收里 A 段（`build:unpack` 成功、`Lumin.exe` 存在）与 B 段（exe 里 7 档图标字节全中、与 electron.exe 对照正确）**全部 PASS**，C 段却连不上 CDP：`packaged-app-boots FAIL pid=13660` + `ERROR connect ECONNREFUSED 127.0.0.1:9225`。

**误导性极强的地方**（也是我绕远路的原因）：手工起同一个 exe，它**立刻退出、exit code 1、stdout/stderr 一个字都没有**；profile 目录建了但是空的；`%TEMP%\lumin-build.log` 里**没有**本次启动的意图行；用 `--inspect` 起它，**Node inspector 根本不监听** —— 即**主进程 JS 一行都没执行**，死在了 Electron 自己的启动阶段。于是我先怀疑配置和代码，依次排查（全是死路）：yml 是否被读、asar 结构是否被截断（自己解析 asar 头部 → 结构完好）、换 `electron.exe` 直接加载 `resources/app.asar`（同样秒退）、Windows 事件日志、磁盘空间。

**已验证的事实**（这部分是硬结论）：

1. 这种产物**重新构建一次就恢复正常**（三次复现，每次重建都立刻好）；
2. 重建后的 `Lumin.exe` 与 `app.asar` 和可用产物的 **SHA256 逐字节一致**（`exe 52B90573…` / `asar 6437F17C…`），构建本身是确定的 —— **所以不是配置问题、不是代码问题、也不是构建不确定**；
3. 坏产物死在 Electron 的启动校验阶段（JS 未执行）。

**已定位的一个真凶（且是验收脚本自己的 bug）**：`run()` 用 `spawnSync` 跑构建，而 **spawnSync 默认只缓冲 1MB 输出**；electron-builder 那一行 `duplicate dependency references dependencies=[...]` 本身就接近 1MB，**一旦超限子进程会被直接杀掉**（`error.code = ENOBUFS`、`status = null`）—— 于是构建被**中途打断**，`dist/` 里留下半成品（asar 换了、exe 的完整性资源没来得及写），这种半成品启动时正是「静默退出」。而且断言只报一句 `exit=1`，完全看不出是「构建真失败」还是「输出太多被杀」。**已修**：`maxBuffer` 提到 64MB，并在失败时额外打印 `BUILD-SUSPECT-LINES`（把 error/fail/EPERM/ENOBUFS 之类的行拎出来）。这一条同时也是本次「排查被误导」的一部分原因 —— **验收工具本身不可信时，排查方向会被它带偏**。

**仍未定位的一处**（如实记录）：另有一轮构建 `exit=0` 正常退出、产物却是坏的。推测是「构建时 `dist` 里上一轮的产物文件仍被占用，electron-builder 往 exe 写 asar 完整性资源（日志 `• updating asar integrity executable resource`）时没能与新的 asar 对上」，但**没有证实**。

**已加的护栏**（不依赖上面哪种解释成立）：

- **构建前清场**：`ensureNoPackagedInstanceRunning()` 干掉残留实例并等它真的退出（断言 `no-packaged-instance-holds-dist-before-build`）；`clearPreviousArtifacts()` **自己删掉上一轮产物并确认删得掉**（断言 `dist-cleared-before-build`）—— 删不掉就当场失败，绝不在文件被占的情况下让构建继续；
- **构建后冒烟启动（A2）**：`smokeBootArtifact()` 真起一次产物、等首页就绪；起不来就**自动重建一次**再试（断言 `packaged-artifact-boots-after-rebuild`）；这一步让「坏产物」在 A2 就被抓住，不用等到 C 段看一句没头没脑的「连不上 CDP」；
- C 段再失败会打印 `HINT-PACKAGED-BOOT-FAILED`，直接给出归因方向与下一步；
- 清场范围刻意收窄：进程名必须是 `Lumin.exe`，**且**（命令行带本套件的隔离 profile **或** 可执行文件就在 `dist\` 下）—— 用户开发态跑的是 `electron.exe`，永远不会被误杀。

> 一句话总结：**构建产物可能坏，而坏法恰好是「静默退出 + 前面几段全绿」**。所以「构建前清场」和「构建后真起一次」都必须写进验收，而不是靠人记得。

#### 四、验收数据（本次实测）

`node tools\_verify-packaging.js` → **24/24 PASS**（全新构建，非复用产物）：

- **A2 冒烟启动本轮一次通过**；而加护栏的那一轮它**真的抓到过一次坏产物**：`SMOKE-FAILED-FIRST-TRY {"ok":false,"pid":26736}` → 自动重建一次 → `PASS packaged-artifact-smoke-boots {"ok":true}`（那一轮因为多跑了「重建后通过」这条断言，总数是 25）。也就是说这个坑**不是理论上的可能，而是会真的碰上**，护栏确实在起作用；
- `ICON-BYTES` `sizes=[16,24,32,48,64,128,256] inExe=[true×7]`，对照 `electron.exe` 全 `false`；
- `ICON-EXTRACT` 我们的 exe 中心像素 `(176,179,198)`、亮度 180；electron.exe 对照 `(60,66,78)`、亮度 66（断言「亮度差 > 60」，避免把「都是深色」误判成同一张图）；
- `C-BARE-PATH` `path=…\Temp\lumin-pkg-fixtures\甲-中文名.md`、`head="# 甲文档标题\n\n这"`、`encoding=utf-8`；
- `D-SECOND-INSTANCE` `乙-第二篇.md`、窗口 `1 -> 2`；`D-DEDUP` `2 -> 2`；
- `E` 开始菜单快照前后完全一致（含 mtime），无新建 `Lumin.lnk`；
- `G` `EFFECTIVE-CONFIG {"appId":"com.lumin.app","productName":"Lumin","executableName":"Lumin","winIcon":"resources/icon.ico","oneClick":false,"allowDir":true,"deleteAppDataOnUninstall":false,"associations":["md","markdown"]}` —— 生效配置确实来自 yml（`oneClick: false` 不是默认值）；
- `F` `Lumin-1.0.0-setup.exe`，**129,201,471 字节（123.2 MB）**，`sha256=6d8f208c421b7e38eeebd9507b1e8b520785763898bae7c09d774beb8cbcd958`；`latest.yml` 一并产出（自动更新的版本清单）。

> 安装包体积会随构建时间戳等变动（同一天两次构建差几十到几百 KB），哈希也随之变 —— 上面是本次实测值。把 `docs/`、`tools/`、构建日志排除出打包后，安装包从 129,444,185 字节降到 **129,201,471 字节**（约 -240 KB），这既是体积收益，也是「不把开发脚本发给用户」。

**回归**（本次改动不碰编辑器内核，但仍全跑一遍，全部在隔离实例上）：

| 套件 | 结果 |
|---|---|
| `_verify-encoding.js` | **34/34** |
| `_verify-open-file-dedup.js` | **21/21** |
| `_verify-open-file-routing.js` | **22/22** |
| `_verify-session.js` | **16/16**（会话恢复没被 `explicitOpen` 判定改坏） |
| `_verify-taskbar-jumplist.js` | **27/27** |
| `npm run typecheck` | 0 error |

> taskbar 套件里 `shortcut-icon-is-app-icon` 原本是「路径以 `icon.ico` 结尾 + 文件存在」。§4.35 把开发态图标改成**内容寻址的运行时副本**（`userData\icons\lumin-<sha1:8>.ico`）之后，这条断言就**过时了**（文件名不再叫 `icon.ico`）。已改为更强的一条：后缀 `.ico` + 文件存在 + **字节与 `resources/icon.ico` 完全一致**（实测 `bytesEqual: true`）—— 既排除 electron.exe 的图标，也排除旧设计的残留。

#### 五、更新通道怎么开

1. 把 `electron-builder.yml` 的 `publish.url` 换成真实地址；
2. 把 `latest.yml` 与安装包一起上传到该地址；
3. 在设置里打开「自动检查更新」（`settings.autoCheckUpdate`，默认关）。

三项缺一，更新就保持「装好但不动」的状态 —— 这是刻意的：默认关、不发请求、不自动下载。

#### 六、本次**未验证**的部分（不要当成已验证）

- **没有真的运行安装包**。所以「安装后 `.md` 关联是否注册成功」「桌面/开始菜单快捷方式是否正确」「卸载是否保留用户数据（`deleteAppDataOnUninstall: false` 的真实行为）」都**没有实测**。安装器只被检查了大小与 SHA256。
- 即便关联注册成功，**Win10+ 也不会自动抢默认程序**：用户需要在「打开方式」里选一次 Lumin（`role: Editor` 只影响候选列表）。这是平台行为，不是配置问题。
- 更新链路只验证了「默认关且不发请求」，**没有接真实更新服务器**跑过一次真实升级。

手动验证步骤（要真验证时）：在**虚拟机或非工作机**上双击安装包 → 装到非默认目录 → 双击任意 `.md`（应打开该文件且窗口里是同一篇）→ 检查开始菜单/桌面快捷方式图标 → 卸载 → 确认 `%APPDATA%\lumin` 仍在。

#### 七、命令

```bash
npm run dev          # 开发（--watch：主进程改动自动重建，§4.38）
npm run build:unpack # 免安装版 → dist/win-unpacked/Lumin.exe（验收 A–E 用这个）
npm run build:win    # NSIS 安装包 → dist/Lumin-<version>-setup.exe
node tools/_verify-packaging.js            # 17 项打包验收（会跑上面两条构建）
set LUMIN_PKG_SKIP_BUILD=1 && node tools/_verify-packaging.js   # 复用已有产物，快速回归
```

> `tools/_verify-packaging.js` 全程不运行安装包，所有打包态启动都用 `--user-data-dir=%TEMP%\lumin-pkg-userdata` 隔离并按该 profile 精确回收进程，不会碰用户正在使用的实例。

### 4.42 安装 / 卸载链路实测报告（本次）

见独立文档 **`docs/packaging-install-test.md`**：在本机用 NSIS 安装包做了完整的装 → 跑 → 卸实测。

- 安装 `Lumin-1.0.0-setup.exe /S`：退出码 0、20.2 s；安装到 `%LOCALAPPDATA%\Programs\Lumin`（82 个文件，`Lumin.exe` 210,974,720 字节）；
- exe 内嵌图标：`resources/icon.ico` 的 **16/24/32/48/64/128/256 七档负载 7/7 逐字节命中**，同一批字节在 `electron.exe` 里 7/7 不存在；**（⚠️ 旧图标的数据；现行图标为 9 档新设计，exe 内嵌结论待复验）**
- 文件关联：`HKCU\Software\Classes\.md` → ProgID `Markdown` → 命令 `…\Programs\Lumin\Lumin.exe "%1"`（`%1` 即裸路径，正好由 §4.41 的 `launchIntent` 解析）；
- 打包版以**裸路径**打开中文文档成功（窗口标题 = 文件名，渲染层从 `app.asar` 加载）；
- 卸载 `/currentuser /S`：退出码 0、10.6 s；安装目录与快捷方式清除；**`%APPDATA%\Lumin` 11027 个文件 / 38 个草稿原样保留**（`deleteAppDataOnUninstall: false` 生效）。

报告同时记录了 **1 个中severity 缺陷**（卸载后 `HKCU\Software\Classes\.md` 默认值残留 `Markdown`，形成悬空关联，需在 `nsis.include` 里补一段删除逻辑）、**4 项待修/待确认**（Publisher 显示 `example.com`、桌面同名快捷方式会被覆盖、快捷方式未携带 AUMID、dev 与打包版共用 `%APPDATA%\Lumin` 与单实例锁）以及 **5 项未覆盖**（真实双击 `.md`、任务栏固定项观感、自动更新、代码签名/SmartScreen、非 Windows 平台）。

> ⬅ 这些问题已在 **§4.43** 逐条处置并**重新跑了一遍完整装/卸实测**。其中「快捷方式未携带 AUMID」那条的**结论被推翻**：安装器写的 `Lumin.lnk` 本来就带 `com.lumin.app`，第一轮是**测量方法**错了（拿原始字节搜 UTF-16 字符串）。

### 4.43 安装 / 卸载缺陷修复 + 复测（本次）

接 §4.42：6 条问题逐条处置，然后**重新构建安装包、重新跑完整个装 → 跑 → 卸链路**，用实测数据证明修好了。完整报告见 `docs/packaging-install-test.md`（第一轮原始记录作为附录保留在文末）。

#### 一、修了什么（逐条给落点与证据）

| 第一轮问题 | 处置 | 落点 | 复测证据 |
| --- | --- | --- | --- |
| **中**：卸载后 `.md` 默认值残留 `Markdown`（悬空关联） | 修 | 新增 `build/installer.nsh`（`customUnInstall` + 自己的 `Lumin_UnassociateExtension` 宏），经 `electron-builder.yml` 的 `nsis.include` 挂载 | `.md=''`、`.markdown=''`，且扩展名下 `OpenWithProgids` 子键也删掉 |
| **中**：Publisher 显示 `example.com` | 修 | `package.json` 的 `author` 改成真实作者（NSIS 的 Publisher 就取自这里） | `Publisher='yang_bai_bai'` |
| 低：桌面同名快捷方式被覆盖 | **有意保持** | 不改代码 | 见下「三」 |
| 低：判断「快捷方式未携带 AUMID」 | **前提有误，改断言 + 留兜底** | `taskbar.ts` 的 `backfillInstalledShortcutAumid()`（幂等，正常走「已存在」分支） | 日志 `shortcut aumid already present … aumid=com.lumin.app` |
| 中（开发期）：dev 与打包版共用 `%APPDATA%\Lumin` 与单实例锁 | 修（opt-in） | 新增 `src/main/devProfile.ts` + `npm run dev:isolated` | 复测全程用 `--user-data-dir` 隔离，用户数据 11027 文件/38 草稿未变 |
| 低：`InstallLocation` 空 | 修（前半） | `build/installer.nsh` 的 `customInstall` 写 `InstallLocation=$INSTDIR` | `InstallLocation='…\AppData\Local\Programs\Lumin'`；`EstimatedSize` 501.4 MB 属上游估算方式，只记录不处理 |

#### 二、根因：漏的那一半在 electron-builder 自带模板里

`nsis.include` 不是「随手加一段脚本」，而是因为根因在依赖里、上游模板又不能改：

- `APP_ASSOCIATE`（`FileAssociation.nsh:65-74`）写的是三处：扩展名默认值 = FILECLASS、`OpenWithProgids` 加点、ProgID 子树；
- `APP_UNASSOCIATE`（同文件 `:99-102`）只删了**后两处** —— `OpenWithProgids` 的那个值和 ProgID 子树，**从不删扩展名的默认值**；
- 于是卸载后 `.md` 的默认值仍指着已被删除的 ProgID，Windows 只能弹「选择打开方式」。

官方给的扩展点正好够用：`customInstall` / `customUnInstall` 宏（`installSection.nsh:81`、`uninstaller.nsh:156`）。我们的宏还顺手做了幂等与「只删自己建的键」：用 `DeleteRegKey /ifempty`，别人的键一个不动。

#### 三、P3 为什么保持现状（桌面快捷方式覆盖同名文件）

`createDesktopShortcut: true` 是主流做法（VS Code / Typora / Obsidian 都是），安装向导非静默时也能取消勾选；改成 `false` 会让「装完桌面没图标」变成更常见的抱怨。真正的风险只是「静默覆盖同名文件」，而 `Lumin.lnk` 这个名字本就属于本应用。**代价**：验收脚本收尾会把桌面那条按原样重建（本轮即 `target = D:\code_workspace\Lumin`），发布说明里要写明会在桌面创建快捷方式。

#### 四、AUMID：我第一轮判错了，留档避免再犯

第一轮我说「在 `.lnk` 字节里搜不到 `com.lumin.app` → 没带 AUMID」。第二轮用 Electron 的 `shell.readShortcutLink()`（内部就是 Windows Shell 的 `IShellLink`/`IPropertyStore`）读同一条快捷方式，**读得到 `com.lumin.app`** —— electron-builder 会按 `appId` 写这条属性。

错在哪：`.lnk` 的扩展属性存储有自己的序列化格式，**把它当 UTF-16 字符串搜子串，搜不到不等于属性不存在**。现在的断言走权威 API，脚本里只保留一条「只观察、不断言」的字节搜索结果，并把这个坑写在输出里（`INFO 原始字节搜索命中=False（仅观察；与日志不一致时以日志为准）`）。

对代码的影响：`backfillInstalledShortcutAumid()` 从「补救」降级为**幂等兜底** —— 正常情况走「已存在」分支直接返回（实测正是这条路），只在快捷方式被换成不带 AUMID 的版本时才真的补写；仍然只动 AUMID 一个属性、绝不新建文件、绝不改启动参数。函数注释已按此改写。

#### 五、复测数据（本次实测）

- 产物：`dist/Lumin-1.0.0-setup.exe` **123.22 MB**（129,201,831 字节），SHA256 `341F322B4C1719532EEED790AFE5EA5609E3884CD0207E0F8B21783A6A91DA76`；
- 安装 `/S`：退出码 0、**11.2 s**；`Lumin.exe` 210,974,720 字节；
- 裸路径启动打包版：窗口标题 `安装测试-甲文档.md - Lumin`；
- 卸载 `/currentuser /S`：退出码 0、**6.4 s**；安装目录残留 0 文件；快捷方式、ProgID、扩展名默认值、卸载条目全部清除；
- **用户数据**：`before=11027/38 after=11027/38`（文件数/草稿数逐项一致）；
- 断言总计 **19/19 PASS**，退出码 0。

> ⚠️ **NSIS 产物不可字节复现**：同一份源码连打三次，sha256 各不相同（`0D953579…` / `b6424599…` / `341F322B…`），差异来自构建时嵌入的时间戳等。所以别拿 sha256 当发布校验。

#### 六、回归（确认没踩坏既有功能）

`npm run typecheck`（`tsc` + `vue-tsc`）exit=0；`node tools/_verify-packaging.js` **24/24 PASS**（含真跑 `build:win`、配置单一来源、`appId` 一致、只关联 `.md/.markdown`）；`node tools/_verify-taskbar-jumplist.js` **27/27 PASS**；本轮改动的 `src/` 文件 ESLint 0 问题。

顺带修掉一个**验收脚本**缺陷（不是产品问题，但会污染回归结论）：`tools/_verify-taskbar-jumplist.js` 的冷启动那一节把渲染页面地址硬编码成 `http://localhost:5173`，而套件里其他每次启动都是继承父进程环境的 —— 没有 dev server 时冷启动进程拿不到页面，脚本会以 `TypeError: Cannot read properties of undefined (reading 'files')` 崩掉，看着像产品回归。现改为继承父进程环境（有 `ELECTRON_RENDERER_URL` 就用，没有就走 `out/renderer`），并在注入失败时输出能看懂的结论。

#### 七、命令

```bash
pwsh -NoProfile -File tools\_install-test.ps1   # 装 → 19 条断言 → 卸 → 自动恢复机器状态
npm run dev:isolated                            # dev 用独立 profile（%APPDATA%\Lumin (dev)），不再和打包版抢锁
```

> `dev:isolated` 是**可选开关**（`LUMIN_DEV_PROFILE=1`）：默认 `npm run dev` 行为**故意不变** —— 否则你现有的开发数据会「凭空消失」（其实是换了目录），那比共用 profile 更吓人。

#### 八、本轮**未验证**的部分（别当成已验证）

真实「双击 `.md`」端到端（你的 dev 实例在跑 → 会转给它，测不出打包版自身行为；要验就关掉 dev 实例或改用 `dev:isolated` 后双击）、图形化安装向导界面、**覆盖安装/升级**、任务栏右键菜单与「固定到任务栏」的**观感**（断言只覆盖到「快捷方式/ AUMID / 启动命令正确」这一层）、自动更新（`publish` 仍是占位）、代码签名与 SmartScreen。

---

### 4.44 未保存草稿横幅的假阳性：草稿语义收敛（本次）

**现象**（用户报的）：每次新开一个窗口、或打开一个没保存过的空文档，编辑器上方都会冒出
「检测到未保存的草稿（比磁盘文件更新）」+ 恢复/丢弃。观感上像出了故障，逻辑上也说不通 ——
明明什么都没有输入。

#### 一、根因（两条，都是「草稿的语义被写成了无条件」）

1. **干净文档也写草稿。** `scheduleSave()` 的注释原文就是「草稿防抖（**始终写入**，用于崩溃恢复）」，
   `flushAll()` 更是在关窗时无条件 `writeDraft()`。于是任何一次关窗都会把**当前缓冲区**（包括
   从未编辑过的空白未命名缓冲区）落成一份草稿。实测用户盘上那份 `%APPDATA%\lumin\drafts\untitled.json`
   正是 `{"content":"","savedAt":…}` —— 空草稿。
2. **未命名草稿全应用共用一个键。** `openUntitled()` 固定读 `'untitled'`，而 `writeDraft()` 用
   `draftKey(null)` 也落到同一个键：所有窗口的未命名缓冲区共享一份草稿。于是「本窗口的空白缓冲区」
   会把**别的窗口 / 上一次运行**留下的草稿当成自己的，条件（`draft.savedAt > mtime + 1000`）对
   未命名缓冲区根本不成立（没有磁盘文件可比较），只要文件存在就弹横幅。

第 1 条决定了「**每次**都会出现」，第 2 条决定了「**新窗口**里冒出来的是别人的东西」。

#### 二、改法：把草稿的语义写成可判定的三条

| 规则 | 落点 |
| --- | --- |
| **只有脏文档才有草稿**：`content === savedContent` 时不写，并把盘上的旧草稿清掉（正等用户决定的横幅除外） | `stores/files.ts` 的 `writeDraft()` |
| **只有「确实不同」才打扰用户**：内容与即将显示的内容一致 → 不弹；文件草稿还要「确实比磁盘新」，并核对草稿里记的路径（键名对 `.`/`_` 会折叠，理论上会撞键） | `restorableDraft()`（`stores/files.ts`） |
| **未命名草稿按窗口（会话槽位）隔离**：`untitled-<slot>`；窗口没了留下的那份由主进程判定为「无主草稿」再交给空白缓冲区认领 | 新增 `src/shared/drafts.ts`（键约定，两个进程共用）+ `main/drafts.ts` 的 `takeUntitledDraft()` |

配套：

- 「谁还活着」只有主进程知道 → `registerIpc({ slotOf, liveSlots })` 由 `index.ts` 注入（不反向
  import，避免成环）；渲染层只调 `drafts.untitledDraft()` 拿结果。
- **数据安全不回退**：未命名缓冲区不进会话（§4.29），草稿是它唯一的保护。窗口被单独关闭或崩溃后，
  它的 `untitled-<slot>` 不再被任何活动窗口占着 → 下一个空白缓冲区认领并**搬移**（天然只被认领一次）；
  空内容草稿直接清掉。升级前遗留的 `untitled`（历史键）同样走认领 + 清理。
- 顺手把横幅文案接进 i18n（原先是硬编码中文、恢复/丢弃按钮也硬编码），未命名缓冲区不再说
  「比磁盘文件更新」（它没有磁盘文件），改用 `editor.restoreDraftUntitled`（三语齐全）。
- `applyDraftRestore(true)` 补 `syncEpoch++`：它和「重新解释编码」一样是**显式外部替换**，不该被
  编辑器的 600ms 回声静默窗吞掉（与 §4.39 同一类坑）。

#### 三、验收（新增套件）

`node tools/_verify-draft-banner.js`（独立 userData 起实例，21/21 PASS）：干净空白缓冲区不写草稿、
不弹横幅 → 旧版遗留的空 `untitled` 草稿不弹横幅且被清掉 → 真有未保存内容时横幅照旧出现（未命名文案）
且「恢复」能取回正文 → 干净文件不留草稿、与磁盘同内容的草稿不弹 → 真比磁盘新的文件草稿弹横幅（文件文案）
→ **多窗口**：A 窗口有未保存未命名正文时，新建窗口不冒横幅且 A 的草稿未被碰 → 无主草稿仍能被认领
→ **重启**（reload）：干净空白缓冲区不再冒横幅、脏未命名缓冲区重启后仍可恢复。

回归：`npm run typecheck` exit=0；`npm run build` 通过；本轮改动文件 ESLint 0 error；
`node tools/_verify-new-window-clean.js` **13/13 PASS**（新建窗口仍是干净窗口，不受草稿认领影响）。

> 存量影响：用户盘上那份空的 `untitled.json` 会在下次启动/新开空白窗口时被自动清掉（套件第 ② 条
> 就是按这份真实文件构造的）；已有的文件草稿只有「内容确实不同且比磁盘新」时才会再弹横幅。

---

### 4.45 关窗再打开：回到刚才那篇文档（本次）

**现象**（用户报的）：关掉窗口、重新打开，**文件夹回来了，文档却是一个不落在任何实际位置的
未命名缓冲区**（`Untitled-1.md`）—— 明明刚编辑过一篇真实的 `.md`。

#### 一、根因：单独关窗被当成「清空槽位」

`createWindow` 的 `closed` 处理器里有这么一句：单独关窗（非整体退出）时 `session.clearSessionSlot(slot)`
—— 本意是「下次启动不要把用户已经关掉的窗口又拉回来」。但用户关掉窗口往往就是「今天先这样」，
再打开时他期望回到刚才那篇；槽位一清，**文档路径就没了**。而侧栏那个文件夹来自另一处（全局
`kv.workspace.root`，不随槽位走），于是出现「文件夹在、文件是虚空的」这种极不协调的状态。
实测（`node tools/_verify-session-last-closed.js` 的 A 段就是按这条构造的）：

```
关窗前 kv：{"slots":[{"path":"…\\restore-me.md","folder":"…"}]}
关窗后 kv：{"slots":[null]}                       ← 文档路径被清掉
重启后   ：{"root":"…","doc":null,"name":"Untitled-1.md"}   ← 文件夹照旧，文档虚空
```

#### 二、改法：槽位不删，改成「已关闭」；恢复时按两种退出方式分流

| 规则 | 落点 |
| --- | --- |
| 单独关窗 → 槽位**保留**并标记 `closed`/`closedAt`（只记最后一个被关掉的） | `services/session.ts` 的 `markSlotClosed()`，由 `index.ts` 的 `closed` 处理器调用 |
| **整体退出**（菜单退出 / 系统关机 / 崩溃）：当时活着的窗口**全部**恢复（原行为不变） | `planRestore()`：优先返回未标记 `closed` 的槽位 |
| **挨个关窗**：只恢复**最后关掉的那一个**；更早关掉的是用户明确关掉的，不再冒出来 | `planRestore()`：一个存活槽位都没有时，返回 `closedAt` 最新的那个 |

两个必须一起处理的细节：

1. **恢复时立刻摘掉「已关闭」标记**（`planRestore` 写回时删掉 `closed`）。否则那个窗口会一直挂着
   这个身份：用户接着再开一个窗口、然后整体退出，它会被当成「被单独关掉的」而丢掉（测试第 C 段
   正是踩到这个才暴露出来的）。
2. **`closed` 记录会顶掉上一条**（旧的连同槽位号一起置空）。否则「先关 C、再关 B」会留下两条记录，
   而更早关掉的那条会以「存活」的身份被恢复 —— 与「只回到最后关掉的那个」相反。

#### 三、验收（新增套件，自起自灭 3 轮实例）

`node tools/_verify-session-last-closed.js`（独立 userData，**8/8 PASS**）：
- **A** 单独关掉唯一窗口 → 再打开：回到关窗时那篇文档（`doc === alpha.md`，且不是 `Untitled-N.md`），工作区文件夹照旧；
- **B** 两个窗口（alpha / beta）挨个关掉（最后关的是 alpha）→ 再打开：**只有一个窗口、且是 alpha**，更早关掉的 beta 不再冒出来；
- **C** 两个窗口一起结束（整进程被杀 ≈ 崩溃/整体退出）→ 再打开：**两个窗口都回来**。

回归：`npm run typecheck` exit=0、`npm run build` 通过、改动文件 ESLint 0 error；
`tools/_verify-session.js` **17/17 PASS**（E 段已从「关窗清槽位」改为「关窗保留并标记」，
A~D 段的光标/滚动/开关/文件丢失恢复全部照旧）；`_verify-draft-banner.js` **21/21**、
`_verify-new-window-clean.js` **13/13**。

顺带把 `_verify-session.js` 变得**不依赖 dev server**：页面识别同时认 `5173` 与
`out/renderer/index.html`，并且不再按 `Symbol(pinia)` 的名字找 store（生产构建会压掉 symbol
描述，只有 dev server 页面能命中）—— 与其余套件统一成「provides 里持有 `_s` Map 的那个对象」。

> 存量影响：你现有的 `kv.session` 里那份记录早被旧逻辑清掉了，所以**下一次正常关窗再打开**才生效
> （从那以后每次都生效）。

---

### 4.46 任务栏图标变缺省：隔离实例抢了用户的 AUMID（本次）

**现象**（用户报的）：跑过项目（开发态）之后，任务栏按钮的图标变成**缺省图标**（Windows 的空白/通用图标）。

#### 一、根因：同一个 AUMID 下有两条快捷方式，用户的应用被解析到**测试实例那条**

任务栏按钮的**图标与名字**不是取窗口自己的 HICON，而是按「**AUMID → 开始菜单快捷方式**」这条链
去解析的。而开发态我们一直用**同一个** AUMID（`com.lumin.app.dev`）给所有实例：

| 谁 | 写的快捷方式 | 图标指向 |
| --- | --- | --- |
| 用户的应用（默认配置目录） | `Lumin (dev).lnk` | `%APPDATA%\lumin\icons\lumin-<hash>.ico`（长期存在） |
| 验收/隔离实例（`--user-data-dir`） | `Lumin (dev) [test].lnk` | `<临时配置目录>\icons\lumin-<hash>.ico`（**跑完就被删**） |

于是：隔离实例一跑，开始菜单里就多了一条**同 AUMID**的快捷方式，而它的图标文件随临时目录一起消失
（`Lumin (dev) [test].lnk` 按字母序还排在前面）。Windows 解析用户的应用图标时命中那条 → 找不到图标文件
→ **任务栏只剩缺省图标**。实测证据（`%TEMP%\lumin-taskbar.log`，来自本轮验收实例）：

```
[taskbar] shortcut ok=true path="…\Start Menu\Programs\Lumin (dev) [test].lnk"
          aumid=com.lumin.app.dev icon="C:\Users\…\Temp\lumin-guard-userdata\icons\lumin-817ce6db.ico"
```

而那条 `.lnk` 的图标文件在套件收尾删掉临时配置目录后就不存在了（`IconExists: False`）。
另外同一份日志还显示隔离实例的跳转列表重建也写进了同一个 AUMID —— 用户的右键菜单会被测试实例
的临时路径顶掉一次。

#### 二、改法：隔离实例用**独立标识**，并清掉历史残留

| 规则 | 落点 |
| --- | --- |
| 开发态按配置目录分流 AUMID：默认配置目录 `com.lumin.app.dev`，隔离实例 `com.lumin.app.dev.test` | `appId()` |
| 隔离实例的图标副本改放**稳定**目录（`%TEMP%\lumin-icons`），不再随它那个跑完就删的配置目录消失 | `iconDir()` + `runtimeIconPath()` |
| 默认配置目录启动时**自愈**：删掉名字里带 `[test]` 的快捷方式（历史版本留下的、带用户 AUMID 的那条） | `removeStaleTestShortcut()`，由 `ensureShortcut()` 调用 |

`appId()` 的打包分支没动（仍是 `com.lumin.app`，与安装器一致），所以打包链路、安装器那条
`Lumin.lnk`、`backfillInstalledShortcutAumid()` 的兜底语义全部不变。`[test]` 这个名字**默认配置目录
从不用**，自愈删它绝不会碰到用户那条快捷方式。

#### 三、修完的机器状态（本次已修）

- 删掉 `…\Start Menu\Programs\Lumin (dev) [test].lnk`（它当时指向已被删除的临时图标）；
- `ie4uinit.exe -show` 刷新 shell 图标缓存；
- 复读用户那条 `Lumin (dev).lnk`：target/args 正确，图标指向
  `%APPDATA%\lumin\icons\lumin-817ce6db.ico` 且**文件存在**。

以后运行验收套件不会再产生这种残留：新的隔离实例写的是 `.test` 标识那条，且图标落在稳定目录里；
默认配置目录每次启动还会顺手清掉 `[test]` 残留。

#### 四、验收

`node tools/_verify-taskbar-jumplist.js`（隔离实例 + 主进程自检日志 + 真起第二进程）**31/31 PASS**，
其中为本次新增/改写的断言：

- `isolated-aumid-is-not-user-aumid`：隔离实例的 AUMID 必须是 `com.lumin.app.dev.test`（**不再与用户同一个**）；
- `isolated-shortcut-path-is-test-only`：它写的必须是 `[test].lnk`，不能是用户那条；
- `isolated-shortcut-icon-outside-profile`：它写的图标必须落在配置目录**之外**（稳定目录）；
- `user-shortcut-icon-still-valid`：**用户那条** `Lumin (dev).lnk` 的图标文件必须仍然存在（这条直接钉住本 bug）。

顺带把该套件的 SETUP 也换成「provides 里持有 `_s` Map 的对象」那套取 pinia 的口径
（与 §4.45 同一处改动：不再按 `Symbol(pinia)` 的名字找，生产构建会压掉 symbol 描述）。

> 如果你的任务栏还留着旧图：图标缓存是按 AUMID 记的，正常重启应用即可；极少数情况需要
> 「从任务栏取消固定 → 重新固定」，或重启一次 explorer.exe。

---

### 4.47 顶部栏「新建」按钮 + Ctrl+N 的语义：新窗口 + 工作区不变 + 未命名文档（本次）

**需求**（用户提的）：顶部栏要有一个「新建」按钮；Ctrl+N 和「文件 → 新建」都应当**开一个新窗口**，
**文件夹不变**，但文档是**未命名**的；按 Ctrl+S 时才问保存到哪。

#### 一、改之前的三种「新建」（各说各话）

| 入口 | 旧行为 |
| --- | --- |
| 文件 → 新建文档 / `Ctrl+N` | 在**当前窗口**的工作区里造一个 `未命名.md` 并打开（还先弹脏数据确认） |
| 文件 → 新建窗口 / `Ctrl+Shift+N` | 干净窗口：**不继承工作区**，空白 + 未命名文档 |
| 侧栏空态 / 文件树的「新建文件」 | 在工作区里造文件（本次**保持不动**，那才是它们该有的语义） |

#### 二、改法：一个动作、三个入口共用一份实现

- 新增 `newDocumentWindow()`（`composables/useAppActions.ts`）：有工作区 → `app.openFolderInNewWindow(root)`
  （新窗口以**同一个文件夹**为工作区）；没有工作区 → `app.newWindow()`（干净窗口）。
- 「文件 → 新建文档」、`Ctrl+N`（命令表 `file.new` → `handleMenu('new')`）、顶部栏新按钮**都调它** ——
  三个入口不可能走岔。
- **不再需要脏数据确认**：新动作完全不碰当前窗口（与「最近文档/最近文件夹 → 新窗口」同一口径）。
- 未命名文档 `path === null` ⇒ `files.save()` 天然走 `saveAs()`（`chooseFile` 对话框）：
  「Ctrl+S 时选择保存到的位置」**不需要新代码**。
- 顶部栏按钮：放在菜单组**右侧**（`data-topbar-action="new"`，`file-plus` 图标 + 「新建」，title 带 `(Ctrl+N)`），
  不挤 Alt+F/E/V/H 的位置；文案走 i18n（新增 `menu.new`，三语齐全）。
  **（后续调整：§4.50 把这个独立按钮收回「文件」菜单第一项 —— 顶部栏只留菜单组。）**

**为什么不做成「在当前窗口新建」**：用户要的是「新建 → 直接开始写 → 保存时再决定放哪」，
而且当前窗口正在写的东西一个字节都不会被打断。

#### 三、验收

新增 `node tools/_verify-new-document.js`（隔离实例，**19/19 PASS**）：

- 顶部栏按钮存在、在菜单栏内、标签等于 `menu.new`（**§4.50 起改为：「文件」菜单第一项就是「新建」、
  顶部栏不再有独立按钮、全菜单只有一个「新建」**）；
- **三个入口各跑一遍真实交互**（真实鼠标点击按钮 / 真实 `Ctrl+N` 按键 / Alt+F 后点菜单项），
  每个都：多出一个窗口（slot 变化）、新窗口 `root` 与当前窗口**同一个文件夹**（侧栏树有行）、
  文档是 `Untitled-N.md`（`path === null`、不脏）；
- **当前窗口没被动**（文档与工作区照旧）、**工作区目录里没多出任何文件**（旧行为会造 `未命名.md`）；
- 未命名 ⇒ 保存走另存为（`path === null` 前提 + 静态核对 `save() → saveAs() → chooseFile` 链，
  原生对话框无法自动作答，与 `_verify-save-as-workspace.js` 同一口径）。

回归：`tools/_verify-keymap.js` **33/33**（C 段从「工作区文件数 +1」改为「**窗口数 +1**」判定，
并新增「新窗口同工作区且未命名、不落盘」两条；录制期间那条也补上窗口数断言）；
`tools/_verify-new-window-clean.js` **13/13**（「新建窗口」的干净窗口语义未受影响）；
`tools/_verify-welcome-removed.js` **32/34**（文件菜单仍有「新建文档」、侧栏空态三个入口不变；
另 2 项是既有的隔离实例环境跳过）；`npm run typecheck` / `build` / 改动文件 ESLint 均干净。

顺带把 `_verify-keymap.js`、`_verify-welcome-removed.js` 也换成「provides 里持有 `_s` Map 的对象」
取 pinia、页面识别同时认 `out/renderer` 的口径（与 §4.45/§4.46 同一处修正）：它们现在**不依赖 dev server**。

---

### 4.48 「另存为」对话框默认落在侧栏那个文件夹（本次）

**需求**（用户提的）：§4.47 的「新建」开出来的未命名文档，按 Ctrl+S 时对话框应当**默认就停在
侧边栏打开的那个文件夹**（省掉每次自己找一遍）。

#### 一、改之前

`file:chooseSaveFile` 的 `defaultPath` 只有**文件名**（`Untitled-1.md`），于是对话框停在哪完全看
Windows 记的「上次位置」—— 常常不是当前工作区。

#### 二、改法：两半各管一段

| 半 | 落点 | 规则 |
| --- | --- | --- |
| 渲染层决定**默认目录**交给主进程 | `stores/files.ts` → `saveAs()` | `const dir = current.path ? currentDir : root` |
| 主进程拼成 `defaultPath` | `main/ipc.ts` → `file:chooseSaveFile` | `dir && existsSync(dir) ? path.join(dir, name) : name` |

- **未命名文档**（含 `Ctrl+N` / 文件 → 新建 开出来的那份）→ 传**侧栏当前工作区**；
  于是 Ctrl+S 默认就存进侧栏那个文件夹，落盘后 `syncWorkspaceToPath()` 还会把新文件在树里露出来。
- **已有路径**（对已存在的文档按「另存为」）→ 传**它自己所在的文件夹**（`currentDir` 就是打开/上次保存时记下的）——
  比一律用工作区根更符合直觉（文档在 `工作区\sub\` 下时，默认还是 `sub`）。
- **都没有**（没打开文件夹、也没有路径）→ 不传：交给系统记上次的位置。
- 目录**已不存在**（工作区被移走/删掉）→ 主进程退回「只给文件名」，不甩一个死路径出去。

#### 三、验收

`tools/_verify-new-document.js` **23/23 PASS**（在原有 19 条上新增 4 条）：

- `untitled-save-defaults-to-sidebar-folder`：Ctrl+N 的那个窗口里，交给对话框的目录 == 侧栏工作区；
- `existing-save-defaults-to-own-folder`：把工作区子目录里的 `sub\c.md` 打开后，默认目录 == `工作区\sub`
  （证明两条分支真的分开，不是都退化成工作区根）；
- `static-save-as-passes-default-dir` / `static-main-joins-dir-and-name`：静态核对两半
  （原生保存对话框无法在自动化里作答，与 `_verify-save-as-workspace.js` 同一口径）。

回归：`_verify-save-as-workspace.js` 里那条「`saveAs` 保存成功后调用 `syncWorkspaceToPath`」的静态断言仍成立；
`npm run typecheck` / `build` / 改动文件 ESLint 均干净。

---

### 4.49 按 Ctrl+N 却冒出「检测到上次未保存的内容」：草稿归属改成显式身份（本次）

**现象**（用户报的）：按 Ctrl+N 开出来的新窗口，弹出了「检测到上次未保存的内容」横幅 ——
用户明确要的是一篇空白，这既打断人又说不通。

#### 一、根因：§4.44 的「无主」判据太宽

§4.44 给未命名草稿分了命名空间（`untitled-<会话槽位>`），「无主」= **没有活动窗口占着那个槽位**。
于是两类东西都会被判成无主，并被**任何一个**空白缓冲区认领：

1. 某个窗口**被关掉**后留下的草稿（`untitled-<它的槽位>` —— 槽位不再 live，草稿还在盘上）；
2. 槽位号被复用：某个关掉的窗口腾出索引后，后来的窗口拿到同一个号，而那一格还留着**上一个住户**的正文。

Ctrl+N 开的新窗口正好是「空白缓冲区」，于是把别人的正文当成自己的弹了出来。

#### 二、改法：草稿带**写它的窗口实例**

| 机制 | 落点 |
| --- | --- |
| 每个窗口实例一个 uid（`crypto.randomUUID()`），随窗口 argv 下发（`--lumin-window-uid=`，reload 后不变） | `index.ts` `createWindow()` |
| 写草稿时盖上这个 uid（`DraftInfo.ownerUid`） | `main/ipc.ts` `drafts:save` + `main/drafts.ts` `saveDraft()` |
| 「是我的」= **uid 相同**（同一个窗口 reload 前后）；「无主」= 写它的窗口已经不在这个进程里 / 来自上一次运行 | `main/drafts.ts` `takeUntitledDraft()` |
| **只有本次运行的启动窗口**能认领无主草稿（Ctrl+N / 新建窗口是明确要空白，不打扰） | `index.ts` 的 `startupWindowId` + `SlotRegistry.mayClaimUntitledDraft` |
| 自己这一格留着**别人**的正文时：不弹、也**不覆盖**，先挪到停放键 `untitled-orphan` 等着被启动窗口认领 | `main/drafts.ts` `parkDraft()` |

安全性没丢：崩溃 / 单独关窗后的未保存正文，仍会在**下次启动的那个窗口**里被认领（§4.44 的
数据安全承诺照旧），只是不再往 Ctrl+N 的窗口里塞。

#### 三、验收

`tools/_verify-draft-banner.js` **25/25 PASS**（需要 `LUMIN_DRAFTS_DIR` 才能构造「写它的窗口不在了」
的草稿并直接核对盘上文件）：

- `new-window-does-not-claim-orphan`：新开的窗口（Ctrl+N 同一条路径）**不弹横幅**，且把它留给启动窗口；
- `startup-window-claims-orphan` / `orphan-draft-moved`：启动窗口照旧认领并搬走（数据安全）；
- `foreign-draft-not-shown` / `foreign-draft-parked-not-overwritten`：别人 uid 的草稿既不展示也不被覆盖；
- `sibling-draft-untouched`、reload / 重启那几条照旧（同一个窗口自己那份仍认得出来）。

`tools/_verify-new-document.js` **24/24 PASS**：新增 `no-new-window-shows-draft-banner` ——
先往盘上种一份无主草稿，再走**文件 → 新建 / 真实 Ctrl+N**（§4.50 前的第三条是顶部栏按钮）几条路，
新窗口都不弹横幅。

回归：`tools/_verify-session.js` **17/17**（新增的 `--lumin-window-uid` 不影响槽位解析与会话恢复）、
`tools/_verify-session-last-closed.js` **8/8**、`npm run typecheck` / `build` / 改动文件 ESLint 均干净。

---

### 4.50 「新建」收进「文件」菜单第一项（本次）

**需求**（用户提的）：把顶部栏那个独立的「新建」按钮收回「文件」菜单里，放在最上面。

**背景**：§4.47 加按钮时，「文件 → 新建文档」和它已经是**同一个动作**（新窗口 + 工作区不变 +
未命名文档）。所以这一轮不是「再加一项」，而是**合并成一个入口**（用户选的就是这条）：
菜单里若同时留着「新建」与「新建文档」，就是两个一模一样的入口。

#### 改法

| 位置 | 改动 |
| --- | --- |
| `TopMenuBar.vue` | 删掉顶部栏右侧的独立按钮；「文件」菜单第一项 = `menu.new`（新建，`file-plus` 图标），动作仍是 `newDocumentWindow()` |
| i18n ×3 | `menu.new`（新建 / New / Создать）成为这一项的文案；删掉已无人引用的 `menu.newDoc`（三语同步删，键集仍完全一致：357 键） |
| `useKeymap.ts` | 命令 `file.new`（`Ctrl+N`）的标题 key 改为 `menu.new` —— 设置 → 快捷键里显示的就是「新建」 |
| `main/menu.ts` | 隐藏的原生菜单那一项也跟着改叫「新建」（仍是同一个 `send('new')`） |
| 侧栏空态 / 文件树 | 仍用 `open.newDoc`（「新建文档」）—— 那是「在工作区里新建文件」，与菜单里的「新建」是两件事，保持不变 |

改完的「文件」菜单：**新建 / 新建窗口 / 打开… / 打开文件夹… / 最近文档 ▸ / 最近文件夹 ▸ /
保存 / 另存为… / 导出 ▸ / 选择编码重新打开 ▸**。

#### 验收

`tools/_verify-new-document.js` **23/23 PASS**（原 19 条的入口断言按新位置重写）：

- `topbar-button-removed`：顶部栏只剩五个菜单组（`文件(F)|编辑(E)|段落(D)|视图(V)|帮助(H)`），没有残留按钮；
- `file-menu-first-item-is-new`：文件菜单**第一项**就是「新建」；
- `file-menu-has-single-new-entry`：全菜单只有**一个**「新建」，且不再有「新建文档」；
- `menu-new-opens-new-window` / `menu-new-keeps-same-folder` / `menu-new-doc-untitled` /
  `menu-new-works-repeatedly`：真实点这条菜单项（两次）→ 每次都多出一个窗口、工作区不变、
  文档是未命名缓冲区；加上 `Ctrl+N` 那条，以及 `no-new-window-shows-draft-banner`（种了无主草稿也不打扰）。

回归：`tools/_verify-welcome-removed.js` **32/34**（`file-menu-has-new` 已改成「第一项是新建、
且没有新建文档」；另 2 项仍是既有的隔离实例环境跳过）、`tools/_verify-i18n.js` 正常切换语言；
三份 locale 键集逐项一致（357 键，无 missing/extra）；`npm run typecheck` / `build` / 改动文件 ESLint 均干净。

> `tools/_verify-keymap.js` 本轮**未跑**：它 `import('/src/lib/keymap/service.ts')`，必须有 dev server
> 在 5173 才跑得起来，而写这轮时它没在跑。本轮对它的影响只是 `file.new` 的标题 key 换成 `menu.new`
> （三语都有这个 key，且 `titles-and-groups-translated` 校验的就是「标题能取到」），Ctrl+N 的行为
> 由上面那个套件覆盖。

---

### 4.51 系统性优化第一轮：数据安全 + 门禁 + 安全/性能 + 测试基建（本次）

> 依据：桌面上的《Lumin 项目评审报告》。按仓库自己的规矩「一次一波、每波留下可复跑数字」，本轮做的是
> 报告里的**第一批（零风险高收益）**，外加三个高价值项（安全加固、索引节流、单元测试 + CI）。
> Wave 1（Markdown 保真）与 Wave 2（元数据/EOL/本地历史）**未动** —— 它们是各自独立的一波，见文末。

#### 一、数据安全（P0）

| 项 | 改法 | 落点 |
| --- | --- | --- |
| **写盘原子化** | 同目录临时文件 → `fsync` → `rename` 覆盖；失败清理临时文件并原样抛出 | `main/fileOps.ts` `writeFile()` |
| 失败要带原因 | IPC 错误前缀削掉后进 toast（不再只有「保存失败」） | 新增 `renderer/lib/errors.ts`，`stores/files.ts` 的 `save()` / `reopenWithEncoding()` |

为什么必须：原先 `fs.writeFile` 直接覆盖原文件，写入中途崩溃/断电/磁盘满会把用户唯一的一份稿件截断，
而当时连本地历史都还没有 —— 这是写作工具最不能接受的一类故障。同分区 `rename` 是原子的，
磁盘上任何时刻只可能是「完整旧版」或「完整新版」。

#### 二、门禁可用（P2）

| 项 | 改法 | 实测 |
| --- | --- | --- |
| `tools/**` 不进 lint | flat config `ignores` 加 `tools/**`、`build/**`（脚手架是 CommonJS + 一次性脚本，898 个 error 把真问题淹了） | 912 → 14 errors |
| 行尾不再假报 | `.prettierrc.yaml` 加 `endOfLine: auto`（工作树是 CRLF，默认 LF 校验让**每一行**都报 `Delete ␍`） | 7260 → 0 warnings |
| 修掉 src 的 14 个 error | 13 个 `no-useless-escape`（正则字符类里的多余转义）+ 1 个缺返回类型 | — |
| 格式化收口 | `prettier --write src`（41 个文件，纯格式） | — |
| **结果** | — | **`npm run lint` 0 error / 0 warning（exit 0）** |

**踩到的坑（值得记住）**：`prettier --write` 会把模板里**内联多语句**的分号吃掉，变成
`@dblclick=" a = 1 b() "`，Vue 模板编译器随后报 `Error parsing JavaScript expression`，构建直接失败。
正确做法是把这类逻辑抽成方法：本轮抽了 `collapseSidebar` / `openGeneralSettings` / `pickTheme` /
`resetSplitRatio`（顺带让模板更干净），并在 `tools/_verify-local-media.js` 里逐个个点了一遍。

#### 三、仓库卫生（P2）

- 取消跟踪并清理误提交的构建产物：`build-out.txt`、`typecheck-out.txt`、`dev-app-update.yml`（`.gitignore` 同步加规则）。
- 新增 `.gitattributes`：行尾与二进制类型写进仓库，不再看各机器的 `core.autocrlf`（**没有**顺手 renormalize 历史，那是独立一次改动）。
- README 重写：平台现状（Windows 优先，mac/Linux 未验证）、真实的质量门禁命令、目录结构、文档地图、
  已知限制与路线 —— 修掉「说 2 种语言其实 3 种」「说 run-verify.ps1 跑 45 项其实只跑 1 个」这类过期信息。
- 新增 `CHANGELOG.md`（Keep a Changelog；此前完全没有）。
- 依赖与元数据：删掉未使用的 `@electron-toolkit/preload`（`src` 里 0 引用，并同步了 lock）、
  删掉 pnpm 专用字段 `allowScripts`、补 `engines.node >= 22`、补 `npm run ci` / `lint:fix`。
- 死代码：删掉 `wasCrashed()` 与整套 crash-flag（写而不读）、`releaseSlot()`（从未被调用）。

#### 四、安全加固（P1）

| 项 | 改法 | 落点 |
| --- | --- | --- |
| `lumin-file://` 无校验 | **两道白名单**：① 媒体扩展名（图片/音视频/PDF）；② 必须位于「当前工作区」或「某个已打开文档所在目录」之内，否则 404 并记一行日志 | `main/index.ts` `protocol.handle` + `shared/media.ts`（纯函数）+ `fileOps.isServableMedia()` + `openDocs.listOpenDocs()` |
| 缺 `will-navigate` 兜底 | 只允许停留在自己的页面，其余拦下并交系统浏览器（与 `setWindowOpenHandler`、`shell:openExternal` 白名单同口径） | `main/index.ts` `createWindow` |
| 搜索结果 `v-html` | 主进程 `snippet()` 改用 U+0001/U+0002 作标记（**数据里不再夹 HTML**），渲染层按段渲染 `<em class="gs-hl">` —— **全程没有 `v-html`**，也就没有转义遗漏的机会 | `main/services/database.ts` + 新增 `renderer/lib/highlight.ts` + `GlobalSearch.vue` |

顺带修掉一个**功能缺口**：`![](img/a.png)` 这类相对图片原先按「页面目录」解析（`resolveLocalImageSrc`
是空实现）→ **渲染不出来**。现在按**文档目录**解析成 `lumin-file:///<绝对路径>`（新增
`renderer/lib/imageSrc.ts`，纯函数 + 单测），走上面那道校验过的协议加载。

#### 五、性能（P1）

**FTS 索引节流**：自动保存默认 3 秒一次，原先每次都 `DELETE` + `INSERT` 整篇正文进 FTS5 ——
`DatabaseSync` 是**同步** API、跑在主进程上，大文档等于每 3 秒卡一下。现在：
元数据（标题/时间/字数）立即写；正文索引按 rowid 合并、**2 秒窗口**批量重建（批次内开事务，
`node:sqlite` 没有 better-sqlite3 的 `.transaction()`，就显式 `BEGIN/COMMIT/ROLLBACK`）；
单篇超过 **256KB** 只索引前一段；**搜索前**与**退出前**各 flush 一次，保证「刚保存就搜」也能命中。
落点：`main/services/database.ts`（`scheduleFtsIndex` / `flushFtsIndex` / `clipForIndex`）+ `index.ts` 的 `before-quit`。

#### 六、测试基建（P1-7 / P2-2）

1. **把判定从 I/O 里剥出来**（这是本轮结构性改动的主线）：
   - `shared/drafts.ts`：`planUntitledDraft(ctx, onDisk)` → 返回 `show / adopt / park / purge` 步骤；
     `main/drafts.ts` 只剩「列目录 → 问它 → 照做」。这块语义连续出过三次真 bug（§4.44/§4.45/§4.49）。
   - `shared/session.ts`：`planRestoreFromSlots(slots, max)` → 返回「重建哪些窗口 + 清哪些 closed 记录 + 摘哪些标记」；
     `main/services/session.ts` 只做 kv 读写。
   - `shared/media.ts`、`renderer/lib/imageSrc.ts`、`renderer/lib/highlight.ts`：同样是纯函数。
2. **`tests/`（`node --test`，原生 TS 类型剥离，零新依赖）**：57 条断言 —— 草稿归属矩阵（11 条）、
   会话恢复矩阵（9 条）、高亮分段（5 条）、图片路径（8 条）、路径工具（5 条）、编码表（5 条）、
   媒体白名单（8 条）、**package.json ↔ package-lock 一致性自检**（6 条）。
3. **CI**（`.github/workflows/ci.yml`，Windows runner）：`npm ci` → typecheck → lint（`--max-warnings 0`）→ 单测 → 构建。
   本地等价命令是 `npm run ci`。

#### 七、本轮验收数字（全部可复跑）

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run lint` | **0 error / 0 warning** |
| `npm run test:unit` | **57/57** |
| `npm run ci`（本地等价 CI） | exit 0 |
| `npm run build` | exit 0 |
| `_verify-draft-banner.js` | 25/25 |
| `_verify-new-document.js` | 23/23 |
| `_verify-session.js` | 17/17 |
| `_verify-session-last-closed.js` | 8/8 |
| `_verify-taskbar-jumplist.js` | 31/31 |
| `_verify-local-media.js`（本轮新增，10 条） | 10/10 |

`_verify-local-media.js` 覆盖三块：相对图片按文档目录解析并**真的加载成功**、协议两道闸
（非媒体文件 404、工作区外图片 404）、以及本轮抽成方法的四个 UI 处理器逐个点一遍。

#### 八、本轮**未做**（下一波的起点，别当成已完成）

1. **Wave 1 Markdown 往返保真**（信誉底线）：夹具 + `EXACT/NORMALIZED/LOSSY` 三档 + 幂等回归 + 报告。**优先做这个。**
2. **Wave 2 数据安全**：`documents` 表加编码/EOL/BOM 列 + 迁移；`services/eol.ts`；本地历史与回滚；以编码/EOL 保存。
3. **Wave 3**：编辑器 ⇄ store 的显式意图状态机（替换回声 + 600ms 两条启发式）；文件树键盘可达；原生菜单文案三语。
4. **工程化**：`tools/lib/harness.js` + `tools/run-suites.js`（57 个 CDP 套件目前没有统一入口，
   且仍有 49 个套件按 `Symbol(pinia)` 名字取 store —— 在生产构建下会失败）；
   `files` store 拆分；把 store 里那份为绕循环导入复制的 `confirmIfDirty` 收敛到 `services/dialog`。
5. 依赖升级与 `node:sqlite` 实验 API 的升级检查单；`publish` 渠道与代码签名决策。

---

### 4.52 Wave 1：Markdown 往返保真（本次）

> 上一节把「Wave 1」列为第一优先，理由是它是**写作工具的信誉底线**：
> 用户打开一份 `.md`、动一下、保存 —— 文件不该变；内容更不该被吃掉。
> 本轮把它做成可复跑的数字，并在过程中查实并修掉了 **7 类内容损坏缺陷**。

#### 一、判级器：`tools/lib/md-fidelity.js`（纯函数，零依赖）

三档分级，等级数字越大越糟（`actual > expected` 即回归）：

| 档 | 含义 |
| --- | --- |
| `exact` | 磁盘字节完全没变 |
| `normalized` | 经过**文档化的保义规则**规范化后完全一致：文件被重写，但语义没丢 |
| `lossy` | 规范化后仍不一致 → 内容/结构真的变了，必须当缺陷处理 |

规范化只收「能在 CommonMark 语义上站得住脚」的改写，共 18 条（`RULES` 导出，报告可直接引用）：
行尾 LF、硬换行两种写法归一、ATX/Setext 标题、列表标记 `*`/`+`/`1)`、引用块、分割线、表格空白与分隔行、
围栏 `~~~`→``` ```、缩进代码 ↔ 无 info 围栏、强调标记 `__`/`_`、链接尖括号、HTML 实体、引用式链接展开、
**段落内软换行合并（软换行 ≡ 空格）**、连续空行压缩、非必要转义 `\\` ≡ `\`、
**不同标记的相邻列表之间的空行无义**（同标记的空行会让列表变松散，那就有义了）。

判定「不能靠规则糊过去」的例子（都写成了单测）：围栏内容里的 `*` 差异、行内代码里的内容差异、
`**粗**`→`*斜*`、少一个列表项、表格单元格内容变化、段落合并、代码语言丢失。

#### 二、夹具库 `tools/fixtures/md/`（30 份 + `EXPECT.json`）

覆盖：标题（ATX/Setext/边界写法）、段落与硬换行、强调与嵌套、转义、列表（无序/有序/嵌套/松散/相邻）、
任务列表（含有序）、引用块、分割线、围栏代码（含内容里带 ```）、缩进代码、表格（对齐/转义竖线）、
链接（行内/带标题/自动链接/裸 URL/中文路径/引用式）、图片（本地/远程/空 alt/行内/被链接）、行内 HTML、
实体、中日韩与 Unicode、公式、mermaid、`[TOC]`、YAML front matter、空行边界、综合文档。

**`EXPECT.json` 就是契约**：`class` + `why`。`lossy` 必须写清**为什么**以及**修法**——
没有 why 的 lossy 等于把缺陷藏进预期里。实测比预期好会在输出里提示「可收紧」，
比预期差就是 FAIL。

#### 三、套件 `tools/_verify-md-fidelity.js`（文档级 / 幂等 / 字节级）

1. **文档级（主断言）**：把夹具装进真实编辑器 → 触发应用**自己的落盘管线**
   （`TyporaEditor` 的 `flushSync`，用 window 的 `beforeunload` 同步触发，正是「关窗落盘」那条真实路径）
   → 读 `files.current.content`（= 文档文本）→ 判级比对。
   *为什么绕这一道*：Tiptap 只在 **docChanged** 时发 `onUpdate`（还有 250ms 防抖），
   而 `beforeunload` 的 flush 是同步的 —— 既确定，又不用给产品代码开后门。
2. **幂等**：把文档文本再装回去走一遍，必须**一字不差**（否则每次保存都在漂，
   git diff 全是噪声，用户会认为编辑器在改他的文件）。已知缺口内的幂等不检查。
3. **字节级**：真开真存（临时目录副本）—— 打开不改就保存必须**字节不变**
   （CRLF / UTF-8 BOM / GB18030 / 文末无换行四种），走一遍落盘管线再保存也要字节不变。
   诊断产出落 `%TEMP%\lumin-md-fidelity-report.json`（原文/产出/判级/逐行差异）。

#### 四、本轮查实并修掉的缺陷（都是「用户会丢内容」那一类）

| 现象 | 根因 | 修法（落点） |
| --- | --- | --- |
| 代码块里出现成对反引号（``let a = `x```）时，**一次编辑后整段代码并成一行** | 标记模型的「源码权威重推」把 `codeBlock` 当普通段落处理（PM 里 `isTextblock` 对代码块也为真），拿代码文本再喂 markdown-it，而重推走的 DOMParser **不保留空白** → 换行全塌成空格 | `isVerbatimBlock()`（`type.spec.code === true`）把逐字块排除在归一化之外（`typoraInlineMarks.ts`） |
| 行内代码里的反斜杠**每保存一次多一层**（非幂等增长） | prose-mirror-markdown 只按**最内层 mark** 的 `escape:false` 决定原样输出，而 `mdStyle(code)` 正文没有这层保护；代码跨度里反斜杠不是转义字符 | 新增 `mdCodeLiteral` mark（空包裹 + `escape:false`），贴在代码样式正文上（`typoraInlineMarks.ts` + `extensions.ts`） |
| 软换行被写成行尾 `\`（每行都加） | `Markdown.configure({ breaks: true })`：markdown-it 把段内单个换行渲染成 `<br>` → 解析成 hardBreak → 序列化成 `\`。语义从「软换行 ≡ 空格」变成强制换行，GitHub 渲染都不一样 | `breaks: false`；真正的「软换行可往返」需要独立节点，列为 Wave 2 |
| 无序列表标记被抹平（`*`/`+` → `-`），相邻两个列表被插**两个空行**，再解析并成一个**松散列表** → 每次保存都在漂 | 上游 `bulletListMarker` 固定 `-`；`renderList` 遇到同类型相邻块会 `flushClose(3)` 兜底 | 解析时记录 `bullet`（`parse.setup` 钩子给 `<ul>` 打 `data-bullet`）→ 序列化写回原标记；标记不同时 `flushClose(1)` 只断行不插空行（`listMarkers.ts`） |
| 任务列表**每个任务项之间都被塞空行**；`1. [ ] x` 变成「空的有序项 + 无序任务列表」 | 任务列表复用无序列表的序列化器，而它读 `node.attrs.tight`，`tight` 只挂在 bulletList/orderedList 上 → `undefined` → 松散；`ol` 形态的任务列表没有 parse 规则 | 给 `taskList` 补 `tight` 属性；parse 规则同时认 `ul/ol[data-type="taskList"]`（`listMarkers.ts`） |
| 相邻图片被粘成一行；图片后紧跟的标题被吞进同一段 | `Image` 是块级节点，但 tiptap-markdown 给它的是行内序列化器（不换行、不 closeBlock） | 自定义 Image 序列化器：沿用上游写法 + `closeBlock`（`extensions.ts`） |
| 内容里含 ``` 的代码块，围栏被内容提前闭合 → 后面正文被解析成代码 | 围栏固定写三个反引号 | `codeFenceFor(content)`：围栏长度 ≥ 内容里最长反引号串 + 1（`shared/documentText.ts` + `codeBlock.ts`） |
| 序列化产出**不含文末换行** → 每次保存都与原文差一个字节 | 上游 serializer 不补 | 文档文本收尾规则 `withFinalNewline()`，收在 `markdownStorage.getMarkdown()`（编辑器内容 → 文档文本的**唯一出口**，否则会与外部同步比较打架、触发 setContent 回滚） |

#### 五、判级器/工具链自身踩过的坑（都已修，值得记）

- **判级器**：围栏闭合必须**不短于**开启（` ```` ` 里的 ``` 不闭合它）；`---` 既是 Setext 下划线又是分割线，
  得按「前面是不是段落文本」判（CommonMark 顺序）；`$$` 块要与多行写法归一；实体要按命名/十进制/十六进制还原
  （`&lt;` 与 `<` 才判等）；链接目标要还原百分号编码（`%E4%B8%AD` ≡ `中`）；
  相邻列表之间的空行要**在标记归一化之前**判定（归一化后 `*` 也成了 `-`，就再也分不出两个列表了）。
- **`start-isolated.ps1`**：Electron 的 `--user-data-dir` 用的是 **8.3 短路径**（`YANGBA~1`），
  拿长路径字符串比对会**漏杀**旧实例 —— 曾经因此对着**旧构建**跑了一整轮验收（结论全错）。
  现在两边都 `Resolve-Path` 成同一形态再比；端口判定改用 TCP 连接（`Get-NetTCPConnection`
  在受限模式会静默返回空，把「被占」判成「空闲」）。
- **PowerShell 脚本必须存 UTF-8 with BOM**：Windows PowerShell 5.1 读无 BOM 的 UTF-8 脚本时按 ANSI 解码，
  中文注释里的多字节序列会撞出引号 → 语法错误。
- **别用 PowerShell 做字符串替换**：`$pair[0]`/`$pair[1]` 在字符串上取到的是**首字符**
  （`'s'`/`'t'`），一次替换把源码里的 `s` 全换成了 `t`（两个文件被改坏，`git checkout` 才救回来）。
  这类一次性改写一律走 Node 脚本。

#### 六、测试基建（本轮补齐）

- **`tools/lib/harness.js`**：CDP 套件公共骨架 —— 连页面、注入 pinia 访问器、键鼠模拟、结果汇总。
  两个反复咬人的坑固化在这里：**按结构找 pinia**（`provides` 里持有 `_s` Map 的那个对象），
  不按 `Symbol(pinia)` 名字找（生产构建会压掉 symbol 描述 → 只有 dev server 的页面能用）；
  页面识别同时认 dev server 与 `out/` 构建产物（不写死 5173）。
- **`tools/run-suites.js`**：统一入口 —— 逐个套件起**全新隔离实例**（串着跑必然互相污染）、
  解析末行 `--- N/M PASS`、汇总矩阵、有 FAIL 非零退出；依赖 dev server 的套件默认跳过（`--all` 才跑）。
- **单测**：`tests/md-fidelity.test.mjs`（判级器自身：每条规则一个同义改写用例 + 反例 + 幂等）、
  `tests/documentText.test.mjs`（收尾规则与围栏长度）。单测总数 57 → **81**。

#### 七、本轮验收数字

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run lint` | 0 error / 0 warning |
| `npm run test:unit` | **86/86**（57 → 86） |
| `npm run ci` | exit 0 |
| `_verify-md-fidelity.js` | **50 PASS / 0 FAIL / 20 SKIP**（30 份夹具；SKIP = `EXPECT.json` 里逐条写明修法的已知缺口） |
| `node tools/run-suites.js` | **7/7 套件 PASS**：session-last-closed 8/8、md-fidelity 50/70（0 FAIL）、draft-banner 25/25、new-document 23/23、session 17/17、local-media 10/10、encoding 31/31 |

#### 八、已知缺口（`EXPECT.json` 里逐条写了修法，Wave 2 的起点）

1. **反斜杠转义保留**：`\*` 被解析器吃掉，模型还原不回来（语义会从「字面星号」变成「斜体」）。
   修法：用 `parse.setup` 钩子替换 markdown-it 的 inline `escape` 规则，把转义字符渲染成带 data 标记的
   span + 一个 `escape:false` 的 mark 原样写回（钩子已验证可用）。
2. **行内 HTML**（`<kbd>`/`<span>`/`<br>`/注释/`<details>`）：unknown 标签被 DOMParser 剥离。修法：加「原样 HTML 节点」。
3. **表格列对齐 +单元格转义竖线**：Tiptap 表格没有 align 属性；`\|` 会被当分隔符。修法：cell 加 align + 自定义 Table 序列化器转义 `|`。
4. **公式**：应用**根本没有数学节点**（KaTeX 只用于导出 CSS），`$$` 只是普通文本，里面的反斜杠会被补成 `\\`。
   修法：mathInline/mathBlock 节点 + 原样序列化（顺带把「公式渲染」这个功能补上）。
5. **链接包裹的图片**（`[![alt](img)](url)`）与**段落中间的图片**：块级 Image 挂不了 link mark、会被拆成独立块。
   修法：内联图片节点或 figure 包裹节点。
6. **有序任务列表编号**：`1. [ ] x` 的编号在模型里没有位置。
7. **YAML front matter**：被解析成分割线 + 段落。修法：解析前摘出头部块存进文档属性。
8. **CommonMark 同标记相邻列表的重编号**：`3. c` 空行 `5. e` 在 CommonMark 里是**同一个**松散列表，
   所以 `5.` 会被重排 —— 这是规范行为，要「保持从 5 开始」得拆列表并记住起始序号。
9. **CRLF 与文末无换行**（字节级）：编辑器序列化只产出 LF；文档收尾规则统一补一个文末换行。
   前者要把 EOL 收进文档模型（Wave 2 的数据安全波）。

---

### 4.53 Wave 2：文档级元数据（编码 / 行尾 / BOM）与本地历史（本次）

> 这三件事是**同一个根**：「文档级元数据没有模型」。此前编码只活在渲染进程的 `current` 上、
> 再配一张 kv 表兜；行尾（EOL）**根本没人管**；保存成功即清草稿 —— 一次误保存无法挽回。
> 本波把前两件收进 `documents` 表，把第三件做成一条**写盘前的快照链**。

#### 一、行尾（EOL）进文档模型

**约定**：**内存里的文本永远是 LF，行尾是文档属性，落盘时才展开。**
理由：编辑器内核（ProseMirror / markdown 序列化器）只会产出 `\n`；若让「当前文本」承担行尾，
那么任何一次序列化都会把 CRLF 抹成 LF，而且没有任何一层知道它该不该抹。
把行尾变成**属性**之后只有一个真相：编辑器怎么改都不会污染行尾。

- `src/shared/eol.ts`（纯函数 + 单测）：`detectEol`（按**多数**行尾判定）、`toLf`、`toEol`、`hasUniformEol`。
- 判定与归一位于 `fileOps.readFileInfo`（打开时一次），展开位于 `fileOps.writeFile`（写盘时一次）——
  **所有写盘路径都走这里**（保存、另存为、导出），不会有调用点漏掉。
- 混合行尾（同一文件两种混用）没有正确答案：按多数判定，保存时统一成它。这条写进代码注释与本文档，
  免得日后被当 bug 报。
- **实测收益**：`_verify-md-fidelity.js` 的 crlf 字节级用例（打开 → 动一下 → 保存，字节必须不变）
  从「已知缺口」变成 **PASS**。

#### 二、编码 / 行尾 / BOM 落库 + 一次性迁移

- `documents` 表加 `encoding` / `eol` / `had_bom` 三列，用 `PRAGMA table_info` + `ALTER TABLE` 迁移
  （与 notifications 加列同一套写法，旧库无痛升级）。
- 老的 kv `fileEncodings`（`{ 小写路径: 编码 }`，插入序当 LRU）做**一次性迁移**：
  能对上 `documents` 行的条目搬进表；对不上的（文件还没进索引）留在 kv 兜底；迁完打标记不重复扫。
  `rememberEncoding` 现在优先写 `documents`，并顺手清掉 kv 里的同名条目，避免两处不一致。
- 顺带修掉一处**同名双份定义**：`DocMeta` 原本在 `shared/types.ts` 与 `main/services/database.ts`
  各写了一份。现在只保留 shared 那份并再导出（"一次真相"这条约定不该有例外）。

#### 三、本地历史（数据安全）

**问题**：保存成功即清草稿 —— 全选删掉再 Ctrl+S、或改错一份稿，就再也回不去了。

**做法**：

- 新表 `documents_history`（path / saved_at / size / preview / content / encoding / eol）。
- **快照取自磁盘上现有的字节**（即将被覆盖的那一版），记录点在主进程 `file:write`：
  * 语义准确 —— 用户想回滚的就是「上次保存时磁盘上的样子」；
  * 与调用方解耦 —— 保存、另存为、以后的回滚写回都自动有历史，不依赖某个调用点记得调用；
  * 内容相同不重复留（连按 Ctrl+S 不会灌水）。
- **抽稀策略是纯函数**（`shared/history.ts` 的 `planHistoryPrune`，有单测）：
  每文件最多 30 条；超过 30 天且不是该文件最新 3 条就丢；全库封顶 2000 条。
  数据安全优先于省空间：**每个文件的最新几条不受年龄限制**（全库膨胀交给总量封顶）。
- **回滚的语义是「载入缓冲」而不是「直接写盘」**：快照是说不准的东西，直接覆盖磁盘风险太大
  （选错版本、或只想摘一段）。载入后文档变成未保存状态，用户能在编辑器里看清/对比再 Ctrl+S。
  实测断言直接盯着这条：载入后缓冲是第一版、**磁盘仍是第三版**、`dirty === true`。

#### 四、界面

- 状态栏新增**可点的行尾标记**（LF ⇄ CRLF，点击即按新行尾写回）—— 行尾是「打开→保存会不会整文件 diff」
  的直接原因，值得一眼可见、一键可改。
- 文件菜单新增两个二级：「行尾」（以 LF / CRLF 保存）与「以编码保存」；「本地历史…」开浮层。
- 设置面板新增「默认行尾」（只影响新建/未命名文档；已有文件按自己原本的行尾）。
- 三语同步 11 个键（377 键，键集合一致）。

#### 五、本轮验收数字

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` / `npm run lint` | exit 0 / 0 error 0 warning |
| `npm run test:unit` | **97/97**（新增行尾 6 条、历史策略 5 条） |
| `_verify-md-fidelity.js` | **63 PASS / 0 FAIL / 19 SKIP**（82 条断言；新增行尾 6 条、历史 6 条） |
| `node tools/run-suites.js` | 7/7 套件 PASS |

行尾与历史的端到端断言（都是一个真实 Electron 窗口里跑出来的）：
打开 CRLF 文件 → 判定 `crlf` 且内存无 CR；切 LF → 磁盘 LF；切回 CRLF → 磁盘 CRLF；
元数据落库（`documents.eol/encoding`）；未命名文档用设置里的默认行尾；
保存两轮 → 历史两条（最新一条正是「即将被覆盖」的那一版、最早一条是打开时的原文）；
载入历史 → 缓冲变、磁盘不变、标记未保存；清空 → 归零。

#### 六、工具链补丁（本轮踩到的坑）

`tools/run-suites.js` 现在会在开场与「端口被占」时**清掉临时目录下的 Electron 实例**：
人工起的隔离实例（`%TEMP%\lumin-ud` 等）会占着 9222，把整轮矩阵顶成 6 个 FAIL ——
而那看起来像"代码坏了"，实际只是端口被占。判定按「命令行里的 user-data-dir 落在 `%TEMP%` 下」，
**绝不碰**用户自己的 `%APPDATA%\lumin` 实例。

#### 七、Wave 2 剩余（下一轮的起点）

1. **多窗口一致性**：同一文件在两个窗口打开时，编码/行尾以库为准（库表已就位，
   还差"打开时优先用库里记的元数据"这一步取舍与套件）。
2. **本地历史的可配项**：设置面板里的开关与保留策略（当前是代码里的常量 + 纯函数策略）。
3. 反斜杠转义保留（Wave 1 留下的第一号缺口，钩子方案已验证可用）。

---

### 4.54 Wave 3：显式意图同步 / 文件树键盘可达 / 原生菜单三语（本次）

> 三条的共同思路：**把"猜"换成"明说"**。

#### 一、编辑器 ⇄ store：显式意图状态机（替掉两条回声启发式）

**旧实现的两年债**（§4.6 / §4.11 记录过它救过的火）：`TyporaEditor` 的 watch 靠两条启发式判断
「这次 `modelValue` 变化是不是我自己的回声」——
① 与最近一次 emit 的内容完全相等 → 跳过；② 距最近 emit < 600ms → 跳过。

两条都**必漏判**，各自有记录在案的故障：

| 场景 | 旧行为 |
| --- | --- |
| 按原编码切回来（内容恰好等于上次 emit 的文本） | 规则①把它当回声丢掉 → **状态栏编码变了、正文没变** |
| 刚打完字就点「恢复草稿 / 切编码」 | 规则②把它丢掉 → 同上 |
| 每次 modelValue 变化 | 都要做一次**整篇字符串比较**（大文档下的无谓开销） |

**新实现**：契约定在 store 里 —— **凡是要编辑器换内容的动作都必须自增 `files.syncEpoch`**
（打开文件、恢复草稿、重新解释编码、载入历史；源码模式切回来走另一条既有路径）。
编辑器只看一件事：

```
世代没变 ⇒ 不是给编辑器的指令（多半是自己 flush 的回声）→ 不动编辑器
世代变了 ⇒ 按 store 的新内容 setContent（内容一致时连这一步都省）
```

于是「碰巧内容相等」「刚 emit 完」都不再影响判断，两条启发式连同 `lastEmitted`/`lastEmitTime`
一起删掉。**验收盯着三件事**（`tools/_verify-wave3.js` A 段）：

- flush 完之后**立刻**做显式替换，必须生效（旧规则②会吞掉它）；
- 编辑器自己的回声**不得**重建文档：输入一个字符后走完回声链路，文档内容与光标位置原样保持；
- 同一 `:key` 下换内容（未命名缓冲区 `openUntitled`）也要生效。

#### 二、文件树键盘可达（ARIA tree + roving tabindex）

`FileTree.vue` 容器是 `role="tree"`，每一行是 `role="treeitem"`，带 `aria-expanded`（目录）、
`aria-selected`（当前文档）、`aria-level`；**整棵树任何时候只有一个可 Tab 的行**（空闲时也挑一个落点，
`schema` 上就是 roving tabindex 的 0）。

键位按 WAI-ARIA 的 Tree View：`↑/↓` 上下、`→` 展开（已展开则进第一个子项）、`←` 收起（已收起则回父项）、
`Home/End` 首尾、`Enter/Space` 打开文件（目录则展开收起）。实现放在 `lib/treeFocus.ts`：

- **递归组件里怎么拿"可见行"**：直接用 DOM 顺序（`[data-tree-row]`）—— 渲染出来的行就是可见行，
  顺序天然等于 ARIA 要求的遍历顺序；不用把递归树拍平成数组再逐层传 props。
- **进子项为什么要轮询**：展开是一次 IPC 读目录 + 渲染，单次 `nextTick` 太早（实测拿不到子行）；
  实现里按 60ms 轮询几轮，并且每次都确认"本行仍是活跃行"（期间用户可能已按别的键）。
- 键盘焦点有可见描边，且只在 `:focus-visible` 时出现（鼠标点击不闪描边）。

#### 三、原生菜单三语化

菜单栏默认被隐藏（自绘顶栏 + `autoHideMenuBar=false`），只有系统级可访问性路径（Alt 唤出、
屏幕阅读器、Windows 菜单键）会用到它 —— 正因为"没人看"，它一直是硬编码中文。

- **语言包搬到 `src/shared/i18n/`**：主进程与渲染层**共用一份**（跨进程的东西放 shared，README 的开发约定）。
- `main/menu.ts` 所有标签走语言包；语言取持久化设置（SQLite kv 的 `settings.language`）。
- **换语言立即重建**：`settings:update` 里 `partial.language` 存在时调用 `installMenu()`（否则要重启才生效）。
- **可验证性**：菜单栏页面侧看不到，所以加了一行 ASCII 自检日志 `[menu] rebuilt lang=… top=…`；
  验收脚本读隔离实例的 stdout 断言"确实按新语言重建了"。
- **静态自检单测** `tests/menu.test.mjs`：菜单源码里没有硬编码中文（去掉注释后搜 CJK）、
  `T('key')` 用到的 key 在三份语言包都存在、顶层菜单带助记符、三份键集合一致。
  这条**当场抓出** 4 个漏翻的键（`cut`/`copy`/`paste`/`selectAll` 在语言包里根本不存在，
  原生菜单会退化成显示英文 key）。

#### 四、本轮验收数字

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` / `npm run lint` | exit 0 / 0 error 0 warning |
| `npm run test:unit` | **101/101**（新增菜单静态自检 4 条） |
| `tools/_verify-wave3.js`（新增，19 条） | **19/19 PASS** |
| `tools/_verify-md-fidelity.js` | 63 PASS / 0 FAIL / 19 SKIP |
| `node tools/run-suites.js` | **8/8 套件 PASS** |

Wave 3 段的端到端断言（真实窗口里跑出来的）：flush 后立刻显式替换仍生效且编辑器确实换成新内容；
自身回声不改文档、不动光标；`openUntitled` 同 key 也清空编辑器；
树结构（role/treeitem/aria-expanded/单一可 Tab 行）、`↓↑`、`Home/End`、`→` 展开并进子项、`←` 回父项并收起、
空目录再按 `→` 安静留在原地、`Enter` 打开焦点行文件；语言切到 en-US 后主进程按新语言重建菜单。

#### 五、仍待办（下一轮起点）

1. **工程化**：`files` store 拆分（约 700 行）、`confirmIfDirty` 收敛到 `services/dialog`。
2. **Wave 2 尾巴**：多窗口元数据一致性、历史保留策略可配。
3. **Wave 1 头号缺口**：反斜杠转义保留（`parse.setup` 钩子 + `escape:false` 的 mark，方案已验证）。
4. 仍有约 40 个老套件按 `Symbol(pinia)` 名字取 store（生产构建下会失败），继续「改到谁就顺手迁谁」。

---

### 4.56 工程化收口：store 拆分与对话框收敛（本次）

> 整改方案的最后两项工程债。原则同前几波：**先把「规则」从「状态」里剥出来** —— 能单测的才有底气。

#### 一、`files` store 瘦身（703 → 535 行）

这个 store 原本一份承担四件事：工作区文件树、当前文档 + 草稿 + 自动保存、**列表视图的派生缓存**、
最近文档/文件夹。拆法按「生命周期是否相同」而不是按行数切：

| 拆出物 | 为什么是它 | 落点 |
| --- | --- | --- |
| **列表视图缓存** → 独立 store | 它是一份**派生缓存**（主进程递归扫描的产物），失效条件是「工作区结构变了 / 某篇保存了」，与文档状态无关；只有一个消费者（`FileList.vue`） | `stores/workspaceDocs.ts`（`docs`/`epoch`/`loading` + `load`/`invalidate`/`bumpMtime`/`reset`） |
| **最近文档/文件夹/置顶的列表规则** → 纯函数 | 「去重 + 置顶 + 截断 + 并入当前工作区」这类容易写错又不容易发现的逻辑散在 4 个 action 里 | `lib/recent.ts`（`planTouchRecent` / `planRemoveRecent` / `planTogglePin` / `planTouchRecentFolder` / `planRemoveRecentFolder` / `planRecentFolderList`） |
| **草稿键与可恢复判定** → 纯函数 | 这块**出过三次真 bug**（§4.44 空草稿假横幅、§4.45 关窗清槽位、§4.49 跨窗认领），必须能被毫秒级钉住 | `lib/draftRules.ts`（`draftKeyFor` / `restorableDraft`） |
| **文档文本小工具** → 纯函数 | 未命名文档的编码/行尾、编码显示名、历史时间格式，都是**规则**不是状态 | `lib/docText.ts` |

依赖方向是**单向**的：`workspaceDocs` 读 `files.root`；`files` 只在结构变化/保存时调用
`invalidate()` / `bumpMtime()`。新增单测 `tests/filesRules.test.mjs`（9 条）。

**一个部署细节**：`tests/*.test.mjs` 直接用 `node --test` 加载这些模块，而 **Node 的 ESM 解析不做
扩展名补全** —— 所以「会被单测加载」的模块里，相对导入写显式 `.ts`（`tsconfig.web.json` 开
`allowImportingTsExtensions`）；其余文件保持仓库既有的无扩展名写法，不搞全仓改造。

**没有继续做的那一步（诚实记录）**：把**状态**也拆成「workspace store + document store」需要改动
约 20 个调用点（`files.root` / `dirCache` / `expanded` / `toggleDir` …），收益是文件更小、
风险是回归面铺得很宽。当前拆法已经把「派生缓存」与「规则」搬出主 store，剩下的 535 行是
「状态 + IPC 编排」，语义内聚；再拆建议单独一波、以现有 8 个套件为安全网来做。

#### 二、未保存更改确认：从四份收敛成一份

此前四处各写一遍同样的 `ui.confirm({ title: t('editor.dirtyConfirmTitle'), ... })`：
`composables/useAppActions.ts`、`stores/files.ts`（当初为绕循环导入复制了一份）、
`TreeNode.vue`（打开文件前）、`FileList.vue`（列表里打开）。文案改一次要改四处，漏一处就是
「两个入口问的话不一样」。

现在只有 `lib/dialog.ts`：

- `confirmDiscardChanges()`：直接问（调用方已确认确实脏了）；
- `confirmDiscardIfDirty(dirty)`：脏了才问，干净直接放行。

**关键设计**：这个模块**只依赖 ui store 与 i18n**，「脏不脏」作为**参数**传进来 ——
于是 `stores/files.ts` 也能用它，不必再为「循环导入」复制一份（那正是当初抄四遍的根因）。

命名偏差说明：整改方案写的是 `services/dialog`，但本仓库的 `services/` 是**主进程**约定
（`src/main/services/*`），渲染层没有这一层，故落在 `lib/dialog.ts`（与 `lib/errors.ts` 同级）。

#### 三、顺带记下的一条踩坑（工具链）

`tools/run-suites.js` 跑套件时**不要同时 `npm run build`**：实例加载的是 `out/`，
边跑边构建会让正在运行的实例读到半截产物 —— 实测表现是编码套件的「设置已落库」与
「菜单标题跟随语言」同时变红，看着像代码坏了，其实是构建把它脚下的产物换掉了。
这条已写进 runner 的文件头。

#### 四、本轮验收数字

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` / `npm run lint` | exit 0 / 0 error 0 warning |
| `npm run test:unit` | **110/110**（新增 9 条） |
| `npm run ci` | exit 0 |
| `node tools/run-suites.js` | **8/8 套件 PASS** |
| `tools/_verify-md-fidelity.js` / `tools/_verify-wave3.js` | 63 PASS / 0 FAIL / 19 SKIP · 19/19 |

#### 五、四波做完之后仍开着的口子（按价值排序）

1. **Wave 1 头号缺口**：反斜杠转义保留（`\*` 被解析器吃掉；`parse.setup` 钩子 + `escape:false` 的 mark 方案已验证）。
2. **Wave 2 尾巴**：多窗口元数据一致性（库表已就位，差「打开时以库为准」）、历史保留策略做成设置项。
3. **Wave 3.2**：三处真相源（WYSIWYG / 源码 textarea / 代码块 CM）收敛成单向数据流。
4. **套件迁移**：约 40 个老套件仍按 `Symbol(pinia)` 名字取 store（生产构建下会失败），继续「改到谁就顺手迁谁」。

---

### 4.57 反斜杠转义保留：`\*` 原样往返（本次）

> Wave 1 留下的第一号缺口。它排第一的原因是**信息在解析那一刻就丢了**：
> markdown-it 的 inline `escape` 规则会把 `\*` 变成文本 `*`，于是「字面星号」往返后
> 变成「斜体标记」—— 语义变了，而任何后置的归一化都补不回来（无法区分 `\*` 与 `*`）。

#### 一、机制：解析时留痕，序列化逐字写回

用 tiptap-markdown 官方给的 `parse.setup` 钩子（与「保留列表标记」同一套机制，见 §4.52）：

1. **替换 markdown-it 的 inline `escape` 规则**：照抄上游的三种分支，只改一处 ——
   可转义标点不再被"吃掉"反斜杠，而是把原文 `\X` 放进一个自定义 token；
2. **渲染成 `<span data-md-escape>\X</span>`**（token 自带渲染规则；内容来自用户源码，做了 HTML 转义）；
3. **`MdEscape` mark**（`escape:false` + 空包裹）认领这个 span → 序列化时**逐字写回**。

三种分支一个都不能漏（实测教训）：

| 分支 | 语义 | 漏掉的后果 |
| --- | --- | --- |
| `\` + 换行 | 硬换行（并吃掉行尾空格） | 退化成「字面反斜杠 + 软换行」→ 整段被并成一行，`paragraph-breaks` 夹具立刻变红 |
| `\` + 空格 | 反斜杠不是转义，字面输出 | 空格被当作转义目标 |
| 其余 | 可转义标点保留 `\X`；不可转义字符本来就原样 | `C:\temp` 会被补成 `C:\\temp`（源码漂移） |

#### 二、三处「不显眼但必须改」的联动

1. **`literalizeStrayMarkers` 要跳过转义文本**：那一步会把裸 `*`/`~`/`` ` `` 包成「字面量标记」，
   若不跳过，`\*` 会被拆成「反斜杠 + 字面量星号」→ 输出 `\\*`。
2. **转义文本必须留在样式构造里**：一开始把它当成不透明节点（`kind: 'other'`），
   结果它把同样式正文**切成两段** —— `**粗体里的 \* 星号**` 被拆成两个 `**…**` 构造，
   实测输出 `****\*****`。正确做法是让它作为**带样式的 verbatim 文本**参与构造
   （`verbatim` 标记只影响「不参与标记派生」与「序列化时贴回 mdEscape」两件事）。
3. **重推的触发条件要认识反斜杠**：`blockNeedsNormalize` / `resolveBlockContent` 的守卫
   此前只认 `*~`` ` ``；现在补上「反斜杠 + ASCII 标点」。用「反斜杠 + 标点」而不是「任意反斜杠」
   是有意的 —— Windows 路径那种普通反斜杠不该让每次按键都对整段做一次 markdown-it 解析。

#### 三、顺带修掉的「孤儿标记漂移」

夹具新加的一行暴露了另一个老问题：`$a * b$` 里那个**不成对**的 `*` 会被写出器补成 `\*`。
原因：把裸标记包成字面量标记（`literalizeStrayMarkers`）那条路径的触发条件用了 `PATTERN_TEST`
（要求**成对**的 `*…*`），单颗星直接漏过。现在触发条件补上「孤儿标记字符」这一档，
源码不再漂移（这正是那一整段代码注释里写的目标）。

#### 四、夹具与已知缺口

- `escapes.md` 扩到 6 个边界：非标点反斜杠、`\`+空格、`\`+emoji（代理对）、反斜杠硬换行、
  与粗体/行内代码/链接混排 —— 现在整份 **exact**（从「已知缺口 lossy」升级）。
- `math.md` 从 lossy 升到 **normalized**：`$$ … $$` 里的反斜杠不再被转义
  （剩下的「没有公式渲染」是**功能**缺口，不是保真缺口，已在 EXPECT 里写明）。
- 新增 `nested-styles.md` 记录一个**结构性**缺口：标记模型是扁平的（`mdStyle` 只带一个 style 值），
  「粗体里套行内代码/链接」表达不出来。修法（给 `mdStyle` 支持样式集合）属独立一波。

#### 五、本轮验收数字

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（110/110 单测） |
| `node tools/run-suites.js` | **8/8 套件 PASS** |
| `tools/_verify-md-fidelity.js` | **67 PASS / 0 FAIL / 17 SKIP**（31 份夹具；exact 9 / normalized 14 / lossy 8） |

---

### 4.58 Wave 2 尾巴：多窗口元数据一致性与历史保留策略可配（本次）

> Wave 2 当时留了两条尾巴：两个窗口打开同一文件时元数据可能各说各话；本地历史的保留策略写死在代码里。

#### 一、编码优先级：显式指定 > 每文件记录 > 全局默认

原来的 `file:read` 只有「设置里是 `auto`」时才查每文件记录，于是：

- 用户把**全局默认编码**改成 windows-1252 之后，之前明确按 GBK 打开过的文件会被解成乱码；
- 两个窗口如果「默认编码」设置不同（比如一个窗口刚改过），**同一个文件会解出不同内容** ——
  这就是「多窗口元数据不一致」的实际表现。

新优先级（`file:read` 增加 `opts.softDefault`）：

| 来源 | 何时生效 | 为什么 |
| --- | --- | --- |
| **显式指定**（`reopenWithEncoding`、显式 readAs） | 永远优先 | 用户刚点的那个必须听，否则「点了没反应」 |
| **该文件的记录**（`documents.encoding`，兼容 kv 兜底） | 调用方说「这只是设置里的默认值」时（`softDefault: true`） | 它是「这个文件是什么编码」的权威答案，比全局默认更具体 |
| **自动判定链**（BOM → 记忆 → 严格 UTF-8 → 语言兜底） | 没有记录、也没显式指定 | 兜底 |

实测（`_verify-md-fidelity.js` F 段）：窗口 A 用 auto 打开 GBK 文件并落库 → 窗口 B 打开同一文件，
**编码与行尾都与库记录一致**；窗口 B 把「默认编码」改成 windows-1252 后重开，**每文件记录仍然优先**。

**套件侧的两处修正**（新语义下必须显式管理状态）：

1. `_verify-encoding.js` 的「默认编码生效」拆成两条：先证明**记录优先**（同一份字节在默认编码改成 1252 后
   仍按 gbk 解出），再删掉记录、证明**没有记录时设置里的默认编码确实生效**；
2. A2 段的两次**显式试读**（windows-1252 / utf-8）会把该文件的记录改掉，而 C 段依赖它被当成 BOM 文件 ——
   所以还原夹具字节的同时也要 `rememberEncoding(…, 'utf-8-bom')` 把记录调回来。

#### 二、本地历史的保留策略进设置

新增三个设置项（默认开、30 条 / 30 天，常量仍以 `shared/history.ts` 为准）：

- `historyEnabled`：关掉后 `pushHistory` 直接返回，不再新增快照（**已有历史仍可查看/回滚**）；
- `historyLimitPerFile` / `historyMaxAgeDays`：主进程在写快照与抽稀时从 kv settings 读，喂给
  `planHistoryPrune`（纯函数，参数化后仍可单测）。

设置面板「通用」页新增一组（开关 + 两档下拉），三语同步（388 键）。实测（同一个套件 G 段）：
关掉后连存两次**不再写快照**；上限设为 2 后连存 4 次**恰好剩 2 条**（且是最新的两条）。

#### 三、顺带修掉的一处配置债

`tsconfig.node.json` 也开 `allowImportingTsExtensions`：`shared/defaults.ts` 现在会被单测直接加载
（断言默认策略与常量一致），它的相对导入按 §4.56 的约定写显式 `.ts` ——
而它同时属于 node 工程，两边都得开这个开关。

#### 四、本轮验收数字

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**111/111** 单测） |
| `node tools/run-suites.js` | **8/8 套件 PASS**（encoding 34/34、wave3 19/19…） |
| `tools/_verify-md-fidelity.js` | **73 PASS / 0 FAIL / 17 SKIP**（90 条断言；新增元数据 4 条 + 历史策略 2 条） |

#### 五、还剩什么（下一轮）

1. **Wave 3.2**：三处真相源（WYSIWYG / 源码 textarea / 代码块 CM）收敛成单向数据流。
2. **嵌套样式**（§4.57 记录的结构缺口）：让 `mdStyle` 支持样式集合。
3. **老套件迁移**：约 40 个仍按 `Symbol(pinia)` 取 store（生产构建下会失败），「改到谁就顺手迁谁」。

### 4.59 Wave 3.2：编辑面 ⇄ 真源的**单向数据流账本**（本次）

> 这一节回答一个问题：**正文有三个能改它的地方（Tiptap 面板 / 源码 textarea / 代码块里的
> CodeMirror），凭什么保证它们不会互相打架？**
> 之前的答案是「每个编辑面各自发明一套判断要不要跟着更新的规则」，于是有了四条通道、
> 三种启发式，和一批看着像玄学的 bug。现在的答案是一个**世代号 + 一个作者标记**。

#### 一、收敛之前：四套判断，三种启发式

| 通道 | 收敛前的判断 | 曾经的漏判形态 |
| --- | --- | --- |
| Tiptap ⇄ store | 比字符串 `syncedMd === content` + 世代号 `files.syncEpoch` | 「切回原编码」时新旧文本恰好相等 → 状态栏变了、正文不动 |
| 源码 textarea → Tiptap | **另一条** 200ms `setContent` 定时器（`scheduleSplitSync`） | 分屏里停顿一下的更新被静默窗吞掉 |
| 切模式时再对齐一次 | `syncEditorContent()` 自己再比一次字符串 | 三处判断对同一件事给出不同结论 |
| 代码块 CodeMirror | 150ms 防抖 + 「节点文本快照相等就跳过」 | 快照过期（CM 已经又往前跑了几行）→ 用旧文本重建 CM，**快速回车丢字** |

根因不是某一条写错了，而是**没有唯一的写入者身份**：每个面都在猜「这次变化是不是我自己弄出来的」。

#### 二、收敛之后：账本（`src/renderer/src/lib/contentSync.ts`）

```
{ rev, author, applied: { wysiwyg, codeblock } }
```

- 谁改内容谁调 `files.setContent(md, author)`：`rev+1`、记下 `author`；
- 需要**命令式回灌**的编辑面（渲染动作是 `setContent` / `setState`）记下自己渲染到哪一代；
- 该编辑面要不要重渲染 ⇔ `files.contentIsStale(surface)`（= 它的 `applied` 落后于 `rev`），
  渲染完 `files.markContentApplied(surface)`。**不比较字符串、不看时间窗。**

三条推论，正好覆盖了上面每个漏判形态：

1. **自己的回声永不回灌自己**：`write()` 顺手把作者的 `applied` 推到最新，所以「刚打完字就
   触发替换」这类时序问题在结构上不存在（A2 断言：输入后内容与光标都不动）；
2. **文本恰好相等也要换内容**：整篇替换（打开文件 / 恢复草稿 / 切编码 / 载入历史）作者记为
   `external`，它**不动任何 applied** ⇒ 所有编辑面都落后 ⇒ 都按新内容重渲染一次（A6 断言）；
3. **嵌套编辑面**：代码块的 CodeMirror 是 Tiptap 文档里的**子编辑面**，它写内容时先把文本写回
   Tiptap 节点，所以 `write(codeblock)` 会**连宿主 `wysiwyg` 一起**标记为最新 —— 否则宿主会把
   md 重新灌回去，把光标从代码块里踢出来（A5 断言）。

**一个必须记住的坑：回灌时读 store，不要读 `props`。** Vue 的 `watch` 默认跑在渲染之前
（pre-flush），而 `props.modelValue` 是父组件**上一次渲染**时传下来的 —— 在 watcher 里读 props
会拿到上一代内容，等于把编辑器灌成旧文本。这不是「偶尔有点旧」那么轻：编辑器里那次 `setContent`
会触发 md 标记归一化插件再产生一次事务 → `onUpdate` → 250ms 防抖 flush 把旧文本写回 store，
**源码面刚敲的那行就没了**（正是本轮实测抓到的那次偶发失败：`_verify-wave3.js` A4 在整轮矩阵里红、
单跑绿）。修法是本节的立场本身 —— 真源只有一个，就直接读它：
`files.current?.content`（代码块那侧同理，`props.node.textContent` 换成按 pos 现读 PM 文档）。

#### 三、四个编辑面各自的角色

| 编辑面 | 角色 | 实现要点 |
| --- | --- | --- |
| Tiptap 面板 | 命令式副本 | `watch(files.contentRev)` → `contentIsStale('wysiwyg')` 才 `setContent`；分屏下源码面逐键输入时 **200ms 合并重解析（渲染节流，不是第二条真源）** |
| 源码 textarea | 声明式副本 | 模板 `:value="files.current?.content"` 就是唯一回灌通道：DOM 值已等于新值时浏览器不动光标，所以「自己写的」那条路径不需要代码再判断一次 |
| 代码块 CodeMirror | 子编辑面（写 + 读） | 写：`editorStore.noteWrite('codeblock')` 挂牌，序列化时消费成作者；读：节点文本变了才重建，且**触发时重新读节点文本**、**CM 拿着光标时绝不覆盖**（改成再等一轮） |
| 外部整篇替换 | 作者 = `external` | 打开/草稿/切编码/载入历史统一走 `setContent(..., 'external')` / `noteExternalReplace()` |

`files.syncEpoch` 与 `editorStore.syncedMd` 一并删除：前者就是账本的 `rev`（且账本还知道是谁写的），
后者是字符串版本的 `applied.wysiwyg`。`docs/optimization-program.md` 里 Wave 3.2 的那条待办到此收口。

#### 四、老套件迁移：不再按 `Symbol(pinia)` 的名字取 store

`tools/` 下 50+ 个 CDP 套件原本靠 `Object.getOwnPropertySymbols(provides).find((s) => String(s) === 'Symbol(pinia)')`
取 store —— 生产构建会把 symbol 描述压掉，于是**同一套件的行为取决于实例是 dev 还是构建产物**（最坑的一类漂移）。

本轮把 77 个套件统一改成**按结构认 pinia**（`prov[s]` 是对象且 `_s instanceof Map`），并把
`t.url.includes('5173')` 换成 `index\.html|5173`。A/B 实测（对着 `out/` 构建产物的隔离实例）：

| | 迁移前（HEAD 版本） | 迁移后 |
| --- | --- | --- |
| 19 个「只按 symbol 名字找、没有结构兜底」的套件 | **13 个直接崩**：`TypeError: Cannot read properties of null (reading '_s')` | **0 个崩** |
| 其中端到端跑通（exit 0 且有真实输出） | 4 个 | 7 个 |

剩下的差异都不是 pinia 的问题：`_regress-*` 那几个用的是早已改名的旧选择器（`.mode-seg-btn`，
现在是 `.seg-btn` / `role="tab"`），`_test-export-full.js` 需要 5173 上的 dev server。
`tools/_regress-split-live.js` 顺手迁到 `tools/lib/harness.js` 并修好选择器，现在进默认矩阵
（它盯的正是本节的账本：分屏双向同步 + 切换文件 + 每次输入后账本必须收敛）。

#### 五、本轮验收数字

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**120/120** 单测，新增 `tests/contentSync.test.mjs` 9 条） |
| `npx eslint .` | 0 error / 0 warning |
| `node tools/run-suites.js` | **9/9 套件 PASS**（新增 `_regress-split-live` 8 条：模式切换 / 右→左 / 左→右 / 账本收敛 / 切文件） |
| `tools/_verify-wave3.js` | A 段 9 条（含账本作者、落后判定、代码块作者标记）|

#### 六、还剩什么（下一轮）

1. **嵌套样式**（§4.57 记录的结构缺口）：让 `mdStyle` 支持样式集合。
2. **其余老套件**：`_regress-*` / `_repro-*` 还有十来个用着旧选择器，按「改到谁就顺手迁谁」继续收；
   迁移时一律 `require('./lib/harness')` + `Reporter`（有 `--- N/M PASS` 才能进矩阵）。
3. **`files` store 继续瘦身**：内容/编码相关的动作已可独立，下一步把「最近文档/置顶」整块移出。

#### 七、附：一次真实事故的恢复办法（值得记下来）

本轮施工中真的把 `src/renderer/src/stores/files.ts`（647 行）毁过一次：用
`(Get-Content -Raw) -replace … | Set-Content -Encoding UTF8` 改一处字面量，先被 ANSI 码页
（GBK）解码、再按 UTF-8 写回 —— 文件当场变成乱码，而且那次解码是**有损**的（约 180 处字节丢失，
`?`/`U+FFFD` 占位，个别换行被吃掉）。当时该文件有大量**未提交**改动，`git checkout` 等于丢掉两波成果。

救回来的三条线索，按可靠性从高到低：

1. **会话转录（最权威）**：DSH 的会话记录落在 `~/.dsh/sessions/<workspace>/<session>/session.v3.jsonl.zstd`
   （**多帧 zstd**：Node 的 `zstdDecompressSync` 只吃第一帧，要按 `28 B5 2F FD` 魔数切片逐帧解）。
   里面按顺序存着每一次 `write` / `edit` 的**完整 payload** —— 拿 HEAD 版本当基线，把这一串
   `old_string → new_string` 按序重放，就能重建出事故前的文件（脚本化的字面量替换可放在 VM 沙箱里
   跑，只改内存里的字符串，不碰磁盘）。
2. **反解编码（结构完整、局部损坏）**：`iconv.decode(iconv.encode(损坏文本, 'gbk'), 'utf8')`
   能把大部分还原回来（GBK 那一步没丢的字节都在）。剩下的 `U+FFFD` 用「上下文窗口 + 上面那份重放文本」
   当字典逐个补 —— 注意上下文要**在相邻损坏点处切断**，否则窗口里带着 `U+FFFD`，在干净字典里永远搜不到。
3. **转录里的 `read` 结果**：本会话读过的每一段文件内容都在转录里（带行号），是逐字权威的局部证据。

最后用三件事交叉验证：行数对得上（事故前 609 行 + 本轮 4 处改动 = 648 行）、
`npm run typecheck` 与 `npx eslint` 全绿、单测与套件矩阵全绿。**教训**：批量改源码一律用 Node 脚本
（见 README 开发约定第 7 条），别让 PowerShell 碰源码字符串。

### 4.60 Wave 1 收尾（一）：嵌套样式与 YAML front matter（本次）

> Wave 1 留下的 8 个 `lossy` 缺口里，最伤内容的两个：**嵌套样式**（`**粗体里的 `代码`**`
> 会被写成 `**粗体里的 **`代码`** …**` 这种 CommonMark 下根本不成立的孤儿标记，渲染直接坏掉）
> 和 **YAML front matter**（被解析成「分割线 + 段落 + 分割线」，元数据静默变成正文）。
> 本节记这两个的改法与验收。

#### 一、嵌套样式：`mdStyle` 的样式从「一个值」改成「一个集合」

**原来为什么表达不出来**：`mdStyle` 只有一个 `style` 属性，而 ProseMirror 里**同一种 mark 只能挂一个**。
`**粗体里的 `行内代码`**` 要求那段代码同时是粗体与代码 —— 一个属性存不下两个样式，于是：

1. 解析时行内代码的遗留 mark `code` 带 `excludes: '_'`（**排斥一切其它 mark**），把外层的 bold 直接丢掉了
   （所以那段代码在模型里从来就不是粗体）；
2. 归一化物化标记时按「单个样式各补一对」，外层构造在内层之前被合上 →
   `**粗体里的 **`行内代码`** 应该整段加粗**`，其中 `**粗体里的 **` 在 CommonMark 里前面的
   `**` 无法闭合（闭合定界符右边必须是标点/非空白），**整段渲染成字面星号**。

**改法**（三处，都很小）：

| 改动 | 位置 | 说明 |
| --- | --- | --- |
| 样式集合 | `MdStyle.attrs.styles: StyleKind[]` | 按固定顺序 `bold → strike → italic → code` 规范化（`styleList()`），顺序固定才能保证「同一份文档每次解析/序列化得到同一串标记」（幂等是套件硬门槛） |
| DOM 呈现 | `MdStyle.renderHTML` | 只出一个元素：标签取集合里最外那个样式（`strong`/`s`/`em`/`code`），全部样式写进 `data-md-styles="bold code"`，其余样式的外观由 CSS 属性选择器补齐。**不能**渲染成嵌套的 `<strong><code>` —— DOM 回读时同类型 mark 后者会顶掉前者，样式丢失并触发回写 churn |
| 标记物化 | `normalizeAtoms` + 新的 `materializeStyledRun()` | 按**样式栈**开关：相邻两段取样式集合的公共前缀保持不动，只开关差集 → 标记天然嵌套。单一样式时它退化成原来的「两边各一对」，所以既有行为不变 |
| 放开互斥 | `CodeQuiet.extend({ excludes: '' })` | 上行默认 `excludes: '_'` 让行内代码排斥一切 mark，嵌套样式在**解析那一刻**就少一半 |

顺带把「按标记配对找构造」的那段扫描改成**深度计数**（`start` +1 / `end` -1），否则外层 `**` 会在
遇到内层的 `` ` `` 时以为「缺 end」而补一个 `**`，把构造劈成两半 —— 这正是旧的扁平物化写法。

**验收**：夹具 `nested-styles.md` 从 `lossy` 升到 **exact**（原文与往返逐字节相同，且幂等）；
`emphasis.md` 里的 `***粗斜体***、**加粗里的 *斜体* 嵌套**` 也回到 exact。端到端断言见
`_verify-md-fidelity.js` 的 A/B 矩阵与幂等段。

#### 二、YAML front matter：做成文档开头的**真实节点**

**为什么不做成「编辑器外面的一个小字符串」**：§4.59 刚把「正文只有一个真源」收敛干净。
front matter 存在组件 ref 或 store 单独字段里就又出现两处表示 —— 而源码模式 textarea 里它明明就在正文里。
做成节点后**文档文本 = 节点序列化结果**，一行不多一行不少，WYSIWYG 里也看得见这段 YAML。

**判定（保守优先，`src/shared/frontmatter.ts`，纯函数有 11 条单测）**：

1. 必须从文档**第一个字符**开始；
2. 收尾分隔符是独立的 `---` 或 `...` 行；
3. 块内至少有一行顶层 `key:` —— 这条是**排除**用的：CommonMark 里 `---\n一段文字\n---`
   （分割线夹文字）合法且常见，没有键值就不能当 YAML 吃掉。

**往返三段**（与 `MdEscape` 同一套 `parse.setup` 机制）：markdown-it **block 规则**只在第 0 行认领
（`state.line` 直接跳到块后首行）→ 推自定义 token → 渲染成 `<pre data-md-frontmatter>原文</pre>`
→ `Frontmatter` 节点的 `parseHTML` 认领它、`storage.markdown.serialize` 把原文**逐字写回**。

**取舍**（都写进代码注释，免得以后当 bug 报）：

- 节点是 `atom`：WYSIWYG 里**只读**，改 YAML 走源码模式（做成可编辑需要一整套 YAML 编辑器，那是功能不是保真）；
- 只能待在文档开头：用户把它拖到中间后再序列化就不再是 front matter（解析规则同样只认开头，语义一致，
  不会出现「看着还在、保存后跑进正文」的错位）。

**验收**：夹具 `frontmatter.md` 升到 **exact**；套件新增 H 段 4 条端到端断言 ——
① 首节点是 `frontmatter` 且 WYSIWYG 里渲染出同样的 YAML；② 在正文末尾敲字后 YAML 逐字不变；
③ 源码模式里 YAML 就是正文开头（改它的入口通）；④ 分割线夹文字**不**被误判成 front matter。

#### 三、本轮验收数字

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**131/131** 单测：新增 `tests/frontmatter.test.mjs` 11 条） |
| `npx eslint .` | 0 error / 0 warning |
| `_verify-md-fidelity.js` | **81 PASS / 0 FAIL / 13 SKIP**（94 条断言；Wave 1 缺口从 8 个减到 6 个） |
| `node tools/run-suites.js` | 见下一节（矩阵全绿） |

**还剩什么**：`table`（列对齐 + 单元格转义竖线）、`html-inline`、`task-lists-ordered`、
`lists-adjacent-ordered`、`images-inline`、`images-linked` 六个缺口，按内容损坏严重度继续收（下一轮）。

### 4.61 Wave 1 收尾（二）：表格、行内 HTML、列表编号（本次）

> 接 §4.60，本轮把剩下 6 个缺口里的 4 个收掉（表格 / 行内 HTML / 有序任务列表 / 相邻有序列表），
> 只剩两个图片缺口。这一节记的是「为什么这些看起来简单的改法其实各有坑」。

#### 一、表格：解析侧本来就对，坏的是写回

先把事实查清楚再动手（这一步很值）：markdown-it 会把列对齐写成单元格的
`style="text-align:center"`，`@tiptap/extension-table` 的 `align` 属性认领它；
单元格里的 `\|` 也被正确解成**字面竖线**。所以 `align` **本来就存得下**，
丢信息的是 tiptap-markdown 内置的表格序列化器：

- 分隔行永远写裸 `---` → 列对齐丢失；
- 单元格内容不转义 → 内容里的 `|` 被当成列分隔符，**整行结构被拆坏**
  （`| 转义 \| 竖线 |  |  |` 重新解析成 4 列）。

改法就是接管 `table` 节点的 markdown 序列化（`lib/editor/tableMarkdown.ts`）：
分隔行按各列表头的 `align` 生成（`:---` / `:---:` / `---:`），单元格先渲染进输出缓冲再把竖线转义
（逐字符写没法插转义）。复杂表格（合并单元格、一格多块）仍退回 HTML —— 那是 Markdown
表格语法表达不了的东西，硬拼成管道表才是真的丢结构。纯文本规则抽在 `tableAlign.ts`，
6 条单测（含「已经是 `\|` 的不重复加反斜杠」这种幂等性）。

#### 二、行内 / 块级 HTML：原文进模型，WYSIWYG 按源码显示

Markdown 允许直接嵌 HTML，而 ProseMirror 的 DOMParser **只认识 schema 里有的节点** ——
未知标签一律剥掉只剩文字：`<kbd>Ctrl</kbd>` → `Ctrl`、注释整条消失、`<br>` 还被写成 `\`
（语义从「HTML 换行」变成「Markdown 硬换行」）。

解法与 `MdEscape`、front matter 同一套：在 markdown-it 那一层认领（`lib/editor/htmlPassthrough.ts`）：

| 形态 | 进模型 | 写回 |
| --- | --- | --- |
| 行内（`html_inline` token） | `<span data-md-html>` → `MdHtml` mark（open/close 空 + `escape:false`） | 逐字写回 |
| 块级（`html_block` token） | `<pre data-md-htmlblock>` → `HtmlBlock` 原子节点 | 原样写回 |

**两个踩到的坑**（都写进代码注释了）：

1. **任务列表的复选框**是 `markdown-it-task-lists` 插件**生成**的 `html_inline` token
   （`<input class="task-list-item-checkbox" …>`），不是用户写的 HTML。若一并「原样保留」，
   任务列表会变成一堆标签文本 —— `task-lists.md` 直接从 exact 掉到 lossy。所以按插件写死的
   class 名放行这类 token。
2. **不透明内容不能切开样式构造**：`**加粗里的 <kbd>Ctrl</kbd> 还是加粗**` 里，
   行内 HTML 在原子模型里是「不透明内容」，一开始会把它当边界、把加粗构造劈成两半。
   改成：样式栈物化时把不透明内容**原样穿过**（不参与栈、也不打断外层构造）。

WYSIWYG 里行内 HTML **按源码显示**（淡色等宽）：把任意 HTML 真渲染出来是另一个功能
（要沙箱、要样式隔离），而「把标签吃掉」是静默丢内容 —— 两害相权取保真。

#### 三、列表：有序任务列表 + 相邻有序列表

- **有序任务列表**（`1. [ ] x`）：`taskList` 新增 `ordered` 属性（解析时按 `<ol>`/`<ul>` 标签记住，
  序列化时有序写 `1. `/`2. `）。上游的任务列表序列化器直接复用无序列表那份、永远写 `- `，
  于是列表**类型**从有序变无序（渲染从数字变圆点）。只覆盖 `serialize`、不动
  tiptap-markdown 默认 spec 里的 `parse.setup`/`updateDOM`（否则任务列表整体失效）。
- **相邻有序列表**（`1./2./3.` + 空行 + `5./6.`）：这一条**不是缺陷**，是 CommonMark 语义 ——
  空行不结束有序列表，它和后面是**同一个**松散列表，渲染序号由位置决定。所以正确的处理是
  给判级器加一条规范化规则（19）：编号按位置重算（**首项**编号保留，那是 `<ol start>`，有语义），
  同一个列表里项与项之间的空行不参与比对（松散是整表属性，源码位置保留不下来）。
  - 规则必须**幂等**：`1) a` 与 `2. b` 的空行判断若区分分隔符，第一遍是两个列表、第二遍
    两边都是 `.` 又成一个列表 —— 判级结果随遍数漂移。所以有序列表的分隔符在这条规则里不区分
    （规则 7 本来就会把 `)` 归一为 `.`）。

#### 四、本轮验收数字

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**137/137** 单测） |
| `npx eslint .` | 0 error / 0 warning |
| `_verify-md-fidelity.js` | **94 PASS / 0 FAIL / 5 SKIP**（99 条断言） |
| `node tools/run-suites.js` | 见矩阵（全绿） |
| 夹具分级 | exact **13** / normalized **16** / lossy **2**（四轮累计：8 → 6 → 4 → 2） |

#### 五、还剩什么（下一轮）

只剩两个**图片**缺口，它们要动的是同一个结构决策：图片目前是**块级节点**（`inline: false`）。

1. `images-inline.md`：段落中间的图片被拆成独立块，前后文字被切成两段；
2. `images-linked.md`：`[![alt](img)](url)` 的**外层链接**丢失（块级节点上挂不了 link mark）。

计划（下一轮）：把图片改成**内联节点**（或按上下文双形态），并复跑 `images.md`（当前 exact）、
`_verify-local-media.js`（本地媒体白名单）与字节级用例，确认块级写法（独立成段的图片）仍然逐字节一致。

### 4.62 Wave 1 收尾（三）：图片改成行内节点 —— Wave 1 缺口清零

> 最后两个缺口（`images-inline.md` / `images-linked.md`）其实是**同一个结构决策**造成的：
> 图片被配成**块级节点**。Markdown 的 `![alt](src)` 本来就是**行内语法** —— 它能出现在段落中间
> （`图标 ![](a.png) 后面还有字`），也能被链接包住（`[![alt](a.png)](url)`）。
> 做成块级节点时这两种写法都表达不出来：段落被拆成「文字 / 图片 / 文字」三段；
> 外层链接因为块节点上挂不了 mark 而**整个丢掉**。

**改法**：`Image.configure({ inline: true })`。三处配套调整：

| 位置 | 调整 | 为什么 |
| --- | --- | --- |
| `extensions.ts` | 删掉自定义的块级 markdown 序列化器（原来补了 `closeBlock`） | 那个序列化器是为了解决「块级图片黏成一行 / 吞掉下一个标题」；行内之后图片在段落里，段落自己负责换行，直接用 tiptap-markdown 的默认实现（prosemirror-markdown 的 image 规则：alt 转义、src 括号转义、title 引号） |
| `style.css` | `img` 默认 `display: inline-block` + `vertical-align: middle`；`p > img:only-child` 才 `display: block; margin: .4em auto` | 「独立成段的图片」观感与改之前**完全一致**（居中、独占一行），而段落中间的图片不再把段落拆开 |
| `style.css` | 删掉文件后部**重复的一份** `.md-preview img` 规则 | 它位置更靠后、会覆盖上面的行内排版（重复定义本来就是个隐患） |

**验收**（三个图片夹具全部 `exact` 且幂等，Wave 1 的 8 个缺口清零）：

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**137/137** 单测） |
| `npx eslint .` | 0 error / 0 warning |
| `_verify-md-fidelity.js` | **100 PASS / 0 FAIL / 1 SKIP**（101 条断言；唯一 SKIP 是文档化的字节级行为「保存补文末换行」） |
| `node tools/run-suites.js` | 9/9 套件 PASS |
| 夹具分级 | exact **15** / normalized **16** / lossy **0**（四轮累计 lossy：8 → 6 → 4 → 2 → **0**） |

新增 M 段 2 条端到端断言：段落中间的图片与文字仍在**同一个**段落里；`[![…](…)](url)`
的两个图片都带着 link mark（外层链接没丢）。

### 4.63 工程化收尾（二）：`recent` store 拆分 + 嵌套样式渲染断言（本次）

#### 一、最近文档 / 置顶 / 最近文件夹：从 `files` store 拆出来

**为什么拆**：这份数据的归属是「**用户开过什么**」，与「当前工作区 / 当前文档」是两件事 ——
关掉所有文档、切换工作区、甚至工作区打不开时，这份历史都还在。挂在 `files` 上时它既管文档生命周期
又管历史列表（评审报告 Wave 5 那条「store 拆分」），`files.ts` 一度到 646 行。

**边界**（这是这次拆分的关键取舍）：

| 归属 | 放哪 | 理由 |
| --- | --- | --- |
| 「列表怎么变」（去重、置顶优先、截断、并入当前工作区） | `lib/recent.ts` 纯函数（**已有单测**） | 规则易测、无状态 |
| 「把结果落盘 + 给 UI 排好序的视图」 | 新 `stores/recent.ts` | 只做这两件事，94 行 |
| 数据本身 | 仍在 `settings`（SQLite kv） | **键名不变 ⇒ 升级不需要迁移**，既有套件（`_verify-session` 等断言 `settings.recentFiles`）也不用改 |

两个设计细节：

- `folders(root)` 只接一个参数而**不反过来 import `files` store** —— 需要工作区根目录的地方
  由调用方传进来（`RecentList` 里就是 `recent.folderList(files.root)`）。两个 store 互相引用
  在这类代码里很容易变成循环 import；
- 置顶判断给的是 **`pinnedPaths: Set<string>`** 而不是数组：列表每行都要问「这个置没置顶」，
  数组 `includes` 是 O(n)，模板里按行调用就是 O(n²)。

`files.ts` 646 → 593 行，调用点只有三处（打开文件夹、打开文件、另存为）改成 `useRecentStore()`。

#### 二、嵌套样式的**渲染**也要有断言（不只是序列化）

上一轮把行内代码的 `excludes` 放开之后，「粗体里的行内代码」这段文本的渲染变成：
**一个** `<strong data-md-styles="bold code">` + CSS 的 `[data-md-styles~='code']` 规则。
这里有个容易被忽略的盲区：**CSS 规则漏了的话，序列化仍然「保真」（往返字节不变），
但用户看到的那段代码不再像代码** —— 保真套件量不到观感。

所以补一条计算样式断言（`_verify-md-fidelity.js` 的 N 段）：加载 `nested-styles.md`，
取 `[data-md-styles~="code"]`，断言 ① 标签是 `strong`（集合里最外的样式决定标签）、
② `data-md-styles` 正好是 `bold code`、③ 计算 `font-weight ≥ 700`（粗体生效）、
④ 计算 `font-family` 命中等宽字体（代码外观生效）。四者缺一都会红。

顺带复核上一轮列出的两处遗留：`.md-preview img` 规则现在只有**一份**（重复的那份已删，
它位置更靠后、会覆盖行内排版）；主题**没有独立 CSS 文件**（明/暗/羊皮纸都是 `style.css` 里的
CSS 变量），所以不存在「另一份主题文件也要同步属性选择器」的问题。

#### 三、本轮验收数字

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**137/137** 单测） |
| `npx eslint .` | 0 error / 0 warning |
| `_verify-md-fidelity.js` | **101 PASS / 0 FAIL / 1 SKIP**（102 条断言） |
| `node tools/run-suites.js` | **9/9 套件 PASS**（`_verify-session` 仍绿 ⇒ recentFiles 数据键未变） |

### 4.64 老套件迁移（一）：`_regress-*` 全部 + 最有价值的 `_repro-*`（本次）

#### 一、迁了哪 6 个、为什么

`tools/` 下有 92 个 `_*.js` 脚本，此前**只有 9 个**用公共骨架（`lib/harness.js`），其余各自抄了一遍
「连 CDP → 找页面 → attach → 注入 store 访问器 → 敲键盘」。本轮把「回归守卫」这一类整批收口：

| 套件 | 断言 | 守什么 |
| --- | --- | --- |
| `_regress-layout.js` | 9 | 常驻布局：代码块可聚焦可输入 / 「渲染→分屏→源码→渲染」光标比例保持 / 源码回灌 / `instance=null` / 大纲联动 |
| `_regress-cb.js` | 3 | 代码块打字 + 回车换行 / 空代码块退格删除 / 段落退格入块尾 |
| `_regress-divider.js` | 4 | 分屏分隔条拖拽改比例 / 双击复位 / 比例写进设置 |
| `_regress-fileswitch.js` | 5 | 切文件（`:key` 重建）与「**源码模式下**切文件」 |
| `_regress-source-roundtrip.js` | 4 | 源码模式往返后代码块仍可聚焦可输入 |
| `_repro-rapidenter.js` | 4 | 快速连续回车不丢行（CM 可见行 / PM 行 / **store 正文行**三处一致） |

它们**此前全部发红**，原因不是产品坏了，而是套件自己过期：按中文按钮文字找 `.mode-seg-btn`
（现在是 `role="tablist"` + 三个 `role="tab"`，且文案可本地化 —— 换语言就整轮跑不了）。
所以模式切换统一挪进 harness：`clickMode(app, 0|1|2)` **按序号**点，语言无关。

#### 二、迁移本身的三个收获（都不是「搬代码」这么简单）

1. **`openDocWith()`：加载文档不能直接 `ed.commands.setContent()`**。
   代码块里的 CodeMirror 有一条「CM 拿着光标时绝不覆盖」的规则（§4.59）—— 用例若刚在代码块里
   打过字（CM 仍持焦），再直接换编辑器内容时 CM 会**故意保持旧文本**，于是后续断言看到的是
   上一份文档的内容（实测：空代码块退格那条莫名其妙 `blocks=1`）。
   走 `files.current` 赋值 + path 变化则等同真实「打开文件」： EditorView 按 `:key=path` 重建，
   CM 一起重建 —— 这才是套件想测的路径。它现在是 harness 里的公共函数。
2. **「焦点稳定」要确认两次**。账本收敛会触发渲染面再 `setContent` 一次，CM 的 NodeView 随之重建；
   在重建前点到的是**即将被换掉的那个** `.cm-content`（当时还在 DOM 里、也能通过一次焦点检查），
   换掉后焦点就丢了。所以 `focusCodeBlock()` 间隔 160ms 连查两次。
3. **迁移过程抓到一个真实保真缺口**（见下节）。

#### 三、顺手修掉的保真缺口：代码块「内容末尾的空行」往返丢失

`_repro-rapidenter.js` 的 store 侧断言（R3）第一版就红了：CM 与 PM 都是 19 行，而落进 store 的
正文只数出 18 行。查下去是 CommonMark 的一个边界：

> 收尾围栏前那个换行是「最后一行的**行终止符**」，不算内容。
> 于是内容 `a\n`（用户在块尾敲过回车）写成 `a` + 换行 + 围栏，重新解析回来就变成 `a` ——
> **块尾那个空行被吃掉**，保存一次少一行。

修法在 `codeBlock.ts` 的围栏序列化器里：内容以换行结尾时，收尾围栏前**多写一个换行**。
夹具 `code-fence.md` 补了这一例（内容末尾带空行），往返与幂等都过。

#### 四、剩下 83 个脚本的定位（写清楚，免得后来人以为是死代码）

| 类别 | 例子 | 定位 |
| --- | --- | --- |
| 回归守卫（已迁） | `_regress-*`、`_repro-rapidenter` | **进矩阵**，`--- N/M PASS` 机器聚合 |
| 一次性复现/观察脚本 | `_repro-backspace-after-cb`、`_repro-cb-delete2`、`_repro-heading-cm*`、`_check-*`、`_exp-*` | 当年查某个具体 bug 时的探针，**需要人读输出**，不是断言套件；留着是因为它们记录了「当时怎么看到的」 |
| 测量/基准 | `_measure-latency`、`_startup-bench`、`_time-close` | 量性能，输出是数字不是 PASS/FAIL |
| 截图/手工触发 | `_shot-heading-badge`、`_trigger-export`、`_set-windowstate` | 配合人工检查 |
| 老 `_verify-*` 套件（约 57 个） | `_verify-toc`、`_verify-links`、`_verify-notifications`… | **能跑**（各自打印 `--- N/M PASS`，矩阵能聚合），但仍自带一份 CDP 样板；按「**改到谁就顺手迁谁**」继续收口，一次全迁风险大于收益 |

顺带把「迁移后仍可能发红的两类坑」写进 README：`build` 之后必须让实例重新加载；
手工探针连 9222 前先确认端口上没有上一轮的旧实例（否则验证的是改动前的代码）。

#### 五、本轮验收数字

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**137/137** 单测） |
| `npx eslint .` | 0 error / 0 warning |
| `node tools/run-suites.js` | **15/15 套件 PASS**（新增 6 个：`_regress-layout` 9、`_regress-cb` 3、`_regress-divider` 4、`_regress-fileswitch` 5、`_regress-source-roundtrip` 4、`_repro-rapidenter` 4） |
| `_verify-md-fidelity.js` | **101 PASS / 0 FAIL / 1 SKIP**（夹具 `code-fence.md` 新增「内容末尾带空行」一例） |

#### 六、下一轮起点

功能缺口：**编辑器内查找替换**（菜单/快捷键目前只 toast「功能待接入」）与
**数学公式渲染**（`$…$` / `$$…$$`，KaTeX 已是依赖但没有数学节点）。

### 4.65 编辑器内查找替换（本次）

> 此前菜单里的「查找 / 替换」和 `Ctrl+F` 都只 toast 一句「功能待接入」。这一节记它怎么落的，
> 以及**两个只有真跑起来才会暴露的坑**。

#### 一、结构：一份查询状态，两个编辑面各自算匹配

| 面 | 在哪儿找 | 位置语义 |
| --- | --- | --- |
| `wysiwyg`（实时渲染 / 分屏） | ProseMirror 文档，**按块**找（`lib/editor/findInDoc.ts`） | 文档位置 |
| `source`（源码模式） | `files.current.content`（= textarea 的值） | 字符偏移 |

两边的匹配数可能不同（源码里有 `**` 这类标记字符，而文档里它们只是文本），所以计数显示的是
**当前编辑面**的结果 —— 比显示一个对不上的数字诚实。纯逻辑（转义、查找、循环步进、替换计划、
片段→位置映射）全在 `lib/findReplace.ts`，**无依赖可单测**（11 条）。

两个刻意的取舍：查询串一律按**字面量**（搜 `a*b` 就是找 `a*b`，不是"a 后面跟任意字符"）；
匹配**不跨块**（段落/标题/列表项之间不连起来找 —— 跨块时"段落之间的换行算不算一个字符"
各渲染器不一致，与其猜不如不做）。

#### 二、两个只有真跑起来才暴露的坑

1. **「下一个」把焦点抢走了**。第一版 `select()` 里用了 `ed.chain().focus().setTextSelection(...)`：
   焦点一进正文，下一次 Enter 就落到**文档里**（而不是查找输入框）—— 按两下「下一个」等于
   在正文里敲了两个回车，实测把整段写坏（内容变成 `\` + 换行）。
   修法：查找的选中/滚动**一律不 focus**（`setTextSelection` + `scrollIntoView` 不需要焦点，
   编辑器照样画出选区与命中高亮）；源码面同理只 `setSelectionRange` 不 `focus`。
   真正的焦点归还只发生在**关闭查找栏**时（`hide()` 里把焦点还给当前编辑面）。
2. **源码模式下 Ctrl+F 没反应**。快捷键系统有个 `notInInput` 守卫（"输入框里 Ctrl+F 交给输入框自身"），
   而源码 textarea 与代码块里的 CodeMirror 都被算成"输入框" —— 于是最需要查找的源码模式反而按不出来。
   修法：`isTextEntry()` 里先排除**文档自己的编辑面**（`.source-editor`、`.ProseMirror`/`.md-preview`
   之内），它们是"文档"不是"表单"。查找栏自己的输入框仍然被挡住（在栏里按 Ctrl+F 不该把栏关掉）。

#### 三、交互与验收

交互对齐主流编辑器：`Ctrl+F` 打开/关闭 · `Enter` 下一个 · `Shift+Enter` 上一个 · `Esc` 关闭 ·
`Aa` 区分大小写 · 「替换」只动当前命中 · 「全部替换」一次改完（渲染面走**一个事务、从后往前**
替换：位置不失效，且 Ctrl+Z 一次整体撤销）。

`tools/_verify-find-replace.js` **12 条**端到端断言：

| 断言 | 覆盖 |
| --- | --- |
| F1 | Ctrl+F 打开查找栏 |
| F2–F5 | 命中 4 处 + 自动选中第一个 + Enter/Shift+Enter 前进后退 + 首尾循环 |
| F6 | `Aa` 区分大小写（命中数从 4 → 2） |
| F7–F8 | 「替换」只改当前命中；「全部替换」改完剩下的（并落进 store） |
| F9 | Esc 关闭 |
| F10–F12 | 源码面：在 textarea 里找到并选中（**不抢输入框焦点**）、全部替换落进 store、切回渲染面同步 |

#### 四、查找命中高亮与「命中处不露标记」（第二十四轮）

跳转命中除了设选区，另加一层 `.find-hit` 装饰（只画底色，不改字号，对光标导航与命中测试
零影响）。**为什么不能只靠选区**：查找栏打开时焦点在输入框里，编辑区那份是**失焦选区**
（浏览器画得很淡），深色主题下几乎看不见，而且跳转过去那点高亮一闪就没。

同时：**命中的加粗文字不再冒出 `**`**。查找的选法是程序化的
`setTextSelection(from, to)`，在编辑器状态里与用户手选长得一模一样，但语义不同 ——
那是「跳到这一处」而不是「要编辑这里的标记」。修法是把这个事实交给标记显隐装饰：
`setFindHit(active, from, to)` 同时携带「命中范围」与「查找态」，查找期间整份显隐装饰为空
（标记全部保持折叠），查找栏一关立刻恢复正常的「光标落在构造内才展开」。模型、落盘字节、
选区语义一个都不动。

两处必须踩准（都实测踩过）：

* 装饰要**合并**返回：同一个插件 key 只有一份 `props.decorations`，命中高亮与显隐装饰
  必须 `add()` 到一起；分两个 key 会各算各的、后者覆盖前者。
* 「查找态翻转」必须进**重建条件**：开/关查找栏既不改文档也不改选区，不认它的话关掉
  查找栏后标记会一直折叠着（实测 `revealed` 停在 0）。判据不能拿「setFindHit 里刚更新的
  那个模块量」比（永远相等），要用「上一次**真正重建显隐装饰**时用的值」。

#### 四、本轮验收数字

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**148/148** 单测：新增 `tests/findReplace.test.mjs` 11 条） |
| `npx eslint .` | 0 error / 0 warning |
| `node tools/run-suites.js` | **16/16 套件 PASS**（新增 `_verify-find-replace` 12 条） |
| `_verify-md-fidelity.js` | 101 PASS / 0 FAIL / 1 SKIP（未受影响） |

#### 五、下一轮起点

**数学公式渲染**（`$…$` / `$$…$$`）：KaTeX 已经在依赖里（目前只用于导出的 CSS），
但应用没有数学节点 —— `math.md` 夹具现在是 normalized（文本往返保义），渲染成公式则是新功能。

### 4.66 数学公式渲染（本次）—— 功能缺口清零

> KaTeX 早就在依赖里，但一直只用于**导出**的 CSS：应用里没有数学节点，`$x^2$` 只是一串普通文本
> （连斜体都不会误判，因为 `$` 挡住了 intraword 规则）。这一节记「公式原文一个字符都不动、
> 渲染成公式只是视图」这件事怎么落地，以及三个只有真跑起来才知道的坑。

#### 一、两条链路，都遵守「标记文本即源码」

| 形态 | 进文档 | 渲染 | 写回 |
| --- | --- | --- | --- |
| 行内 `$…$` | markdown-it 行内规则 → `<span data-md-math>` → 文本带 `MdMath` mark | 装饰：KaTeX 组件插在公式起点 + 原文加类折叠 | `MdMath`（open/close 空 + `escape:false`）**逐字写回** |
| 块级 `$$…$$` | block 规则 → `<div data-md-math-block data-source=…>` → `MathBlock` 原子节点 | NodeView 里 `katex.renderToString` | 序列化写成多行形态（单行写法归一到它，保义） |

行内之所以用**装饰**而不是自定义节点：模型里公式原文必须留在文档里，序列化才能逐字写回；
「画成公式」是视图的事，正好是 ProseMirror 装饰的适用场景。交互与行内标记显隐同一套
（手册 §4.14）：光标不在公式上 → 只看得到渲染结果；光标落进去/选中 → 装饰消失，露出 `$…$` 原文可编辑。

识别规则抽在 `lib/mathScan.ts`（纯函数，9 条单测）：不跨行、内容非空、
**闭合 `$` 后面不能紧跟数字**（否则「价格 $5 和 $6」会被吃成一段公式 —— 各家编辑器都踩过这个坑）、
`\$` 不是起点、`$$` 不当行内公式。

#### 二、三个坑

1. **`*` 会把公式从中间切开**。公式原文是「不透明内容」，但第一版只把行内 HTML 与展开态链接算作
   不透明，公式没算 → 归一化里的 `literalizeStrayMarkers`（给裸 `*`/`~`/`` ` `` 包字面量标记，
   免得写出时被转义）把 `$a * b$` 在 `*` 处切成两个文本节点，公式碎成两段（实测：4 个公式渲染成 5 个）。
   修法：`toAtoms`/`literalizeStrayMarkers` 把 `mdMath` 与 `mdHtml`、`linkSource` 一视同仁地当不透明。
2. **这套 prosemirror-view（1.42）的 `Decoration` 只有 `widget`/`inline`/`node`** ——
   **没有** `replace`，也没导出 `WidgetType`。所以「替换掉那段文本」是两步拼出来的：
   `widget` 插入 KaTeX 结果 + `inline` 加类把原文 `font-size: 0` 折叠掉
   （与行内标记同一套手法：不用 `display: none`，那会破坏光标导航）。
3. **PM 的 DOMOutputSpec 不能注入 HTML**（这个版本的 `renderSpec` 不认 `innerHTML`），
   所以块级公式的屏幕呈现走 **NodeView**；`renderHTML` 只在「复制为 HTML」等场景用到，那里给原文。

#### 三、验收

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**157/157** 单测：新增 `tests/mathScan.test.mjs` 9 条） |
| `npx eslint .` | 0 error / 0 warning |
| `node tools/run-suites.js` | **17/17 套件 PASS**（新增 `_verify-math` 7 条） |
| 夹具 | `math.md` 从 normalized 升到 **exact**（16 exact / 15 normalized / **0 lossy**） |

`_verify-math.js` 的 7 条断言：原文进文档（含定界符）/ 行内渲染成 KaTeX 且原文折叠 /
块级成为 `mathBlock` 且渲染成 display 公式 / 下划线与星号没被当斜体加粗 / 落进 store 的正文逐字 /
**光标落进公式露出原文** / **写坏的公式不让整篇崩**（KaTeX 降级成红字，原文仍在）。

#### 四、这条线的收口

评审报告里列出的两个功能缺口（查找替换、数学公式渲染）到此都做完了；
`tools/run-suites.js` 的默认矩阵从 9 个套件涨到 17 个，件件有 `--- N/M PASS` 可复跑。

### 4.67 单实例锁：第二个实例立刻干净退出（本次）

> 现象：dev 实例还开着时再跑一次 `npm run dev` → 控制台刷出三条 Chromium 磁盘缓存报错，
> 然后整个命令就结束了、窗口也没出来。这一节记根因（两段都有实测）、修法，以及为什么
> 「照抄官方文档的单实例写法」在这里是错的。

#### 一、根因：`app.quit()` 早于 ready 只是「标记」，并不终止流程

`src/main/index.ts` 原来写的是 Electron 文档里的标准写法：

```ts
if (!app.requestSingleInstanceLock()) app.quit()
```

两个事实，都是实测出来的（第二个已固化成套件里的对照项）：

| 事实 | 怎么测的 | 结果 |
| --- | --- | --- |
| 锁本身没问题 | 首个实例在跑时，用同一条代码路径调 `requestSingleInstanceLock()` | `false` —— userData 一致，认得出对方 |
| `app.quit()` 在 ready 前**不**跳过启动流程 | 最小脚本：`app.whenReady().then(打印)` + `app.quit()` | ready 一到打印照跑 → 回调没被跳过 |

于是第二个进程照样走完 `whenReady`：开 SQLite、写设置、建窗口、装菜单、拉 GPU 进程。它与首个实例
共用同一个 userData，Chromium 磁盘缓存被两边同时写：`Unable to move the cache: 拒绝访问。(0x5)`、
`Unable to create cache`、`Gpu Cache Creation failed: -2`。这个进程一退，electron-vite 的 dev 命令
也跟着结束；「窗口没出来」是因为那个窗口还没显示就被退出流程带走了。

#### 二、修法：`app.exit(0)` + 把守卫排在「会开库的模块」之前

新增 `src/main/singleInstance.ts`，在 `index.ts` 里第三个 import：

1. `app.setName('Lumin')` —— userData（以及按它认定的锁）由 app name 推导，名字必须早于抢锁；
2. 抢不到锁 → `fs.writeSync(2, 提示)` + `app.exit(0)`。

两个容易漏的点：

- **必须是 `app.exit(0)` 而不是 `app.quit()`**：实测 `app.exit()` 不返回（其后的语句不会执行），
  退出码 0。提示要用 `fs.writeSync(2, …)` **同步**写 —— 重定向/管道下 `console` 是异步的，
  紧接着退出会把提示吞掉。
- **只退出还不够**：`services/database` 的 `db` 是模块级 `new LuminDatabase()`，那个模块一旦被求值，
  SQLite 就已经打开并跑了迁移。所以守卫必须排在 `./menu` / `./ipc`（→ `services/database`）**之前**
  —— 与 `devProfile.ts` 靠 import 顺序保证 userData 先被改掉是同一套机制。构建产物里可以直接核对
  这个顺序（套件 D 项：`another instance is already running` 的偏移 < `new LuminDatabase` 的偏移）。

启动参数不会丢：`requestSingleInstanceLock()` 返回 false 之前，已经**同步**把命令行交给了已运行的实例
（那边触发 `second-instance` → `services/launchIntent` → 打开文件/目录/新窗口），紧接着退出不会截断它。

#### 三、第二个坑：提示在用户终端里是乱码（Windows 控制台代码页）

第一版修好之后，用户终端里那条中文提示长这样（他把输出贴了回来）：

```
[Lumin] 宸叉湁瀹炰緥鍦ㄨ繍琛岋紙鍗曞疄渚嬮攣琚畠鎸佹湁锛夛紝鏈鍚姩宸查€€鍑恒€?        鍛戒护琛屽弬鏁?…
```

两件事同时发生：**中文全乱码**，而且**四行被并成一行**（行尾那个非法尾字节把 `\n` 一起吃了）。
根因是 `fs.writeSync(2, 中文)` 写的是 UTF-8 字节，而 Windows 控制台按**代码页**解读它们
（中文系统 cmd 是 936/GBK）。

「先认出控制台、再交给 Node 转码（WriteConsoleW）」这条路走不通，全是实测：

| 想用的信号 | 实测结果 |
| --- | --- |
| `process.stderr.isTTY` | 真实控制台与管道下**都是 `undefined`**；Electron 自己把这条 spec 标成「on some machines 不可靠」压掉了（[electron/electron@62b1034](https://github.com/electron/electron/commit/62b1034c6be9a0590d3cea8978927e67650b0a08)） |
| `new tty.WriteStream(2)` | 控制台侧 `ERR_TTY_INIT_FAILED`（`uv_tty_init` 返回 EPERM）、管道侧同样失败（EBADF） |
| 子进程 `[Console]::IsOutputRedirected` | 两种落点都是 `True` —— 连「有没有控制台」都问不出来（Electron 是 GUI 子系统进程，`stdio: 'inherit'` 拿到的句柄类型不可信） |

探测不可靠，就只能让**内容**不依赖探测：**提示改成纯 ASCII**（英文）。ASCII 在任意代码页、
管道、日志文件里都是对的；而提示的关键信息本来就是命令（`npm run dev:isolated` / 先关掉再
`npm run dev`），英文不影响操作。中文说明留在 README 与本节。

顺带立规矩并落地：**主进程 console 输出一律 ASCII**。原先三处中文 console 输出一并改成英文
（`[protocol] refused lumin-file request`、`[profile] isolated dev profile active`、
`[db] encoding metadata migration: …`）。规矩由 `tests/mainConsoleAscii.test.mjs` 守着 ——
它扫描 `src/main/**/*.ts` 里所有 `console.*` 的**实参文本**（跳过注释里的假调用、跳过字符串里的
括号），出现非 ASCII 就红；测试自己还有两个「扫描器先自证」的断言，免得扫描器悄悄失效变成空扫通过。
为什么值得写这条测试：违反这条规矩**不会有任何报错**，只会在用户终端里显示成乱码，而乱码又很
容易被误判成「用户环境有问题」。

#### 四、验收

| 门禁 | 结果 |
| --- | --- |
| `npm run ci` | exit 0（**159/159** 单测：新增 `tests/mainConsoleAscii.test.mjs` 2 条） |
| `npx eslint .` | 0 error / 0 warning |
| `node tools/run-suites.js` | **18/18 套件 PASS**（`_verify-single-instance` **14/14**） |
| 现场复现（同一个 userData 再起一个实例；`npm run dev`） | 四行 ASCII 提示可读、**exit 0**、~0.2s（整条 dev 命令 1314ms）、无缓存报错 |

`tools/_verify-single-instance.js` 自己起「首个实例 + 第二个实例」（独立 userData + 独立调试端口 9231，
不占运行器给别的套件用的 9222），14 条断言见 CHANGELOG。修复前它至少有 3 条必红：
输出里出现 `[menu] rebuilt`（跑了启动流程）、出现那三条缓存报错、第二个实例不是「自己干净退出」；
提示被改回中文时，另有一条「提示是纯 ASCII」立刻红。

#### 五、与既有套件的关系

单实例相关的既有套件（`_verify-taskbar-jumplist`、`_verify-packaging` 的第二实例段）测的是**首个实例
那一侧**（参数转交有没有落成新窗口）；本条补的是**第二个实例那一侧**（它自己该不该干活、退得干不干净、
说给人听的话看不看得懂）。默认矩阵现在是 **18 个套件**（§4.66 里的「17」是上一轮的数字）。

### 4.68 双面一致性测试验收（本次）：L0–L4 五层 + 两个真实缺陷

> 问题：`实时渲染` 与 `源码` 之间的逻辑到底可不可靠？结构、渲染、数据有没有问题？
> 这一节是「一次系统性验收」的结论摘要；完整方案（质量模型、不变量 I1–I12、生成器设计、
> 预算口径、扩展方式、结果台账 F1–F12）在 **`docs/wysiwyg-test-plan.md`**。

#### 一、怎么测（五层，快反馈在下）

| 层 | 位置 | 说明 |
| --- | --- | --- |
| L0 纯函数性质 | `tests/*.test.mjs`（进 `ci`） | 生成器可信（种子确定/追加稳定/构造全覆盖/最坏随机源不抛）+ 判据本身不许误报漏报 |
| L1 黄金夹具 | `_verify-md-fidelity.js` | 31 份夹具三层断言（本轮 101 PASS / 1 SKIP） |
| L2 双面矩阵 | `_verify-surfaces.js` | 30 条：切面无副作用、textarea = 真源、文档树签名同构、光标语义、dirty/撤销/保存、13 条渲染结构、分屏同世代 |
| L3 生成式 fuzz | `_verify-surface-fuzz.js` | 60 篇随机组合语料 × 5 类不变量；失败按块/行贪心最小化，给**最小复现** |
| L4 极端/压力 | `_verify-surface-stress.js` | 12 个用例 × 6 类断言（不崩/结构/切面/内容/三处耗时基线） |

三个决定「这套测试能不能信」的设计：**文档树签名**（比两棵 PM 树是否同构，抓「计数一样但位置变了」）、
**哨兵词**（生成器埋在可见文本里的唯一词，抓吃掉/截断，并能指出丢的是哪一段）、
**lossy 分诊**（判级器只认 19 条明文规则，签名同构 + 哨兵齐全 ⇒ 只是重写了标记；否则才是回归）。

#### 二、两个真实缺陷（都已修）

1. **深层嵌套静默丢内容（S1）**：100 层缩进列表保存后只剩 49 层，第 50 层往后一个字符都不剩。
   根因是 markdown-it 块解析器触到 `maxNesting`（默认 100）就 `state.line = endLine; break` ——
   **跳过剩余行**；每个列表层吃 2 级，所以实际上限 ≈ 50 层。
   修法：`parseLimits.ts` 用 `parse.setup` 钩子把 `maxNesting` 抬到 1000（有界）。
2. **段尾孤立反斜杠被改写（S2）**：`a\`（CommonMark 里是字面反斜杠）保存一次变 `a\\`，文件涨一个字符。
   根因：自定义 escape 规则在「反斜杠是本段最后一个字符」时放弃认领 → 被当普通文本转义。
   修法：该分支也走 `md_escape`（`escape:false`）逐字写回；**不能**推 `hardbreak`（上游要求 `\` 后有内容）。

#### 三、不够好的地方（登记在案）

* **性能**：977KB 文档装载/回灌各 ~16s；2000 个围栏代码块（仅 56KB）装载 ~52s；100 代码块 + 100 表
  的 98KB 混合文档 ~34s。耗时集中在装载（解析 + 建节点 + 挂编辑器），块数相关的成本线性膨胀 ——
  头号嫌疑是「每个代码块都挂一个 CodeMirror 实例」，建议虚拟化。三条都已立耗时基线守卫。
* **边角语义**（fuzz 抓到）：空引用代码块内容从空串变一个换行；CR 行尾 + 引用的空行展开与 setext 重排；
  纯文本下划线补转义（保义但改字节）；HR 与 setext 歧义处结构重排。
* **测试基建**：`_verify-find-replace.js` 在**成套连跑**时 10/12、单独跑 12/12 → 测试隔离/时序问题
  （S4，非产品回归），需要加固。

#### 四、验收数字

`npm run ci` exit 0（**176/176** 单测）；`npx eslint .` 0/0；`electron-vite build` 成功；
**21 个套件**：20 绿 + 上面那个时序问题；L2 **30/30**、L3 5 类不变量通过、L4 **72/72**。

### 4.69 日常与深度使用验收（本次）：逐控件盘点 + 结构面审计

> 视角：日常使用（每个按钮/菜单/设置项/对话框/面板）与深度使用（边界状态、结构与一致性）。
> 完整报告在**桌面**《lumin-日常与深度使用测试验收报告.md》；原始审计在 `docs/_audit/`。

**规模事实**：原生菜单 46 个 label 项 + 15 个 role 项 + 11 条分隔线；渲染层 25 个 `.vue`；
工具栏 **14 个按钮**（13 `title` + 1 `aria-label`，无哑按钮）；设置对话框 20 处 `settings.set(`；
三语语言包**各 399 key**（零缺失、零漏翻译、**59 条死键**）；主进程 **75** 个 IPC 通道 / preload **74** 个调用
（双向孤儿仅 `file:getPathForFile`）；`tools/_*.js` 共 98 个、**949 条具名断言**；矩阵 **121 行**覆盖 12 个功能域。

**最要紧的三条**：

1. **设置面板等约 60 处文案硬编码中文**（词条已存在于语言包 → 属于「翻译做完了没接上」），
   同类还有 `AboutView` 整页、`ModalHost` 的「取消/确定」、浮动工具条 title、全局搜索面板、
   原生对话框「所有文件」、未命名文档名、router 离开确认（与已本地化的 `lib/dialog.ts` 重复）。
2. **`tools/verify-tiptap.js`（1473 行 / 114 断言）不在任何矩阵里**：它守着气泡菜单、input rules、
   光标标记符、表格编辑、全局搜索、粘贴 —— 硬编码绝对路径 + 写死 dev server + 不用 harness，
   所以运行器解析不了它的输出。**它守的功能在矩阵里等于没守**（下一轮第一优先）。
3. **矩阵「假绿」**：`--all` 里约 15 个 0 断言探针（`_verify-i18n`/`-theme-auto`/`-toc`/`-export-fix*`…）
   只打印观察值，运行器按退出码判定 → 显示 `PASS 0/0`。建议加 `PROBE` 判定（`total === 0` 不算 PASS）。

**健壮性缺口**（已登记）：`settings:update`（设置唯一写入点）零入参校验；`splitRatio` 载入不 clamp；
`autoSaveInterval` NaN → 0ms 定时器；非法 `defaultEncoding` 被当显式编码并**污染该文件的编码记忆**；
`nativeMenuBar` 名实不符；死通道 `file:getPathForFile`（本轮已删，并同步守卫测试的记账）。

**覆盖面健康的部分**：编辑内核与数据安全链路（保真 101 断言、双面矩阵 30、fuzz、压力 72、会话/草稿/编码/
任务栏/多窗口各专项）、工具栏按钮可访问标签、三语 key 结构、IPC 双向闭合。

**新增守卫**：`tests/i18nAndIpc.test.mjs`（5 条，进 `ci`）：三语 key 集合一致、en/ru 不许残留中文、
字面量 key 必须在语言包、preload 调用的通道必须注册、死通道必须登记原因。实测 **5/5 PASS**。

### 4.70 行内标记的三个缺陷：光标漂移 / 冗余嵌套星号被吃 / `~~~~` 整行清空（本次）

> 用户报的两个必现缺陷（空光标点加粗得到 `*|***`；手打 `**` 包裹后新增的 `*` 消失），
> 追下去一共三个**根因**，都落在「标记文本模型」的同一类边界上：**归一化把光标/字符吃掉了**。

**一、归一化后的光标落到「被替换区间的末尾」（两个报障的主要根因）**

- 现象：空段落点工具栏「加粗」→ 得到 `****|`（用户描述为 `*|***`），而不是 `**|**`；
  在 `x` 末尾点加粗 → `x****|`。更隐蔽的是**手打标记时字符会跑位**：`x` 前手打 `**`
  得到 `*x*`（两颗星被拆到两端）——因为第一颗星打完后光标已被挪到块尾，第二颗星落在了末尾。
- 根因：`typoraInlineMarks.ts` 的 appendTransaction 里，光标保护把锚点算成
  `$sel.before(d) - 1`。`before(d)` 本身就是「文本块之前的位置」（与 `descendants` 给的
  `pos` 同域，块内容从 `pos + 1` 开始），再减一让顶层段落得到 **-1**，
  `caretBlockStart >= 0` 的守卫直接不成立 → 光标保护**整段失效**；
  嵌套块（引用/列表项）则被统一左移一位。失效之后，`tr.replaceWith` 换掉整块内容时
  PM 把光标映射到**被替换区间的末尾**。
- 修法：锚点改回 `$sel.before(d)`，落点规则抽成纯函数
  `inlineMarkerCore.blockCaretTarget(blockPos, offset, size)`（单测钉死，含越界钳制）。
  空格子点加粗因此重新得到 `**|**`，接着打字得到 `**文字**`。

**二、冗余嵌套强调的多余标记被 CommonMark 吃掉（第二个报障的根因）**

- 现象：`**x**` 前后各手打一对 `**` → 期望 `****x****`，实际**新增的四个 `*` 全没了**，
  只剩加粗的 `x`；而且保存重开后 `****x****` 也只剩 `**x**`（一次掉四个字符）。
- 根因：CommonMark 把 `****x****` 解析成 `<strong><strong>x</strong></strong>`（两组定界符
  各配成一对），而 PM 里**同一种 mark 只能挂一个** —— 嵌套两层 strong 塌成一层 bold，
  多出来的那对 `**` 在 HTML→PM 那一步就没了。
- 修法：在 markdown-it 的**渲染器**上拦一道（`patchRedundantEmphasis`，与反斜杠转义同一套
  `parse.setup` 机制）：遇到**同类嵌套**（外层 strong 还没关又开一个 strong）时不再输出标签，
  而是把那对定界符当**字面文本**写成 `<span data-md-escape>**</span>`（复用 `MdEscape` 的
  `escape:false`，逐字写回；直接写裸文本会被 markdown 写出器转义成 `\*\*`）。
  归一化时它随样式一起被物化成标记 → `****x****` 逐字节还原；`***x***`（em+strong 不同类）
  与 `**a**b**c**`（不嵌套）走原路径，行为不变。

**三、源码权威重推把「整行标记字符」当成块级构造（顺带修掉的字符清空）**

- 现象：空段落点「删除线」→ 四个 `~` **直接消失**（段落变空）；点「加粗」得到 `****`
  再保存重开会变成 `---`（前者本轮修掉，后者见下面的口径 ④）。
- 根因：`resolveBlockContent` 的「源码权威重推」把整行文本喂给 markdown-it，而 `~~~~` 在
  CommonMark 里是**代码围栏**的开头 —— 解析产物的文本是空的，于是整段字符被替换掉。
- 修法：重推是「重新解释同一段源码」，**一个字符都不许丢** —— 加一条
  `fragmentText(frag2) === block.textContent` 护栏，文本对不上就不采用、退回常规归一化
  （标记字面量仍在）。同类受益：`- **a**` 这种会被解析成列表的整行文本不再被吃掉前缀。

**四、整行只有标记字符 → 落盘逐字符转义（产品口径 ②，本轮定稿）**

- 现象（三的尾巴）：空段落点「加粗」得到字面 `****`，点「删除线」得到 `~~~~` —— 但这两行在
  CommonMark 里**不是普通文本**：`****`（≥3 个 `*`）是**分割线**、`~~~~`（≥3 个 `~`）是
  **代码围栏**开头。不处理的话，用户存盘再打开就会看到段落变分割线 / 内容变空代码块。
- 为什么不能在实时模型里让步：光标必须落在两个标记之间（`**|**`）用户才能接着打字，
  所以实时正文**必须**是字面 `****`；而文件里写成 `****` 又必然被重开语义改写 —— 两条
  要求在「文件字节 = 屏幕上那几个字符」的口径下无法同时满足。
- 口径与修法（**「绝不静默改变语义」优先于「原始字节逐字相同」**）：新增文档文本规则
  `shared/documentText.escapeMarkerOnlyLines()`（挂进 `getMarkdown` 这个唯一出口）：
  **整行（去行尾空白后）只由 `*` `~` `` ` `` `_` 组成**时逐字符转义（`****` → `\*\*\*\*`）。
  于是文件里是显式转义、重开仍是**字面文本**（不会变分割线/围栏），而且**跨编辑器一致**
  （别的 Markdown 编辑器也渲染成字面星号）；实时编辑完全不受影响（转义只发生在落盘那一刻）。
  刻意排除的边界（都写进了实现与单测，避免误伤）：
  * **反引号代码围栏及其内部内容**（围栏本身就是三个以上反引号，和「整行标记」长得一样；
    围栏里的行是代码内容，改一个字节都不行）→ 扫描时维护「是否在围栏内」的状态。
    只认反引号围栏：本仓库的序列化器（CodeBlock / `codeFenceFor`）只写反引号围栏，
    波浪线整行只会出现在正文里（`~~~~` 正是要转义的那种）；
  * **原样写回的节点**（HTML 块 / 公式块 / front matter，`attrs.source`）里的行全部跳过
    —— 那是用户原文（`getMarkdown(ed)` 把它们作为 `protect` 集合传进去）；
  * 有前导空白的行不动（缩进代码/续行）、行尾空白保留、`---`/`> `/`1. ` 不在集合里。
  * **已知边界**：带容器前缀的整行（引用里的 `> ****`、列表项里的 `- ****`）不在本规则
    范围内（规则按「整行只由标记字符组成」判定）——需要时另开一轮按容器前缀处理。
- 验收：单测 7 条（转义 / 不误伤 / 围栏 / protect / 缩进 / 行尾空白 / 幂等）；CDP 套件里
  两条真断言 —— `****` 行、`~~~~` 行「保存 → 重开」后**是 paragraph（不是
  horizontalRule/codeBlock）、四个标记字符一个不少、再序列化字节稳定」。

**五、样式正文里的字面标记字符被补反斜杠（本轮，任务 A）**

- 现象：实时渲染区逐字输入 `**2****2**` → 落盘变成 `**2\*\*\*\*2**`（凭空多出四个反斜杠）。
- **先取证，再改**（隔离实例四条路径，每步打印 `doc.textContent` + 每个 text 节点的文本与 marks）：
  1. **逐字键入** → 转义。中间态本身都是对的：`**2***` 的模型是「strong + 末尾一颗
     literal 星」（与 CommonMark `<strong>2</strong>*` 一致），打到 `**2****2*` 时那颗
     literal 星还被**重新评估**成了斜体起始 —— 可见「字面量一旦锁定就再也回不去」并不成立；
  2. **一次性 `insertContent('**2****2**')`** → **同样**转义；
  3. **从磁盘装载同一份源码** → **同样**转义；
  4. 先打 `**2**` 再整段插入 `**2**` → 不转义。但它干净的原因是模型恰好成了
     「两个相邻 strong」（与 CommonMark 解析无关），不是「避开了输入中间态」。
  ⇒ 报障时的两条推断（「输入中间态把标记锁成字面文本」「一次性写入/粘贴不会这样」）**都被证伪**。
- **口径修正（本轮的关键判断）**：`**2****2**` 在 CommonMark 里**不是**
  `<strong>2</strong><strong>2</strong>`，而是**一个** `<strong>` 包住字面文本 `2****2`。
  依据是 §6.2 的「3 的倍数」规则：它只在参与配对的某一侧定界符串**同时能开能闭**时生效
  —— `**`（只能开，长度 2）与 `****`（既开又闭，长度 4）的长度和 6 是 3 的倍数、
  且两者都不是 3 的倍数 → 这一对**不许配对**，`****` 只能作为开定界符留在栈上，
  最后的 `**` 于是回头配到最前面的 `**`。三方实测一致：markdown-it 默认 preset、
  markdown-it `commonmark` preset、marked 都输出 `<strong>2****2</strong>`。
  所以实时渲染区显示「粗体的 `2****2`（星号可见）」**才是**与 GitHub / VS Code 一致的行为；
  改成「两个相邻粗体 2、星号不显示」反而会与 GitHub 不一致，也会破坏「实时 = 重开」
  这条不变量（重开走 markdown-it，必然回到一个 strong）。
  → 真正的缺陷只有一条：**字符没丢、语义没变，但文件字节被改写了**（多了 `\*\*\*\*`）。
- 根因（文件:行）：`typoraInlineMarks.ts` 的 `literalizeStrayMarkers`（旧 472–517 行）在
  函数开头就对带 `mdStyle` 的文本整段 `continue` —— 「字面量化」只覆盖**无样式正文**，
  **样式正文里**的裸标记字符（`<strong>2****2</strong>` 里的 `****`）落进普通文本分支，
  被 markdown 写出器（prosemirror-markdown `MarkdownSerializerState.esc()`：
  `` ` `` `*` `\` `~` `[` `]` `_` 一律补反斜杠）转义。
- 改法：把**字面量化下沉到纯逻辑核心**，成为归一化的一步
  （`inlineMarkerCore.literalizeStrayAtoms`，在 `normalizeAtoms` 末尾跑）：
  * 判据 = `splitStrayMarkerRuns()`：只有 `*` / `~` / `` ` `` 的**连续段**才可能被字面量化；
  * 无样式正文 → `side:'literal'` 标记原子（原行为：原样序列化，且文本变了还能「配对重提升」）；
  * **样式正文 → 切成独立原子并标 `verbatim`**（`fromAtoms` 给它贴 `MdEscape` 的
    `escape:false` → 逐字写回，反斜杠一个都不多）；
  * **不动**的两类：行内代码正文（styles 含 `code`，本来就由 `MdCodeLiteral` 逐字写回）、
    带链接/下划线等 mark 的**无样式**文本（literal 标记挂不住那些 mark，硬切会把链接
    劈成 `[a](u)*[b](u)` —— 宁可保留那几个反斜杠，也绝不破坏结构）；
  * 「重推触发判据」抽成 `needsSourceReparse()` 一并进核心并单测钉死 ——
    **它就是「已字面化标记的重新评估」机制**：文本一变就把整段原文重新喂给 markdown-it，
    判定永远跟着 CommonMark 走。取证显示这条机制原本就在工作，不必另造一套「回滚字面量」。
- 结果：键入 / 一次性写入 / 装载 `**2****2**` 都得到**与输入逐字节相同**的 `**2****2**`，
  实时渲染 = `<strong>2****2</strong>`（与 GitHub 一致）；同类 `**a * b**`、`*a**b*`、
  `**c****d**` 也不再被补反斜杠（此前分别写成 `**a \* b**`、`*a\*\*b*`）。
- **顺带查出并修掉「粘贴路径丢字符」**（真实剪贴板 Ctrl+V，上一轮遗留的缺陷）：
  * 现场：粘贴 `**2****2**` 落成 `**2**2**`（**少两个星号**）；粘贴 `**a * b**` 落成
    `**a  b*`。
  * 定位：先用**真的系统剪贴板** + CDP Ctrl+V 复现（合成 `ClipboardEvent` 走不通：
    实测它被当纯文本直插，语义与真实粘贴不同）；再把同一 slice 用四种方式插入——
    只有加上 `paste` / `uiEvent` 两个 meta 才丢字符（不带 meta → `**2****2**`；
    带 meta → `**2**2**`），最后**忠实复刻 PM 的 appendTransaction 循环**，看到
    keyless 的插件（源码片段即 tiptap `markPasteRule` 的 appendTransaction）在
    `uiEvent === 'paste'` 时把那批定界符当语法消费掉。
  * 根因：真实粘贴走 `clipboardTextParser`（markdown 解析）→ 得到「一个 legacy bold
    文本节点 `2****2`」，紧接着 tiptap 的 **mark 粘贴规则**又去「把 `**` 换成 mark」，
    字符就此消失（`extensions.ts` 的四个「安静版」mark 此前只关了
    `addInputRules` / `addKeyboardShortcuts`，漏了 `addPasteRules`）。
  * 修法：四个安静版 mark 连 `addPasteRules` 一起关掉 —— 与 2026-09-16 关掉它们输入
    规则**同一个理由**：本模型的样式由**标记文本**派生，任何「吃掉 `**` 换成 mark」
    的自动化都会删掉用户写下的字符；粘贴内容的 Markdown 语义由
    `markdownPaste.clipboardTextParser` + 派生归一化负责。
  * 结果：真实粘贴 `**2****2**`、`**a * b**`、`**加粗**` 全部逐字节一致（套件新增
    真剪贴板断言，剪贴板前后保存/复原）。

**六、转义反斜杠的观感：拆成两个 span + 按光标显隐（与 `**` 同一机制；本轮行为修订）**

- 现象（五的反面）：**真正无法配对、必须字面化**的场景 —— 整行只有 `****` —— 落盘按
  口径 ④ 写成 `\*\*\*\*`；重开之后这个反斜杠在实时渲染区与正文同色，看起来「凭空多出来」。
- 第一版（上一轮，已修订掉）：把反斜杠画成**暗色常显**。用户反馈：不该一直挂在屏幕上，
  应当**和加粗的 `**` 一样按光标显隐**；而且**连续多个转义要整体显隐**。
- 现口径（本轮）：
  * `MdEscape` 的 `renderHTML` 只能给出**一个** span（PM 里一个 mark 的内容洞是连续的，
    renderHTML 拆不开），所以在**装饰层**拆：`typoraInlineMarks.escapeDecorations()` 把
    `\X` 渲染成 `<span class="md-escape-backslash">\</span><span class="md-escape-char">X</span>`。
    一个文本节点里可能连着**好几处**转义（整行 `\*\*\*\*` 会被 PM 合并成一段），
    所以按字符走而不是只切第一个；
  * 只对**真的以反斜杠开头**的 `MdEscape` 文本做：同一层 mark 还承担「冗余嵌套强调多出来
    那对定界符」的逐字写回（`literalSpan('**')`，内容里**没有**反斜杠），那是字面标记、
    不是转义，不该被画成暗色；
  * **显隐复用 `.md-marker` 那一套机制与判据**（不另造 CSS）：反斜杠 span 默认
    `font-size: 0`（零占位折叠，**不用 `display:none`** —— 那会破坏浏览器光标导航与命中，
    与 `.md-marker` 的取舍一致）；光标/选区落在该转义段内（或紧贴段的两端）时，
    装饰给**同一个 span** 加上 `.md-reveal-inline`（`class="md-escape-backslash
    md-reveal-inline"`）→ 字号恢复 `inherit` + 暗色 `--ink-3` + 与 `.md-marker` 同一条
    `md-marker-in` 淡入动画（避免过场跳字）；
  * 判据与 `buildRevealDecorations` 里的 mdMarker 构造**逐字一致**：
    `from <= run.end && to >= run.start`（左右边界均含）。**边界口径**：光标**紧贴**转义段
    两端（`|\*…`、`…*|`）也算「在该构造内」⇒ 显示 —— 与 `**x**` 的光标贴着 `**` 两端时
    标记同样显示完全一致，用户在段首/段尾接着编辑时不会出现「刚打完就看不见」；
  * **连续转义段整体显隐**（本次要求的核心）：`collectEscapeRuns()` 把「后一个转义单元的反斜杠
    紧跟前一个被转义字符末尾」的单元并成**一段** —— `\*\*\*\*` 的 8 个字符两两相接 = **1 段
    4 个**，光标在段内任一位置 ⇒ 4 个反斜杠**同时**显示 / 同时折叠；中间隔着别的字符就断开，
    `\* \*`（空格）= **2 段**，只显示光标所在那一段。与「一对 `**` + 正文当作一个构造整体显隐」
    同一个思路，只是这里的「构造」是一段连续的转义；
  * `data-md-escape` 仍由 `MdEscape.renderHTML` 承载（解析规则与既有套件依赖它，语义未变），
    `doc.textContent`、模型与落盘字节都不变（拆的、藏的只是渲染层）；
  * 被转义的字面字符本身（`.md-escape-char`）**始终**正常显示（`color: inherit`）。
  * **只有「真转义」折叠**（本轮第二处口径判断）：「真转义」= `\` + **ASCII 标点**，
    判据直接复用文件里既有的 `ASCII_PUNCT` 常量（即 `ESCAPED_PUNCT_RE` 用的那一份，
    CommonMark 的可转义集合）。原因是一条**实测出来的**边界：`C:\Users\x` 这类 Windows
    路径在装载路径上**同样是 `MdEscape` 文本节点**（`patchEscapeRule` 的分支 ③ 把不可
    转义字符也原样保留、逐字写回），但它不是 CommonMark 语义上的转义 —— 一起折叠的话，
    屏幕上的路径会**少字符**（`C:\Users\x` 显示成 `C:Usersx`，实测取证）。所以非标点的
    `\X`（含孤立反斜杠、`\` + 空格）一律常显：装饰永远给它 `.md-reveal-inline`（复用同一个
    显隐类的「已展开」态，不新造机制），cursor 进出一律不变。取舍方向是**宁可多显示一个
    反斜杠，也绝不把内容藏起来**；
  * 样式 `style.css`：`.md-escape-backslash { font-size: 0; color: var(--ink-3) }` +
    `.md-escape-backslash.md-reveal-inline { font-size: inherit; animation: md-marker-in … }`、
    `.md-escape-char { color: inherit }`。`--ink-3` 三套主题各自定义，实测反斜杠色与
    正文色都不同：light `rgb(138,145,158)` vs `rgb(32,36,43)`、dark `rgb(109,116,131)` vs
    `rgb(232,234,239)`、sepia `rgb(165,148,122)` vs `rgb(74,59,42)`。
- 验收：套件断言 `\*\*\*\*` 拆出 **4 个反斜杠 span + 4 个字面字符 span**、`data-md-escape`
  包裹仍在、**光标在别段 ⇒ 反斜杠折叠不可见**（`font-size: 0` + rect 宽 0 + `display ≠ none`
  + `visibility: visible`，与 `.md-marker` 隐藏态**同一口径**）、**光标落在段内三处
  （第一处 / 最后一处 / 选中整段）⇒ 4 个同时可见且暗色**、**连续段整体性**（`\*\*\*\*`
  光标在 7 个位置都 4 个同显、紧贴段两端也显示）、**两段 `\* \*` 各显各的**（含「光标落在
  中间空格上只显第 1 段」的边界）、**键盘 ←/→ 跨段边界显隐正确切换**、三主题各两条
  （折叠 + 显示暗色）、`textContent` 与落盘字节不变、实时键入的 `\*` 同样拆两个 span 且
  光标移出即折叠、**非标点 `\X`（`C:\a\b`）光标在段外/段内都常显且字节不变**。

**剩下的已知限制（已定口径：保持现状 + 登记后续任务，不引入膨胀链）**

**下划线（`<u>`）与标记样式共存**：下划线没有 Markdown 语法，序列化形态是**裸 HTML `<u>`**。
若为了保住这个 mark 而跳过源码重推（「开后门」），同一段里的 `**` 会在每次重开时**指数膨胀**
（实测 `**<u>a</u>**<u>bc</u>` → `**<u>****a****</u>**<u>**bc</u>` → 星号 4→8→12…，
属数据损坏级）。权衡后当前行为是：给带下划线的文本套标记样式时**保留字节稳定、丢弃下划线**
（`abc` 加下划线 → 局部加粗 → `**a**bc`）。已登记后续任务：给下划线一个**一等 mark**
（`<u>…</u>` + `escape:false`，与 `MdHtml` 同思路），让它能和标记样式安全嵌套
（见 `docs/optimization-program.md` 台账）。

**回归**：`tests/inlineMarkers.test.mjs`（30 条纯逻辑单测：标记对落点 / 归一化光标落点 /
手打标记识别与字面量化 / **字面量化判据 + 重推判据 + 幂等** / 冗余嵌套判定与渲染规则）
+ `tests/documentText.test.mjs` 新增 7 条
（整行标记转义：转义/不误伤/围栏/protect/缩进/行尾空白/幂等）；CDP 套件
`_verify-inline-formats.js`（**159/160 PASS + 1 SKIP**——SKIP 是「下划线 + 加粗」那条
已知缺口的登记，不是假绿；其中转义反斜杠显隐一组 **29 条**断言），
格式 × 操作矩阵：工具栏三种光标情形、四个快捷键、手打标记对、`***粗斜***`、
粗+斜/粗+码/删+斜/链接+粗/嵌套取消、整行标记的落盘转义与重开语义、
**样式正文里的裸标记字符不产生转义（键入/一次性写入/装载三条路径）+ 相邻与嵌套不回退**、
**转义反斜杠的拆分渲染 + 按光标显隐（与 `**` 同机制：折叠零占位 / 显示暗色 / 连续段整体显隐 /
两段各显各的 / 键盘 ←→ 跨边界 / 三主题各两条）**、**真实剪贴板粘贴逐字节**，每条都查
**字节 + 光标 + 每个 text 节点的 marks**，末尾再做「保存→重开→再序列化」的往返），
已进 `run-suites.js` 默认矩阵；取证脚本 `tools/_probe-taskA.js`（四条写入路径）、`tools/_probe-taskB.js`（转义渲染、逐 span 显隐与三主题）、`tools/_probe-paste.js`（真剪贴板粘贴）**已按清单 §2.I 删除** —— 对应结论已固化进 `_verify-inline-formats.js` 的 182 条断言。

**已知边界（本轮明确保留，不是遗漏）**：

- **带链接 / 下划线 mark 的无样式文本里的裸标记字符仍会被补反斜杠**（例如
  `[a*b](url)` 里那颗星 → `[a\*b](url)`）：字面量化在无样式分支只能产出
  `mdMarker(literal)`，挂不住链接 mark，硬切会把链接劈成 `[a](u)*[b](u)`（结构损坏）。
  按「宁可字节不完美，也绝不破坏结构」保留现状；语义不变（`\*` 在链接文本里仍是字面星）。
- **`**2****2**` 的实时渲染是「粗体的 `2****2`，星号可见」**（CommonMark / GitHub / VS Code
  一致）。若产品口径要的是「两个相邻粗体 2、星号隐藏」，那与 CommonMark 相悖，
  需要**显式决定**（并且会与「重开走 markdown-it」的实时一致性冲突），本轮按
  CommonMark 语义实现，未改。
- 带容器前缀的整行标记（`> ****`、`- ****`）仍不覆盖（沿用 §4.70 四的口径）。

### 4.71 CJK 标点旁的加粗 + 打字卡顿（两个用户报障）

> 报障 ①：`**一句话**：……押在了**「保存路径」与「Markdown 保真」**这两件……**写盘不是原子操作…**`
> 这一整段在实时渲染区里**加粗变成字面星号**、加粗区间整体错位。
> 报障 ②：「写入内容变的非常卡，非常非常卡」。两件都**先取证再改**，取证脚本 `tools/_probe-fixture.js`（三条写入路径，**已按清单 §2.I 删除**）、`tools/_probe-cjk-flank.js`（改动半径，**已按清单 §2.I 删除**）、
> `tools/_probe-perf.js`（每键耗时 + markdown-it 计数 + CPU 采样）、`tools/_probe-md-baseline.js`（markdown-it 对照基准）—— 后两个作为常驻测量工具保留。

#### 一、加粗变成字面星号：根因**不在**本仓库的字面量化，在 markdown-it 的 flanking 判定

报障时高度怀疑「上一轮的字面量化把合法的 `**…**` 对误判成 stray」。**证伪**：

1. 把那段原文直接喂给 **stock markdown-it（默认 preset）**：`<strong>` **6** 个（不是 7），
   且 `押在了**「保存路径」` 与句尾 `统一入口**。` 两处的 `**` 是**字面文本** —— 报障里的
   「字面星号 + 加粗区间错位」是 CommonMark 的**原生结果**，不是本仓库加工的产物；
2. 隔离实例三条写入路径（① `openDocWith` 装载 ② 逐字键入 ③ 真实 Ctrl+V）**结果完全一致**：
   `literalMarkers=2`（那两处 `**` 被字面量化）、`mdStyle`/`mdEscape` 分布与 stock markdown-it 的
   token 结构逐字对应、`getMarkdown()` 与输入**逐字节一致**（含 `**2****2**` 那类既有语义全部保持）。
   ⇒ 字面量化**没有误判**，它只是忠实地执行了 markdown-it 的判定。

**真根因**：CommonMark 的定界符左右可开/可闭（flanking）判定把 `「` `」` `（` `）` `：` 这类
**全角/中文标点算作「标点」**，于是

* 开定界符 `押在了` **`**`** `「保存路径」`：后面跟标点、前面既不是空白也不是标点 ⇒ **不是 left-flanking ⇒ 不能开**；
* 与之配对的 `」` **`**`** `这两件`：同样的镜像原因 ⇒ **不能合**。

下一个 `**` 于是去配更靠后的 `**`，整段的定界符配对**整体错位**，多出来的两处落成字面星号。
（这也是 VSCode / GitHub 的行为，但中文写作里 `**「…」**`、`**（…）**` 是最常见的加粗写法，
而且本编辑器内部的「手打标记识别」`recognizeTypedMarkers` 一直把它们当合法配对 —— 所以会出现
**同一段文字在不同上下文里渲染不一致**：`押在了**「…」**这两件` 单独一行是**加粗**，
放进长段落里就变**字面星号**。这条不一致本身就是缺陷。）

**改法（`src/renderer/src/lib/editor/cjkEmphasis.ts` + `inlineMarkerCore.scanDelimsCjk`）**：
在 **markdown-it 那一层**换掉 emphasis 分词用的 flanking 判定，让 **CJK/全角标点不参与**
`*` 的标点分类（其余标点仍是标准 CommonMark 语义）。因为它是 `parse.setup` 钩子装上去的，
**「加载/刷新」与「实时重推」共用同一条规则**，不会再出现实时/刷新不一致。
上游的 `balance_pairs` 与 `rule of 3`（`**2****2**` 那类）**一个都没动**。

**为什么只对 `*` 放宽（`canSplitWord === true`）**：对 `*` 而言标点分类**只起阻挡作用**，
放宽是**单调**的（只会多配、不会少配）；而 `_` 的 `can_open` 里 `isLastPunctChar` 是**正向使能**项
（intraword 限制），放宽会把 `下划线形式：__加粗__` 直接关掉 —— 实测 31 份 md 夹具逐份 diff：
放宽前/后 **30 份 HTML 完全相同**，唯一变化的正是 emphasis.md 的 `__加粗__` 那一行；改成「只对 `*` 放宽」
后 **31 份全部相同**（改动半径 = 0）。

**结果**（三条路径一致，`_verify-inline-formats.js` J 组永久断言）：
`<strong>` **8 个元素 = 7 个逻辑加粗**（`` `npm run lint` `` 那段是「粗+码」样式集合，按本模型
「一个样式集合只出一个元素」拆成 2 个：`npm run lint` + ` 目前是坏的（912 errors）`），
内容与 markdown-it 对照基准逐项一致、**字面量化的标记 = 0**、`getMarkdown()` 与输入逐字节一致。

#### 二、打字卡顿：每键都会把**全篇**带样式的块重算一遍

**量化**（`tools/_probe-perf.js`；同一台机器、同一探针、先各跑一遍取稳定值）：

| 场景（末尾逐字输入 100 字，页面内 `performance.now()` 包 `ed.commands.insertContent`） | 修复前 avg/p95/max (ms) | 修复后 avg/p95/max (ms) | 每键 markdown-it 解析次数 |
| --- | --- | --- | --- |
| 空段落（对照） | 0.50 / 0.8 / 1.2 | 0.50 / 0.7 / 1.3 | 1 → 1 |
| 单段 500 字 | 1.17 / 1.6 / 2.0 | 1.12 / 1.6 / 2.5 | 2 → 2 |
| 单段 3000 字 | 3.75 / 4.6 / 7.8 | 3.62 / 4.5 / 8.2 | 2 → 2 |
| 8 段 ≈500 字（都有加粗） | 1.77 / 2.5 / 6.7 | **0.63 / 0.9 / 1.5** | 9 → 2 |
| 50 段 ≈3000 字（都有加粗） | **14.54 / 19.7 / 40.1** | **0.65 / 0.9 / 1.4** | **51 → 2** |
| 500 字被编辑段 + 2000 字别的段 | 8.08 / 10.9 / 15.6 | 1.04 / 1.8 / 5.4 | 35 → 2 |
| 500 字被编辑段 + 8000 字别的段 | **69.44 / 116.1 / 122.1** | **1.50 / 2.3 / 6.7** | **136 → 2** |

CPU 采样（修复前，单段 3000 字）自带时间 top：`normalizeAtoms` 13.3ms、`fromAtoms` 9.3、
`materializeStyledRun` 8.8、`recognizeTypedMarkers` 5.4、`styleList` 6.4（合计 460ms 采样里
原子归一化管线约 33ms、markdown-it + DOM 往返约 90ms）；**装饰构建只有 1.1ms**
（所以卡顿与「转义反斜杠按光标显隐」无关，不必回退该功能）。

**根因**：`typoraInlineMarks.ts` 的 `appendTransaction` 每次事务都遍历**全篇** textblock，
对每个「需要归一化」的块跑 `resolveBlockContent`（toAtoms + normalizeAtoms + **可能的
markdown-it 重推** + fromAtoms + `frag.eq`）。而 `blockNeedsNormalize` 对**已经带样式标记的块
恒为真** ⇒ 每敲一个字，**全篇每个带加粗的段落**都要重算一遍（50 段文档 = 每键 51 次
markdown-it 解析）。这就是「平方级」的来源：成本 ≈ 文档长度 × 每键。

**改法（两处，都是「按块缓存」）**：

1. `appendTransaction` 里的 `normalizeClean: WeakMap<PMNode, true>`：PM 节点**不可变 + 结构共享**，
   没被这次编辑碰到的块**引用不变** ⇒ 一次查表就跳过（归一化完稳定态、以及 `blockNeedsNormalize`
   为假的块都记进去）。只重算**被这次编辑改到的块**。
   顺带一条前置守卫：`_transactions` 里没有 `docChanged` 就整段跳过（纯选区变化不该做归一化）。
2. 装饰的 `decoCache: WeakMap<PMNode, BlockDecos>`：把「块 → 行内构造/转义段清单」按**块内相对
   偏移**缓存（绝对位置在遍历时加），每键只对变化过的块重扫 marks；一次遍历同时产出 mdMarker 构造
   与转义段（此前是两次全文遍历）。
   **不改成「只算可见视口」是故意的**：转义拆分出来的 `.md-escape-backslash`/`.md-escape-char`
   是**常显**的渲染结构，而 PM 的 docView 是惰性构建、滚动不重建已有视图 —— 视口外的块若不带这套
   装饰，滚过去就会看到反斜杠直接露在正文里。宁可多算一点，也不让渲染结构随滚动位置变。
3. `inlineMarkerCore.styleList()` 加一条无分配快路径（入参已是规范序时直接浅拷贝）——归一化热路径上
   它被调用次数与文本原子数成正比。

**结果**：每键成本与**文档长度**解耦（500 字 vs 3000 字多段 p95 = 2.0 → 1.8ms，比值 1.0；被编辑段
等长、文档从 2000 字加到 8000 字：5.4 → 6.7ms max）；每键 markdown-it 解析次数 51 → 2。
**没有回退任何既有功能**（「转义反斜杠按光标显隐」原样保留）。

#### 三、本轮口径（需要显式知情的一处）

**CJK/全角标点不参与 `*` 的 flanking 判定**（`、。〈〉《》「」『』【】〔〕…`、全角 ASCII 变体
`！？，．：；（）［］…`、`‘’“”`、`—` `―` `…`、CJK 兼容形式）。这是**对 CommonMark 的一处有意偏离**：
严格 CommonMark 会把 `押在了**「…」**这两件` 渲染成字面星号（GitHub/VSCode 同款），
本编辑器的产品口径是**中文写作里它必须成粗**（与编辑器内部的「手打标记识别」一致）。
偏离**只影响**「CJK/全角标点紧贴 `*` 定界符」这一类输入，31 份 md 夹具逐份 diff 证明
**其余渲染一个字节都没变**。若将来要回到严格 CommonMark，只需删掉 `cjkEmphasis.ts` 的注册
（`extensions.ts` 里一行）与两个单测；套件 J 组的「对照基准」断言会立刻变红，不会被静默绕过。

#### 五、一条**不是**本轮引入的红：`many-fences-2000 切到源码 ≤ 6000ms`

`_verify-surface-stress.js` 的这条耗时断言本轮报红（`toSource=18.8~21.9s`，预算 6s）。**逐项排查后判定
与本轮改动无关**，取证如下（都跑在「只跑这一个用例」的同一台机器上）：

| 构建 | load | toSource | back |
| --- | --- | --- | --- |
| 改动前的代码（第一次量） | 53.7s | **1.4s** ✅ | 1.8s |
| 本轮改动 | 54.5s | 18.8s ❌ | 1.7s |
| 只留 `normalizeClean` 记忆、撤掉装饰缓存 | 62.2s | 21.8s ❌ | 2.2s |
| 关掉 CJK 定界符补丁 | 62.4s | 21.9s ❌ | 2.2s |
| **改动前的代码（复量，同一时段）** | 61.8s | **21.9s** ❌ | 2.1s |

**结论**：把原代码重新构建再量，同一条断言**同样报红**（21.9s，与改动后的 21.8s 无异）⇒ 这是
**机器状态/负载**导致的，不是本轮引入的回退；`load` 也从 53.7s 漂到 62s（同一份原代码）。
为什么 `toSource` 会「吸收」这么多时间：CDP 的 `Runtime.evaluate` **阻塞到渲染进程主线程空闲**，
而 2000 个围栏代码块要建 2000 个 CodeMirror 实例，其中一部分是**跨帧（rAF/requestMeasure）异步完成**的
——窗口被遮挡时 rAF 被节流，这批工作就顺延到**下一个 evaluate**，于是「装载 54s + 切面 1.4s」与
「装载 62s + 切面 21.9s」是**同一份工作量在两次测量里的不同归因**（实测同一构建两种归因都出现过）。
排查时用的探针留在 `tools/_probe-fences-total.js`（全程 CPU 采样）、`_probe-fences-hot2.js`（**已按清单 §2.I 删除**）、
`_probe-modeswitch.js`；CPU 采样显示本轮代码只占 0.6~1.8ms（`blockInventory`），
热点是 PM/Vue 侧的 `DOMSelection.eq` / `StyleModule.mount` / `EditorView` 构造与 GC。

**没做到的地方**：这条预算（2000 个代码块 + 切到源码 ≤ 6s）在本机当前负载下**改前改后都过不去**，
没有把它改成绿的（改预算或加 `bringToFront` 都会掩盖真实的环境敏感度）；按用户口径「红了先单独
复跑确认抖动」，复跑 + 原代码对照就是本节的结论。

#### 六、验收

* 单测 `tests/inlineMarkers.test.mjs` 新增 5 条（`isCjkPunctCode` 分类表、`scanDelimsCjk` 在
  `了**「`/`」**这两` 处能开能闭、ASCII 标点不放宽、`_` 保持上游语义、行首行尾/词中/长度计数），
  合计 **222/222**；
* `tools/_verify-inline-formats.js`：J 组（三条写入路径 × strong 个数与内容 / 无字面量化标记 /
  `docText` 与 `getMarkdown` 逐字节 / **markdown-it 对照基准**）+ 最小复现 4 条 + K 组性能 5 条
  （空段落/3000 字长段落/3000 字长文档各自的 p95 ≤ 25ms、max ≤ 60ms；文档长度比值 ≤ 2；
  每键 markdown-it 解析 ≤ 4 次），套件 **183/184 PASS + 1 SKIP**（SKIP = 既有的「下划线 + 加粗」缺口）；
* `tools/lib/harness.js` 新增 `bringToFront(app)` 并在该套件的取焦点重试里每轮调用：用户**自己的**
  Lumin 窗口占着前台时，被测实例拿不到焦点会让真实输入类断言报 `NO-FOCUS`（本轮实测复现，
  与代码无关），现在每次重试都重新提一次前台。

### 4.72 主题：副色改中性灰 + 文字选区走浏览器默认（本次）

**用户口径**：副色原来以紫色为主 ⇒ 改成**浅灰为主**（像 Typora）；选中文字的颜色「用默认颜色即可，
无需紫色」。

#### 一、副色（accent 家族）改成灰，靠明度差不靠色相

参照 Typora：界面里的「强调」不靠色相。三个角色各司其职，但**都必须是低饱和的灰**
（暖灰 / 冷灰都算灰，判据见验收里的「通道极差 ≤ 40 且不是紫/品红」）：

| 令牌 | 角色 | 浅色 | 深色 | 羊皮纸 |
| --- | --- | --- | --- | --- |
| `--accent` | 图标 / 焦点环 / 边框 / 勾选态 | `#6b7280` | `#8a919e` | `#8a7f6b`（暖灰） |
| `--accent-soft` | 选中淡底（半透明） | `rgba(17,24,39,.07)` | `rgba(255,255,255,.08)` | `rgba(90,74,48,.09)` |
| `--accent-ink` | 淡底之上的文字 | `#374151` | `#dcdfe5` | `#5c5140` |
| `--accent-2` | 次级强调（渐变另一端） | `#4b5563` | `#6b7280` | `#6f6555` |

深色主题的 `--accent` 必须**够亮**（暗底上的图标/焦点环），而「白字压在按钮上」要的是**够深** ——
两个角色互相拉扯，所以**实心主按钮改用独立令牌**（`--btn-solid` / `--btn-solid-2` / `--btn-ink`），
不再跟着副色走：三主题实测按钮文字对比度 **7.56 / 6.87 / 6.11 : 1**（都 ≥ 4.5:1）。
同理，**代码高亮的两档结构色**（`--code-key` / `--code-key-2`，板岩蓝）也独立出来 ——
若沿用副色，关键字/标签/属性会与正文灰糊在一起（与字符串绿、数字琥珀也难区分）。

**链接保持蓝色**（新增 `--link`，目录条目 `--toc-link: var(--link)`）：灰副色下链接若也跟着变灰，
就和正文分不开了（Typora 的链接也是蓝的）。

#### 一点五、标记符（`**` 这类源码符号）再淡一档

用户第三条口径：「像是加粗 `**` 这种符号的颜色改为再浅一点的灰色」。原来它是
`color-mix(副色 70%, --ink-3)`，副色变灰之后偏重、抢正文注意力。现在收进**一个新令牌 `--marker`**，
三主题都往**贴近背景**的方向取值（浅色下更浅、深色下更暗 —— 都是「对比度更低」）：

| 主题 | `--marker` | 标记/纸 | （对照）`--ink-3`/纸 | 副色/纸 |
| --- | --- | --- | --- | --- |
| 浅色 | `#a4aab4` | **2.28:1** | 3.09:1 | 4.71:1 |
| 深色 | `#666c78` | **3.49:1** | 3.92:1 | 5.81:1 |
| 羊皮纸 | `#b3a894` | **2.14:1** | 2.69:1 | 3.59:1 |

同一个令牌一并收掉另外三处「源码符号」的墨色：`.md-meta`（代码围栏与行内代码的标记）、
`h1~h6 > .md-heading-marker`（光标在标题里显示的 `#`）、`.md-escape-backslash`（`\`）——
它们原先各写一套 `color-mix`，语义其实是同一个「源码符号」，分开写只会各自漂移。
**链接语法（`.md-link-syntax`：`[`、`](`、网址、`)`）不动**：那一类里混着 URL 正文，
淡到 2:1 会让网址难读，它继续用 `--ink-3`。

#### 二、文字选区交回浏览器

撤掉全部 author `::selection` 规则（原来有五处：全局、源码面、front matter、代码块编辑层；
现在只剩 `.code-edit-input` 一条，见下），选区颜色就是浏览器默认（系统 `Highlight` + `HighlightText`）。
为什么改成默认：① 用户口径；② 默认色自带正确的文字反色，而我们自己涂半透明色时，
一旦底色接近（淡灰底 + 淡灰选中）就会看不见。

唯一保留的是 `.code-edit-input::selection`：那层 `<textarea>` 的文字是**透明**的（可见文字由
下面那层高亮元素画），所以不能让系统去「反色画文字」，只能自己给底色 —— 取系统 `Highlight`，
`color` 继续 `transparent`，观感与浏览器默认一致。

**插入符**（`caret-color`）从 `var(--accent)` 改成 `var(--ink)`：跟随正文色，不再用高亮色。

#### 三、副色改灰暴露出的两处旧问题（顺手修）

* **导出 HTML 的 `--edge-strong` 根本没定义**：`export.ts` 的独立排版 CSS 里 `:root` 少了这个令牌，
  而引用块用它做 3px 色条 —— 失效的 `var()` 在计算值阶段回退成 `currentColor`，
  于是导出的引用色条一直是**正文色**（深色）。本轮补齐令牌，导出引用条终于和编辑器一致。
* `tools/_verify-blockquote-style.js` 的 `bar-is-gray-not-accent` 原来写死了旧紫色字面量
  （`99,102,241`）—— 换了副色之后这条永远成立，等于没守。改成跟**实测的 `--accent` 计算值**比。

#### 四、验收

* 新增 `tools/_verify-neutral-accent.js`（11 条，三主题各量一遍）：N1 副色家族是灰
  （通道极差 ≤ 40 且不是紫/品红）、N2 令牌里不再出现任何历史紫色值、N3 淡底药丸在纸/壳上可辨
  （实测 1.15 / 1.23 / 1.15 与 1.15 / 1.20 / 1.14）、N4 自绘淡底对纸可辨（1.25 / 1.61 / 1.24）、
  N5 正文选区没有 author `::selection`、N5b 代码块编辑层底色是系统 `Highlight` 且文字透明、
  N6 插入符 = `--ink`（编辑器 + 源码面）、N7 链接是蓝色且与副色不同、N8 主按钮对比度 ≥ 4.5:1、
  N9 代码结构色是蓝色系且与正文灰可区分、**N10 标记符墨色 = `--marker` 且比 `--ink-3` 与副色都更淡**
  （先把光标放进加粗构造里让 `**` 真的显形，再量它的计算字色：浅色 2.28:1 / 深色 3.49:1 / 羊皮纸 2.14:1，
  对照 `--ink-3` 分别是 3.09 / 3.92 / 2.69）；**11/11**。
* 截图人工核对：`tools/_shot-theme.js` 输出三主题整窗 + 浅/深两套「真实拖拽选中」特写
  （选区是系统蓝色高亮 + 白字，工具/侧栏/引用条/表头都是灰的）；另用临时探针拍标记符特写对照改前改后
  （浅色 `**`：改前 rgb(116,123,137) → 改后 rgb(164,170,180)；深色：rgb(129,136,150) → rgb(102,108,120)）。
* 回归：`_verify-surfaces`（T 段量的是关系，令牌换了仍全绿）、`_verify-sidebar-tree-style`
  （选中态 = accent-soft + accent）、`_verify-toc-style-scroll`（目录仍是蓝色）、
  `_verify-blockquote-style`、`_verify-theme-auto`、`_verify-inline-formats`（转义反斜杠的字色换了令牌，
  显隐口径不变）等 19 套件 **0 FAIL**。

### 4.73 代码块 CodeMirror 虚拟化（F 项 / O2）：不再「每块一个实例」

**痛点（实测，见桌面《Lumin-F项实施方案-代码块CM虚拟化.md》）**：`CodeBlockView.vue` 是每个代码块一个
Vue NodeView + 一个完整的 CodeMirror `EditorView`。500 个围栏的文档打开 22.8s、常驻 1.4GB；
1500 个围栏 >185s（纯散文 572k 字符只要 2.24s ⇒ 瓶颈是**块数**不是字符数）。CPU 剖面里
`eq` 41% + StyleModule `mount` 32% 都花在「每块建一个 CM」上。

#### 一、三态模型 + 按需挂载

```
每个代码块 → A. mermaid 态（不变）｜B. 已挂载态（建 CM）｜C. 静态态（<pre class="cb-static">，不建 CM）
```

挂载条件收在一个**纯函数**里（`lib/editor/codeBlockMountPolicy.ts`）：`视口附近 ∨ 选区所在 ∨ 刚点过`。
- 视口附近 = 共享的 `IntersectionObserver`（`rootMargin: 600px`）。**观察根用默认视口**：
  IntersectionObserver 的相交矩形会被祖先裁剪，分屏下「在自己那个滚动容器里被滚出去」同样算不相交，
  所以不用给两个 pane 各建 observer（风险 R8 的对策）。
- 选区所在 = `props.editor.on('selectionUpdate')` 里判「选区是否落在本节点范围内」。这条同时解决
  「按键路由」与「用户正在打字」——正在编辑的块**永远不会**被卸掉。
- 没有 `IntersectionObserver` 的环境直接 `near = true`：宁可不省，也不能让代码块不可编辑。

#### 二、卸载顺序不能反（契约）

```
syncToNode()  →  teardownCm()  →  记高度 → 切静态态（minHeight 固定） →  unregisterCodeBlockHandle()
```
少第 1 步会丢字符（CM 里最后几个字符还没写回节点）；少最后一步会让 `findCodeBlockHandle` 命中
「没有 CM 的块」。另外 `keymap.ts` 的「代码块后空段行首 Backspace」原来**找不到句柄也 `return true`**
（按键被吃掉）—— 虚拟化之后「屏幕外的块没有句柄」是常态，已改成 `if (!handle) return false`（风险 R1）。

静态态的 `.cb-static` 在字号/字体/行高/内边距上**刻意抄 CM 的那一套**（12.5px / `--font-mono` / 1.65 /
`padding: 10px 4px 14px`），加上卸载时记下的 `minHeight`，所以挂/卸切换时高度几乎不差（实测漂移 < 1%，
滚动不跳）。行号用 CSS 计数器那一栏（`.cb-static-gutter`）跟着设置走。

离开视口附近**延迟 500ms** 才卸（来回滚一点不该反复挂/卸）；点静态块会挂上并把光标交给 CM
（事件**不** `preventDefault`，让 PM 先把光标放进块里 ⇒ 选区条件也成立）。

#### 三、实测前后对比（同一台机器、同一探针、每个状态都新建隔离 profile）

| 文档 | 改前：打开 / CM 实例 | 改后：打开 / CM 实例 |
| --- | --- | --- |
| 120 个围栏（≈7k 字符） | 1,070ms / **120** | **193ms / 4** |
| 180 个围栏（≈10.5k 字符） | 9,101ms / **180** | **184ms / 4** |

CM 实例数从「等于块数」变成「视口附近那几块」（两次都是 4），打开耗时 −82% / −98%。
`mounted` 数与块数解耦，所以**不需要**再加「单文档最大挂载数」这道闸（P3 的调参项据此关闭）。

#### 四、验收

* 新增 `tools/_verify-cb-virtualization.js`（9 条，已进默认矩阵）：60 块文档里 `.cm-editor` ≤ 12、
  视口内三块必挂、滚到第 40 块后它挂上且高度漂移 ≤ 20%、滚过去后挂载数仍小、
  **选区落进屏幕外的第 55 块必须强制挂载**、来回滚（挂/卸 churn）之后第一块仍**可打字**（守丢字符与
  `hasFocus` 守卫计数两条风险）、换文档后旧块全卸且新文档照常。
* 既有套件：`_regress-cb` 3/3、`_verify-cb-button-line-numbers` 26/26、`_verify-cb-no-active-line`、
  `_regress-layout` 9/9、`_regress-source-roundtrip` 4/4、`_repro-rapidenter` 4/4、`_verify-md-fidelity`
  101/102、`_verify-toc-style-scroll` 23/23、`_verify-surfaces` 37/37（它的「代码块走 CM 渲染」一条
  改成**接受两种形态**：远块是静态态，等宽字体仍然成立）、`_verify-cb-languages` 5/5
  （改成**逐个滚进视野再量**，否则量到的是一堆静态态 ⇒ 假失败）。
* **未做**：P2「静态态也做语法高亮」。理由：挂载边距是 600px（约两屏），静态块在正常阅读中
  基本不会出现在屏幕上（快滚时可能一闪）；要做的话用 Lezer 解析器 + `highlightTree` 生成静态 HTML，
  不为高亮再建 CM 实例。留作独立一步。
* 回滚点：把 `shouldMountCm()` 改成恒真（一行）即回到「每块一个 CM」的旧行为；
  卸载延迟是常量 `UNMOUNT_DELAY_MS`，视口边距是 `CODE_MOUNT_MARGIN_PX`。
* 顺带：`heavyMode`（≥200 围栏自动降级源码模式）**保持不变**——虚拟化之后这个阈值原则上可以放宽
  （方案 §6 提到 200 → 800），但那是一次独立的行为取舍，本轮不动。

### 4.74 草稿提示改成**独立强制弹窗**（先选「恢复 / 丢弃」才能继续编辑）

**用户口径**：取消「检测到未保存的草稿（比磁盘文件更新）」原来那条提示的样式与位置；
当当前内容与磁盘文件不一致要触发这个提示时，改成**单独弹窗**，不做出选择就无法继续编辑此文档。

#### 一、形态：从「编辑区上方的内联横幅」到「独立弹窗」

- 触发条件**完全不变**（`files.draftRestore`：打开文档时发现未保存草稿，且它比磁盘文件新；
  未命名缓冲区走另一条文案）。变的只是呈现与强制性：
  * 弹窗挂在 `EditorView.vue` 里（`<Teleport to="body">`），沿用 `ModalHost` 的对话框语言
    （半透明遮罩 + 圆角卡片 + `--shadow-2`），但**不进通知中心、也不与通知带混排**；
  * 遮罩 `@click.self` **什么都不做**（点外面不关）、Esc 也**不关** —— 必须明确点一个；
  * 打开时焦点给「恢复」（回车即恢复），Tab 只在「丢弃 / 恢复」之间循环；
  * `role="dialog"` + `aria-modal="true"` + `aria-labelledby`（标题元素带 id）。

#### 二、「不选就不能编辑」要挡住的是**所有写入途径**，不只是键盘

第一版只加了键盘闸门（捕获阶段吞 keydown），结果被自己的套件当场打红：
`Input.insertText`（CDP 的文本插入，等同 IME 组字 / 粘贴那一类）**不产生 keydown**，
照样把 `BLOCKED` 写进了文档 —— 这正是中文输入法路径上的真实漏洞。修法是三层一起上：

| 层 | 做法 | 挡住什么 |
| --- | --- | --- |
| 渲染面 | `editorStore.instance?.setEditable(false)`（DOM 变 `contenteditable=false`） | 键盘、IME、粘贴、拖放 —— 浏览器层面就拒绝 |
| 源码面 | `textarea.source-editor` 加 `:readonly` | 同上（源码模式下编辑的是它） |
| 事件层 | 捕获阶段吞掉 `keydown`（放行 Tab/回车/空格）与 `beforeinput / paste / cut / drop` | 兜底：任何漏网的写入途径 |

#### 三、验收

* `tools/_verify-draft-banner.js` **27/27**（原 25 条 + 本轮新增两条）：
  * `modal-blocks-editing-until-chosen`：弹窗开着时**真的往编辑器里打字**（先聚焦渲染面/源码面，
    再 `Input.insertText` + 一次 `keyDown`），文档内容必须一字未变（这条最初是红的，见上表）；
  * `modal-esc-does-not-close`：Esc 之后弹窗仍在。
  另把 `restore-brings-content-back` 的判据从全等改成「去掉结尾换行后相等」—— 序列化会把 markdown
  规整成结尾带换行（`# hello draft` → `# hello draft\n`），不是内容差异；本轮在恢复前多插了一段等待，
  时序一变就撞上规整后的值（假失败）。
* `_verify-new-document` 23/23（同一条 `banner` 探针换成 `.draft-modal`）、
  `_verify-notifications` 32/32、`_verify-notify-style` 22/22、`_verify-toast-tip` 21/21、
  `_verify-surfaces` 37/37、`_verify-a11y` 6/6、`_verify-i18n` 5/5、`_verify-session` 17/17、
  `_regress-layout` 9/9、`_verify-local-media` 10/10。
* 新增 i18n 键 `editor.draftTitle` / `editor.draftHint`（三语同步）；`sidebar.css` 里原来那套
  `.restore-bar` / `.draft-reveal` 样式随之删除（`.draft-modal` 只留遮罩兜底与最小高度）。

### 4.75 三处版式微调：通知操作按钮靠右 / 分屏左栏滚动条贴左 / 分隔条「抓住」动效

**用户口径**：① 通知的布局、结构与样式再优化，操作按钮放右边（原来在左边）；② 分屏时渲染面（左栏）
的滚动条也放左边；③ 分隔条的鼠标点击动效自然一点。

#### 一、通知：操作按钮从「正文下方（左）」搬到行内右侧

`.ntf-row` 从两列栅格（文本 · 信息条）扩成三列（文本 · **操作按钮** · 信息条）：按钮列 `auto`、
`justify-content: flex-end`、与标题首行同一条基线（沿用 `align-items: start` 的那条 20px 起始线 ——
所以 `_verify-notify-style` 的「信息条与标题首行对齐」仍然成立）。窄窗口允许换行，但两枚按钮仍成组靠右。
实测：内容 320–976、按钮 1000–1147、信息条 1171–1248（窗口右缘 1304 − 内衬 56 = 1248 ✓）。

#### 二、分屏：左栏滚动条贴左

`.editor-scroll` 在 `ui.editorMode === 'split'` 时加 `editor-scroll--split-left`：
容器 `direction: rtl`（Chromium 里纵向滚动条跟着书写方向走 ⇒ 贴左），**内容再 `direction: ltr` 复位**
（否则标点、数字与西文混排、列表编号的方向会跟着翻）。滚动条仍占那 6px 布局宽度，
所以两栏正文几何完全不变（实测 pane 520 / 滚动容器 520 / 内容 514），只是滚动条换了一侧：
两侧各自贴外缘，中间分界线干净。

#### 三、分隔条：按下只「加深一度」，不加宽

把手平时 3×36（`--edge-strong`）；hover 变 3×56 + `--accent`（**宽度始终 3px**，只动高度与颜色）。
**按下 / 拖拽期间宽度、高度、发光、缩放全不变**，只把颜色从 `--accent` 走到更深一档的 `--accent-ink`
（三主题各一档，见 `theme.css`）。热区仍从 11px 扩到 23px（为了好抓），但它的底是**透明**的 ——
`:active` 与 `.dragging` 都撤掉 hover 的软底，所以视觉上不会出现「点一下就变宽」。

| 状态 | 把手尺寸 | 把手颜色 | 热区 |
| --- | --- | --- | --- |
| 静止 | 3×36 | `--edge-strong` | 11px 透明 |
| hover | 3×56 | `--accent` | 11px `--accent-soft` |
| **按下 / 拖拽** | **3×56（不变）** | **`--accent-ink`（深一档）** | 23px **透明** |

实测：idle 3×36 `rgb(210,213,219)` → 按下 3×56 `rgb(55,65,81)`（= `--accent-ink`）→
拖拽中 3×56 同色、热区 23px 透明 → 松开回到 3×36。
（`:hover` 那一档在隔离窗口里量不到 —— CDP 的 `mouseMoved` 不产生真实 hover 命中，
所以 hover 只由 CSS 声明保证，按下/拖拽两档是实测的。）

#### 四、顺带修掉两条「批量跑才出现」的假失败（`_verify-surfaces`）

- **T 段主题循环**由 `sleep(900)` 改成轮询：批量跑时主题还没落地就量，令牌会落后一档
  （实测 dark 读到 light 的纸色、sepia 读到 dark 的）。稳定性判据必须**同时**包含实际表面色
  （body 与两个 pane 的计算色）—— 只等 CSS 变量不够：`body` 的 `background-color` 还有 ~300ms 过渡，
  实测读到过渡中间色 `rgb(19,21,26)` 而外壳是 `rgb(11,13,18)`，于是「body 就是外壳色」判红。
- **F2**（分屏左栏跟上且账本收敛）同样由定长 sleep 改成轮询到条件成立：批量负载下
  「右栏输入 → 序列化 → 回灌左栏 → 账本收敛」这条链 900ms 走不完（实测 `leftHas=false / stale=true`，
  单独跑 37/37）。轮询只去掉假红，不会造假绿：一直不收敛仍然判红。

验收：默认矩阵 **33/33**（`NOASSERT 0`）；`_regress-divider` 4/4、`_regress-split-live` 8/8、
`_verify-surfaces` 37/37、`_verify-link-open` 63/63（它点的是 `.ntf-action`，按钮换位置不受影响）、
`_verify-notify-style` 22/22、`_verify-notifications` 32/32、`_verify-toast-tip` 21/21、
`_regress-layout` 9/9、`_verify-segmented-control` 16/16、`_verify-cb-virtualization` 9/9。
另：单独跑时 `_verify-editor-menu` 51/51、`_verify-surface-stress` 72/72 ——
全量连跑里那两条红是**负载相关**的（stress 的「1MB 切回渲染 ≤26s」实测 38s，属机器忙/前序套件 GC 压力）。

### 4.76 表格保真：单元格里按回车不再把整张表打成 HTML（用户报障）

**用户报障**：分屏下在表格单元格「**实测痛点**」后面按一下回车，源码与渲染面**同时**变成
`<table style="min-width: 50px;">…` 一整段 HTML。这段 HTML 一旦落盘，再打开时 markdown-it
只把它当 HTML 块解析 —— **markdown 表格结构就此损坏**（不是显示问题，是数据问题）。

#### 一、根因（两处，缺一不可）

1. **编辑侧**：单元格里回车走的是 Tiptap 默认的 `splitBlock` ⇒ 单元格里多出**第二个（空的）段落**。
2. **序列化侧**：`lib/editor/tableMarkdown.ts` 的 `isSimpleTable()` 判据是
   `cell.childCount !== 1 ⇒ 复杂表格 ⇒ 退回 HTML`。于是那个空段落让**整张表**被打成 HTML。

#### 二、修法

| 侧 | 改动 |
| --- | --- |
| 序列化 | 空段落**不参与判定、也不渲染**；单元格取它**第一个有内容的段落**渲染。只有「一格里有 2 个以上**有内容**的段落」与合并单元格才退回 HTML |
| 编辑 | 单元格里回车 = **跳到下一格**（末格补一行），与表格扩展自身的 `Tab` 完全同语义 ⇒ 单元格内容一个字都不动 |

两处都踩过的坑，记在这里免得回退：

- **不能「截流不写回」**：单元格渲染是「先把这段渲染进输出缓冲取出来、转义竖线、再写回」。
  我第一版为了在多段之间插 `<br>`，改成「取出来就不写回」，结果标记符的**闭合**被推到下一次写入，
  序列化出 `\| **实测痛点**<br>** \|` —— 尾巴上一个没有内容的 `**`。
  标记符开合是状态机，`state.out` 与它必须同步，**截掉就必须立刻按原样（只转义竖线）写回**。
- **「回车插硬换行」这条也试过、退回来了**：本编辑器的标记符是**真实文本**（§4.13 的模型），
  光标停在「**实测痛点**」这种已被样式包住的文字末尾时，硬换行会被插在内容与闭合标记符**之间**，
  序列化同样得到 `\| **实测痛点**<br>** \|`（重新解析 = 两个多余的字面星号）。
  「跳到下一格」不动单元格内容，零往返风险 —— 这才是正确解。

#### 三、验收

- 新增 `tools/_verify-table-enter.js`（**9 条，已进默认矩阵**）：回车后单元格仍 1 块、
  **源码逐字节不变**（`before === after`）、无 `<table>`；末格回车补一行且仍是管道表；
  **历史上已经写成「一格两段」的文档**（用户现场已经产生的坏文档）仍写回管道表；
  合并单元格**照旧**退回 HTML（刻意钉住）。
  它进套件时先清掉待恢复的草稿、把模式切回 `wysiwyg` —— 草稿弹窗（§4.74）会拦掉所有按键，
  前序套件留下的状态会让「回车完全没生效」（实测踩过）；键注入偶发丢失时会重试并在日志里记明。
- 相邻套件：`_verify-md-fidelity` 101/102、`_verify-table-width` 25/25、`_verify-surfaces` 37/37、
  `_verify-inline-formats` 182/182、`_regress-layout` 9/9、`_verify-surface-stress` 72/72；
  默认矩阵 **34/34**。
- 顺带修掉 `_regress-layout` 的 L1 探针崩（`Cannot read properties of null (reading 'w')`）：
  它只读一次 `.cm-content` 且用 `cm !== 'null'` 比字符串哨兵（`JSON.parse('null')` 得到 `null`，
  判断恒真）⇒ 前序套件留下重文档（渲染面整体降级不挂载）时直接崩。改成**轮询**等 CM 出现。

#### 四、还没做的一步（如实记录）

**已经落盘成 HTML 的文档不会自动修回来**：markdown-it 把 `<table …>` 当 HTML 块，
应用侧没有「HTML 表格 → markdown 表格」的转换。需要的话可以单独做一步
（打开时识别 HTML 表格并转回管道表）。
