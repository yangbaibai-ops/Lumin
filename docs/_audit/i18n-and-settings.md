# Lumin 只读静态审计：i18n 完整性与设置项一致性

- **审计范围**：`src/shared/i18n/*.json`、`src/renderer/src/i18n/index.ts`、`src/main/menu.ts`、全部 `t()/$t()/tm()` 调用点；`src/shared/defaults.ts`、`src/shared/types.ts`、`src/renderer/src/components/SettingsDialog.vue`、`src/renderer/src/stores/settings.ts`、`src/main/ipc.ts`、`src/main/services/database.ts`。
- **方式**：只读静态分析（read / grep / glob + 只读 JSON 键集比对）。**未修改任何 `src` 代码，未执行 npm / electron，未做 git 提交。**
- **产物**：仅本文件。
- **仓库快照**：审计时的 `src` 状态（工作区含未提交改动时可能与本文件描述有偏差）。

---

## 0. 结论速览

| 维度 | 结论 |
| --- | --- |
| 三语 key 结构 | **完全一致**，各 399 条，缺失 **0 / 0 / 0** |
| 占位符一致性 | **24 个含占位符的 key，三语完全一致**，无缺失、无多余、无拼写不一致 |
| 大小写/拼写不一致的 key | **无** |
| 中文原样留在 en/ru | **0 条**（locale 文件本身翻译是干净的） |
| 死键 | **59 条**（占 399 的 14.8%） |
| **真正的 i18n 问题** | **不在 locale 文件，而在代码**：约 **60+ 处用户可见文案绕过 i18n 硬编码中文**，导致 en-US / ru-RU 下仍有大量中文界面 |
| 设置项 | 30 项中 **28 项有 UI 且有消费者**；**1 项无消费者**（`export.html.template`）；**1 项语义与实现不符**（`nativeMenuBar`） |

> **最重要的一句话**：三份语言包本身是健康的（无缺键、无漏译、占位符一致）；**缺陷集中在「有词条却不用」**——大量界面直接写死中文，同时对应词条躺在语言包里成为死键。

---

## 1. i18n 覆盖统计

### 1.1 覆盖统计表

| 语言 | key 总数 | 缺失数 | 疑似未翻译数 | 说明 |
| --- | ---: | ---: | ---: | --- |
| `zh-CN` | 399 | 0 | — | 基准语言 |
| `en-US` | 399 | 0 | 0 | 与 zh-CN 逐键比对，无「中文原样保留」的条目 |
| `ru-RU` | 399 | 0 | 0 | 同上 |

- **缺失 key 的完整清单**：三语均为**空清单**（并集 399 = 各语言 399，双向差集为空）。
- **`fallbackLocale: 'en-US'`**（`src/renderer/src/i18n/index.ts:26`）：即使未来某语言缺键，UI 也不会显示 key 本身。

### 1.2 「值完全相同」的 key（全量，共 6 条）

判定标准：三语值逐字符相同 → 高度疑似漏翻译。逐条人工复核后全部属于**本就不应翻译**，**不构成缺陷**：

| key | 值 | 是否缺陷 | 判定 |
| --- | --- | --- | --- |
| `app.name` | `Lumin` | 否 | 产品名 |
| `about.github` | `GitHub` | 否 | 品牌名 |
| `app.tagline` | `Write in Light.` | 否 | 品牌标语，zh/ru 均保留英文属有意设计 |
| `editor.resultCount` | `{current} / {total}` | 否 | 纯数字格式串 |
| `editorMenu.linkPlaceholder` | `https://example.com` | 否 | 示例 URL |
| `links.kindUrl` | `URL` | 否 | en/ru 相同、zh 不同；三语通用缩写 |

> **结论：locale 文件不存在「中文原样留在 en/ru」的漏译。** 进一步的字符集检查：`en-US` / `ru-RU` 中**没有任何一条值包含 CJK 汉字**。

### 1.3 占位符与复数一致性

含占位符的 key 共 **24 个**，三语的占位符集合**逐一比对完全一致**：

| key | 占位符 |
| --- | --- |
| `editor.cursor` | `{line}` `{col}` |
| `editor.deleteConfirmBody` | `{name}` |
| `editor.exportedTo` | `{path}` |
| `editor.resultCount` | `{current}` `{total}` |
| `editor.tableSize` | `{rows}` `{cols}` |
| `find.replaced` | `{count}` |
| `keymap.conflictWith` | `{names}` |
| `keymap.customizedCount` | `{n}` |
| `links.confirmDir` / `links.confirmFile` | `{path}` |
| `settings.autoSaveDesc` | `{sec}` |
| `settings.historyDays` | `{days}` |
| `settings.linksCount` | `{count}` |
| `sidebar.docsCount` | `{n}` |
| `sidebar.modifiedAt` | `{time}` |
| `statusbar.eolTooltip` | `{eol}` |
| `toast.eolChanged` | `{eol}` |
| `toast.exportedTo` | `{path}` |
| `toast.historyRestored` | `{time}` |
| `toast.reopenedWithEncoding` / `toast.savedWithEncoding` | `{enc}` |
| `update.availableBody` / `update.downloadedBody` | `{version}` |
| `update.errorBody` | `{message}` |

- **复数**：全库**未使用 vue-i18n 的复数管道 `|`**，也**未启用 `pluralizationRules`**。`ru-RU` 是复数形态复杂的语言（1 / 2-4 / 5+ 三套规则），`sidebar.docsCount`（`{n} 篇文章` / `{n} articles` / `Статей: {n}`）与 `keymap.customizedCount`（`已自定义 {n} 项` / `{n} customized` / `Изменено: {n}`）目前靠**改写句式**规避复数，三语都可接受。**属设计取舍，非缺陷**，但若后续加入真正的复数语义需补 `pluralizationRules`。
- **大小写/拼写不一致**：**未发现**诸如 `menu.file` vs `menu.File` 的问题；全库统一小驼峰，命名空间首层 21 个（`app` `common` `open` `sidebar` `menu` `context` `find` `editor` `settings` `links` `session` `about` `toast` `editorMenu` `notifications` `statusbar` `keymap` `encoding` `update` `history`），三语同名同序。

### 1.4 死键清单（定义但从未使用，共 59 条）

**验证方法**：全 `src`（含 `menu.ts` 的 `T('x')` 特例与 `notifications.level.${...}` 动态前缀）扫描全部字符串字面量 key 路径，与 zh-CN 键集求差；再对差集逐条反向 grep 复核，确认无 i18n 调用点（命中的均为 `settings.xxx` 属性访问、注释或 Electron 的 `app.name`）。

| 命名空间 | 数量 | 死键 |
| --- | ---: | --- |
| `about` | 6 | `back` `desc` `github` `license` `stack` `version` |
| `app` | 3 | `desc` `name` `tagline` |
| `common` | 12 | `cancel` `confirm` `delete` `done` `more` `new` `ok` `open` `rename` `search` `setting` `untitled` |
| `editor` | 10 | `continue` `exportedTo` `find` `math` `noResults` `placeholder` `replace` `replaceAll` `resultCount` `typewriter` |
| `settings` | 16 | `editorMode` `exportNote` `fontFamily` `fontMono` `fontSans` `fontSerif` `language` `languageDesc` `linksDeclinedBadge` `pdfMargin` `pdfPageSize` `reset` `sidebar` `sidebarDesc` `theme` `themeDesc` |
| `sidebar` | 7 | `clickReselect` `newFile` `newFileHint` `newFolder` `openFolderBtn` `openWorkspace` `workspace` |
| `statusbar` | 2 | `mode` `theme` |
| `toast` | 3 | `copyPath` `createFailed` `fileCreated` |
| **合计** | **59** | |

**说明**
- `notifications.level.info/success/warning/error` 曾疑似死键，经复核为**动态拼接使用**（`NotificationCenter.vue:142` 的 ``t(`notifications.level.${active.level}`)``），**不计入死键**。
- 这 59 条不是「翻译资源的浪费」这么简单：其中绝大多数**正好对应界面上写死的中文**（见第 3 节 S1/S2/S3）。即「词条已备好，代码没用」。

---

## 2. 设置项矩阵

图例：**UI** = 设置界面入口；**消费点** = 该值真正被读取并影响行为的位置；**生效** ✅ 正常 / ⚠️ 有条件或边界问题 / ❌ 不生效。

| 设置项 | UI 入口 | 默认值 | 消费点（文件:行） | 是否生效 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `theme` | 设置›外观（`SettingsDialog.vue:694-758`）；状态栏主题菜单 | `'auto'` | `stores/settings.ts:9-14,25`（`--theme-*`/`dark` class）；`main/ipc.ts:323-324`（`nativeTheme.themeSource`）；`main/menu.ts:134-156` | ✅ | `auto` 依赖 `prefers-color-scheme`，`setTheme()` 特意 await 主进程同步后再重算（`settings.ts:38-53`） |
| `language` | 设置›通用（`SettingsDialog.vue:275-288`）；状态栏语言按钮（`StatusBar.vue:304`） | `'zh-CN'` | `stores/settings.ts:30`→`i18n/index.ts:30-33`；`main/ipc.ts:327,329`（跳转列表 + 重建原生菜单）；`main/menu.ts:38-42` | ✅ | 语言切换即时重建原生菜单，无需重启 |
| `autoSave` | 设置›通用开关（`SettingsDialog.vue:302-306`）；状态栏 | `true` | `stores/files.ts:343,346` | ✅ | 关闭时 `cancelAutoSave()` 清理挂起定时器（`SettingsDialog.vue:61`） |
| `autoSaveInterval` | 设置›通用滑块（`SettingsDialog.vue:316-328`，min 1 / max 30） | `3` | `stores/files.ts:343` | ⚠️ | 只有下界 `Math.max(x,1)`，**无上界、NaN 不兜底** → 见 F13 |
| `nativeMenuBar` | 设置›通用开关（`SettingsDialog.vue:342-346`） | `true` | `App.vue:92`（`<TopMenuBar v-if>`） | ⚠️ | **名实不符**：只控制应用内自绘菜单；`app:setMenuBar` 通道全工程无调用者 → 见 F9 |
| `fontSize` | 设置›编辑器滑块（`SettingsDialog.vue:598-610`，13-26） | `17` | `stores/settings.ts:27`（`--editor-size`） | ✅ | 消费端不 clamp，仅靠 UI 约束 |
| `lineHeight` | 设置›编辑器滑块（`SettingsDialog.vue:620-633`，1.3-2.6） | `1.9` | `stores/settings.ts:28`（`--editor-lh`） | ✅ | 同上 |
| `fontFamily` | 设置›编辑器三按钮（`SettingsDialog.vue:640-656`） | `FONT_OPTIONS[0]`（Inter/sans） | `stores/settings.ts:29`（`--editor-font`） | ✅ | 选项源自 `shared/defaults.ts:5-19` |
| `editorMode` | 设置›编辑器（`SettingsDialog.vue:523-552`） | `'wysiwyg'` | `renderer/src/main.ts:46`（`ui.editorMode`） | ✅ | 运行时切换走 `composables/useEditorMode.ts` |
| `sidebarVisible` | 设置›通用（`SettingsDialog.vue:509-513`）；侧栏收起按钮 | `true` | `stores/ui.ts` / `AppSidebar.vue:54` / `App.vue:74` | ✅ | |
| `toolbarVisible`（本轮新增） | 设置›编辑器›快捷工具栏（`SettingsToolbar.vue`）；视图菜单「显示快捷工具栏」；工具栏空白区右键「关闭工具栏」 | `true` | `views/EditorView.vue`（`<Toolbar v-if>`） | ✅ | 关闭后右键菜单随栏消失，故保留菜单入口 |
| `toolbarItems`（本轮新增） | 设置›编辑器›快捷工具栏（`SettingsToolbar.vue`）；工具栏空白区右键「调整工具项」的二级勾选列表 | 目录顺序（`shared/toolbarItems.ts` 的 `DEFAULT_TOOLBAR_ITEMS`，21 项） | `components/Toolbar.vue`（`sanitizeToolbarItems` → 目录查表 → 渲染） | ✅ | **有兜底**：未知 id / 重复项在渲染前清洗；空数组 = 全部隐藏（不回退默认） |
| `sidebarWidth` | **无设置面板入口**，侧栏拖拽 | `264` | `AppSidebar.vue:24-25`（get/set，clamp 200-420） | ✅ | 读入路径不 clamp，仅写入时 clamp |
| `splitRatio` | **无设置面板入口**，分屏拖拽/双击复位 | `0.5` | `EditorView.vue:100,392`（左栏 `width`） | ⚠️ | **加载时不 clamp**，仅拖拽时 clamp → 见 F12 |
| `syncScroll` | 设置›编辑器（`SettingsDialog.vue:564-568`）；分屏浮钮（`EditorView.vue:598`） | `false` | `EditorView.vue:144` | ✅ | |
| `codeLineNumbers` | 设置›编辑器（`SettingsDialog.vue:580-584`）；代码块按钮（`ToolbarCodeBlockButton.vue:130`） | `true` | `editor/CodeBlockView.vue:357,417`（CM Compartment 即时生效） | ✅ | |
| `linkCreateMode` | 设置›链接三选一（`SettingsDialog.vue:862-876`） | `'ask'` | `lib/linkOpen.ts:203` | ✅ | |
| `restoreSession` | 设置›通用（`SettingsDialog.vue:358-363`） | `true` | `lib/session.ts:175`；`main/index.ts:422` | ✅ | 关闭后主进程走单窗口空白缓冲 |
| `defaultEncoding` | 设置›通用下拉（`SettingsDialog.vue:393-408`） | `'auto'` | `stores/files.ts:231,274`→`main/ipc.ts:182-196`→`services/encoding.ts:104` | ⚠️ | **非法值不兜底**，会强制 UTF-8 且污染每文件编码记忆 → 见 F11 |
| `defaultEol` | 设置›通用下拉（`SettingsDialog.vue:422-437`） | `'lf'` | `stores/files.ts:276`→`lib/docText.ts:17`（`isEol` 校验，非法→`lf`） | ✅ | **有兜底**，是全部设置项里处理最好的一项 |
| `historyEnabled` | 设置›通用（`SettingsDialog.vue:453-459`） | `true` | `main/services/database.ts:668,684`（`pushHistory` 早退） | ✅ | 关闭后不再新增快照，已有历史仍可读 |
| `historyLimitPerFile` | 设置›通用下拉（`SettingsDialog.vue:463-479`，选项 10/20/30/50/100） | `30`（`HISTORY_LIMIT_PER_FILE`） | `database.ts:658,661` → `shared/history.ts:73` | ✅ | **有兜底**：`Number.isFinite && >0` 才用，否则回落默认 30 → 0/负数/NaN 均安全 |
| `historyMaxAgeDays` | 设置›通用下拉（`SettingsDialog.vue:483-499`，选项 7/30/90/365） | `30`（`HISTORY_MAX_AGE_MS/86400000`） | `database.ts:659,662` → `shared/history.ts:74` | ⚠️ | 数值兜底同上有保护；但见 F14（非选项值下拉无匹配项） |
| `autoCheckUpdate` | 设置›通用（`SettingsDialog.vue:377-382`） | `false` | `main/services/updater.ts:98,126` | ✅ | 仅打包版 + 配置渠道才真联网（开发态不查） |
| `recentFiles` | 应用内源（最近文档列表，非设置面板） | `[]` | `stores/recent.ts:34-92`；`main/services/taskbar.ts:410` | ✅ | 清空会同步重建跳转列表（`ipc.ts:327`） |
| `recentFolders` | 最近文件夹列表 | `[]` | `stores/recent.ts:46,68-79` | ✅ | |
| `pinnedFiles` | 最近列表置顶 | `[]` | `stores/recent.ts:34,41,62` | ✅ | |
| `keybindings` | 设置›快捷键（`SettingsKeymap.vue`） | `{}` | `lib/keymap/service.ts`；`composables/useKeymap.ts:223` | ✅ | `null` = 明确解绑；重置用函数式 `$patch`（`settings.ts:66-82`） |
| `export.pdf.margin` | 设置›导出滑块（`SettingsDialog.vue:775-790`，8-50） | `24` | `composables/useExport.ts:37` | ✅ | |
| `export.pdf.pageSize` | 设置›导出三按钮（`SettingsDialog.vue:795-812`） | `'A4'` | `composables/useExport.ts:37` | ✅ | |
| `export.html.template` | **无 UI** | `'default'` | **不存在** | ❌ | **死设置**：全工程仅 `defaults.ts:55` 与 `types.ts:15` 声明，无任何读取 → 见 F14 |

### 2.1 「有 UI 没消费者 / 有消费者没 UI」汇总

| 类型 | 设置项 | 结论 |
| --- | --- | --- |
| **有 UI、无消费者（设了没用）** | `export.html.template` | ❌ 完全无读取点（且连 UI 也没有，双重缺失） |
| **有 UI、消费者与描述不符** | `nativeMenuBar` | ⚠️ 有消费者（`App.vue:92`），但只作用于应用内菜单，与字段名/`types.ts:24` 注释「原生菜单栏」及 IPC 通道 `app:setMenuBar` 的承诺不一致 |
| **有消费者、只能改 config/SQLite（无设置面板 UI）** | `sidebarWidth`、`splitRatio` | ⚠️ 只能靠鼠标拖拽调整，无法在设置里精确输入/复位（`splitRatio` 双击分隔条可复位，`sidebarWidth` 无复位入口） |
| **有消费者 + UI，但不 clamp** | `autoSaveInterval`、`splitRatio`、`fontSize`、`lineHeight` | ⚠️ 仅靠 UI 控件范围约束，非法持久化值会直达消费点 |

---

## 3. 缺陷清单

| 严重度 | 现象 | 证据（文件:行） | 建议修法 |
| --- | --- | --- | --- |
| **S1** | **设置面板整体硬编码中文**：切到 `en-US` / `ru-RU` 后，设置面板 90% 文案仍是中文。约 60 处，含页头标题、分节标题、开关说明、滑块标签、字体标签、预览示例、导出说明 | `SettingsDialog.vue:215`(`设置`) `:216`(`个性化你的 Lumin`) `:238`(`关于 Lumin`) `:250` `:254`(`'关闭'`) `:268`(`语言`) `:271` `:272` `:295` `:297-299` `:310` `:335` `:506` `:507` `:521` `:559` `:561` `:575` `:577` `:589` `:592` `:614` `:637` `:653` `:661` `:678` `:681-682` `:691` `:692` `:766` `:769` `:793` `:818` `:822-825` `:842-843`；数据数组 `:99-121`(主题 4 项 label+desc) `:127-129`(编辑器模式 3 项) `:136-140`(字体标签) | **把已存在的死键接上**：`settings.title` `settings.language` `settings.languageDesc` `settings.autoSave` `settings.autoSaveInterval` `settings.sidebar` `settings.sidebarDesc` `settings.editorMode` `settings.theme` `settings.themeDesc` `settings.fontSize` `settings.lineHeight` `settings.fontFamily` `settings.fontSans/Serif/Mono` `settings.pdfMargin` `settings.pdfPageSize` `settings.exportNote` `settings.syncScroll` `settings.codeLineNumbers` `common.close` `about.title`。主题/模式数组改为 `labelKey` 形式（`StatusBar.vue:88-91` 已是正确范式，可直接复用） |
| **S2** | **「关于」页整页硬编码中文**，且 `about` 命名空间 7 条中 6 条为死键 | `AboutView.vue:51-52` `:56`(`版本`) `:60`(`平台`) `:67`(`技术栈`) `:80` `:84`(`返回`)；死键 `about.version/stack/license/desc/back/github`（`zh-CN.json:293-300`） | 改用 `t('about.version')`、`t('about.stack')`、`t('about.license')`、`t('about.back')`、`t('about.desc')`；`about.title` 已被 `AppSidebar.vue:150` 使用，可参照 |
| **S2** | **全局确认/输入对话框按钮硬编码「取消」「确定」**——这是全应用所有确认框（含删除文档、清空历史、创建链接）的公共组件 | `ModalHost.vue:63,91`(`取消`) `:74,97`(`确定`)；死键 `common.cancel` `common.ok`（`zh-CN.json:8,10`） | 改为 `t('common.cancel')` / `t('common.ok')` |
| **S3** | **编辑器浮动工具条 7 个按钮 title 硬编码中文** | `TyporaEditor.vue:332`(`加粗`) `:340`(`斜体`) `:348`(`下划线`) `:356`(`删除线`) `:364`(`行内代码`) `:370`(`链接`) `:373`(`清除格式`)；已有词条 `editor.bold/italic/underline/strike/inlineCode/link` | 改用 `t('editor.*')`；「清除格式」需新增词条（三语） |
| **S3** | **全局搜索面板硬编码中文**（含计数、空态、快捷键提示、页脚索引说明） | `GlobalSearch.vue:120`(`篇索引`) `:122`(`'关闭 (Esc)'`) `:134`(`搜索中…`) `:185`(`未找到匹配内容`) `:193-194` `:217`(`SQLite FTS5 全文索引`)；已有 `common.searchPlaceholder`（`:113` 已正确使用）与 `common.loading` | 复用 `common.loading` / `common.close`；新增 `search.*` 词条（结果计数、空态、快捷键提示、索引说明）三语 |
| **S3** | **原生「打开文件」对话框过滤器名硬编码中文**：非中文用户看到的文件类型下拉是「Markdown / 所有文件」 | `main/ipc.ts:274` `{ name: '所有文件', extensions: ['*'] }` | 主进程取 `settings.language` 后查语言包（`menu.ts:38-42` 已有现成的取语言+查包范式），或新增 `dialog.allFiles` 词条三语 |
| **S3** | **未命名文档名硬编码「未命名」**：非中文用户新建文档得到的是「未命名.md」 | `stores/files.ts:194,294` `const base = '未命名'`；死键 `common.untitled`（`zh-CN.json:23`） | 改为 `i18n.global.t('common.untitled')`；注意 `useWindowTitle.ts:17-18` 已论证过未命名编号跨窗口不唯一，改名只影响展示 |
| **S3** | **`nativeMenuBar` 名实不符，`app:setMenuBar` IPC 通道成死代码**：设置项名为「原生菜单栏」、类型注释与 preload API 都承诺控制原生菜单，但渲染层**从未调用** `setMenuBar`，实际只隐藏应用内自绘 `TopMenuBar` | 声明 `types.ts:24,383`；preload `preload/index.ts:38`；主进程处理器 `main/ipc.ts:160-164`；**全工程无调用者**（`luminAPI.app.setMenuBar` 零命中）；唯一消费者 `App.vue:92` | 二选一：① 在 `SettingsDialog.vue:54` 的 `toggleMenuBar()` 里同步调用 `window.luminAPI.app.setMenuBar(v)`，让字段名与行为一致；② 若产品意图就是「应用内菜单」，把字段重命名为 `inAppMenuBar` 并修正 `types.ts:24` 注释，同时删除死 IPC 通道 |
| **S3** | **离开编辑器的未保存确认硬编码中文，且与已本地化实现重复**：同一语义存在两份实现，`lib/dialog.ts` 走 i18n，router 守卫走硬编码 | `router/index.ts:41-42`(`'有未保存的更改'` / `'当前文档有未保存的更改，确定要离开吗？'`) vs 已本地化 `lib/dialog.ts:25-26`（`editor.dirtyConfirmTitle/Body`） | router 守卫改为调用 `lib/dialog.ts` 的封装（或直接 `i18n.global.t('editor.dirtyConfirmTitle')`），消除重复实现 |
| **S3** | **非法 `defaultEncoding` 不兜底**：未知值（如 `"utf8"`、`"UTF-8"` 大小写错误、任意字符串）因 `!== 'auto'` 被当作**显式指定编码**，一律按 UTF-8 解码（`iconvName` 未知→`utf8`），且 `ipc.ts:195` 判定 `encoding !== 'auto'` 会把该非法值**记入该文件的编码记忆**，后续自动打开继续沿用 | `services/encoding.ts:104`（`if (requested !== 'auto')`）、`:58-60`（`iconvName` 未知回落 `utf8`）；`main/ipc.ts:186,195-196`；UI `SettingsDialog.vue:395` 的 `:value` 绑定非法值时下拉无匹配项（浏览器显示首项 `auto`，但 store 仍是非法值 → **显示与实际行为不一致**） | 读取处加白名单校验：`encodingOf()`（`shared/encodings.ts:53`）为 null 且非 `'auto'` 时回落 `'auto'`。建议在 `ipc.ts:182` 入口或 `stores/files.ts:231` 处统一 `sanitize`，同时修正 UI 显示 |
| **S3** | **59 条死键**（`about`×6、`app`×3、`common`×12、`editor`×10、`settings`×16、`sidebar`×7、`statusbar`×2、`toast`×3），占资源 14.8% | 完整清单见 §1.4；其中绝大多数正是 S1/S2/S3 硬编码文案「本该使用」的词条 | 优先**接线**（而非删除）：完成 S1-S3 的硬编码替换后，大部分死键会自动转正；剩余确实无需求的（如 `statusbar.mode`、`statusbar.theme`）再删除三语条目 |
| **S4** | **`splitRatio` 加载时不 clamp**：越界值（如 `2`、`-1`、`0`）被直接用于左栏宽度计算，界面布局被破坏；只有拖拽/双击复位路径才 clamp | `EditorView.vue:100`（`ref<number>(settings.splitRatio)` **未 clamp**）vs `:103-105`（`clampRatio` 0.25-0.75）与 `:114,133`（仅这两处调用） | 初始化为 `ref(clampRatio(settings.splitRatio))`（注意 `clampRatio` 需在使用前定义），或把 clamp 下沉到 `settings.ts` 的 `set()`/`init()` |
| **S4** | **`autoSaveInterval` 无上界、NaN 退化**：`Math.max(NaN, 1)` 返回 `NaN`，`setTimeout(fn, NaN)` 等效 0ms → 可能形成近乎即时的重复落盘；超大值（如 999999）则长时间不保存。仅靠 UI 滑块 1-30 约束 | `stores/files.ts:343`（`Math.max(settings.autoSaveInterval, 1) * 1000`）；UI 范围 `SettingsDialog.vue:319-320`(min 1/max 30)；`settings:update` 无校验（`main/ipc.ts:318-333`） | `const sec = Number(settings.autoSaveInterval); const delay = (Number.isFinite(sec) ? Math.min(300, Math.max(1, sec)) : 3) * 1000` |
| **S4** | **`settings:update` 全无入参校验**：`deepMerge` 任意 `Partial<AppSettings>` 后直接落库，无枚举校验、无数值 clamp。渲染层 `persist()`（`settings.ts:83-91`）每次发送**完整 state**，任何上游脏值都会被持久化 | `main/ipc.ts:318-320`；`main/store.ts:9-12`（electron-store 仅作迁移源） | 在主进程加一层 `sanitizeSettings(partial)`：校验 `theme`/`editorMode`/`language`/`linkCreateMode`/`defaultEncoding`/`defaultEol` 枚举，clamp `fontSize`/`lineHeight`/`autoSaveInterval`/`sidebarWidth`/`splitRatio`/`export.pdf.margin`。这是**唯一的权威写入点**，放这里收益最大 |
| **S4** | **`export.html.template` 是死设置**：有 schema、有默认值、无消费者、无 UI；HTML 导出实际忽略它 | `defaults.ts:55`、`types.ts:15`（仅此两处）；消费点 `useExport.ts:40-42` 未传 template | 二选一：① 实现模板选择（设置›导出加下拉 + `useExport.ts` 读取）；② 从 `AppSettings` 与 `defaults` 移除，避免「看起来可配其实无效」 |
| **S4** | **「恢复默认设置」能力缺失**：`settings` store 已有 `reset()` 动作、语言包已有 `settings.reset` 词条，但**都无入口**（`settings.reset` 属死键） | `stores/settings.ts:92-96`（`reset()` 无调用者）、`zh-CN.json:234`（`settings.reset` 死键）、`SettingsDialog.vue` 无重置按钮 | 在设置面板底部加「恢复默认设置」按钮（带 `ui.confirm` 二次确认），调用 `settings.reset()` + `t('settings.reset')` |
| **S4** | **非选项值的下拉显示失真**：`historyLimitPerFile` / `historyMaxAgeDays` 用固定选项渲染，若持久化值不在选项内（如手工改 SQLite 为 42 / 45），`<select>` 无匹配项 → 视觉上落到首项，与实际生效值不一致 | `SettingsDialog.vue:476`(选项 `HISTORY_LIMIT_CHOICES=[10,20,30,50,100]` `:17`)、`:496`(`HISTORY_AGE_CHOICES=[7,30,90,365]` `:18`)；默认值 30/30 均在选项内，正常路径不触发 | 渲染时若无匹配项则动态补一个 `<option>`（如「42（自定义）」），或把非法值在 `sanitizeSettings` 里归一到最近选项 |
| **S4** | **若干零散硬编码文案**（影响面小但同类） | `lib/editor/extensions.ts:149`（编辑器 placeholder，死键 `editor.placeholder`）；`stores/editor.ts:108`（`'（无标题）'`）；`EditorView.vue:567`(`'拖动调整左右比例（双击复位）'`) `:599`(`'同步滚动已开启（点击关闭）'`/`'开启同步滚动'`)；`AppSidebar.vue:82`(`'打开文件夹'`) `:102`(`'刷新'`)；`CodeBlockView.vue:672`(`'点击编辑源码'`)；`composables/useAppActions.ts:140`(`pendingRefactor('打字机模式')`)；`main/export.ts:195`（导出 HTML 的 `<title>目录</title>`） | 逐项接入已有词条（`editor.placeholder`、`editor.typewriter`、`sidebar.openFolderBtn`/`sidebar.refresh`、`editor.syncScroll` 需新增）；`main/export.ts` 的导出内嵌标题建议按当前语言取值 |

### 3.1 已复核、确认**不是**缺陷的项（避免误报）

| 项 | 复核结论 |
| --- | --- |
| 三语缺键 | 无（各 399，并集 399，双向差集空） |
| 占位符不一致 | 无（24 个 key 三语完全一致） |
| key 大小写/拼写不一致 | 无 |
| 中文漏译进 en/ru | 无（en/ru 无任何 CJK 字符） |
| `notifications.level.*` 疑似死键 | **误报**，`NotificationCenter.vue:142` 动态拼接使用 |
| `historyLimitPerFile` 0/负数 | **有兜底**，`database.ts:661` 的 `isFinite && >0` 判空后回落 `shared/history.ts:73` 默认 30 |
| `historyMaxAgeDays` 0/负数 | **有兜底**，同上（`:662` → `history.ts:74` 默认 30 天） |
| `defaultEol` 非法值 | **有兜底**，`lib/docText.ts:17` 的 `isEol()` 校验后回落 `'lf'` |
| `settings.language` 等「看起来在用」 | **确为死键**：命中的 38 处全是 `settings.xxx` 属性访问、注释或 Electron `app.name`，无一是 i18n 调用 |

---

## 4. 需要运行时验证清单

以下结论依赖运行时行为，静态分析无法闭环，建议在实机（打包版 + 开发态各一轮）验证：

1. **语言切换回归**：切到 `en-US` 与 `ru-RU`，逐一打开 ①设置面板全部 6 个页签 ②关于页 ③任意确认框（如删除文档/清空历史）④编辑器选中文字的浮动工具条 ⑤全局搜索面板 ⑥「打开文件」系统对话框类型下拉 ⑦新建未命名文档的标题栏名 —— 预期**当前全部仍有中文**（对应 S1/S2/S3），修复后应全部为对应语言。
2. **`nativeMenuBar` 语义确认**：关闭该开关后，按 `Alt` 是否仍能唤出原生菜单条；确认它当前只影响应用内菜单。这是判定 F9 该「补调用」还是「改命名」的产品前提。
3. **非法持久化值容错**：手工把 SQLite kv `settings` 改为
   - `defaultEncoding: "utf8"`（非法 id）→ 观察打开一个 GBK 文件是否被误解码为乱码、`documents.encoding` 是否被写成 `"utf8"`（验证 F11）；
   - `splitRatio: 2` → 观察分屏左栏宽度是否异常（验证 F12）；
   - `autoSaveInterval: 0` 与 `null` → 观察是否出现高频重复落盘（验证 F13）；
   - `historyLimitPerFile: -5` → 确认回落默认 30（预期**无异常**）。
4. **`settings:update` 校验缺口**：通过 DevTools 直接 `window.luminAPI.settings.update({ theme: 'neon', fontSize: 500 })`，确认当前会原样落库（验证 F15），并作为修复后的回归用例。
5. **下拉显示失真**：把 `historyLimitPerFile` 设为 42 后重启，观察设置面板该下拉的显示值（验证 F17）。
6. **通知级别动态 key**：三语下分别触发 info/success/warning/error 四类通知，确认 `NotificationCenter.vue:142` 的动态拼接在运行时正确解析（静态已确认 key 齐备，但未见运行证据）。
7. **导出内嵌文案**：以非中文语言导出 HTML / EPUB，确认 `main/export.ts:195` 的 `<title>目录</title>` 是否出现在产物中（验证 F18 末条）。
8. **「恢复默认」缺失确认**：确认设置面板确实无重置按钮，且 `settings.reset()` 无任何调用路径（验证 F16）。
