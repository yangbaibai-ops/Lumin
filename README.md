# Lumin — Write in Light ✨

一款基于 **Electron + Vue 3 + CodeMirror 6** 构建的跨平台桌面 Markdown 编辑器，以「所见即所得」为核心设计理念，提供媲美 Typora 的沉浸式写作体验。

## 功能特性

- **Typora 式行内所见即所得**：实时渲染界面直接编辑；点击表格直接在单元格上编辑（`Tab` 移动单元格，编辑时显示 `|` 标记）；点击公式行内编辑 LaTeX；代码块点击后在框内原地编辑（高亮层 + 透明输入层，语法颜色与框样式保持不变，`Enter`/`Tab` 行为可靠）；Mermaid 图表点击进入局部源码编辑
- **标记符显隐**：加粗 / 斜体 / 删除线 / 行内代码在光标进入或悬停时才显示 `**`、`*`、`~~`、`` ` `` 标记符，字体样式保持不变；标题在光标进入时显示 `#` 标记符，在标记符处退格可直接取消样式
- **超链接保持可点击**：链接始终渲染为链接（`Ctrl/Cmd + 点击` 在浏览器打开），普通点击只放置光标
- **块级操作（Typora 一致）**：`Enter` 在行中拆分块、在标题行末自动去标题、在段落行末插入空段落；块首 `Backspace` 合并（空块直接删除）；文档末尾虚尾块持续写作
- **极简界面**：编辑中的块无背景色与左侧色条提示，仅行内标记符与光标反馈
- **DOM ↔ Markdown 序列化往返**：编辑后自动序列化回 Markdown 源码，自动保存 / 草稿 / 导出与编辑内容始终一致
- **SQLite 持久化**：`node:sqlite`（Electron 内置，零原生依赖）+ FTS5 **trigram 分词器**（中文子串匹配）+ 短词 LIKE 回退；文档元数据与全文索引在打开/保存时自动同步（增删改查），`Ctrl+Shift+P` 全局搜索（片段高亮）
- **源码模式**：CodeMirror 6 原生编辑体验，支持查找/替换面板
- **专注模式 / 打字机模式**：居中窄栏布局、光标始终居中的沉浸写作
- **文件管理**：工作区文件树（新建/重命名/删除/右键菜单）、拖拽打开文件、最近文档（可固定）
- **自动保存与草稿恢复**：可配置间隔自动保存；意外退出后重启恢复未保存内容
- **多格式导出**：PDF / HTML / Word (.doc) / EPUB 3
- **三套主题**：浅色 / 深色 / 羊皮纸（护眼），支持跟随系统，平滑过渡
- **语法支持**：GFM 表格、任务列表、KaTeX 数学公式（行内 + 块级）、Mermaid 图表、highlight.js 代码高亮、`[TOC]` 自动目录
- **大纲导航**：标题大纲与编辑区滚动联动
- **国际化**：简体中文 / English
- **安全设计**：contextIsolation + sandbox + CSP + 受限 IPC（`ipcMain.handle` 校验工作区路径）
- **窗口隐藏健壮性**：窗口被遮挡/最小化时自动关闭过渡动画，避免路由切换死锁

## 技术栈

Electron · Vue 3 · CodeMirror 6 · Marked.js · KaTeX · Mermaid · highlight.js · Tailwind CSS v4 · Pinia · Vue Router · vue-i18n · electron-store · node:sqlite (FTS5)

## 项目结构

```
src/
├── main/          # 主进程：窗口、菜单、IPC、文件系统、导出、草稿、electron-store
│   └── services/  #   database.ts：SQLite 持久层（documents 元数据 + FTS5 全文索引）
├── preload/       # contextBridge 安全桥接（luminAPI）
├── shared/        # 主/渲染进程共享类型与默认配置
└── renderer/      # Vue 3 应用
    ├── components/  # 编辑器、侧边栏、文件树、大纲、工具栏等
    ├── views/       # 欢迎页 / 编辑器 / 设置 / 关于
    ├── stores/      # Pinia（settings / files / ui）
    ├── lib/         # Markdown 渲染管线、格式化工具、导出样式
    ├── composables/ # 全局快捷键、导出、菜单动作
    └── i18n/        # zh-CN / en-US
```

## 开发

```bash
npm install
npm run dev        # 启动开发模式
npm run typecheck  # 类型检查
npm run build:win  # 打包 Windows 安装包
```

`tools/` 目录包含应用图标生成脚本（`gen-icon.js`）与基于 CDP 的自动化冒烟测试工具（需以 `LUMIN_DEBUG_PORT=9222 npm run dev` 启动后运行）。

## 快捷键

| 功能 | 快捷键 |
| --- | --- |
| 保存 | `Ctrl/Cmd + S` |
| 新建 / 打开 | `Ctrl/Cmd + N` / `Ctrl/Cmd + O` |
| 查找替换 | `Ctrl/Cmd + F` |
| 全局搜索（全文索引） | `Ctrl/Cmd + Shift + P` |
| 导出 PDF | `Ctrl/Cmd + Shift + E` |
| 切换侧边栏 | `Ctrl/Cmd + Shift + B` |
| 专注模式 | `Ctrl/Cmd + Shift + F` |
| 打字机模式 | `Ctrl/Cmd + Shift + T` |

## License

MIT · Free & Open Source
