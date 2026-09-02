# Lumin — Write in Light ✨

一款基于 **Electron + Vue 3** 构建的跨平台桌面 Markdown 编辑器。编辑器内核采用 **Tiptap（ProseMirror）**，提供 Typora 式所见即所得体验：内容实时渲染，光标/选区所在处的 Markdown 语法标记（`#` / `**` / `- ` / `> ` / 表格 `|`）以浅色符号短暂浮现，移出即隐藏。

## 功能

- ✅ **所见即所得编辑**（Tiptap v3 + tiptap-markdown 双向转换）
  - 标题 / 加粗 / 斜体 / 删除线 / 下划线 / 行内代码 / 引用 / 有序与无序列表 / 任务列表 / 表格 / 图片 / 链接 / 分割线
  - 动态输入语法：`# ` 标题、`- ` 列表、`[ ] ` 任务列表
  - 光标感知语法标记：块级用 ProseMirror Decoration，行内用 DOM 类管理（本版 PM 的 Decoration 移除路径有缺陷，见 `lib/editor/markers.ts` 注释）
  - 选区浮动气泡菜单（加粗 / 斜体 / 下划线 / 删除线 / 行内代码 / 链接 / 清除格式）
- ✅ **代码块**：CodeMirror 6 NodeView 内嵌编辑、语言切换（含按需加载的语法高亮）、行号、折叠、括号闭合与补全
- ✅ **Mermaid 图表**：` ```mermaid ` 代码块自动渲染为 SVG，点击可回到源码编辑
- ✅ **大纲**：标题自动收集，编辑区滚动联动高亮，点击跳转
- ✅ **表格**：插入 / 编辑单元格 / Tab 加行（列分隔符 `|` 随光标浮现）
- ✅ **数据层**：文件系统操作（打开 / 保存 / 新建 / 重命名 / 删除 / 拖拽打开）、自动保存与草稿恢复、最近文档、SQLite 持久化（documents 元数据 CRUD + FTS5 trigram 全文索引 + `Ctrl+Shift+P` 全局搜索）
- ✅ **导出**：PDF / HTML / Word / EPUB（主进程侧实现，含 Mermaid 预渲染与 KaTeX 样式内联）
- ✅ **三主题**（亮色 / 暗色 / 羊皮纸）、中英双语、状态栏光标行列统计

## 技术栈

Electron · Vue 3 · Tailwind CSS v4 · Pinia · Vue Router · vue-i18n · electron-store · node:sqlite (FTS5) · Tiptap v3（StarterKit / Table / TaskList / Image / Underline / Placeholder）· tiptap-markdown · CodeMirror 6 · Mermaid · KaTeX

## 项目结构

```
src/
├── main/          # 主进程：窗口、菜单、IPC、文件系统、导出、草稿、electron-store
│   └── services/  #   database.ts：SQLite 持久层（documents 元数据 + FTS5 全文索引）
├── preload/       # contextBridge 安全桥接（luminAPI）
├── shared/        # 主/渲染进程共享类型与默认配置
└── renderer/      # Vue 3 应用
    ├── components/
    │   └── editor/     # TyporaEditor.vue（编辑器封装）、CodeBlockView.vue（CodeMirror/Mermaid NodeView）
    │   # 其余：侧边栏、文件树、大纲、工具栏、状态栏、全局搜索、气泡菜单
    ├── views/       # 欢迎页 / 编辑器 / 设置 / 关于
    ├── stores/      # Pinia（settings / files / ui / editor 桥接）
    ├── composables/ # 全局快捷键、菜单动作、页面可见性、导出
    ├── lib/editor/  # 扩展集组装、标记符插件、附加输入规则、Markdown 存取桥
    └── i18n/        # zh-CN / en-US
```

### 内核要点（供后续维护参考）

- `lib/editor/extensions.ts`：扩展集组装；StarterKit 关闭内建 codeBlock（由 CodeMirror NodeView 接管）
- `lib/editor/markers.ts`：光标感知标记符。块级（标题/引用/列表项）用 Decoration.node（本版 prosemirror-view 的 Decoration 坐标为相对 doc.content 的 0 基坐标，且 `DecorationSet.create` 以 `content.findIndex` 校验）；行内样式用 PluginView.update 直接在样式元素上增删 `md-reveal-inline` 类（本版 PM 移除行内 Decoration 时会遗留孤儿 span）
- `lib/editor/inputRules.ts`：任务列表 `[ ] ` 输入规则。本版 prosemirror 的局部替换原语（deleteRange/delete/replaceWith/replaceRange/ReplaceAroundStep）对列表类型转换均会做边界拟合或深度校验而失效，因此采用“重建顶层内容 + 整文档范围 ReplaceStep”的可靠路径；位置为紧凑偏移（顶层子节点间无 +1 间隙）
- `CodeBlockView.vue`：CM 的 contentDOM 默认无 tabindex（点击无法聚焦），创建后需显式 `cmView.contentDOM.tabIndex = 0`，并在容器上 `@mousedown.stop` 阻止 PM 抢焦点

## 开发

```bash
npm install
npm run dev        # 启动开发模式
npm run typecheck  # 类型检查
npm run build      # 生产构建
npm run build:win  # 打包 Windows 安装包
```

`tools/` 目录包含应用图标生成（`gen-icon.js`）、CDP 页面求值工具（`cdp-eval.js`）、工作区切换（`switch-ws.js`）、SQLite 检查（`db-inspect.js`）等脚本，以及基于 CDP 的内核验收矩阵：

```bash
# 1. 以调试端口启动应用
LUMIN_DEBUG_PORT=9222 npm run dev
# 2. 前台化窗口并运行 45 项验收（渲染 / 输入规则 / 标记符 / CodeMirror / SQLite / 导出）
powershell -NoProfile -ExecutionPolicy Bypass -File tools/run-verify.ps1
```

## License

MIT · Free & Open Source
