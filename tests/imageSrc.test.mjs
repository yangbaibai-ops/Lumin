// 图片相对路径解析（renderer/lib/imageSrc.ts）
//
// 这是本轮修的一个真实功能缺口：`![](img/a.png)` 以前按「页面目录」解析，相对图片渲染不出来；
// 现在按「文档目录」解析成绝对路径再交给 lumin-file:// 协议。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  imageSrcForDoc,
  isAbsolutePath,
  isExternalImageSrc,
  joinDocPath
} from '../src/renderer/src/lib/imageSrc.ts'

test('远程 / 内联图片原样返回', () => {
  for (const src of [
    'https://x/y.png',
    'http://x/y.png',
    'data:image/png;base64,AAA',
    'blob:x',
    '//cdn/x.png'
  ]) {
    assert.equal(imageSrcForDoc(src, 'D:\\notes'), src)
    assert.equal(isExternalImageSrc(src), true)
  }
})

test('相对路径按文档目录解析（Windows 绝对路径）', () => {
  assert.equal(imageSrcForDoc('img/a.png', 'D:\\notes'), 'lumin-file:///D%3A/notes/img/a.png')
})

test('`..` 上溯不会越过盘符', () => {
  assert.equal(joinDocPath('D:\\notes\\sub', '..\\img\\a.png'), 'D:\\notes\\img\\a.png')
  assert.equal(joinDocPath('D:\\notes', '..\\..\\..\\img\\a.png'), 'D:\\img\\a.png')
})

test('分隔符混用、`.` 与多余斜杠都能规范化', () => {
  assert.equal(joinDocPath('D:/notes/', './img//a.png'), 'D:/notes/img/a.png')
  assert.equal(joinDocPath('D:\\notes', 'img/a.png'), 'D:\\notes\\img\\a.png')
})

test('已经是绝对路径（含 UNC）时不拼文档目录', () => {
  assert.equal(isAbsolutePath('C:\\x\\a.png'), true)
  assert.equal(isAbsolutePath('C:/x/a.png'), true)
  assert.equal(isAbsolutePath('\\\\server\\share\\a.png'), true)
  assert.equal(isAbsolutePath('img/a.png'), false)
  assert.equal(imageSrcForDoc('C:\\x\\a.png', 'D:\\notes'), 'lumin-file:///C%3A/x/a.png')
})

test('没有文档目录时保持原样（不瞎猜）', () => {
  assert.equal(imageSrcForDoc('img/a.png', null), 'img/a.png')
})

test('URL 转义：空格 / 中文 / # 不会把 URL 拆坏', () => {
  const url = imageSrcForDoc('图 片#1.png', 'D:\\我的 笔记')
  assert.equal(
    url,
    'lumin-file:///D%3A/%E6%88%91%E7%9A%84%20%E7%AC%94%E8%AE%B0/%E5%9B%BE%20%E7%89%87%231.png'
  )
  // 逐段解码后应当还原成原始绝对路径
  const decoded = url
    .replace('lumin-file:///', '')
    .split('/')
    .map((seg) => decodeURIComponent(seg))
    .join('/')
  assert.equal(decoded, 'D:/我的 笔记/图 片#1.png')
})

test('POSIX 绝对路径（mac/Linux 场景）保留根', () => {
  assert.equal(joinDocPath('/home/u/notes', '../img/a.png'), '/home/u/img/a.png')
})
