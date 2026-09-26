// ─── 启动意图解析 `parseLaunchIntent`（审计 §10 P1「≥80 行 src 文件在 tests 里零引用」）──
//
// `src/main/services/launchIntent.ts` 是主进程里**少数完全不依赖 electron 的护栏函数**：
// 「进程命令行 → 该打开什么」。它同时服务四条入口（双击文件关联 / 任务栏跳转列表 /
// 第二实例转发 / macOS open-file），此前 tests/ 里零引用 —— 而它修的正是
// 「注册了 .md 文件关联却双击没反应」那类事故，改坏了只有真人双击才发现。
//
// 这里逐条钉住它自己写在注释里的规则顺序（这是模块的核心契约）：
//   ① 跳过 argv[0]；② `--` 之后一律忽略；③ 认自己的开关；④ 其余 `-` 开头的一律忽略
//   （Chromium/Electron 的开关绝不能当路径去打开）；⑤ 裸路径：自身/应用目录跳过、
//   存在则按目录/文件分流、不存在则记一笔 ignored。
//
// 相对路径要真解析、裸路径要真 existsSync —— 所以夹具用**真的临时目录**（不 mock fs）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { installTsExtensionResolve } from './lib/tsExtensionResolve.mjs'

// 该模块 import 的是 `'../../shared/paths'`（无扩展名）→ 先装解析钩子再动态 import
installTsExtensionResolve()
const {
  OPEN_FILE_PREFIX,
  OPEN_FOLDER_PREFIX,
  NEW_WINDOW_SWITCH,
  NO_WORKSPACE_SWITCH,
  parseLaunchIntent
} = await import('../src/main/services/launchIntent.ts')

const ROOT = mkdtempSync(join(tmpdir(), 'lumin-launch-'))
const SUB = join(ROOT, 'sub')
const DOC = join(ROOT, 'note.md')
const CJK_DOC = join(ROOT, '中文 笔记.md')
const SELF = join(ROOT, 'Lumin.exe') // argv[0]：进程自己的可执行文件（不要求真的存在）
const APP = join(ROOT, 'app') // 开发态 `electron .` 传进来的应用目录
mkdirSync(SUB)
mkdirSync(APP)
writeFileSync(DOC, '# note\n')
writeFileSync(CJK_DOC, '# 中文\n')

after(() => rmSync(ROOT, { recursive: true, force: true }))

/** 默认上下文：appPath = 应用目录，cwd = 临时工作区 */
const run = (argv, opts = {}) => parseLaunchIntent(argv, { appPath: APP, cwd: ROOT, ...opts })

test('裸路径 = 双击文件关联：既不是开关也不是自身/应用目录 → 打开为文档', () => {
  const intent = run([SELF, DOC])
  assert.equal(intent.openFile, DOC)
  assert.equal(intent.openFolder, null)
  assert.deepEqual(intent.ignored, [], '真实存在的路径不该进 ignored')
})

test('裸路径指向目录 → openFolder（同一个判定分支，按 statSync 分流）', () => {
  const intent = run([SELF, SUB])
  assert.equal(intent.openFolder, SUB)
  assert.equal(intent.openFile, null)
})

test('相对路径按 opts.cwd 解析成绝对路径（否则文件关联只会打开相对当前目录的东西）', () => {
  const intent = run([SELF, 'note.md'])
  assert.equal(intent.openFile, resolve(ROOT, 'note.md'))
})

test('不存在的裸路径：绝不 openFile，而是在 ignored 里记一笔原因', () => {
  const missing = join(ROOT, 'nope.md')
  const intent = run([SELF, missing])
  assert.equal(intent.openFile, null)
  assert.equal(intent.openFolder, null)
  assert.equal(intent.ignored.length, 1)
  assert.match(intent.ignored[0], /\(path does not exist\)$/)
  assert.ok(intent.ignored[0].includes(missing), '要能把是哪个参数写出来')
})

test('Chromium/Electron 自己的开关一律不当路径（否则 --user-data-dir 会被"打开"成一个文件夹）', () => {
  const intent = run([
    SELF,
    '--user-data-dir=C:\\tmp\\lumin',
    '--remote-debugging-port=9222',
    '--inspect',
    '--no-sandbox',
    '--enable-logging',
    '--type=renderer'
  ])
  assert.equal(intent.openFile, null)
  assert.equal(intent.openFolder, null)
  assert.deepEqual(intent.ignored, [], '这些是"不是给我们看的"，不该污染 ignored')
})

test('`--` 之后一律忽略（Chromium 约定：其后不是开关），且自己记一笔', () => {
  const after1 = run([SELF, DOC, '--', SUB])
  assert.equal(after1.openFile, DOC, '`--` 之前的裸路径照常处理')
  assert.equal(after1.openFolder, null, '`--` 之后的目录不再处理')
  assert.equal(after1.ignored.length, 1)
  assert.match(after1.ignored[0], /^-- /)
  // 反过来：`--` 在裸路径之前时，路径也不该被处理
  const after2 = run([SELF, '--', DOC])
  assert.equal(after2.openFile, null)
})

test('自身路径与应用目录都被跳过（开发态 `electron .` 会把应用目录当参数传进来）', () => {
  const selfIntent = run([SELF, SELF])
  assert.equal(selfIntent.openFile, null)
  assert.equal(selfIntent.openFolder, null)
  assert.deepEqual(selfIntent.ignored, [], '自身路径不算"忽略了一个参数"')
  // 应用目录是个**真实存在的目录**：没有这条护栏它会变成 openFolder
  const appIntent = run([SELF, APP])
  assert.equal(appIntent.openFolder, null)
  assert.deepEqual(appIntent.ignored, [])
})

test('`--lumin-open=` 认开关，值走 encodeURIComponent 解码', () => {
  const intent = run([SELF, `${OPEN_FILE_PREFIX}${encodeURIComponent(CJK_DOC)}`])
  assert.equal(intent.openFile, CJK_DOC, '含空格与中文的路径必须完整还原')
})

test('`--lumin-open-folder=` 认开关', () => {
  const intent = run([SELF, `${OPEN_FOLDER_PREFIX}${encodeURIComponent(SUB)}`])
  assert.equal(intent.openFolder, SUB)
  assert.equal(intent.openFile, null)
})

test('坏编码 / 空值当作"没有"（宁可不开，也不要开到一个乱码路径）', () => {
  assert.equal(run([SELF, `${OPEN_FILE_PREFIX}%E4%B8`]).openFile, null, '截断的 UTF-8 百分号编码')
  assert.equal(run([SELF, `${OPEN_FILE_PREFIX}`]).openFile, null, '空值')
  assert.equal(run([SELF, `${OPEN_FOLDER_PREFIX}%`]).openFolder, null)
})

test('同一个开关出现两次时取**第一个**（??= 语义：先到者胜）', () => {
  const second = join(ROOT, 'second.md')
  writeFileSync(second, '# 2\n')
  const intent = run([
    SELF,
    `${OPEN_FILE_PREFIX}${encodeURIComponent(DOC)}`,
    `${OPEN_FILE_PREFIX}${encodeURIComponent(second)}`
  ])
  assert.equal(intent.openFile, DOC)
})

test('--lumin-new-window / --lumin-no-workspace=1 两个布尔开关', () => {
  const intent = run([SELF, NEW_WINDOW_SWITCH, NO_WORKSPACE_SWITCH])
  assert.equal(intent.newWindow, true)
  assert.equal(intent.noWorkspace, true)
  const plain = run([SELF])
  assert.equal(plain.newWindow, false)
  assert.equal(plain.noWorkspace, false)
})

test('空字符串参数被跳过（argv 里可能出现空串，不该当成 cwd 去打开）', () => {
  const intent = run([SELF, '', DOC])
  assert.equal(intent.openFile, DOC)
  assert.deepEqual(intent.ignored, [])
})

test('什么都没有时返回一个"全空"的意图（不抛）', () => {
  assert.deepEqual(run([SELF]), {
    openFile: null,
    openFolder: null,
    newWindow: false,
    noWorkspace: false,
    ignored: []
  })
  assert.deepEqual(run([]), {
    openFile: null,
    openFolder: null,
    newWindow: false,
    noWorkspace: false,
    ignored: []
  })
})

test('ignored 的诊断文本是 ASCII（主进程日志/控制台在 Windows 代码页下会乱码）', () => {
  const intent = run([SELF, join(ROOT, 'ghost-ascii.md'), '--', SUB])
  assert.equal(intent.ignored.length, 2)
  for (const line of intent.ignored) {
    assert.match(line, /^[\x20-\x7e]*$/, `非 ASCII：${line}`)
  }
})
