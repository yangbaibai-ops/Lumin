# 图片行为契约（`docs/image-behavior.md`）

> 本文是**图片这条线**的行为契约：每一条都写清「**怎么做 / 为什么 / 踩过什么坑**」。
> 实现分布在 `src/renderer/src/lib/editor/imageToolbar.ts`（渲染 + 事件 + 状态）、
> `imageReveal.ts`（**纯判据**，可单测）、`imagePicker.ts`（空槽选图按钮）、
> `assets/markdown.css`（我名下的图片规则）、`extensions.ts`（图片节点渲染 + 远程占位）。
> 行为契约的**可执行版本**是 `tools/_verify-image-ui.js`（85 条断言）。

---

## 1. 数据模型：图片在文档里的三种形态

| 形态 | Markdown | 文档里的节点 | 说明 |
|---|---|---|---|
| 节点 | `![alt](url)` | Tiptap `image` 节点（`inline: true`） | 标准写法；`inline` 才能出现在段落中间、或被链接包住 |
| 原文文本 | `<img src="…" style="zoom:50%;" />` | `MdHtml` mark（`escape: false`）+ 文本 | **原文即正文**：字符串逐字节保留，缩放只改 `style` |
| 空槽 | `![]()` | 同上（空 `src` 的原文文本） | 只画一个**渲染层**选图按钮；文档里仍是 `![]()` |

**为什么"源码即正文"**：早期把源码做成**浮层**（绝对定位的小窗）被用户否掉 ——
「完全是在图片顶部出了个悬浮窗而已，一点也不实用」。现在标识符**就是文档里那段文本**：
能点入、能拖选、能复制、能编辑，只是**未激活时隐藏**。

**三种形态的统一判据**：`collectImgSources(state)` 一次扫出所有"图片源码"（节点 + 原文文本 +
`htmlBlock` 原子），统一成 `ImgSource { kind: 'node' | 'raw', from, to, src, alt, zoom, markdown }`。
所有后续逻辑只认 `ImgSource`，不再各自判断 DOM。

---

## 2. 渲染

### 2.1 行内 vs 独占一行
判据是纯函数 `imgIsInline(state, img)`：看**这一段里除了它自己**还有没有别的内容
（文本节点里"它自己的源码文本"不算，**别的图片算**）。

* 段落里只有这一张图 ⇒ **块级**：整段居中（`.img-block-center`），图片 `display:block; margin-inline:auto`。
* 段落里还有文字 / 别的图片 ⇒ **行内**：图片随文字流动、**不折行**（`vertical-align: middle`），
  段落在装饰阶段被挂 `.img-inline-mode`。

> ⚠️ **坑（第七十轮首帧对齐 bug）**：`:only-child` **只数元素子节点** —— `前文 ![]() 后文`
> 里图片是唯一**元素**子节点，于是被误判成"这一段只有一张图"，图片被设成 block + auto 外边距，
> 文字跑到图片上方，看起来"文字与图片最上方对齐"。修法：判据用 `imgIsInline()`，并在**装饰
> 构建阶段**（首帧就会跑）给行内段落挂 `.img-inline-mode`，不依赖任何后续 update/dispatch。

### 2.2 相邻并排 + 间隙
`![](a)![](b)`（紧邻无分隔）必须**同行并排**、不折行、不各自居中：
* `.md-preview p > img:not(:only-child)` ⇒ `display:inline-block; vertical-align:top`；
* 间隙只在**两张图之间**：`.md-preview p > img:not(:only-child) + img:not(:only-child)` 与
  `.md-preview p > .img-widget ~ .img-widget` ⇒ `margin-inline-start: 0.6em`（相对单位；仓库无通用间距令牌）。
  外侧不撑开 ⇒ 不影响"独占一行仍居中"。
* 段内空白策略是 `break-spaces`（保留换行 ⇒ 会把两张图拆两行），故 `.md-preview p:has(> img:not(:only-child))`
  改回 `white-space: normal`。

### 2.3 远程图片
http(s) 图片走闸门（`lib/remoteImages.ts`）：
* **默认档 `always`（第七十七轮起）**：打开文档**直接加载**，与 Typora 一致（用户实测口径）。
* 显式切 `click`：渲染成**占位** `<span data-remote-src=… role=button tabindex=0>`，
  **无图标、无文案、无子节点**（第五十五轮用户要求），但**要看得出是块图区**（`min 6.5em×4.2em`、
  极淡虚线）；**不点不发请求**，点击后走 `loadGuardedImage()` 就地换成真 `<img>`。

> ⚠️ **坑（第七十八轮）**：占位上也要放行 `mousedown` —— 我们对图片源码范围一律 `preventDefault`
> 时，加上元素自身 `draggable`，会把后续的 `click` 吞掉 ⇒ `click` 档"点一下加载"变成**点不动**。

---

## 3. 标识符（源码文本）的显隐契约

判据是纯函数 **`revealDecision(sel, img)`**（`imageReveal.ts`，可单测）：

| 情形 | 结果 | 理由 |
|---|---|---|
| `NodeSelection` 且 `sel.from === img.from` | **显示** | 点图片 = 选中这张图 |
| **空光标**与 `[img.from, img.to]` 有交集（含边界） | **显示** | 点图片后光标落在 `from` 边界要能显示 |
| 非空选区**被完全包含**（`from >= img.from && to <= img.to`，**含恰好等于**） | **显示** | "在标识符内部拖动 / 选中全部文字"不消失（用户第七十二轮报障） |
| 非空选区的**其它任何交集**（两端都超出、**一端在外一端在内**、由外侧拖入） | **隐藏** | 用户第七十五轮口径：**从别处拖动连续选文字时不许出现标识符**（防闪烁） |
| 无交集 | **隐藏** | 视线离开 |

* 点别处 / `Esc` / 失焦 ⇒ 隐藏。
* **平时隐藏**（只显示图片）：未激活的源码文本挂 `.img-src-marker-hidden { display:none }`。
* **点击图片、鼠标松开后**才出现（见第 4 节）。
* 排版 = **正文样式**（同字体/字号/行高/颜色，无拼写波浪线）：
  * **独占一行** ⇒ `display:block` + **顶格**（`text-align:left`，对齐正文内容列左边缘）；
  * **行内** ⇒ 在图片**之前**同一行、`vertical-align: top`；
  * 激活态浅灰底（`--code-bg`）、**编辑态去底**（`.img-src-revealed--editing`）。

> ⚠️ **坑（第八十轮）**：块级标识符是 `display:block`、宽度=段宽，父段落 `text-align:center`
> 会把**盒内每一行文字**居中 ⇒ 看起来"标识符跑到正中间"。修法是只给标识符自己
> `text-align: left`（图片的居中来自 `margin-inline:auto`，不受影响）。

---

## 4. 鼠标 / 键盘契约

* **单击图片**：`mousedown` **只记落点**（`pendingClick`）+ `preventDefault`，**不出现**标识符；
  `mouseup` 在**同一事务**里完成"节点 → 原文文本 + 落选区 + 打开"（或打开原文）⇒
  **一次单击 = 一次可见状态跃迁**（不闪）。
* 点图片时**水平位置不动**：块级图片靠 `margin-inline:auto` 居中，激活只把它**向下让位**（`top` 只增不减）。
* **标识符上的按下 / 拖动 / 输入一律走原生文本行为**：`mousedown` 若命中
  `[data-img-revealed]`（已显示的标识符）或 `[data-remote-src]`（远程占位）⇒ 直接 `return false`。
  * 能点入（`selection.empty`、`from/to` 落在文本内）、能拖选（内部拖选 / 跨图片连续拖选）、
    能复制（`Ctrl+C` 得到完整原文）、能编辑（输入/退格改文档文本）；
  * **改坏语法 ⇒ 图片消失、正文保留截断文本**（"改坏即失效"）。
* 判"点到的是哪张图"**不看 DOM 身份**（PM 会重建 DOM），而是
  `posAtCoords(clientX/Y)` → 文档位置 → 落在哪个 `ImgSource` 范围里（`±1`）。

---

## 5. 归一化：同一份源码 ⇒ 同一份模型

`appendTransaction` 做两件事（都 `addToHistory:false`、幂等、**序列化逐字节不变**）：
1. 独立成行、且**整段就是一个 `<img …>`** 的 `htmlBlock` ⇒ 段落 + 行内原文文本；
2. 一个文本节点里被 PM 合并的**多个 `<img …>`** ⇒ 按标签边界拆成多个文本节点。

于是"解析入口"与"打字入口"产出的 Markdown **逐字节相同**（`tools/_verify-image-ui.js` 的 ⑪/⑭）。

---

## 6. 零污染

所有渲染层物件（装饰、`data-img-*` 属性、浮层工具栏、占位、选图按钮）**都不进 Markdown**：
`getMarkdown()` 与输入**逐字节相同**（契约由 ⑪/②C/㉒/㉔ 等断言把守）。

---

## 7. 缩放（100 / 75 / 50 / 25）

选档 ⇒ 源码写成 `<img src="URL" style="zoom:50%;" />`（**持久化进文档**）；再选档 ⇒
`withZoomInRaw()` **原地**改 `style` 里的 `zoom`（**永不出现第二个标签**）。
工具栏定位在**图片矩形上方**，与标识符不相交（`intersectArea:0`）。

---

## 8. 空 `![]()` 的选图按钮

**纯渲染装饰**（文档文本仍是逐字节 `![]()`）：括号内显示一个带图标的按钮，
光标可落在它前后；**括号内有字符即消失**（`isImgSourceText` 不再成立）。

---

## 9. 失败模式与自愈

`pendingClick` 必须**可靠清理**，否则 `apply` 的抑制条件会滞留 ⇒"有时不灵、得再点一次图片"：
* **900ms 到期**（`PENDING_TTL` + `isPendingExpired`）、`window.blur`、`document.visibilitychange`（非 visible）、
  `window.keydown`(capture)、`view.dom.pointercancel` / `mouseleave`、**下一次 mousedown 开始前重置**；
* 诊断锚：`.ProseMirror[data-img-pending]`（清理后为空串）。

---

## 10. 量具与坑（写下来免得后人重踩）

1. **判"居中/顶格"必须用 `Range` 取首个字符的行盒**：标识符是 `display:block`，
   `marker.getBoundingClientRect().left` 恒等于段宽（实测 320）⇒ 用它判会**假绿**；
   真正被居中影响的是盒内文字（实测首行 776 vs 基准 320）。
2. **CDP 直线拖拽在折行文本上不稳定**（实测 `from/to` 卡在第一个词）：量"依次选满"请用
   **逐位置扩选/收缩**的等价手势；鼠标拖拽路径另用**单行**夹具覆盖。
3. **`:only-child` 只数元素子节点**：`文字 + 单图` 段落会被误判成"独占一行"（第 2.1 节的坑）。
4. **沙箱里 `naturalWidth` 恒 0**（远程图与本机图床都解码不出）⇒ 断言只记尺寸、不断言；
   需在有网真机手工确认一次。
5. **模板字符串里写注释别带反引号**：页面侧代码是模板串，注释里的反引号会**提前结束模板**
   （本会话踩过 3 次，报错位置还会指到很远的一行）。
