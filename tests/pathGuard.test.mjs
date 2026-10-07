// 主进程的工作区逃逸护栏（src/main/pathGuard.ts）：**以前没有任何测试**。
//
// 审计 §10「重复实现」的原话：`isInside` 是"工作区逃逸"护栏（`assertWorkspacePath` 用它），
// 而 `tests/` 里只引用了渲染层那份 —— 主进程那份（真正拦人的那份）零覆盖。
//
// 这条测试的价值全在**负例**上：`isInside` 写错的典型后果不是"少拦一个"，
// 而是"看起来拦住了、其实用 `..` 或同名前缀绕过去了"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isInside, sameResolvedPath } from '../src/main/pathGuard.ts'

test('isInside：正常工作区内的路径放行（含根自身、含子目录）', () => {
  assert.equal(isInside('D:\\ws', 'D:\\ws'), true)
  assert.equal(isInside('D:\\ws', 'D:\\ws\\a.md'), true)
  assert.equal(isInside('D:\\ws', 'D:\\ws\\notes\\deep\\a.md'), true)
  // 分隔符混用也算同一个位置
  assert.equal(isInside('D:\\ws', 'D:/ws/notes/a.md'), true)
  // Windows 大小写不敏感
  assert.equal(isInside('D:\\WS', 'd:\\ws\\a.md'), true)
})

test('isInside：`..` 逃逸必须被拦（这是护栏的核心）', () => {
  assert.equal(isInside('D:\\ws', 'D:\\ws\\..\\evil.md'), false)
  assert.equal(isInside('D:\\ws', 'D:\\ws\\a\\..\\..\\evil.md'), false)
  assert.equal(isInside('D:\\ws', 'D:\\ws\\..\\..\\Windows\\system32\\x.dll'), false)
  // 相对形式的越界
  assert.equal(isInside('D:\\ws', '..\\evil.md'), false)
})

test('isInside：同名前缀不算内部（`D:\\ws2` 不是 `D:\\ws` 的子目录）', () => {
  assert.equal(isInside('D:\\ws', 'D:\\ws2\\a.md'), false)
  assert.equal(isInside('D:\\ws', 'D:\\ws-other\\a.md'), false)
})

test('isInside：别的盘符一律拒绝', () => {
  assert.equal(isInside('D:\\ws', 'C:\\ws\\a.md'), false)
})

test('isInside：目录自身后面多一个分隔符也算自身', () => {
  assert.equal(isInside('D:\\ws', 'D:\\ws\\'), true)
})

// ─── sameResolvedPath：拖入文件夹时"是不是已经开着这个工作区"的判据 ────────────────
//
// 为什么要用主进程这份而不是 `shared/paths.ts` 的 `samePath`：那一份**不解析 `.`/`..`**，
// 于是一个带 `..` 的等价写法会被判成"不同" ⇒ 拖同一个文件夹却新开一个窗口（用户报障的那类）。
// 四条等价写法（大小写 / 末尾 `\` / 正斜杠 / `..`）必须全部判"相同"。
test('sameResolvedPath：同一个目录的四种等价写法都算相同', () => {
  const dir = 'D:\\ws\\pkg'
  assert.equal(sameResolvedPath(dir, 'd:\\WS\\PKG'), true, '大小写不同')
  assert.equal(sameResolvedPath(dir, 'D:\\ws\\pkg\\'), true, '末尾带反斜杠')
  assert.equal(sameResolvedPath(dir, 'D:/ws/pkg'), true, '正斜杠')
  assert.equal(sameResolvedPath(dir, 'D:\\ws\\sub\\..\\pkg'), true, '含 `..`（必须被 resolve 掉）')
  // 组合写法
  assert.equal(sameResolvedPath('D:\\ws\\pkg\\', 'd:/WS/sub/../PKG'), true)
  // `.` 与重复分隔符
  assert.equal(sameResolvedPath(dir, 'D:\\ws\\.\\pkg'), true)
  assert.equal(sameResolvedPath(dir, 'D:\\\\ws\\\\pkg'), true)
})

test('sameResolvedPath：不是同一个目录的必须判不同（前缀相同也不行）', () => {
  assert.equal(sameResolvedPath('D:\\ws\\pkg', 'D:\\ws\\pkg2'), false)
  assert.equal(sameResolvedPath('D:\\ws\\pkg', 'D:\\ws\\pkg\\sub'), false)
  assert.equal(sameResolvedPath('D:\\ws\\pkg', 'D:\\ws'), false, '父目录不是同一个')
  assert.equal(sameResolvedPath('D:\\ws\\pkg', 'C:\\ws\\pkg'), false, '别的盘符')
  assert.equal(sameResolvedPath('D:\\ws\\pkg', 'D:\\ws\\pkg-old'), false)
})

test('sameResolvedPath：盘符根与 UNC 路径也按 Windows 口径处理', () => {
  assert.equal(sameResolvedPath('D:\\', 'd:/'), true, '盘符根（尾分隔符保留）')
  assert.equal(sameResolvedPath('D:\\', 'D:\\ws\\..'), true, 'resolve 回盘符根')
  assert.equal(
    sameResolvedPath('\\\\srv\\share\\d', '\\\\SRV\\share\\d\\'),
    true,
    'UNC 大小写与尾分隔符'
  )
  assert.equal(
    sameResolvedPath('\\\\srv\\share\\d', '\\\\srv\\share\\e'),
    false,
    'UNC 不同共享目录'
  )
})

test('sameResolvedPath：拿不到其中一侧就判不同（不许把"不知道"当成"相同"）', () => {
  assert.equal(sameResolvedPath(null, 'D:\\ws'), false)
  assert.equal(sameResolvedPath('D:\\ws', undefined), false)
  assert.equal(sameResolvedPath('', ''), false)
  // 只有空白不能算路径（否则两侧都被 resolve 成同一个 cwd，"什么都不给"会变成"相同"）
  assert.equal(sameResolvedPath('   ', '   '), false)
})

/**
 * 这一层**只做字符串**，所以有两类"Windows 上其实是同一处"的写法它判不出来，
 * 由主进程 `fileOps.isSamePath` 的第二段（`fs.realpath`）兜住（不在这里断言，因为没有 fs）：
 *   * 符号链接 / junction；
 *   * 8.3 短名（`C:\Users\YANGBA~1\…`，资源管理器拖进来时 Chromium 给的就是这种）；
 *   * 末尾空格/点（Windows 在打开路径时会吃掉它们，`realpath` 会给出规范形）。
 */

test('sameResolvedPath：与 isInside 的分工（解析 `..` 之后仍按目录边界比较）', () => {
  // `isInside` 拒绝的逃逸路径，在"同一性"这件事上也不该意外判成相同
  assert.equal(sameResolvedPath('D:\\ws', 'D:\\ws\\..\\ws2'), false)
  assert.equal(sameResolvedPath('D:\\ws\\pkg', 'D:\\ws\\pkg\\..\\other'), false)
  assert.equal(sameResolvedPath('D:\\ws\\pkg\\..', 'D:\\ws'), true, '`..` 正确解析回父目录')
})
