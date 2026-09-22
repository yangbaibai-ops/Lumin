<!-- 本文件由 docs/typora-wysiwyg-manual.md 按章拆出（清单 §2.H）；索引见该文件。 -->

## 6. 工程化与质量保障

### 6.1 类型与静态检查

- 双 tsconfig：`tsconfig.node.json`（main/preload）+ `tsconfig.web.json`（renderer，vue-tsc）；
- `npm run typecheck` 进 CI；`prettier` + `eslint` 统一风格；
- 扩展装配处的类型注意点：`@tiptap/extension-table` 无默认导出（具名导入）；v3 的 InputRule 是配置对象 API（从 `@tiptap/core` 导入 `InputRule`/`textblockTypeInputRule`）。

### 6.2 测试分层

| 层 | 工具 | 覆盖 |
|---|---|---|
| 单元 | vitest（预留） | 序列化器往返、字数统计、input rule 正则 |
| 集成 | 验证脚本直连页面 | 事务/选区/标记行为 |
| E2E | CDP（`verify-tiptap.js`） | 完整用户路径 + 持久化 + 搜索 + 导出 + 主题 |

CDP 测试的三个工程约束：窗口必须真实置前（否则可信输入被丢弃）；vite 启动期全量刷新会清掉页面桥接对象（每阶段 `ensureBridge`）；断言位置用 `textBetween` 逐位扫描而不是手算偏移。

### 6.3 性能策略

- 序列化只在防抖窗口末尾执行一次（250ms），不随每次击键跑全文档；
- SQLite 写盘 500ms 防抖 + WAL（读不阻塞写）；
- 大纲/字数统计用 `descendants` 单次遍历；
- CodeMirror 实例按代码块惰性创建，mermaid 动态 `import`。

### 6.4 安全基线

- 渲染进程无 Node 权限：`contextIsolation: true`、`nodeIntegration: false`、preload 白名单桥接；
- CSP 白名单 + `lumin-file://` 协议隔离本地资源；
- 打开文件只读自己的工作区根目录。

---
