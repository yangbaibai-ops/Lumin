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

### 7.5 渲染内联 / 块级 HTML（白名单 + 安全过滤）

**状态：待办（未开工）。** 用户口径：希望本应用**像主流 Markdown 编辑器一样直接渲染 HTML**，而不是把 `<p>…</p>` 这类源码当文本显示。

**目标**：文档中的 HTML **即时渲染**，并且**不破坏**保真、撤销、光标与既有装饰层。

- **行内**：`span` / `kbd` / `br` / `sub` / `sup` / `mark` / `a` / `img`（徽章那类"链接包图片"要能正常显示）；
- **块级**：`div` / `p` / `table` / `details` / `picture` / `figure`（首期只做**只读渲染**，不做内部编辑）。

**架构（四步，缺一不可）**

1. **解析**：渲染层用 `DOMParser` 解析片段；**先清洗、再进 DOM**（绝不把未清洗的字符串交给 `innerHTML`）；
2. **白名单**：标签 / 属性 / URL 协议三张表 —— 默认拒绝 `script`、`style`、`iframe`、`object`、`embed`、`form`、`link`、`meta`，拒绝全部 `on*` 事件属性，拒绝 `javascript:`、`data:text/html`、`vbscript:`；`img src` 复用既有 `resolveImageSrc`（相对/绝对路径统一走 `lumin-file://`）；
3. **映射到 ProseMirror**：能映射的安全标签 → 原生 marks/nodes（如 `strong`/`em`/`code`/`a`）；不能映射但安全的 → 自定义只读节点（`html_inline` / `html_block`），**光标不进入节点内部**，选区落在两侧；
4. **序列化**：节点 attrs **保留原始 HTML 源串**，保存时原样写回 —— 不把 HTML 改写成 Markdown（保真优先）。

**必须处理的边界**

- **光标/选区**：HTML 块内不落光标；`Backspace`/`Delete` 整块删除；复制粘贴保留原文；
- **与既有装饰层隔离**：拼写检查、选区带、mermaid/代码块、图片点击编辑都**不得**进入或扰动 HTML 节点；沿用独立命名空间；
- **性能护栏**：单块 HTML 的元素数/字符数设上限（复用粘贴护栏阈值），超限**降级为源码文本**并提示；解析/渲染排在空闲时；
- **开关**：设置里提供「渲染 HTML」（默认开）；关闭时回退到"显示源码"（当前行为），便于排查与保守使用。

**验收（分两期）**

- **P0**：行内白名单 + 块级只读渲染；XSS 载荷**全部中和** —— `<script>`、`<img onerror>`、`<a href="javascript:">`、`<svg onload>`、`<iframe srcdoc>`、`data:text/html`、样式里的 `expression()` 与 `url(javascript:)`；不发起任何非白名单网络请求；
- **P1**：`table` / `details` / 自定义属性白名单；表格内仅允许行内白名单；
- **保真**：打开含 HTML 的文档 → 保存 → 与原文**逐字节一致**（沿用 `_verify-md-fidelity` 口径）；
- **回归**：拼写检查、选区一致、滚动不跳、代码块两态等高、防卡死不退化；新增用例覆盖 XSS 表与保真。

**工作量估算**：解析 + 只读渲染 **2–3 天**；PM 映射与光标边界 **3–5 天**；XSS 与保真测试 **2 天**。

---
