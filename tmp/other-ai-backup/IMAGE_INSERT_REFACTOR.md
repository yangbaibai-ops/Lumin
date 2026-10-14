# 图片插入功能重构文档

## 概述

本次重构将 Lumin 的图片插入功能改造为像 Typora 一样的现代化、用户友好的体验。主要改进包括：

## 核心改进

### 1. 统一的图片插入对话框

**之前的问题：**
- 点击图片按钮后需要在"本地文件"和"URL"之间二选一，增加操作步骤
- 没有拖拽上传功能
- 没有批量选择
- 没有图片预览
- 剪贴板粘贴功能不够直观

**改进后：**
- 一个完整的对话框集成所有功能
- 三个标签页：本地文件、URL、剪贴板
- 拖拽上传支持（拖到对话框即可）
- 批量选择多张图片
- 实时预览缩略图
- URL 历史记录（最多 10 条）

### 2. 新建的文件

#### `src/renderer/src/components/ImageInsertDialog.vue`
现代化的图片插入对话框组件，包含：
- 拖拽上传区域（带视觉反馈）
- 文件选择器（支持多选）
- 图片预览列表（显示文件名、大小、缩略图）
- URL 输入框（带验证）
- URL 历史记录
- 剪贴板粘贴按钮
- Ctrl+Enter 快捷插入
- 完整的错误提示

#### 更新的文件

**类型定义：**
- `src/shared/types.ts`: 添加 `imageUrlHistory` 字段到 `AppSettings`
- `src/shared/defaults.ts`: 设置默认值 `imageUrlHistory: []`
- `src/renderer/src/stores/ui.ts`: 添加 `ImageDialogState` 和相关 actions

**语言包（三语）：**
- `src/shared/i18n/zh-CN.json`
- `src/shared/i18n/en-US.json`
- `src/shared/i18n/ru-RU.json`

新增的文本键：
- `imageDialogTitle`: 对话框标题
- `imageDragHint`: 拖拽提示
- `imageFormatHint`: 格式提示
- `imageSelectFiles`: 选择按钮
- `imageSelectedCount`: 已选数量
- `imageClearAll`: 清空按钮
- `imageUrlInput`: URL 输入标签
- `imageUrlPlaceholder`: URL 占位符
- `imageUrlHistory`: 历史记录标题
- `imageClipboardHint`: 剪贴板提示
- `imagePasteFromClipboard`: 粘贴按钮
- `imageInsertHint`: 快捷键提示
- `imageInsertButton`: 插入按钮
- `imageInserting`: 插入中提示
- `imageFromClipboard`: 剪贴板标签页
- `imageInvalidFormat`: 格式错误提示
- `imageInvalidUrl`: URL 错误提示
- `imageNoClipboard`: 剪贴板为空提示
- `imageClipboardFailed`: 剪贴板读取失败

**组件更新：**
- `src/renderer/src/components/Toolbar.vue`: 简化图片按钮，直接打开新对话框
- `src/renderer/src/App.vue`: 注册 `ImageInsertDialog` 组件（异步加载）

## UI/UX 设计亮点

### 视觉设计
- 现代化的对话框样式（圆角、阴影、模糊背景）
- 清晰的标签页切换（带下划线指示器）
- 拖拽区域的视觉反馈（蓝色边框和背景变化）
- 图片预览卡片（缩略图、文件名、大小）
- 响应式布局（最大高度 85vh，内容区域可滚动）

### 交互设计
- 支持拖拽文件到对话框
- 支持点击选择（单选/多选）
- URL 输入实时验证
- 历史记录一键选择
- 剪贴板粘贴按钮
- Ctrl+Enter 快速插入
- Esc 关闭对话框
- 点击遮罩关闭对话框

### 错误处理
- 格式验证（只接受图片文件）
- URL 格式验证（http/https/data:image）
- 剪贴板读取失败提示
- 插入失败详细错误信息

## 技术实现细节

### 1. 状态管理
```typescript
// UI Store 新增
interface ImageDialogState {
  insert: InsertImageSrc  // 插入回调
  resolve: () => void     // 关闭回调
}
```

### 2. 图片预览
使用 `FileReader.readAsDataURL()` 生成预览：
```typescript
function createImagePreview(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => resolve(e.target.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}
```

### 3. URL 历史记录
- 存储在 Settings Store 中
- 最多保留 10 条
- 自动去重
- 最近使用的排在前面

### 4. 批量插入
循环插入所有选中的图片：
```typescript
for (const img of images.value) {
  if (img.file) {
    const path = getPathForFile(img.file)
    if (path) {
      await insertImageFromPath(insertCallback, path, img.file.name)
    } else {
      const bytes = new Uint8Array(await img.file.arrayBuffer())
      await insertImageFromBytes(insertCallback, bytes, img.name)
    }
  }
}
```

### 5. 剪贴板集成
使用 Clipboard API 读取图片：
```typescript
async function pasteFromClipboard(): Promise<void> {
  const items = await navigator.clipboard.read()
  for (const item of items) {
    const imageType = item.types.find((type) => type.startsWith('image/'))
    if (imageType) {
      const blob = await item.getType(imageType)
      const file = new File([blob], 'clipboard.png', { type: imageType })
      await processFiles([file])
      return
    }
  }
}
```

## 代码规范

- ✅ 无硬编码文本（全部使用 i18n）
- ✅ TypeScript 类型完整
- ✅ 组件化设计（复用 Icon 组件）
- ✅ 响应式状态管理（Vue 3 Composition API）
- ✅ 异步加载（按需加载，不影响首屏）
- ✅ 错误处理完善
- ✅ 无障碍支持（aria-label）
- ✅ 键盘快捷键（Enter、Esc、Ctrl+Enter）

## 与现有功能的兼容性

### 保留原有功能
- ✅ 粘贴图片到编辑器（imagePaste.ts）
- ✅ 拖拽图片到编辑器（imagePaste.ts）
- ✅ 图片资源管理（imageAsset.ts）
- ✅ 相对路径解析（imageSrc.ts）
- ✅ 工作区 assets 目录

### 增强的功能
- 工具栏图片按钮现在打开完整对话框
- 对话框内也可以拖拽和粘贴
- 支持批量选择和插入

## 测试建议

### 功能测试
1. 点击工具栏图片按钮，验证对话框打开
2. 拖拽单张/多张图片到对话框
3. 点击选择按钮，选择单张/多张图片
4. 查看图片预览是否正确
5. 删除单张图片，清空所有图片
6. 输入有效/无效的 URL
7. 从 URL 历史记录选择
8. 粘贴图片从剪贴板
9. Ctrl+Enter 快速插入
10. Esc 关闭对话框
11. 验证图片是否正确插入到编辑器

### 边界测试
1. 无工作区时插入图片（应提示先保存）
2. 拖拽非图片文件（应提示格式错误）
3. 输入无效 URL（应显示错误）
4. 剪贴板为空时粘贴（应提示无图片）
5. 批量插入大量图片（应正常处理）

### 性能测试
1. 选择大量图片（测试预览生成）
2. 插入大量图片（测试批量处理）
3. 对话框打开/关闭速度

## 后续改进方向

### 可选增强
1. **图片编辑功能**
   - 裁剪、旋转
   - 调整大小
   - 滤镜效果

2. **更多设置选项**
   - 默认对齐方式
   - 默认宽度
   - 图片质量压缩

3. **拖拽排序**
   - 在预览列表中拖拽调整顺序

4. **进度显示**
   - 大文件上传进度条
   - 批量插入进度

5. **图片库**
   - 显示工作区中已有的图片
   - 快速插入之前用过的图片

## 总结

本次重构将图片插入功能从基础的"选择文件"升级为完整的图片管理对话框，大幅提升了用户体验：

- ⚡ **更快**：拖拽即可上传，无需多次点击
- 🎨 **更美**：现代化UI设计，视觉反馈清晰
- 🛠️ **更强**：批量选择、预览、历史记录
- 🌐 **更全**：支持本地文件、URL、剪贴板三种来源
- 🔐 **更稳**：完整的错误处理和验证

与 Typora 的图片插入体验相比，我们提供了：
- ✅ 同样流畅的拖拽上传
- ✅ 同样直观的界面设计
- ✅ 更多的功能（批量选择、URL历史）
- ✅ 更好的错误提示

这是一个符合现代编辑器标准的图片插入功能。
