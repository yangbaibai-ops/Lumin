# 收尾路径审计与"单一真相"收口（架构收口 · 阶段 1/3）

> 触发：用户报障「在表格中跨行连续选中、或从表格连续拖动到表格外的文字时，会**偶发**出现鼠标按下未抬起时
> 选中的文字和抬起后不一致」⇒ 实测签名 **松手后少 1–2 列**。
> 本轮**不打补丁**，而是消除这一类 bug 的**根源**：同一个事实有**四份真相**（模型选区 / 我们画的带 /
> 原生 DOM 选区 / 拖动期试探区间），任何一条收尾路径不是"以本次手势记录为准落定"，就会把
> **原生那份被夹扁的选区**留在屏幕上（劣化实例实测 9/70 ≈ 13%）。
>
> 只改 `src/renderer/src/lib/editor/imageToolbar.ts`（未动 `markdown.css`，故未动任何样式）。
> 方案仍是**既有** `boxDrag` / `boxDragLive` / `boxDragSettle` 一套，**未新增第二套拖动/落定逻辑**；
> 未改 `BOX_SETTLE_WATCH`（仍 `0`）；无 `!important`、无硬编码颜色/像素。

---

## 1. 收尾路径审计表

行号对 **`b6e6218`**（本阶段提交）而言。口径三列：
* **改前** = `before-arch-hardening`（= `feafc91`）的行为；
* **改后** = `b6e6218` 的行为；
* **单一真相** = 落定依据是否只取"本次手势的唯一记录"（`boxDrag.g` / 别名 `liveGesture`）⇒ 必须 **是**。

| 文件:行号 | 触发事件 | 改前行为 | 改后行为 | 单一真相 |
| --- | --- | --- | --- | --- |
| `imageToolbar.ts:3712` `onBandUp`（注册 `:3733`） | `mouseup`（window 捕获） | 有 `boxDrag` ⇒ 按 `lastLiveNear/Far`+锚点+落点落定 | 只调 `settleGesture(ev2)`；依据同一份 `liveGesture` | ✅ |
| `imageToolbar.ts:3712`（注册 `:3734`） | `pointercancel`（window 捕获，实测约占一半的收尾触发） | 与 `mouseup` 同一分支（当时无区别） | 同一分支、**同一** `settleGesture`；第二次到达被识别为同一次手势 | ✅ |
| `imageToolbar.ts:3712`（注册 `:3735`） | `window blur` | 同一分支（`boxDrag` 在 ⇒ 正常落定；已被消费 ⇒ **旧早退分支 `clearLiveSel(); return`** ⇒ 落定一次都没发生） | 同一分支：早退**已取消**，`liveGesture` 新鲜即按记录落定 | ✅ |
| `imageToolbar.ts:3744` `onVisUp`（注册 `:3752`） | `document visibilitychange` 且 `visibilityState !== 'visible'` | **无此路径**（窗口被隐藏时不再有 `mouseup` ⇒ 拖动期的临时带与落定一起丢） | 未收尾的手势 ⇒ 走 `onBandUp` ⇒ `settleGesture` | ✅ |
| `imageToolbar.ts:3748` `onKeyUp`（注册 `:3753`） | 任意 `keydown`（含 **Escape**、含 `event.repeat` 过滤） | **无此路径**（拖动期按 Escape ⇒ 手势残留、落定不发生） | 同上（只在"有未收尾手势"时动作 ⇒ 正常打字零影响） | ✅ |
| `imageToolbar.ts:3637` `settleGesture` | **收尾的唯一入口** | 不存在（逻辑散在 `onBandUp` 的两个分支里） | 只读 `liveGesture`：`from/to` + `maxFrom/maxTo` + 锚点/落点 | ✅（这是唯一出口） |
| `imageToolbar.ts:3650` `settleGesture` 早退（无记录/过期/空区间） | 任何收尾事件但本次手势没有记录 | `if (!boxDrag)`：`clearLiveSel(); return`（**把屏幕让回原生**） | `boxSettleTarget = null` + `clearLiveSel`（显式"没有要落定的东西"，不再有"让回原生"这条语义） | ✅ |
| `imageToolbar.ts:3672` `settleGesture` **幂等**跳过 | 同一次手势的**第二次**收尾（`pointercancel` → 真 `mouseup`） | **不存在**：第二次会再落一次（用 `lastLiveRange` 的同一值，多余 dispatch + 多余绘制窗口） | `g.settled && from>=closeFrom && to<=closeTo` ⇒ **直接跳过**（0 次 dispatch），诊断锚记 `dup-skip` | ✅ |
| `imageToolbar.ts:3679` `settleGesture` 单调性候选集 | 收尾目标计算 | `cands = [lastLiveNear, lastLiveFar, anchor, focus]` | `cands = [画面最后一帧, maxFrom/maxTo, 上次落成值, anchor, focus]` ⇒ 只可能**往外补** | ✅ |
| `imageToolbar.ts:1304` `boxDragSettle` | 落定 + 有界复验（成功即停） | 目标 `boxSettleTarget` 定一次、不再更新 | `tryOnce`（`:1417`）每次补写前先把 `g.maxFrom/maxTo`、`g.from/to` **并进目标** ⇒ PM 读回也改不小 | ✅ |
| `imageToolbar.ts:1461` | 落定成功那一帧的 rAF 回调 ⇒ `clearLiveSel(view)` | 同 | 同（成功即清临时绘制，`fallback=ok`） | ✅ |
| `imageToolbar.ts:1475` | 连续被推翻到上限 ⇒ 兜底 `setTo` + `clearLiveSel(view)` | 同 | 同（`fallback=late/fail`） | ✅ |
| `imageToolbar.ts:2498`（在 `paintLiveSel` 内） | 试探区间为空（`to <= from`） | `clearLiveSel(view)` 后返回 | 同（**不是**收尾路径，只是"这一帧没东西可画"） | n/a |
| `imageToolbar.ts:3835`（在 `destroy` 内） | 插件 `destroy`（换文档 / 切模式 / 视图重建） | 直接 `boxDrag = null` + `clearLiveSel(null)` ⇒ 落定一次都没发生、模型停在原地 | **先** `if (liveGesture && !liveGesture.settled) settleGesture()` **再**拆层 | ✅ |
| `imageToolbar.ts:3487` `onDragDown`（`mousedown`，注册 `:3542`） | 任何新的按下（含"点别处"） | `boxDrag = null`（只清拖动状态） | 额外 `liveGesture = null`（**作废上一次手势记录**，避免"不带 boxDrag 的按下+松手"误用上一趟区间） | ✅（防误用） |
| `imageToolbar.ts:1001` `bandDragMove` / `:3442` `onDragDown` 内的 `bandDrag = {…}` | 带内按下并拖动 | `mousedown` 被 `preventDefault`、拖动期**每帧 dispatch**、松手只清状态 | **不变**（这条路径本来就是"以自己那份选区为准"，从不读原生；它不需要也不得接进 `boxDragSettle`） | ✅（自成一份真相） |
| `imageToolbar.ts:3544` `window pointercancel → onDragUp` / `:3545` `blur → onDragUp` | 失焦 / 指针取消 | 只置 `dragActive=false` 并发一次空事务 | **不变**（它不落定、不清绘制 ⇒ 不与 `onBandUp` 争；注册顺序在前，只做状态复位） | n/a |
| `imageToolbar.ts:3543` `window mouseup → onDragUp` | 松手（图片源码那条既有路径） | 置 `dragActive=false` + 发一次空事务重算 | **不变**（见上一行） | n/a |
| `imageToolbar.ts:3433` `onUpBlank`（注册 `:3552`） | 空白带拖选的收尾 | `blankAnchor = null` + 取消 rAF | **不变**（那条路径自己每帧 dispatch，不需要落定） | n/a |
| `imageToolbar.ts:3097` 插件 `keydown` | Escape | 只关图片工具栏（`setMeta(KEY,{from:null})`） | **不变**（受 `if (from == null) return false` 保护 ⇒ 与拖动无交集；拖动的 Escape 由 `:3748` 收） | n/a |
| `imageToolbar.ts:3242` / `:3259` / `:3800` `paintSettledSel` 三处 | `ResizeObserver` / `window resize` / PM `update` | `boxDrag == null` ⇒ 立刻按**模型选区**画落定态 | 加 `!closeWindowOpen(now)`：**收尾窗口内不画**（那一刻模型常是 DOMObserver 读回来的夹扁值） | ✅ |
| `imageToolbar.ts:1122` `closeWindowOpen` | 判据本身 | 不存在 | `boxDrag != null \|\| boxSettleTarget != null \|\| now-settleStampAt <= 200ms` | — |

### 1.1 `clearLiveSel` 的全部调用点

| 文件:行号 | 在哪个路径里 | 语义 |
| --- | --- | --- |
| `:3650` | `settleGesture` 早退（无记录） | 显式"没有要落定的东西" |
| `:3688` | `settleGesture` 空区间（`sFrom === sTo`） | 同上 |
| `:1461` | `boxDragSettle.tryOnce` 落成那一帧的 rAF | 撤临时绘制（`fallback=ok`） |
| `:1477` | `boxDragSettle.tryOnce` 兜底 | 撤临时绘制（`fallback=late/fail`） |
| `:2498` | `paintLiveSel`（空区间） | 无内容可画 |
| `:3839` | `destroy` | 视图销毁时拆层 |

> 除 `destroy` 外，**每一处都在"手势已收尾"之后**；`destroy` 现在是"先收尾（`:3835`）再清"。

---

## 2. 改法：单一真相 + 幂等 + 单调性

### 2.1 单一真相（`imageToolbar.ts:1049-1086` 的类型 + `:3487` 起手创建 + `:1100` 别名）

```
boxDrag.g = liveGesture = {
  id,                      // 每次 mousedown 自增（诊断锚 data-img-gesture）
  from, to, at,            // 最近一帧"画面上那一份" + 时间戳
  maxFrom, maxTo, maxAt,   // 本手势已画过的最大覆盖（单调性护栏）
  settled,                 // 是否已收尾（幂等判据）
  closeFrom, closeTo       // 上次落成的区间（幂等判据）
}
```

* **拖动期**（`:2583 boxDragLive`）：每帧写 `from/to/at`；**只有指针确实压在原子盒内**（`focus != null`）时
  才写 `maxFrom/maxTo`。
  * 为什么盒外帧不写：盒外帧的 `[锚点, 原生光标]` 会随**滞后的原生光标**变宽，并进来会在反向拖动松手时
    **多选一段没画过的内容**（"本不该选中却被选中"，第 2.x 步实测过）；而盒内帧是**我们自己选的那一边**，
    对"原生被夹扁"这个失败模式灵敏。
* **旧的第二份记录 `lastLiveRange` 已删除** —— 它正是"两份真相、谁先写谁算"的根源。

### 2.2 收尾幂等（`:3637 settleGesture`）

* 第一次收尾：记录 `g.settled = true`、`g.closeFrom/closeTo = 实际落定区间`；
* 后续事件：`g.settled && from >= closeFrom && to <= closeTo` ⇒ **跳过**（0 次 dispatch，`data-img-up-diag` 记 `dup-skip`）；
* 若记录**真的变大**（拖动期还有新帧）⇒ 允许"只修正一次"，且候选集里带上 `closeFrom/closeTo` ⇒ **绝不回缩**。

### 2.3 单调性（`:1304 boxDragSettle` + `:1417 tryOnce`）

每次尝试落定前：

```
t = boxSettleTarget
t = [min(t.from, g.maxFrom, g.from), max(t.to, g.maxTo, g.to)]
boxSettleTarget = t        // 目标只增不减
```

于是 PM 的 `DOMObserver` 把过期的 DOM 选区读回来时，我们的下一次补写**不小于**画面上画过的那一份；
±2 容差只用于"吸附造成的 1~2 位偏差"，不再承担"防止整段被吃掉"的责任。

### 2.4 收尾窗口（`:1122 closeWindowOpen`）

`boxSettleTarget` 在落成那一刻就被 `cancelWatch()` 清成 `null`（`:1333`，同一处盖 `settleStampAt` 印记），
所以**落成之后** PM 读回那一帧不再触发"按假的模型选区画带"（三处 `paintSettledSel` 都加了 `!closeWindowOpen`）。

---

## 3. 结构性不可达（(a)/(b) 要求）

| 情形 | 判定 | 处理 / 证据 |
| --- | --- | --- |
| 端点落在**原子节点内部**（块级公式 `$$…$$`、表格边界） | **结构性不可达** | 走既有 `textSelAt` **吸附**（`:1365`），且吸附方向恒"往区间内收"；本轮实测 ㊴②五例、6 类跨越双向差集全 0 |
| 指针在原子盒内、我们按"盒内取半"选远端 | 可达 | 拖动期画的就是它（`maxFrom/maxTo` 记录同一帧），落定目标 ⊇ 它 |
| 原生 DOM 选区**比我们画的还宽**（原生滞后） | 可达 | `paintLiveSel` 取 `试探区间 ∪ 原生区间` ⇒ 画面上本来就更宽 ⇒ 落定 ⊇ 画面 |
| 反向拖动（指针带着原生光标往回走） | 可达 | 画面跟着缩、落定按"画面最后一帧"落 ⇒ 不出现"拖动期更多、松手后更少" |

---

## 4. 本轮原始数值（证据）

### 4.1 收尾路径逐次（`tmp/probe-settle.js`，真表格文档 + 逐格命中自检 `ok=true`，端口 9420，全新实例 `%TEMP%\xw-single-ud`）

| 路径 | 次数 | 差集非 0 | 收尾 >1 次 | live | settled | fallback | 绘制泄漏 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `mouseup` | 30 | 0 | 0 | `367-582` | `367-582` | `ok` ×30 | 全 0 |
| 中途 `pointercancel` | 30 | 0 | 0 | `367-582` | `367-582` | `ok` ×30 | 全 0 |
| 中途 `blur` | 30 | 0 | 0 | `367-582` | `367-582` | `ok` ×30 | 全 0 |
| 中途 `visibilitychange` | 30 | 0 | 0 | `367-582` | `367-582` | `ok` ×30 | 全 0 |
| **重复收尾**（`pointercancel` → 真 `mouseup`） | 30 | 0 | **0**（第二次记 `dup-skip`） | `367-582` | `367-582` | `ok` ×30 | 全 0 |

泄漏口径 = `{bandN:.sel-band > div, selBand:存在, hl:CSS.highlights['lumin-img-drag'] 条数, own:data-sel-own, imgSelN:.img-selected}`。

### 4.2 失败率复测

| 条件 | 实例 | 场景 | 次数 | 少覆盖 |
| --- | --- | --- | --- | --- |
| 正常（前台、`rafFramesIn500ms ≈ 30–32`；启动脚本带 `--disable-features=CalculateNativeWinOcclusion`） | 9421 | 表内跨行 `T1`（末行第 2 列 → 表头） | 30 | **0** |
| 正常 | 9421 | 表内→表外 `T2`（末行第 2 列 → 表格下方正文） | 30 | **0** |
| **节流**（窗口被真实遮挡 ⇒ 测试期 `rafFramesIn500ms = 0–1`） | 9420 | 同上 `T1` | 30 | **0** |
| **节流** | 9420 | 同上 `T2` | 30 | **0** |

`up` 触发分布实测：`["pointercancel"]`（T1）、`["pointercancel","dup-skip"]`（T2）⇒ 确认
`pointercancel` 仍常态参与收尾，且**重复收尾被正确识别**（`dup-skip`）。
两条节流结论合起来就是本轮的关键口径：**正确性不再依赖帧调度与事件到达顺序**。

### 4.3 既有套件（`tools/_verify-image-ui.js`）

| 运行 | 末行 | 红条 |
| --- | --- | --- |
| 第 1 次（全新实例 `%TEMP%\xw-single-ud` / 端口 9420） | `TOTAL 130 PASS 127 FAIL 3` | ㉛①、㉛②、㉞①（**基线三条**） |
| 第 2 次（同上，重开实例） | `TOTAL 130 PASS 127 FAIL 3` | ㉛①、㉛②、㉞①（**基线三条**） |

条数 125 → **130**（+5，逐条见下）；新增断言**两次全绿**。

### 4.4 新增断言一览（+5）

| 断言 | 覆盖 | 次数 | 结果 |
| --- | --- | --- | --- |
| ㊴③ | **单调性**：`settled ⊇ 画过的最大覆盖`（`data-img-sel-paint`）且 `⊇ 盒内高水位`（`data-img-gesture` 的 `max`） | 5 例 | 差集 case 数 0 |
| ㊶ | 中途 `blur` ⇒ settled == live、`fallback ∈ {ok,late}`、**临时绘制零泄漏** | 10 | 10/10 全绿 |
| ㊷ | 中途 `visibilitychange`（伪造 `hidden`）⇒ 同上 + **事件当帧就已落定** | 10 | 10/10 全绿 |
| ㊸ | **重复收尾**（`pointercancel` → 真 `mouseup`）⇒ `settleN == 1`（第二次 0 次 dispatch）、`up-diag` 记 `dup-skip` | 10 | 10/10 全绿 |
| ㊹ | **单调性（不得回缩）**：`settled.from <= paint.min` 且 `settled.to >= paint.max` | 30 | 30/30 全绿 |

> "零泄漏"口径：`data-sel-own !== 'all'` 且 `CSS.highlights['lumin-img-drag']` 条数 = 0
> （**不是**"一条带都不许有" —— 落定态本来就会给行内公式画带，`own='math'`；第一版按
> `bandN === 0` 判，实测 30/30 全红，属误判，已改正并写进断言说明）。

### 4.5 由此修掉的一处**诊断误差**（不是落定缺陷）

㊴② 在本轮之前会**间歇红**：反向拖动（尾段 → 首行）时 `data-img-drag-live` 报 `51-604`，
而落定是 `3-604`（用例判 `extra 48`）。逐帧取证后确认这是**读数错**：

* 屏幕上画的本来就是 `试探区间 ∪ 原生 DOM 区间`（`paintLiveSel` 的老口径），反向段原生选区
  **领先一帧**先到 `3` ⇒ 画面是 `3-604`、落定也是 `3-604`（**一致**）；
* 只有 `data-img-drag-live` 这个**诊断属性**只写了 `试探区间`（`51-604`）⇒ 套件读到"落定 ⊋ live"。
* 修法（`boxDragLive`）：诊断属性改写成与**画面同一份**的 `试探区间 ∪ 原生区间`；并新增
  `data-img-sel-paint`（本手势"画过的最小/最大"，只增不减）作为"落定 ⊆ 画过"的独立上界。
  **落定口径一个字都没改**（`boxDragRange` / `settleGesture` 的候选集与 `maxFrom/maxTo` 不变）。

修后 ㊴② 在两次运行里都**稳定绿**（此前在同一实例上可复现 2 次红）。

---

## 5. 未做 / 遗留

* `markdown.css` 未改（本轮不需要）。
* `BOX_SETTLE_WATCH` 仍 `0`（未动）。
* `tmp/` 下的探针（`probe-settle.js` / `probe-regress.js`）不入库（`.gitignore` 已忽略 `tmp/`）。
