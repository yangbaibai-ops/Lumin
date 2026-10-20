# Lumin 文档索引

> 这里是仓库内所有文档的导航。**第一次使用请先读根目录的 [`README.md`](../README.md)**；
> 本目录里的多数文件面向开发者、测试者与维护者，不是用户手册。

## 用户文档

| 文档 | 说明 |
| --- | --- |
| [`../README.md`](../README.md) | 产品定位、功能、安装、快捷键、已知限制（中英双语） |
| [`screenshots/README.md`](screenshots/README.md) | 界面截图占位与投稿说明（仓库目前还没有正式截图） |

## 开发与维护文档

| 文档 | 说明 |
| --- | --- |
| [`releasing.md`](releasing.md) | 发版三步：改版本 → 构建 → 打 tag 并上传产物 |
| [`distribution.md`](distribution.md) | 分发链还缺哪些外部输入（更新渠道、签名证书），怎么接 |
| [`packaging-install-test.md`](packaging-install-test.md) | Windows 安装 / 卸载链路实测报告与复现命令 |
| [`electron-upgrade.md`](electron-upgrade.md) | Electron 39 EOL 的影响评估与升级检查清单 |
| [`design-tokens.md`](design-tokens.md) | 设计令牌表（由 `tools/doc-tokens.js` 生成，勿手改） |
| [`image-behavior.md`](image-behavior.md) | 图片行为契约（插入、缩放、相对路径、远程图） |
| [`wysiwyg-test-plan.md`](wysiwyg-test-plan.md) | 实时渲染与源码两面一致性的测试方案 |
| [`wysiwyg-manual.md`](wysiwyg-manual.md) | 技术实现手册索引（按章拆到 `manual/`） |
| [`manual/09-components.md`](manual/09-components.md) | 组件与控件清单：哪个控件必须用哪个组件 |
| [`report-coverage.md`](report-coverage.md) | 评审报告逐条覆盖表（哪些已修、哪些是外部阻塞） |
| [`_audit/`](_audit/) | 只读审计的**历史快照**，描述“当时”的状态，别当现状引用 |

工程手册各章：`manual/01-design.md` 到 `manual/09-components.md`，入口见
[`wysiwyg-manual.md`](wysiwyg-manual.md)。

## 开发日志（非用户文档）

以下文件是**开发过程记录**，不是用户文档，也不承诺与当前实现逐条对齐：

- [`optimization-waves.md`](optimization-waves.md) —— 按波次记录整改项与验收数字的台账（**开发日志**）。
- [`optimization-program.md`](optimization-program.md) —— 整改方案与排期（**开发日志**）。
- [`changelog/archive-01.md`](changelog/archive-01.md)、[`changelog/archive-02.md`](changelog/archive-02.md) ——
  已发布版本的完整变更归档（**开发日志 / 历史记录**；当前变更看根目录 `CHANGELOG.md`）。
- `manual/08*-*.md` —— 手册附录里的逐轮修复日志（属于工程手册的一部分，但同样是**过程记录**）。

> 需要“现在怎么用”请回到 [`../README.md`](../README.md)；
> 需要“现在怎么实现”请看 [`wysiwyg-manual.md`](wysiwyg-manual.md) 与各章。

## 文档维护约定

- 文档里的数字（源码规模、套件数、文档份数）由 `tools/doc-facts.js` 生成到 `tools/README.md`，
  改了代码或文档后跑 `npm run docs:facts:write`，CI 用 `npm run docs:facts:check` 对账。
- 设计令牌表同理：`npm run docs:tokens:write` / `npm run docs:tokens:check`。
- 文档里引用的仓库路径必须真实存在；`README.md`、手册与审计快照由
  `tests/docsClaims.test.mjs` 做路径存在性检查。
