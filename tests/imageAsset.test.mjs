// 插入图片的路径与命名规则（renderer/lib/imageAsset.ts）：纯函数，毫秒级。
//
// 为什么单独钉它：这三条规则各自都有"看起来对、实际会把文档写坏"的错法 ——
//   * 落点算错 → 图片写进了工作区根目录，文档换目录就找不到；
//   * 名字没时间戳 → 同一张截图粘两次，第二张覆盖第一张（图变成别的图）；
//   * 名字没过滤非法字符 → Windows 上直接写盘失败（`:` `?` `*` 都在非法字符表里）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ASSET_DIR,
  IMAGE_EXT_RE,
  assetDirFor,
  assetNameFor,
  dirOf,
  joinPath,
  stemOf
} from '../src/renderer/src/lib/imageAsset.ts'

test('joinPath：分隔符跟随传入路径，末尾多余斜杠不叠加', () => {
  assert.equal(joinPath('D:\\ws', 'assets'), 'D:\\ws\\assets')
  assert.equal(joinPath('D:\\ws\\', 'assets'), 'D:\\ws\\assets')
  assert.equal(joinPath('/home/u/ws', 'assets'), '/home/u/ws/assets')
})

test('dirOf / stemOf：没有分隔符 / 没有扩展名时也不炸', () => {
  assert.equal(dirOf('D:\\ws\\a.md'), 'D:\\ws')
  assert.equal(dirOf('/home/u/a.md'), '/home/u')
  assert.equal(dirOf('a.md'), '')
  assert.equal(stemOf('a.multi.md'), 'a.multi')
  assert.equal(stemOf('noext'), 'noext')
})

test('assetDirFor：优先工作区，其次文档目录，都没有则 null', () => {
  assert.equal(assetDirFor('D:\\ws', 'D:\\ws\\notes\\a.md'), `D:\\ws\\${ASSET_DIR}`)
  assert.equal(assetDirFor(null, 'D:\\ws\\notes\\a.md'), `D:\\ws\\notes\\${ASSET_DIR}`)
  assert.equal(assetDirFor(null, null), null)
  assert.equal(assetDirFor('', ''), null)
})

test('assetNameFor：带时间戳、保留扩展名、认得出来源', () => {
  const now = new Date('2026-09-24T15:30:12').getTime()
  assert.equal(assetNameFor('clipboard.png', now), 'clipboard-20260924-153012.png')
  assert.equal(assetNameFor('我的 截图.PNG', now), '我的-截图-20260924-153012.png')
  // 同一秒内两次调用得到同一个名字：唯一性靠主进程的 uniqueName 兜（这里是"通常够用"）
  assert.equal(assetNameFor('clipboard.png', now), assetNameFor('clipboard.png', now))
  // 不同秒必须不同名（否则第二张会覆盖第一张）
  assert.notEqual(assetNameFor('clipboard.png', now), assetNameFor('clipboard.png', now + 1000))
})

test('assetNameFor：过滤 Windows 非法字符，扩展名缺省 png', () => {
  const now = 0
  const name = assetNameFor('a:b*c?d|e"f<g>h.png', now)
  assert.ok(!/[:*?"|<>]/.test(name), `非法字符必须被过滤掉：${name}`)
  assert.ok(name.endsWith('.png'))
  assert.equal(assetNameFor('noext', now).endsWith('.png'), true)
})

test('IMAGE_EXT_RE：认常见图片，不认文档', () => {
  for (const ok of ['a.png', 'a.JPG', 'a.jpeg', 'a.gif', 'a.webp', 'a.svg', 'a.avif']) {
    assert.equal(IMAGE_EXT_RE.test(ok), true, `${ok} 应被认成图片`)
  }
  for (const no of ['a.md', 'a.txt', 'a.png.md', 'a']) {
    assert.equal(IMAGE_EXT_RE.test(no), false, `${no} 不该被认成图片`)
  }
})
