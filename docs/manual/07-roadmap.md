<!-- 本文件由 docs/wysiwyg-manual.md 按章拆出（清单 §2.H）；索引见该文件。 -->

## 7. 可扩展性路线图

### 7.1 自定义块的统一范式（下一步最值得做）

本项目已验证：任何新块类型 = **四件事**：

1. **schema**：`Node.create` 声明节点与 attrs；
2. **解析**：tiptap-markdown 升级（0.10+ 开放自定义 parser/serializer）或自定义 Input Rule 从文本构建节点；
3. **渲染**：`renderHTML`（简单块）或 `addNodeView`（复杂块，如公式、图表、白板）；
4. **序列化**：serializer 把节点还原为 Markdown/扩展语法。

候选：KaTeX 数学块、警告块（`:::warning`）、脚注、内嵌 PDF、双链 `[[wiki]]`。

### 7.2 协同编辑

ProseMirror 的 Step 天然可序列化——接入 `y-prosemirror`（Yjs CRDT）即可获得实时协同 + 离线合并。架构上只需把 `dispatchTransaction` 的 Step 推给 Yjs 文档，其余（schema、序列化、渲染）零改动。这是选 ProseMirror 的长线红利。

### 7.3 产品能力清单（对标 Typora/Obsidian）

- ✅ 源码模式（§3.12：纯文本 textarea + `Ctrl+/`，Typora 同款交互——整文档 CodeMirror 视图留作后续增强，NodeView 已趟平 CM 嵌入路径）；
- ✅ 分屏对比（§3.12：渲染+源码左右实时同步、拖拽比例 SQLite 持久化，IDEA 式）；
- 焦点模式 / 打字机滚动；
- 图片拖拽粘贴 + 自动入库；
- 主题市场（CSS 变量体系已具备，`--accent/--edge/…`）；
- 移动端/平板触摸选择（PM 对 touch 有基础支持，需补触摸选区菜单）；
- 导出 PDF（HTML → Electron `webContents.printToPDF`）。

### 7.4 版本升级策略

- Tiptap v3 的 PM 依赖被重新打包（位置紧凑化、装饰校验等行为差异都来自这里）——**升级 Tiptap 版本时必须重跑全部验收矩阵**；
- `tiptap-markdown` 关注 0.10+ 的自定义 parser/serializer API，是 §7.1 的前置。

---
