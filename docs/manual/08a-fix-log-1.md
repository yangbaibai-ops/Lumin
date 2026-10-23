# 附录 4.39–4.52：编码/打包/草稿语义/安装链路

> 本文件是 [附录索引](./08-appendix.md) 的第 1/5 片，
> 内容为原 `08-appendix.md` 的第 66–982 行（**逐行原样**，拆片脚本见 commit 说明）。
> 线上（live）的优化台账在 [docs/optimization-waves.md](../../optimization-waves.md)。

---

### 4.39 编码切换的两个加固：强制同步 + 构建自检（本次）

**用户反馈**：UTF-8 文档切成 GBK 成功，但再切回 UTF-8「切不回去」。

**排查结论（重要）**：在当前构建上我用四种方式复现，**全部通过、复现不出来** —— ① 直接调 `reopenWithEncoding`；② 走真实菜单两级点击；③ 两次点击间隔 <600ms 的快速切换；④ 先让编辑器 emit 过一次原文（`focus` → `blur` 触发 `flushSync`，使 `lastEmitted === 磁盘原文`）再切换。四条的编码、正文、磁盘字节都正确往返。

**但确实找到了一条「能产生完全相同症状」的代码路径**，并把它封掉了：

`src/renderer/src/components/editor/WysiwygEditor.vue` 的外部同步 watch 有两条**回声过滤**（启发式）：

1. `if (nv === lastEmitted) return` —— 「store 内容 == 我上次 emit 的文本」当成自身回声；
2. `if (performance.now() - lastEmitTime < 600) return` —— 600ms 静默窗。

两条对「显式外部替换」都不成立：**按原编码切回来时，store 里的内容恰好就是原文**（= 编辑器上次 emit 的文本）→ 规则 1 把它当回声丢掉；若上次 emit 在 600ms 内 → 规则 2 丢掉。表现就是「状态栏编码变了、正文却没回来」。实测里之所以没咬到，是因为切成 GBK 后编辑器往往又 emit 了一次乱码文本、把 `lastEmitted` 顶掉了 —— 属于时序运气，不能依赖。

**改法**：`files` store 新增 `syncEpoch`（显式外部替换计数），`reopenWithEncoding` 替换内容后 `syncEpoch++`；WysiwygEditor 把同步逻辑抽成 `applyExternalContent(nv, force)`，`force = true` 时**跳过两条过滤**、无条件 `setContent`。于是「重新解释编码」这类显式动作永远能落到编辑器上，不受任何回声启发式影响。

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

**验收**：`tools/build-app-icon.js` **14/14**（像素取样 + 三条单一来源守卫）；`_verify-taskbar-jumplist.js` 里快捷方式的 `IconLocation` 独立用 Windows COM 复核为 `<仓库根>\resources\icon.ico,0`；`npm run typecheck` 0 error。

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
const arg = argv.find((a) => a.startsWith(OPEN_FILE_PREFIX)) // --lumin-open=<encodeURIComponent(path)>
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

| 行为             | 开发态                                                              | 打包态                                                                                                        |
| ---------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 开始菜单快捷方式 | 启动时写（`ensureAppShortcut()`）                                   | **不写**，早退并记日志 `shortcut skipped (packaged; installer owns it)` —— 快捷方式归安装器所有，运行时不越权 |
| 窗口 `icon`      | 传 `runtimeIconPath()`（内容寻址副本）                              | **不传**：图标已内嵌进 `Lumin.exe`（验收 B 段就是证明），再传一次只会多一条路径依赖                           |
| 跳转列表图标     | `runtimeIconPath()`（按内容换路径，规避 Windows 按路径缓存，§4.35） | `process.execPath`（即 `Lumin.exe`，系统直接取 exe 内嵌图标）                                                 |

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

| 套件                           | 结果                                              |
| ------------------------------ | ------------------------------------------------- |
| `_verify-encoding.js`          | **34/34**                                         |
| `_verify-open-file-dedup.js`   | **21/21**                                         |
| `_verify-open-file-routing.js` | **22/22**                                         |
| `_verify-session.js`           | **16/16**（会话恢复没被 `explicitOpen` 判定改坏） |
| `_verify-taskbar-jumplist.js`  | **27/27**                                         |
| `npm run typecheck`            | 0 error                                           |

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

| 第一轮问题                                                  | 处置                          | 落点                                                                                                                                       | 复测证据                                                                                                  |
| ----------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| **中**：卸载后 `.md` 默认值残留 `Markdown`（悬空关联）      | 修                            | 新增 `build/installer.nsh`（`customUnInstall` + 自己的 `Lumin_UnassociateExtension` 宏），经 `electron-builder.yml` 的 `nsis.include` 挂载 | `.md=''`、`.markdown=''`，且扩展名下 `OpenWithProgids` 子键也删掉                                         |
| **中**：Publisher 显示 `example.com`                        | 修                            | `package.json` 的 `author` 改成真实作者（NSIS 的 Publisher 就取自这里）                                                                    | `Publisher='Lumin'`（`author.name`）                                                                      |
| 低：桌面同名快捷方式被覆盖                                  | **有意保持**                  | 不改代码                                                                                                                                   | 见下「三」                                                                                                |
| 低：判断「快捷方式未携带 AUMID」                            | **前提有误，改断言 + 留兜底** | `taskbar.ts` 的 `backfillInstalledShortcutAumid()`（幂等，正常走「已存在」分支）                                                           | 日志 `shortcut aumid already present … aumid=com.lumin.app`                                               |
| 中（开发期）：dev 与打包版共用 `%APPDATA%\Lumin` 与单实例锁 | 修（opt-in）                  | 新增 `src/main/devProfile.ts` + `npm run dev:isolated`                                                                                     | 复测全程用 `--user-data-dir` 隔离，用户数据 11027 文件/38 草稿未变                                        |
| 低：`InstallLocation` 空                                    | 修（前半）                    | `build/installer.nsh` 的 `customInstall` 写 `InstallLocation=$INSTDIR`                                                                     | `InstallLocation='…\AppData\Local\Programs\Lumin'`；`EstimatedSize` 501.4 MB 属上游估算方式，只记录不处理 |

#### 二、根因：漏的那一半在 electron-builder 自带模板里

`nsis.include` 不是「随手加一段脚本」，而是因为根因在依赖里、上游模板又不能改：

- `APP_ASSOCIATE`（`FileAssociation.nsh:65-74`）写的是三处：扩展名默认值 = FILECLASS、`OpenWithProgids` 加点、ProgID 子树；
- `APP_UNASSOCIATE`（同文件 `:99-102`）只删了**后两处** —— `OpenWithProgids` 的那个值和 ProgID 子树，**从不删扩展名的默认值**；
- 于是卸载后 `.md` 的默认值仍指着已被删除的 ProgID，Windows 只能弹「选择打开方式」。

官方给的扩展点正好够用：`customInstall` / `customUnInstall` 宏（`installSection.nsh:81`、`uninstaller.nsh:156`）。我们的宏还顺手做了幂等与「只删自己建的键」：用 `DeleteRegKey /ifempty`，别人的键一个不动。

#### 三、P3 为什么保持现状（桌面快捷方式覆盖同名文件）

`createDesktopShortcut: true` 是主流做法（VS Code / Typora / Obsidian 都是），安装向导非静默时也能取消勾选；改成 `false` 会让「装完桌面没图标」变成更常见的抱怨。真正的风险只是「静默覆盖同名文件」，而 `Lumin.lnk` 这个名字本就属于本应用。**代价**：验收脚本收尾会把桌面那条按原样重建（本轮即 `target = <仓库根>`），发布说明里要写明会在桌面创建快捷方式。

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

| 规则                                                                                                                                                       | 落点                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **只有脏文档才有草稿**：`content === savedContent` 时不写，并把盘上的旧草稿清掉（正等用户决定的横幅除外）                                                  | `stores/files.ts` 的 `writeDraft()`                                                            |
| **只有「确实不同」才打扰用户**：内容与即将显示的内容一致 → 不弹；文件草稿还要「确实比磁盘新」，并核对草稿里记的路径（键名对 `.`/`_` 会折叠，理论上会撞键） | `restorableDraft()`（`stores/files.ts`）                                                       |
| **未命名草稿按窗口（会话槽位）隔离**：`untitled-<slot>`；窗口没了留下的那份由主进程判定为「无主草稿」再交给空白缓冲区认领                                  | 新增 `src/shared/drafts.ts`（键约定，两个进程共用）+ `main/drafts.ts` 的 `takeUntitledDraft()` |

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

| 规则                                                                                 | 落点                                                                              |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| 单独关窗 → 槽位**保留**并标记 `closed`/`closedAt`（只记最后一个被关掉的）            | `services/session.ts` 的 `markSlotClosed()`，由 `index.ts` 的 `closed` 处理器调用 |
| **整体退出**（菜单退出 / 系统关机 / 崩溃）：当时活着的窗口**全部**恢复（原行为不变） | `planRestore()`：优先返回未标记 `closed` 的槽位                                   |
| **挨个关窗**：只恢复**最后关掉的那一个**；更早关掉的是用户明确关掉的，不再冒出来     | `planRestore()`：一个存活槽位都没有时，返回 `closedAt` 最新的那个                 |

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

| 谁                                 | 写的快捷方式             | 图标指向                                                  |
| ---------------------------------- | ------------------------ | --------------------------------------------------------- |
| 用户的应用（默认配置目录）         | `Lumin (dev).lnk`        | `%APPDATA%\lumin\icons\lumin-<hash>.ico`（长期存在）      |
| 验收/隔离实例（`--user-data-dir`） | `Lumin (dev) [test].lnk` | `<临时配置目录>\icons\lumin-<hash>.ico`（**跑完就被删**） |

于是：隔离实例一跑，开始菜单里就多了一条**同 AUMID**的快捷方式，而它的图标文件随临时目录一起消失
（`Lumin (dev) [test].lnk` 按字母序还排在前面）。Windows 解析用户的应用图标时命中那条 → 找不到图标文件
→ **任务栏只剩缺省图标**。实测证据（`%TEMP%\lumin-taskbar.log`，来自本轮验收实例）：

```
[taskbar] shortcut ok=true path="…\Start Menu\Programs\Lumin (dev) [test].lnk"
          aumid=com.lumin.app.dev icon="%TEMP%\lumin-guard-userdata\icons\lumin-817ce6db.ico"
```

而那条 `.lnk` 的图标文件在套件收尾删掉临时配置目录后就不存在了（`IconExists: False`）。
另外同一份日志还显示隔离实例的跳转列表重建也写进了同一个 AUMID —— 用户的右键菜单会被测试实例
的临时路径顶掉一次。

#### 二、改法：隔离实例用**独立标识**，并清掉历史残留

| 规则                                                                                                | 落点                                                    |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 开发态按配置目录分流 AUMID：默认配置目录 `com.lumin.app.dev`，隔离实例 `com.lumin.app.dev.test`     | `appId()`                                               |
| 隔离实例的图标副本改放**稳定**目录（`%TEMP%\lumin-icons`），不再随它那个跑完就删的配置目录消失      | `iconDir()` + `runtimeIconPath()`                       |
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

| 入口                             | 旧行为                                                                |
| -------------------------------- | --------------------------------------------------------------------- |
| 文件 → 新建文档 / `Ctrl+N`       | 在**当前窗口**的工作区里造一个 `未命名.md` 并打开（还先弹脏数据确认） |
| 文件 → 新建窗口 / `Ctrl+Shift+N` | 干净窗口：**不继承工作区**，空白 + 未命名文档                         |
| 侧栏空态 / 文件树的「新建文件」  | 在工作区里造文件（本次**保持不动**，那才是它们该有的语义）            |

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

| 半                               | 落点                                  | 规则                                                   |
| -------------------------------- | ------------------------------------- | ------------------------------------------------------ |
| 渲染层决定**默认目录**交给主进程 | `stores/files.ts` → `saveAs()`        | `const dir = current.path ? currentDir : root`         |
| 主进程拼成 `defaultPath`         | `main/ipc.ts` → `file:chooseSaveFile` | `dir && existsSync(dir) ? path.join(dir, name) : name` |

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

| 机制                                                                                                        | 落点                                                                   |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 每个窗口实例一个 uid（`crypto.randomUUID()`），随窗口 argv 下发（`--lumin-window-uid=`，reload 后不变）     | `index.ts` `createWindow()`                                            |
| 写草稿时盖上这个 uid（`DraftInfo.ownerUid`）                                                                | `main/ipc.ts` `drafts:save` + `main/drafts.ts` `saveDraft()`           |
| 「是我的」= **uid 相同**（同一个窗口 reload 前后）；「无主」= 写它的窗口已经不在这个进程里 / 来自上一次运行 | `main/drafts.ts` `takeUntitledDraft()`                                 |
| **只有本次运行的启动窗口**能认领无主草稿（Ctrl+N / 新建窗口是明确要空白，不打扰）                           | `index.ts` 的 `startupWindowId` + `SlotRegistry.mayClaimUntitledDraft` |
| 自己这一格留着**别人**的正文时：不弹、也**不覆盖**，先挪到停放键 `untitled-orphan` 等着被启动窗口认领       | `main/drafts.ts` `parkDraft()`                                         |

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

| 位置              | 改动                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `TopMenuBar.vue`  | 删掉顶部栏右侧的独立按钮；「文件」菜单第一项 = `menu.new`（新建，`file-plus` 图标），动作仍是 `newDocumentWindow()`      |
| i18n ×3           | `menu.new`（新建 / New / Создать）成为这一项的文案；删掉已无人引用的 `menu.newDoc`（三语同步删，键集仍完全一致：357 键） |
| `useKeymap.ts`    | 命令 `file.new`（`Ctrl+N`）的标题 key 改为 `menu.new` —— 设置 → 快捷键里显示的就是「新建」                               |
| `main/menu.ts`    | 隐藏的原生菜单那一项也跟着改叫「新建」（仍是同一个 `send('new')`）                                                       |
| 侧栏空态 / 文件树 | 仍用 `open.newDoc`（「新建文档」）—— 那是「在工作区里新建文件」，与菜单里的「新建」是两件事，保持不变                    |

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

| 项             | 改法                                                                 | 落点                                                                                  |
| -------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **写盘原子化** | 同目录临时文件 → `fsync` → `rename` 覆盖；失败清理临时文件并原样抛出 | `main/fileOps.ts` `writeFile()`                                                       |
| 失败要带原因   | IPC 错误前缀削掉后进 toast（不再只有「保存失败」）                   | 新增 `renderer/lib/errors.ts`，`stores/files.ts` 的 `save()` / `reopenWithEncoding()` |

为什么必须：原先 `fs.writeFile` 直接覆盖原文件，写入中途崩溃/断电/磁盘满会把用户唯一的一份稿件截断，
而当时连本地历史都还没有 —— 这是写作工具最不能接受的一类故障。同分区 `rename` 是原子的，
磁盘上任何时刻只可能是「完整旧版」或「完整新版」。

#### 二、门禁可用（P2）

| 项                      | 改法                                                                                                         | 实测                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `tools/**` 不进 lint    | flat config `ignores` 加 `tools/**`、`build/**`（脚手架是 CommonJS + 一次性脚本，898 个 error 把真问题淹了） | 912 → 14 errors                                  |
| 行尾不再假报            | `.prettierrc.yaml` 加 `endOfLine: auto`（工作树是 CRLF，默认 LF 校验让**每一行**都报 `Delete ␍`）            | 7260 → 0 warnings                                |
| 修掉 src 的 14 个 error | 13 个 `no-useless-escape`（正则字符类里的多余转义）+ 1 个缺返回类型                                          | —                                                |
| 格式化收口              | `prettier --write src`（41 个文件，纯格式）                                                                  | —                                                |
| **结果**                | —                                                                                                            | **`npm run lint` 0 error / 0 warning（exit 0）** |

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

| 项                      | 改法                                                                                                                                                        | 落点                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `lumin-file://` 无校验  | **两道白名单**：① 媒体扩展名（图片/音视频/PDF）；② 必须位于「当前工作区」或「某个已打开文档所在目录」之内，否则 404 并记一行日志                            | `main/index.ts` `protocol.handle` + `shared/media.ts`（纯函数）+ `fileOps.isServableMedia()` + `openDocs.listOpenDocs()` |
| 缺 `will-navigate` 兜底 | 只允许停留在自己的页面，其余拦下并交系统浏览器（与 `setWindowOpenHandler`、`shell:openExternal` 白名单同口径）                                              | `main/index.ts` `createWindow`                                                                                           |
| 搜索结果 `v-html`       | 主进程 `snippet()` 改用 U+0001/U+0002 作标记（**数据里不再夹 HTML**），渲染层按段渲染 `<em class="gs-hl">` —— **全程没有 `v-html`**，也就没有转义遗漏的机会 | `main/services/database.ts` + 新增 `renderer/lib/highlight.ts` + `GlobalSearch.vue`                                      |

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

| 门禁                                        | 结果                    |
| ------------------------------------------- | ----------------------- |
| `npm run typecheck`                         | exit 0                  |
| `npm run lint`                              | **0 error / 0 warning** |
| `npm run test:unit`                         | **57/57**               |
| `npm run ci`（本地等价 CI）                 | exit 0                  |
| `npm run build`                             | exit 0                  |
| `_verify-draft-banner.js`                   | 25/25                   |
| `_verify-new-document.js`                   | 23/23                   |
| `_verify-session.js`                        | 17/17                   |
| `_verify-session-last-closed.js`            | 8/8                     |
| `_verify-taskbar-jumplist.js`               | 31/31                   |
| `_verify-local-media.js`（本轮新增，10 条） | 10/10                   |

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

| 档           | 含义                                                             |
| ------------ | ---------------------------------------------------------------- |
| `exact`      | 磁盘字节完全没变                                                 |
| `normalized` | 经过**文档化的保义规则**规范化后完全一致：文件被重写，但语义没丢 |
| `lossy`      | 规范化后仍不一致 → 内容/结构真的变了，必须当缺陷处理             |

规范化只收「能在 CommonMark 语义上站得住脚」的改写，共 18 条（`RULES` 导出，报告可直接引用）：
行尾 LF、硬换行两种写法归一、ATX/Setext 标题、列表标记 `*`/`+`/`1)`、引用块、分割线、表格空白与分隔行、
围栏 `~~~`→` `、缩进代码 ↔ 无 info 围栏、强调标记 `__`/`_`、链接尖括号、HTML 实体、引用式链接展开、
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
   （`WysiwygEditor` 的 `flushSync`，用 window 的 `beforeunload` 同步触发，正是「关窗落盘」那条真实路径）
   → 读 `files.current.content`（= 文档文本）→ 判级比对。
   _为什么绕这一道_：Tiptap 只在 **docChanged** 时发 `onUpdate`（还有 250ms 防抖），
   而 `beforeunload` 的 flush 是同步的 —— 既确定，又不用给产品代码开后门。
2. **幂等**：把文档文本再装回去走一遍，必须**一字不差**（否则每次保存都在漂，
   git diff 全是噪声，用户会认为编辑器在改他的文件）。已知缺口内的幂等不检查。
3. **字节级**：真开真存（临时目录副本）—— 打开不改就保存必须**字节不变**
   （CRLF / UTF-8 BOM / GB18030 / 文末无换行四种），走一遍落盘管线再保存也要字节不变。
   诊断产出落 `%TEMP%\lumin-md-fidelity-report.json`（原文/产出/判级/逐行差异）。

#### 四、本轮查实并修掉的缺陷（都是「用户会丢内容」那一类）

| 现象                                                                                                           | 根因                                                                                                                                                                            | 修法（落点）                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 代码块里出现成对反引号（``let a = `x```）时，**一次编辑后整段代码并成一行**                                    | 标记模型的「源码权威重推」把 `codeBlock` 当普通段落处理（PM 里 `isTextblock` 对代码块也为真），拿代码文本再喂 markdown-it，而重推走的 DOMParser **不保留空白** → 换行全塌成空格 | `isVerbatimBlock()`（`type.spec.code === true`）把逐字块排除在归一化之外（`inlineMarks.ts`）                                                                 |
| 行内代码里的反斜杠**每保存一次多一层**（非幂等增长）                                                           | prose-mirror-markdown 只按**最内层 mark** 的 `escape:false` 决定原样输出，而 `mdStyle(code)` 正文没有这层保护；代码跨度里反斜杠不是转义字符                                     | 新增 `mdCodeLiteral` mark（空包裹 + `escape:false`），贴在代码样式正文上（`inlineMarks.ts` + `extensions.ts`）                                               |
| 软换行被写成行尾 `\`（每行都加）                                                                               | `Markdown.configure({ breaks: true })`：markdown-it 把段内单个换行渲染成 `<br>` → 解析成 hardBreak → 序列化成 `\`。语义从「软换行 ≡ 空格」变成强制换行，GitHub 渲染都不一样     | `breaks: false`；真正的「软换行可往返」需要独立节点，列为 Wave 2                                                                                                   |
| 无序列表标记被抹平（`*`/`+` → `-`），相邻两个列表被插**两个空行**，再解析并成一个**松散列表** → 每次保存都在漂 | 上游 `bulletListMarker` 固定 `-`；`renderList` 遇到同类型相邻块会 `flushClose(3)` 兜底                                                                                          | 解析时记录 `bullet`（`parse.setup` 钩子给 `<ul>` 打 `data-bullet`）→ 序列化写回原标记；标记不同时 `flushClose(1)` 只断行不插空行（`listMarkers.ts`）               |
| 任务列表**每个任务项之间都被塞空行**；`1. [ ] x` 变成「空的有序项 + 无序任务列表」                             | 任务列表复用无序列表的序列化器，而它读 `node.attrs.tight`，`tight` 只挂在 bulletList/orderedList 上 → `undefined` → 松散；`ol` 形态的任务列表没有 parse 规则                    | 给 `taskList` 补 `tight` 属性；parse 规则同时认 `ul/ol[data-type="taskList"]`（`listMarkers.ts`）                                                                  |
| 相邻图片被粘成一行；图片后紧跟的标题被吞进同一段                                                               | `Image` 是块级节点，但 tiptap-markdown 给它的是行内序列化器（不换行、不 closeBlock）                                                                                            | 自定义 Image 序列化器：沿用上游写法 + `closeBlock`（`extensions.ts`）                                                                                              |
| 内容里含 ``` 的代码块，围栏被内容提前闭合 → 后面正文被解析成代码                                               | 围栏固定写三个反引号                                                                                                                                                            | `codeFenceFor(content)`：围栏长度 ≥ 内容里最长反引号串 + 1（`shared/documentText.ts` + `codeBlock.ts`）                                                            |
| 序列化产出**不含文末换行** → 每次保存都与原文差一个字节                                                        | 上游 serializer 不补                                                                                                                                                            | 文档文本收尾规则 `withFinalNewline()`，收在 `markdownStorage.getMarkdown()`（编辑器内容 → 文档文本的**唯一出口**，否则会与外部同步比较打架、触发 setContent 回滚） |

#### 五、判级器/工具链自身踩过的坑（都已修，值得记）

- **判级器**：围栏闭合必须**不短于**开启（` ```` ` 里的 ``` 不闭合它）；`---` 既是 Setext 下划线又是分割线，
  得按「前面是不是段落文本」判（CommonMark 顺序）；`$$` 块要与多行写法归一；实体要按命名/十进制/十六进制还原
  （`&lt;` 与 `<` 才判等）；链接目标要还原百分号编码（`%E4%B8%AD` ≡ `中`）；
  相邻列表之间的空行要**在标记归一化之前**判定（归一化后 `*` 也成了 `-`，就再也分不出两个列表了）。
- **`start-isolated.ps1`**：Electron 的 `--user-data-dir` 用的是 **8.3 短路径**（`ALICE~1`），
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

| 门禁                       | 结果                                                                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`        | exit 0                                                                                                                                                            |
| `npm run lint`             | 0 error / 0 warning                                                                                                                                               |
| `npm run test:unit`        | **86/86**（57 → 86）                                                                                                                                              |
| `npm run ci`               | exit 0                                                                                                                                                            |
| `_verify-md-fidelity.js`   | **50 PASS / 0 FAIL / 20 SKIP**（30 份夹具；SKIP = `EXPECT.json` 里逐条写明修法的已知缺口）                                                                        |
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

