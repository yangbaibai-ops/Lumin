// `lumin-file://` 的访问规则（shared/media.ts）
//
// 这是本轮的安全加固：协议等价于「把本地文件读给渲染层」，而渲染层渲染的是用户文档。
// 两道闸都必须能被单测钉住 —— 否则只能靠人工点，点不出来等于没有。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isMediaExtension, isWithinAnyRoot, normalizeMediaPath } from '../src/shared/media.ts'

test('媒体白名单：图片 / 音视频 / PDF 放行', () => {
  for (const p of [
    'a.png',
    'a.PNG',
    'a.jpg',
    'a.jpeg',
    'a.gif',
    'a.webp',
    'a.svg',
    'a.bmp',
    'a.avif',
    'a.ico',
    'a.mp4',
    'a.webm',
    'a.mp3',
    'a.wav',
    'a.pdf'
  ]) {
    assert.equal(isMediaExtension(p), true, p)
  }
})

test('媒体白名单：正文 / 配置 / 数据库 / 密钥一律不放行', () => {
  for (const p of [
    'notes.md',
    'config.json',
    'lumin.db',
    '.env',
    'id_rsa',
    'a.txt',
    'a.js',
    'a.exe',
    'a.png.txt',
    'a.svgz',
    'a.pdf.exe'
  ]) {
    assert.equal(isMediaExtension(p), false, p)
  }
})

test('归一：分隔符与大小写不影响判定', () => {
  assert.equal(normalizeMediaPath('D:/A/B/'), 'd:\\a\\b')
  assert.equal(isMediaExtension('D:\\Pics\\A.PNG'), true)
})

test('位置白名单：工作区之内放行', () => {
  assert.equal(isWithinAnyRoot('D:\\ws\\img\\a.png', ['D:\\ws']), true)
  assert.equal(isWithinAnyRoot('D:\\ws\\a.png', ['D:\\ws', null]), true)
})

test('位置白名单：按目录边界比较，`D:\\ws2` 不算在 `D:\\ws` 之内', () => {
  assert.equal(isWithinAnyRoot('D:\\ws2\\a.png', ['D:\\ws']), false)
})

test('位置白名单：多个根（工作区 + 已打开文档目录）任一命中即可', () => {
  assert.equal(isWithinAnyRoot('C:\\other\\a.png', [null, 'C:\\other']), true)
  assert.equal(isWithinAnyRoot('C:\\secret\\a.png', ['D:\\ws', 'C:\\other']), false)
})

test('位置白名单：空根 / 无根 → 一律不放行', () => {
  assert.equal(isWithinAnyRoot('C:\\x\\a.png', []), false)
  assert.equal(isWithinAnyRoot('C:\\x\\a.png', [null, undefined]), false)
})

test('大小写与分隔符混用不影响位置判定', () => {
  assert.equal(isWithinAnyRoot('d:/WS/IMG/a.PNG', ['D:\\ws']), true)
})
