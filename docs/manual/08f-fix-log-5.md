# 附录 4.90：`Ctrl+P` 改为应用内打印预览

> 本文件是 [附录索引](./08-appendix.md) 的第 6/6 片（只收录 §4.90）。
> 线上（live）的优化台账在 [docs/optimization-waves.md](../../optimization-waves.md)。
> 相关代码：`src/main/printPreview.ts`、`src/shared/printPreview.ts`、`src/preload/printPreview.ts`；
> 端到端判据：`tools/_verify-print-preview.js`（14 条）；单测：`tests/printPreview.test.mjs`（8 条）。

---

### 4.90 `Ctrl+P` 改为应用内打印预览（为什么系统对话框说"此应用不支持打印预览"）

**用户原话**：「点击 `Ctrl+P` 打印的时候，出现的 Windows 打印窗口提示：**此应用不支持打印
预览**，可以优化使其**支持打印预览**吗。」

**真因（平台限制，不是我们写错了）**：`webContents.print()` 只弹**系统**打印对话框 ——
Chromium 那套带缩略图/缩放/页范围的**打印预览 UI 是 Chrome 浏览器的功能，Electron 里没有
这个实现**，所以 Windows 的对话框只能明说"此应用不支持打印预览"。改前链路（HEAD）：

```
useKeymap.ts 的 file.print（Mod+P）
  → useExport.runPrint()
    → IPC 'print:document'
      → main/export.ts 的 printDocument()
        → 隐藏窗口渲染导出 HTML
          → webContents.print({ silent: false })   ← 系统对话框，没有预览
```

**做法：自己做预览**（不重造排版，而是复用**导出 PDF 的那段流水**）：

1. `Ctrl+P`（与菜单「打印…」同一命令）→ 渲染层照旧构建 `ExportPayload`（当前文档 + 导出用
   CSS，与导出逐字相同，见 `lib/exportPayload.ts`）；
2. 主进程 `main/printPreview.ts` 调 **`export.buildPdfBytes()`**（本轮从 `exportPdf` 里抽出来的
   那一段：同一个隐藏窗口 `withRenderedDocument` + 同一套 `printToPDF` 页面尺寸/边距/
   **页眉页脚模板**）拿到 PDF 字节 —— **分页口径只有这一份**，预览显示的页数因此与导出的
   PDF 必然一致；
3. 写进 `<temp>/lumin-print-preview-<id>/{preview.pdf, index.html}`；
4. 开一个**专用小窗口**（`parent` = 主窗口、`sandbox: true`、`contextIsolation: true`、
   **只带专用 preload**）加载 `index.html`：顶栏是我们的（标题 + 「共 N 页」 + 打印 / 关闭），
   下面是 **Chromium 内置 PDF 查看器**渲染那份 PDF
   （`<embed type="application/pdf" src="./preview.pdf">`）。**不引 CDN、零网络请求**
   （套件用 CDP 的 Network 域钉住：只有 `index.html` 与 `preview.pdf` 两条 `file://`）；
5. 预览里点「打印」→ 走**既有**打印通路 `export.printDocument(payload, settings)`（同一个
   隐藏窗口 + `webContents.print()` → 系统对话框），结果回写到预览页的
   `data-print-preview-result` 并显示在工具栏右侧；
6. 关闭预览 / 关窗 / 退出 → 删掉那个临时目录（都在 `app.getPath('temp')` 下，绝不写工作区/
   文档目录）。

**为什么不打印"那个 PDF"本身**：Electron 里对 PDF 查看器的 webContents 调 `print()` 打的是
插件宿主页，社区长期反馈会打出空白页；而"原 HTML"这条路是本仓库已经在用、且有真实打印验收
口径的那条。

**实测踩到的两个坑（都留成守卫）**：

- `<embed type="application/pdf">` 受 **`frame-src`** 管，**不是 `object-src`**！预览页第一版
  CSP 只写了 `object-src file:`，`default-src 'none'` 兜上去 → 控制台报
  `Framing 'file:///…/preview.pdf' violates the following Content Security Policy directive:
  "default-src 'none'"` —— PDF **根本不会被取**（套件当场红，逐秒的 Network 域里
  `pdfRequested:false`）。现在那份 CSP 是 `default-src 'none'; style-src 'unsafe-inline';
  frame-src file:; object-src file:; img-src file:; base-uri 'none'; form-action 'none'`，
  单测钉住 `frame-src file:` 必须在（`tests/printPreview.test.mjs`）。
- 预览页**没有内联脚本**：交互由专用 preload（`src/preload/printPreview.ts`）接线
  （DOMContentLoaded → 两个按钮 → IPC → 把结果写回 DOM）。逻辑在能被 eslint/tsc 检查的代码里，
  而不是拼进 HTML 字符串；`electron.vite.config.ts` 的 preload 因此有了**第二个入口**。

**口径与旁路**：

- `LUMIN_PRINT_DRY_RUN=1`（**仅非打包实例**生效，与 `LUMIN_EXPORT_DIR` /
  `LUMIN_OPEN_EXTERNAL_DRY_RUN` 同一口径）：打印只记账、不弹原生对话框，返回
  `{ status:'ok', dryRun:true }` 并向主进程 stdout 写一行
  `[print] dry-run pages=N pageSize=A4 silent=false`；**发布版忽略它，永远真打印**。
- `Ctrl+P` **仍在应用 keymap 里**（`file.print` → `Mod+P`），主进程的浏览器级拦键没碰它
  （`blockedShortcut(key('p',{control:true})) === null`，单测钉住）。
- 成功/取消不再走主窗口的 toast（那两条 `toast.printDone` / `toast.printCancelled` 因此
  **删掉了**，否则语言包守卫会报死键）：结果就在预览窗口的工具栏右侧显示，用户看的就是那个窗口。

**验收**（`tools/_verify-print-preview.js`，自管实例端口 9237，**已登记进默认矩阵**，14 条）：

- **改前红**：`TOTAL 8 PASS 0 FAIL 2 SKIP 6`（预览窗口压根不出现 —— 正是用户看到的现象）；
- **改后绿**：`14/14 PASS`。要证据：Ctrl+P 后新目标出现且临时目录里真有一份 `%PDF-`（43 KB）；
  预览页有 embed + 两个按钮 + `data-print-preview-pages="4"`；预览窗口 console **零违约**、
  Network 域只有两条 `file://`；页数 **4 == 4 == 4**（页面属性 / 直接解析 PDF / **走正常导出
  路径**产出的 PDF）；点打印得 `{result:'ok', dryRun:'true'}` 且主进程日志有
  `[print] dry-run pages=4 …`；点关闭后临时目录与 PDF 都没了、窗口也没了。
- 回归：`_verify-export-quality.js` **7/7**（导出没被这次重构弄坏）。
- 截图：`tmp/print-preview-1.png`（预览窗口 + 4 页缩略图）、`tmp/print-preview-2.png`
  （点打印后的状态）、`tmp/print-preview-3-main.png`（主窗口上下文）。

**如实边界**：系统打印对话框**本身仍然没有预览缩略图**（那是 Windows/Chromium 的事）——
我们提供的是**应用内预览**：用户先在这里看到分页与版式，确认后再交给系统对话框选打印机。
另外预览的 PDF 带我们的页眉页脚模板，而 `webContents.print()` **不支持**
`headerTemplate/footerTemplate`，所以**打出来的页眉页脚由系统打印设置决定**（版式、分页、
页面尺寸、边距仍与预览一致）。
