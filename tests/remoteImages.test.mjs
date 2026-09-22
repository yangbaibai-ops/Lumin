// ─── 远程图片隐私闸门（自查报告 H2）──────────────────────────────────────────
//
// 背景：`![x](https://tracker/px.png)` 原来**无条件加载** —— 打开别人的笔记/下载的文档
// 就会向外部发请求，泄露 IP 与「你在什么时间打开了这篇文档」。现在默认策略是
// `click`：浏览时渲染成占位（没有 `src` 属性 ⇒ 浏览器不会发请求），点一下才加载。
//
// 这里钉死决策函数与「导出必须放行」这两条纯逻辑；DOM 侧的点击加载由 CDP 套件
// `tools/_verify-remote-image.js` 验（见该文件的验收项）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  allowRemoteImage,
  beginExportRender,
  endExportRender,
  isRemoteHttp,
  needsRemotePermission,
  resetRemoteImageState
} from '../src/renderer/src/lib/remoteImages.ts'

test('识别远程图片：http/https/协议相对是，本地与内联不是', () => {
  for (const s of [
    'https://a.com/x.png',
    'http://a.com/x.png',
    'HTTPS://A.COM/x.png',
    '//cdn.a.com/x.png'
  ]) {
    assert.equal(isRemoteHttp(s), true, s)
  }
  for (const s of [
    'lumin-file:///D%3A/x.png',
    'data:image/png;base64,AAA',
    'img/a.png',
    '',
    './a.png'
  ]) {
    assert.equal(isRemoteHttp(s), false, s)
  }
})

test('默认策略 click：未放行的远程图需要权限；本地/内联/已放行的都不需要', () => {
  resetRemoteImageState()
  assert.equal(needsRemotePermission('https://a.com/x.png', 'click'), true)
  assert.equal(needsRemotePermission('lumin-file:///D%3A/x.png', 'click'), false, '本地图不受影响')
  assert.equal(needsRemotePermission('data:image/png;base64,AAA', 'click'), false, '内联图不受影响')
  allowRemoteImage('https://a.com/x.png')
  assert.equal(needsRemotePermission('https://a.com/x.png', 'click'), false, '放行后不再挡')
  assert.equal(needsRemotePermission('https://b.com/y.png', 'click'), true, '放行是按 URL 记的')
})

test('策略 always：一律不挡（旧行为的逃生门）', () => {
  resetRemoteImageState()
  assert.equal(needsRemotePermission('https://a.com/x.png', 'always'), false)
})

test('导出/复制 HTML 期间必须放行（否则导出的文档里图片全丢）', () => {
  resetRemoteImageState()
  assert.equal(needsRemotePermission('https://a.com/x.png', 'click'), true)
  beginExportRender()
  assert.equal(
    needsRemotePermission('https://a.com/x.png', 'click'),
    false,
    'getHTML() 期间必须给真实 src'
  )
  endExportRender()
  assert.equal(needsRemotePermission('https://a.com/x.png', 'click'), true, '窗口关闭后恢复拦截')
  // 深度计数：嵌套/异常情况下 endExportRender 多调几次不会把深度打成负数
  endExportRender()
  assert.equal(needsRemotePermission('https://a.com/x.png', 'click'), true)
})

test('放行是会话级、不落库（换一篇文档重新来过更安全）', () => {
  resetRemoteImageState()
  allowRemoteImage('https://a.com/x.png')
  assert.equal(needsRemotePermission('https://a.com/x.png', 'click'), false)
  resetRemoteImageState()
  assert.equal(needsRemotePermission('https://a.com/x.png', 'click'), true)
})

test('默认设置值是 click（改默认值必须是有意为之）', async () => {
  const { defaultSettings } = await import('../src/shared/defaults.ts')
  assert.equal(defaultSettings.remoteImages, 'click')
})
