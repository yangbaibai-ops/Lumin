// 路径授权纯判据（src/main/services/pathGrantPolicy.ts）的单测。
//
// 审计 P1-2：授权必须只源于用户手势；`lumin-file://` 与 fs 读取走同一个校验函数，
// 且必须先 realpath（挡 junction / symlink 逃逸）。纯字符串层容易写错的地方——
// `..`、大小写、尾随分隔符、盘符根、UNC、同前缀不同目录——这里逐条钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalPath, isInsideDir, isPathAllowed } from '../src/main/services/pathGrantPolicy.ts'

const GRANTS = {
  workspace: 'C:\\ws',
  dirs: ['D:\\shared\\assets'],
  files: ['C:\\picked\\a.md'],
  readDirs: ['E:\\docs'],
  readFiles: ['E:\\docs\\b.md']
}

test('canonicalPath：大小写 / 分隔符 / .. / 尾随分隔符 / 盘符根', () => {
  assert.equal(canonicalPath('C:/WS/notes/../a.md'), 'c:\\ws\\a.md')
  assert.equal(canonicalPath('c:\\ws\\a.md\\'), 'c:\\ws\\a.md')
  assert.equal(canonicalPath('C:\\'), 'c:\\')
  assert.equal(canonicalPath('\\\\SERVER\\Share\\x\\'), '\\\\server\\share\\x')
})

test('工作区子树：内部放行，同前缀/上跳一律拒绝', () => {
  assert.equal(isPathAllowed('C:\\ws\\a.md', GRANTS), true)
  assert.equal(isPathAllowed('C:\\WS\\notes\\deep\\a.md', GRANTS), true)
  assert.equal(isPathAllowed('C:\\ws', GRANTS), true)
  assert.equal(isPathAllowed('C:\\ws\\..\\evil.md', GRANTS), false)
  assert.equal(isPathAllowed('C:\\ws2\\a.md', GRANTS), false)
  assert.equal(isPathAllowed('C:\\Windows\\win.ini', GRANTS), false)
})

test('目录/文件精确授权：读写两档分明', () => {
  assert.equal(isPathAllowed('D:\\shared\\assets\\x.png', GRANTS), true)
  assert.equal(isPathAllowed('D:\\shared\\assets2\\x.png', GRANTS), false)
  assert.equal(isPathAllowed('C:\\picked\\a.md', GRANTS), true)
  assert.equal(isPathAllowed('C:\\picked\\A.MD', GRANTS), true)
  assert.equal(isPathAllowed('C:\\picked\\b.md', GRANTS), false)
  // 只读来源：读可以，写不行
  assert.equal(isPathAllowed('E:\\docs\\c.md', GRANTS, 'read'), true)
  assert.equal(isPathAllowed('E:\\docs\\b.md', GRANTS, 'read'), true)
  assert.equal(isPathAllowed('E:\\docs\\c.md', GRANTS, 'write'), false)
  assert.equal(isPathAllowed('E:\\docs\\b.md', GRANTS, 'write'), false)
})

test('junction/symlink：传 realpath 之后的外部目标必须拒绝', () => {
  // 授权的是 C:\ws；C:\ws\link 是一个指向 C:\Windows 的 junction。
  // 调用方 realpath 之后拿到的是 C:\Windows\win.ini —— 纯判据只看这个真实路径。
  assert.equal(isPathAllowed('C:\\Windows\\win.ini', GRANTS), false)
  // 同一 junction 指向**授权目录内部**时（C:\ws\real）应当放行
  assert.equal(isPathAllowed('C:\\ws\\real\\a.md', GRANTS), true)
})

test('UNC：共享根内放行，别的共享/同前缀拒绝，大小写不敏感', () => {
  const g = { workspace: '\\\\SERVER\\Share\\ws' }
  assert.equal(isPathAllowed('\\\\server\\share\\ws\\a.md', g), true)
  assert.equal(isPathAllowed('\\\\SERVER\\SHARE\\WS\\notes\\a.md', g), true)
  assert.equal(isPathAllowed('\\\\server\\share\\ws2\\a.md', g), false)
  assert.equal(isPathAllowed('\\\\server\\other\\ws\\a.md', g), false)
})

test('尾随分隔符与盘符根', () => {
  assert.equal(isInsideDir('C:\\ws\\', 'C:\\ws\\a.md'), true)
  assert.equal(isPathAllowed('C:\\ws\\a.md\\', { workspace: 'C:\\ws\\' }), true)
  assert.equal(isPathAllowed('C:\\Windows\\x', { workspace: 'C:\\' }), true)
  assert.equal(isPathAllowed('D:\\x', { workspace: 'C:\\' }), false)
})

test('空授权 / 空路径：一律拒绝（不要因为"没数据"而放行）', () => {
  assert.equal(isPathAllowed('C:\\ws\\a.md', {}), false)
  assert.equal(isPathAllowed('', { workspace: 'C:\\ws' }), false)
  assert.equal(isPathAllowed('C:\\ws', {}), false)
})
