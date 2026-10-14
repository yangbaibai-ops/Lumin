# Electron 启动环境问题说明

## 问题现象

在 Node.js v24.19.0 环境下运行 `npm run dev` 时，Electron 无法启动，报错：

```
TypeError: Cannot read properties of undefined (reading 'isPackaged')
```

## 根本原因

**Node.js v24 与 Electron 39（内置 Node.js v22.22.1）的初始化时序不兼容。**

在 Node.js v24 下，`require('electron')` 返回的 `electron.app` 对象在模块求值阶段可能是 `undefined`，导致以下模块在 IIFE（立即执行函数）中访问 `app.isPackaged` 时抛出异常：

1. `@electron-toolkit/utils/dist/index.cjs:6` - 在模块顶层直接访问 `electron.app.isPackaged`
2. `src/main/devProfile.ts:27-29` - IIFE 中访问 `app.isPackaged`
3. `src/main/singleInstance.ts:44-47` - 模块顶层调用 `app.setName()` 和 `app.requestSingleInstanceLock()`
4. `src/main/index.ts:24` - 模块顶层访问 `app.isPackaged`

## 解决方案

### 方案 1：降级 Node.js 到 v22（推荐）

```powershell
# 使用 nvm-windows 切换到 Node.js 22
nvm install 22
nvm use 22

# 重新安装依赖
npm ci

# 启动开发服务器
npm run dev
```

**优点：** 彻底解决兼容性问题，与 Electron 39 内置的 Node 版本一致  
**缺点：** 需要安装 Node 版本管理工具

### 方案 2：修改所有早期 app 访问（已部分实施）

已修改的文件：
- `src/main/index.ts` - 移除 `@electron-toolkit/utils` 依赖，直接使用 `app.isPackaged`
- `src/main/devProfile.ts` - 添加 try-catch 保护
- `src/main/singleInstance.ts` - 添加安全检查

**但仍有大量文件在函数中访问 `app.isPackaged`，需要全面审查和修改。**

### 方案 3：等待 @electron-toolkit/utils 更新

跟踪 issue: https://github.com/alex8088/electron-toolkit/issues

## 当前状态

- ✅ **拖选系统代码已完成**（4 个新模块，集成到编辑器，通过类型检查）
- ✅ **图片缩放问题已修复**（mousedown 时机执行）
- ⏸️ **实际测试被环境问题阻塞**

## 拖选系统实现摘要

已创建以下模块：

1. **pointerTarget.ts** (151行) - 指针映射层，查询 widget 边界
2. **dragSelection.ts** (167行) - 拖选状态机，管理锚点、试探区间、落定
3. **dragPaint.ts** (78行) - 视觉反馈层，CSS Custom Highlight API + classList
4. **dragSystem.ts** (135行) - 集成管理器，注册 resolver、协调三层

**核心特性：**
- 拖动期零 dispatch（避免打断 Chromium 原生手势）
- 松手后落定 + 6 帧有界复验（对抗 ProseMirror 异步更新）
- 注册式 resolver 设计（图片和公式各自注册查询函数）
- 使用既有样式令牌（`--sel`、`--accent`），不硬编码颜色

## 验证清单（环境修复后）

1. **从图片/公式后往前拖选** - 应能连续选中 widget + 文字
2. **拖动期视觉反馈** - 文字浅灰底色，widget 彩色边框
3. **松手落定** - 选区准确包含所有划过的内容
4. **图片缩放按钮** - 点击 100%/75%/50%/原始 应立即生效

## 建议

**立即行动：** 安装 Node.js 22 并重新测试拖选系统。

```powershell
# 快速验证（假设已切换到 Node 22）
npm run dev

# 在编辑器中测试：
# 1. 插入图片和行内公式
# 2. 光标放在图片后，向前拖选
# 3. 检查拖动期是否有视觉反馈
# 4. 检查松手后选区是否包含图片
```

---

**文档生成时间：** 2026-10-13  
**Electron 版本：** 39.8.10  
**内置 Node 版本：** 22.22.1  
**系统 Node 版本：** 24.19.0 ⚠️
