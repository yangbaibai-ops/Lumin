# 附录 4.91：启动变慢 —— 先量化，再优化（产物压缩 / KaTeX CSS / 先挂壳再等路由）

> 本文件是 [附录索引](./08-appendix.md) 的第 7/8 片（只收录 §4.91）。
> 线上（live）的优化台账在 [docs/optimization-waves.md](../../optimization-waves.md)。
> 测量工具：`tools/_probe-boot.js`（探针档，多轮中位数）；确定性门禁：`tests/bootBudget.test.mjs`。

---

### 4.91 启动变慢：三个数字与三项优化

**用户原话**：「现在**打开应用的速度明显变慢了**，还可以优化下吗。」

**测量方法**（新增 `tools/_probe-boot.js`，可复跑）：

- 冷启动 = 每轮**删掉 `%TEMP%\lumin-boot-ud`** 再起；热启动 = 复用同一份 profile（预热一轮不计）；
  每轮先只杀**自己**的实例（`lumin-boot-ud` / `lumin-startup-ud`），不碰别人的隔离实例与用户
  自己的 Lumin；每次取 `/json/list` 出现页面为起点做交叉校验（拿到旧页面就作废这一轮）。
- 时间线来自两处**已经存在**的打点 + 本轮补的几个：主进程 `LUMIN_STARTUP_LOG=1` 时的
  `[startup] <label> t+…ms uptime=…ms`；渲染层 `performance.mark('lumin:*')`（`performance.now()`
  是相对 navigation start 的，与主进程 uptime 是两条轴，报告里分开写）。
- **体积只能从构建产物量**：页面里的 `performance.getEntriesByType('resource')` 在本应用
  （Electron + `file://`）**恒为空数组** —— 拿它做"入口 CSS 多大"的判据会永远通过，是假绿。
  探针因此解析 `out/renderer/index.html` 引用的那份 `index-*.js/css` 并 `statSync`。
- 多轮取**中位数**，冷/热分开；`tools/_probe-boot.js --tag=<名字> --cold=3 --warm=2`。

**冷启动时间线（中位，单位 ms；渲染层 marks 相对 navigation start，主进程为 uptime）**：

| 阶段 | 起点 → 终点 | 耗时 | 谁的问题 |
| --- | --- | --- | --- |
| Electron 进程起来 → `app-ready` | uptime 0 → ~200 | **~200** | Electron 自身 + 主 bundle 求值 |
| 数据库/迁移 + 授权表 | t+20 → t+33 | ~12 | 主进程（已很小） |
| 建窗口 + 渲染进程 spawn | t+33 → t+120 | **~85** | `new BrowserWindow` 的固有成本 |
| 文档加载 → `did-finish-load` | t+120 → t+270 | **~150** | 入口 chunk 读+解析+求值 |
| 其中：渲染层 `entry-exec` | nav 0 → ~150 | **~150** | 948KB entry JS + 143KB CSS |
| `settings`（设置 IPC） | ~151 | ~2 |  |
| `/editor` 路由 chunk（2.5MB） | ~151 → ~237 | **~85** | `EditorView` chunk 解析/求值 |
| 编辑器创建 + 首次装饰 | ~237 → ~254 | ~17 | Tiptap + 三套装饰 |
| 会话/文档落地 → `doc-visible` | ~254 → ~272 | ~18 |  |
| 窗口首次可见（`first-window-painted`） | t+~485 | — | 与上面两条轴交叉 |

**最贵前三**：① `~200ms` 进程起来到 `app-ready`；② `~150ms` 入口 chunk（948KB JS + 143KB CSS）
解析/求值；③ `~85ms` `/editor` 路由 chunk（2.5MB）加载+求值。

**与历史提交对照**（`6cff645`，独立 worktree、同机同法）：
冷启动总时长 **924 vs 909ms**、`entry-exec` 159 vs 159、`decorations-first` 237 vs 235、
`shell` 255 vs 252、`doc-visible` 273 vs 271；产物**逐字同规模**（89 个 JS / 11182KB、
3 个 CSS、入口 CSS 142.9KB）。**结论：没有"某一轮买来的"回归** —— 慢是结构性的
（未压缩产物 + 2.5MB 编辑器 chunk + 143KB 渲染阻塞 CSS）。

**三项优化与前后数字**（交替 A/B，冷启动 2–3 轮中位）：

| 指标 | 改前 | 改后 | Δ |
| --- | --- | --- | --- |
| 入口 JS | 991KB | **423KB** | −57% |
| 编辑器 chunk | 2547KB | **1259KB** | −51% |
| 主进程 bundle | 334KB | **220KB** | −34% |
| 入口 CSS | 143KB（未压缩口径）→ 111KB | **87KB** | −22%（再压缩） |
| `entry-exec` | 149ms | **145ms** | −4 |
| `first-frame` | 165ms | **146ms** | −19 |
| `router-ready` | 246ms | **234ms** | −12 |
| `doc-visible`（编辑器可交互） | 272ms | **256ms** | −16 |
| 主进程 `first-window-painted` | 485ms | **457ms** | **−28** |
| `first-contentful-paint`（先挂壳那项） | 304ms | **224ms** | **−80** |
| `shell`（壳画出来那项） | 257ms | **172ms** | **−85** |

1. **产物压缩**：`electron-vite` 给 main/preload/renderer 的默认 `build.minify` 是 **`false`**
   （它的取舍：Electron 从本地加载，可读性更重要）。显式开 `'esbuild'`。
   风险核查：仓库里所有 `.name` 用法都是**数据名**（ProseMirror 节点/标记名、路由名、文件/列名），
   不依赖 JS 标识符；压缩产物上冒烟 10 条套件全绿（math/markers/export/print-preview/devtools/
   i18n/a11y/toc/cb-languages/settings-layout）。
2. **KaTeX CSS 按需**：`katex/dist/katex.min.css` 曾静态 `@import` 进渲染阻塞的入口 CSS；
   改为 `lib/editor/mathStyles.ts` 的 `import()`（编辑器 setup 预热）。探针会断言
   `.katex` 的计算 `font-family` 是 `KaTeX_Main…` 且有按需 `<link>` —— 样式被弄坏就是红的。
   代价（如实）：文件里的公式若在那份 CSS 落地**之前**完成首帧，会出现极短（本机 ~10–30ms 量级）
   的未样式化公式；预热把窗口压到最小，但不能证明为零。
3. **先挂壳、再等路由**：`app.mount()` → 等一帧（rAF）→ `await router.isReady()`。
   代价：路由未就绪时 `<RouterView>` 是空的（那一帧显示的是壳），这是刻意的 —— 用户感知的
   "应用开了"就是壳出现。

**没做（需要用户决策）**：

- **拆 `EditorView` chunk（2.5MB，压缩后 1.26MB）**：它是 `doc-visible` 里最大的一项。
  拆它要么把 Tiptap/扩展/KaTeX JS 进一步按需化（编辑器创建路径会变成异步、首次输入可能
  需要等模块落地），要么把编辑器 UI 拆成"先只读后增强"——**改动面大、回归面是整个编辑器**，
  本轮只给出测量结果，不动。
- **入口 chunk（压缩后 423KB）**：里面是 Vue 生态 + `App.vue` 的整棵组件树（侧栏/工具栏/
  状态栏都在首屏可见）+ 应用自身逻辑。要再瘦只能按"首屏可见/不可见"拆组件，收益不确定、
  风险落在首屏正确性上。
- **清系统文件缓存测"真冷盘"**：需要管理员权限，没做。压缩省下的 ~568KB + 1.29MB 在真冷盘
  上收益会明显更大（这是本轮最大的**未量化**收益）。

---

#### 4.91.1 收尾：压缩的副作用 —— `keepNames`（`TextSelection` 被压成 `Tt`）

打开压缩后 `tools/_verify-math-edit.js` 掉到 **117/119**：S2 / TB2 两条红的**行为数据完全正确**，
只有**选区类型名**不对 —— `editor.state.selection.constructor.name` 从 `TextSelection` 变成了
**`Tt`**（esbuild 默认连类名一起改）。同一颗雷在 `_verify-table-quickbar.js:125`
（`s.constructor.name`）与 `_verify-round-perf.js` / `_repro-cb-delete.js` 里也埋着。

**影响面清查结论**（这是重点）：

- **产品代码（`src/`）里没有一处依赖被压缩的标识符**。`constructor.name` / `getPrototypeOf` /
  `prototype.constructor` / `Function.toString` / `KeepAlive include` 这些写法在 `src/` 里
  一处都没有；所有 `.name` 用法都是**数据名**：ProseMirror 的 `node.type.name` / `mark.type.name`
  （字符串字面量，压缩不动）、`router` 的路由名、`e.name`（目录项）、`c.name`（SQLite 列名）、
  `err.name`（引擎给的属性值）。
- 依赖名字的**全在工具/套件**里，共 7 处（上面那 4 个文件 5 处 + 两处 `CSSFontFaceRule`：
  浏览器原生类，不受压缩影响）。

**修法：压缩 + `esbuild.keepNames: true`**（Vite 会把它转给压缩器 —— 实测生效：chunk 里出现
`__name` 助手与 `TextSelection` 字面量）。选它的理由：一次修好全部 7 处（而不是逐条改断言），
并且**日志与崩溃栈**在任何环境下可读、将来再写"按类名判断"的代码也不会踩雷。

**代价**（同窗口交替 A/B）：入口 **423 → 455KB（+7.6%）**、编辑器 chunk **1259 → 1317KB
（+4.6%）**、主进程 **220 → 227.8KB（+3.6%）**、入口 CSS 不变；相对**未压缩基线**仍是
**−54% / −48%**。备选方案（保留改名 + 把 7 处换成语义判据，例如 ProseMirror 每个 Selection
子类的 `prototype.jsonID`：`'text'`/`'node'`/`'all'`，是 PM 自己的序列化 id、压缩不动）字节更省，
但只修当下、不改将来。两条路都写在这里，便于以后按需切换。

**守卫**：`tests/bootBudget.test.mjs` 新增"压缩必须带 `keepNames`"一条（关回去就会红），
并在 `electron.vite.config.ts` 的注释里留下反面教材（`TextSelection` → `Tt`）。
