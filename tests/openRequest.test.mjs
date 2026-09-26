// ─── 「打开请求落到哪个窗口」的落点决策单测（`main/openRequest.ts`）──────────────
//
// 这段规则是**第二实例**（任务栏跳转列表 / 双击文件 / 再点一次图标）与 macOS `open-file` 的
// 共同入口，也是「一个文件只开一个窗口」这条承诺的唯一实现。它此前是 `main/index.ts` 里的一条
// if 链 —— 只能靠"真的双击两次文件"验，而审计 §2 P1（同一文件开在两个窗口里各自保存会互相覆盖）
// 正是它要防的事。抽成纯函数后，四条优先级可以逐条穷举。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planOpenRequest } from '../src/main/openRequest.ts'

const FILE = 'C:\\ws\\a.md'
const FOLDER = 'C:\\ws'

test('① 要新窗口：带不带目标都开新窗口，且只有"纯新窗口"才是干净窗口', () => {
  assert.deepEqual(planOpenRequest({ newWindow: true }), {
    kind: 'new-window',
    openFile: undefined,
    openFolder: undefined,
    noWorkspace: true
  })
  // 带了文件/目录也照样"新窗口"，但参数不能丢，且**不**清工作区
  assert.deepEqual(planOpenRequest({ newWindow: true, openFile: FILE }), {
    kind: 'new-window',
    openFile: FILE,
    openFolder: undefined,
    noWorkspace: false
  })
  assert.deepEqual(planOpenRequest({ newWindow: true, openFolder: FOLDER }), {
    kind: 'new-window',
    openFile: undefined,
    openFolder: FOLDER,
    noWorkspace: false
  })
})

test('② 打开文件：已在别的窗口开着 → 聚焦过去（绝不重复开窗）', () => {
  assert.deepEqual(planOpenRequest({ openFile: FILE }, { docAlreadyOpen: true }), {
    kind: 'focus-doc'
  })
})

test('② 打开文件：没有别处开着 → 新窗口打开它（且不继承当前工作区）', () => {
  assert.deepEqual(planOpenRequest({ openFile: FILE }, { docAlreadyOpen: false }), {
    kind: 'new-window',
    openFile: FILE,
    noWorkspace: false
  })
  // 不传 docAlreadyOpen 时按"没开着"处理（调用方偷懒也不会静默聚焦错窗口）
  assert.deepEqual(planOpenRequest({ openFile: FILE }), {
    kind: 'new-window',
    openFile: FILE,
    noWorkspace: false
  })
})

test('③ 打开目录：新窗口以它为工作区（不继承当前工作区）', () => {
  assert.deepEqual(planOpenRequest({ openFolder: FOLDER }), {
    kind: 'new-window',
    openFolder: FOLDER,
    noWorkspace: false
  })
})

test('④ 都没有：聚焦任一已有窗口（再点一次图标的常见路径）', () => {
  assert.deepEqual(planOpenRequest({}), { kind: 'focus-any' })
})

test('优先级：文件压过目录（同时带两者时按文件走）', () => {
  // 解析器本身一般不会同时给两者；这里钉住"万一给了"的行为：文件优先（与既有实现一致）
  assert.deepEqual(planOpenRequest({ openFile: FILE, openFolder: FOLDER }), {
    kind: 'new-window',
    openFile: FILE,
    noWorkspace: false
  })
  assert.deepEqual(
    planOpenRequest({ openFile: FILE, openFolder: FOLDER }, { docAlreadyOpen: true }),
    { kind: 'focus-doc' }
  )
})
