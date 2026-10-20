# Pull Request

## 改动说明

<!-- 改了什么、为什么改。关联 issue 请写 "Closes #123"。 -->

## 测试方式

<!-- 跑了哪些命令/套件，结果分别是多少（例如 `_verify-find-replace.js` 12/12 PASS）。 -->

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run test:unit`
- [ ] `npm run ci`（含 notices / docs:facts / docs:tokens / 生产构建）
- [ ] 改了行为时，跑了对应的 CDP 套件：`node tools/run-suites.js --suite=<文件名>`

## 截图 / 录屏

<!-- 界面有变化时附前后对比；纯逻辑改动写"不涉及"。 -->

## 自查清单

- [ ] 没有提交 `node_modules/`、`dist/`、`out/`、`tmp/` 或本机路径
- [ ] 没有把真实文档内容、最近文件清单、签名证书或 `.env` 带进提交
- [ ] 行为改动有对应的单测或套件断言（没有断言的改动不算验过）
- [ ] 改了 `src/**` 的对外行为时，同步更新了 `CHANGELOG.md` 的 `[Unreleased]`
- [ ] 文本文件是 UTF-8 无 BOM（`.ps1` 除外）
- [ ] 新增/修改的文档路径真实存在，没有留下失效链接
