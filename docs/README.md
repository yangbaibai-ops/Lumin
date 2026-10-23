# Lumin 文档索引

> 仓库：[GitHub](https://github.com/yangbaibai-ops/Lumin)（主仓库）·
> [Gitee](https://gitee.com/yangbai-bai/Lumin)（镜像）·
> [GitCode](https://gitcode.com/yangbaibai-ops/Lumin)（镜像）。Issue 请优先提交到 GitHub。
>
> 面向开源读者的文档导航。**第一次使用请先读根目录的 [`README.md`](../README.md)**（中英双语：
> 功能、安装、快捷键与截图）。
>
> 本目录只保留与**当前实现、参与方式和发布流程**有关的活文档。内部审计快照、逐轮修复日记与
> 整改台账不随开源分支发布 —— 需要"当时怎么改的"请查 `CHANGELOG.md` 与 Git 历史。

## 用户文档

| 文档 | 说明 |
| --- | --- |
| [`../README.md`](../README.md) | 产品定位、功能、安装、快捷键、平台说明（中英双语） |
| [`screenshots/README.md`](screenshots/README.md) | 界面截图的用途与投稿说明 |

## 开发文档

| 文档 | 说明 |
| --- | --- |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | 本地开发、测试与提交约定 |
| [`../CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md) | 社区行为准则 |
| [`wysiwyg-test-plan.md`](wysiwyg-test-plan.md) | 实时渲染 ⇄ 源码两面一致性的测试方案 |
| [`../tools/README.md`](../tools/README.md) | 工具链：单元测试、CDP 套件矩阵、一键门禁 |
| [`report-coverage.md`](report-coverage.md) | 评审项落地状态与外部阻塞的覆盖表 |

## 架构与实现

| 文档 | 说明 |
| --- | --- |
| [`wysiwyg-manual.md`](wysiwyg-manual.md) | 技术实现手册总索引：原理、交互、坑位、工程化 |
| [`manual/01-design.md`](manual/01-design.md) – [`manual/09-components.md`](manual/09-components.md) | 分章手册（第 1–9 章，入口见上面总索引） |
| [`manual/09-components.md`](manual/09-components.md) | 组件与控件清单：哪个控件必须用哪个组件 |
| [`design-tokens.md`](design-tokens.md) | 设计令牌表（由 `tools/doc-tokens.js` 生成，勿手改） |
| [`image-behavior.md`](image-behavior.md) | 图片行为契约（插入、缩放、相对路径、远程图） |
| [`internal/settle-single-source.md`](internal/settle-single-source.md) | 选区收尾路径与「单一真相」的架构说明 |
| [`electron-upgrade.md`](electron-upgrade.md) | Electron 39 EOL 的影响评估与升级检查清单 |

## 发布与分发

| 文档 | 说明 |
| --- | --- |
| [`releasing.md`](releasing.md) | 发版三步：改版本 → 构建 → 打 tag 并上传产物 |
| [`distribution.md`](distribution.md) | 分发链还缺哪些外部输入（更新渠道、签名证书），怎么接 |
| [`packaging-install-test.md`](packaging-install-test.md) | Windows 安装 / 卸载 / 便携链路实测报告与复现命令 |
| [`electron-upgrade.md`](electron-upgrade.md) | 升级 Electron 前的兼容性与复验清单 |

## 文档维护约定

- 文档里的数字（源码规模、套件数、文档份数）由 `tools/doc-facts.js` 生成到
  [`../tools/README.md`](../tools/README.md)，改完跑 `npm run docs:facts:write`，
  CI 用 `npm run docs:facts:check` 对账。
- 设计令牌表同理：`npm run docs:tokens:write` / `npm run docs:tokens:check`。
- 文档里引用的仓库路径必须真实存在；`tests/docsClaims.test.mjs` 会对
  `README.md`、本索引与 `docs/manual/*.md` 做路径存在性检查。
- 不要在文档里写本机绝对路径（例如 `C:\Users\<你>`）；示例一律用中性的 `C:\work\Lumin`。
