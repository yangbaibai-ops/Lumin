// ─── 大文档降级闸的纯函数（本轮新增），对应 src/renderer/src/lib/largeDoc.ts ────
//
// 背景（实测，见桌面《待优化清单》F 项）：代码围栏是唯一的性能悬崖 —— 500 块文档打开 22.8s、
// 1500 块 >185s 且进程常驻 1.4GB；而纯散文 572k 字符只要 2.24s。降级闸按"围栏块数 / 字符数"
// 判定，超阈值直接进源码模式。
//
// ⚠️ F 项 P3 之后围栏阈值从 200 抬到 **800**（施工图 §6，用户已拍板）：虚拟化之后
// 「每块一个 CM」的悬崖没了 —— 探针实测 500 围栏可用 1,157ms、CM 实例峰值 10 个。
// 下面那条 `HEAVY_FENCES === 800` 是**刻意把这个产品决策钉住**：改它就得同时改这里的说明。
//
// ⚠️ 波次 2 复测（`tools/_probe-bigprose.js`）把**字符阈值从 1M 收到 300k**：
// 旧值 1M 是照"572k 字符 → 打开 2.24s"定的，而那句话量的是 `openPath` 返回（读盘 + 解析），
// 用户真正能用的时刻是 DOM 稳定。散文探针实测：977 KB / 373,185 字符 → open 1.97s + render 4.37s
// = **6.34s 不可用**、RSS 1272MB；1.1MB / 420,312 字符 → 8.59s、1247MB。两档都从旧闸下面漏了过去。
// CPU 采样显示这 4.4 秒几乎全是第三方常数（markdown-it tokenize 717ms、prosemirror-markdown
// atBlank 1168ms、PM 内部约 490ms、GC 411ms），一次改动消不掉 ⇒ 按实测 17µs/字符 标定 5 秒线 ≈ 290k。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HEAVY_CHARS,
  HEAVY_FENCES,
  docLoad,
  heavyReason,
  isHeavyDoc
} from '../src/renderer/src/lib/largeDoc.ts'

const fence = '```js\nconst a = 1\n```\n'
const prose = (n) => '这是一段散文。'.repeat(n)

test('阈值钉住：围栏 800 块 / 300k 字符（两条都是实测标定的产品决策）', () => {
  assert.equal(HEAVY_FENCES, 800, '改了阈值就要同步改这条断言与 largeDoc.ts 的说明')
  assert.equal(HEAVY_CHARS, 300_000, '字符阈值按实测 open+render ≤5s（17µs/字符）标定')
})

test('围栏按对计数（``` 与 ~~~ 都算，含 0–3 空格缩进）', () => {
  assert.equal(docLoad(fence).fences, 1)
  assert.equal(docLoad(fence.repeat(3)).fences, 3)
  assert.equal(docLoad('~~~\ncode\n~~~\n').fences, 1)
  assert.equal(docLoad('   ```\ncode\n   ```\n').fences, 1, '列表里的围栏也算')
  assert.equal(docLoad('```\n未闭合\n').fences, 1, '未闭合的同样会建一个 CM，按一块算')
  assert.equal(docLoad('普通段落，没有围栏。').fences, 0)
})

test('行内反引号不算围栏', () => {
  assert.equal(docLoad('这是 `行内代码`，不是围栏。').fences, 0)
  assert.equal(docLoad('四个反引号 ````` 在行内也不匹配（必须行首）').fences, 0)
})

test('阈值：正常文档不降级，结构密集或超大文档降级', () => {
  assert.equal(isHeavyDoc(fence.repeat(HEAVY_FENCES - 1)), false)
  assert.equal(isHeavyDoc(fence.repeat(HEAVY_FENCES)), true, `${HEAVY_FENCES} 块起降级`)
  assert.equal(isHeavyDoc(prose(HEAVY_CHARS / 8)), false)
  assert.equal(isHeavyDoc('x'.repeat(HEAVY_CHARS)), true, `${HEAVY_CHARS} 字符起降级`)
})

test('降级原因是可区分的（提示文案要说对是哪一种）', () => {
  // 代码块多：说"有 N 个代码块"；字符多：说"有 N 个字符"
  assert.equal(heavyReason(fence.repeat(HEAVY_FENCES)), 'fences')
  assert.equal(heavyReason('x'.repeat(HEAVY_CHARS)), 'chars')
  assert.equal(heavyReason('# 小稿子\n\n正文\n'), null)
  // 两者都超时：以围栏为先（那是更"结构性"的原因，也是老用户熟悉的说法）
  assert.equal(heavyReason(fence.repeat(HEAVY_FENCES) + 'x'.repeat(HEAVY_CHARS)), 'fences')
  // 临界值：刚好低一格不算
  assert.equal(heavyReason('x'.repeat(HEAVY_CHARS - 1)), null)
})

test('真实量级自检：用户的稿子（1.6 万字 / 少量围栏）不该被闸到', () => {
  const draft = '# 剧本\n\n' + prose(2400) + '\n' + fence.repeat(3)
  const load = docLoad(draft)
  assert.ok(load.chars > 16000, '样本量级对得上（实际 ' + load.chars + '）')
  assert.equal(isHeavyDoc(draft), false)
})

test('真实量级自检：一本 20 万字的中文长篇（≈600k 字符）要闸住', () => {
  // 波次 2 的现场：这类稿子在旧闸（1M 字符）下面会以 1.2GB 常驻 + 6s 卡顿进实时渲染
  const novel = '他推开窗，风从山谷里涌上来。'.repeat(40_000)
  assert.ok(novel.length > HEAVY_CHARS, '样本要真的超过阈值（实际 ' + novel.length + '）')
  assert.equal(heavyReason(novel), 'chars')
})

test('docLoad 返回的字符数就是内容长度（含空白）', () => {
  const s = '# 标题\n\n正文\n'
  assert.equal(docLoad(s).chars, s.length)
})
