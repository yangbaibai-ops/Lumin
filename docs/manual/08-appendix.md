<!-- 本文件由 docs/wysiwyg-manual.md 按章拆出（清单 §2.H）；索引见该文件。 -->

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
   │  ├─ WysiwygEditor.vue       # useEditor + 防抖序列化（气泡菜单已于第 25 轮移除）
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
├─ run-suites.js                # CDP 套件矩阵入口（默认 58 条；--all/--tier/--suite/--probe）
├─ lib/harness.js               # 套件公共骨架（连 CDP / 注入 pinia / 输入模拟）
└─ _verify-*.js                 # 各领域验收套件（清单见 tools/README.md）
docs/wysiwyg-manual.md   # 本文档
```

### 附录 B：关键依赖（package.json 实况）

- `@tiptap/vue-3`、`@tiptap/starter-kit`、`@tiptap/extension-table`、`@tiptap/extension-task-list`、`@tiptap/extension-task-item`、`@tiptap/extension-image`、`@tiptap/extension-placeholder`、`@tiptap/extension-horizontal-rule`、`@tiptap/pm` —— 均 `^3.31.0`
- `tiptap-markdown` `^0.9.0`（remark 系双向转换）
- `@codemirror/*` 六件套 `^6`
- `katex` `^0.18.5`、`mermaid` `^11.17.2`
- `electron` `^39.2.6`、`electron-vite` `^5.0.0`、`vite` `^7.2.6`、`vue` `^3.5.25`、`pinia` `^4.0.3`、`tailwindcss` `^4.3.3`、`typescript` `^5.9.3`

### 附录 C：验收矩阵速查

| 阶段  | 覆盖                                                                                                                                                                                                                                                                                                                                                                                   |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| setup | 窗口可见、pinia 桥接、控制台零错误                                                                                                                                                                                                                                                                                                                                                     |
| A     | 15 项：打开文件 → 全格式渲染（标题/粗斜体/行内码/引用/列表/任务/表格/代码块/mermaid/无源码标记残留/大纲）                                                                                                                                                                                                                                                                              |
| B     | 10 项：Input Rules + 标记符浮现/隐藏 + 任务列表回车语义 + 往返一致                                                                                                                                                                                                                                                                                                                     |
| C     | 8 项：CodeMirror 编辑同步、围栏保持、文件保存、SQLite 落库搜索、重开渲染                                                                                                                                                                                                                                                                                                               |
| D     | 10 项：表格单元格编辑、气泡菜单可见/加粗/保持、导出、主题切换、全局搜索                                                                                                                                                                                                                                                                                                                |
| E     | 5 项：分割线回车确认（不即时转换/回车生效/`---你好` 保留与转义）、标题行首退格降级、设置 SQLite 持久化往返                                                                                                                                                                                                                                                                             |
| F     | 24 项：表格按钮默认 3×3、悬停网格选择器 2×3、单元格宽度 CSS、表格占满写作区宽度、代码块真实键入（焦点保持/同步/大纲 DOM 稳定/Enter 换行）、Markdown 粘贴（块级节点/标题标记符/粘贴内容可编辑/标题去粗）、源码模式（进入/编辑/填满高度/切回重建）、分屏对比（进入/右→左/左→右/分隔条拖拽持久化/同步滚动开关与双向滚动映射）；另有 B 阶段行内标记显隐边界断言（真实文本标记模型，§4.13） |
| G     | 3 项：构造边界打字不失粗（起点/终点打字后 `strong` 保留 + 移出折叠为纯粗体，§4.13 坑位 7）                                                                                                                                                                                                                                                                                             |
| H     | 2 项：Ctrl/Cmd+左键退化为普通光标点击（不整选段落/节点、无主题色全选框）、普通左键不受影响（§4.14）                                                                                                                                                                                                                                                                                    |
| I     | 3 项：链接普通点击原地展开（锚点消失、label/syntax 双形态、光标折叠不自动选中、md 不变）、光标移出自动折叠还原、Ctrl+点击保持链接不展开（§4.15）                                                                                                                                                                                                                                       |
| J     | 3 项：标记内回车切段后源码精确两段且首行 5 立即斜体（与刷新一致，零转义）、段首退格合并（单段 `**5**` + 粗体即时还原 + 无 `.ProseMirror-selectednode`）、合并后光标移开粗体保持（§4.13）                                                                                                                                                                                               |

运行方式：`$env:LUMIN_DEBUG_PORT='9222'; npm run dev` 后执行 `powershell -NoProfile -ExecutionPolicy Bypass -File tools/run-verify.ps1`。

---

_本手册随代码演进持续更新；任何涉及编辑器内核的改动（扩展装配、标记、输入规则、序列化桥）都必须先跑通附录 C 的验收矩阵。_


---

## 附录 D：历史记录分片索引

> 原先这一份附录有 3500+ 行，翻起来和改起来都难受（报告 §6.2 P1「文档收敛」）。
> 现在按时间与主题分片，**内容逐行原样**；本文只留参考表（附录 A/B/C）与索引。
> 开源分支只收录后段记录；更早的逐轮修复日志属于内部开发记录，未随仓库发布。

| 分片 | 覆盖小节 | 主题 |
| --- | --- | --- |
| [08b-fix-log-2.md](./08b-fix-log-2.md) | 4.53–4.64 | 元数据与历史 / 数据流账本 / 套件迁移 |
| [08d-fix-log-4.md](./08d-fix-log-4.md) | 4.74–4.85、4.88–4.89 | 草稿弹窗 / 版式与主题 / 状态栏重排 / 浏览器自带键的收口（DevTools 进「帮助」、Ctrl+R…）/ 确认提示第二轮 |
| [08e-wave-records.md](./08e-wave-records.md) | 4.86–4.87 | 两波按报告优化的交付记录 |
| [08f-fix-log-5.md](./08f-fix-log-5.md) | 4.90 | `Ctrl+P` 改为应用内打印预览（系统对话框「不支持打印预览」的绕法） |
| [08g-fix-log-6.md](./08g-fix-log-6.md) | 4.91 | 启动变慢：先量化再优化（产物压缩 / KaTeX CSS 挪出首屏 / 先挂壳再等路由） |
| [08h-fix-log-7.md](./08h-fix-log-7.md) | 4.92 | 图片标识符的排版：`vertical-align: top` → `baseline`（含一次被用户否掉的「窄盒」方案与两条 CSS 坑） |

- 打包 / 安装 / 便携的手动清单：[docs/packaging-install-test.md](../../packaging-install-test.md)
- 分发链外部输入（仓库地址 / 更新渠道 / 签名证书）：[docs/distribution.md](../../distribution.md)

