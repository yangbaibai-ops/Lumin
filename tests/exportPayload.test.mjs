// ─── 导出请求必须是「可结构化克隆的普通对象」──────────────────────────────────
//
// 来源：自查报告 H1 的副产物。原来这条不变量由两个 GUI 套件守着
// （`tools/_verify-export-fix.js` / `_verify-export-fix2.js`），而它们靠 monkey-patch
// `window.luminAPI.export.pdf` 截获调用 —— `contextBridge` 暴露的对象是**只读**的，
// 补丁从未生效：一个长期红（退出码 1）、一个 0 断言。于是这条**真实存在过的 bug**
// （Pinia 响应式代理过不了 IPC，"could not be cloned" → 导出 PDF 必失败）在代码里
// 没有任何有效保护。
//
// 现在把构造逻辑抽成纯函数 `exportRequest()`（src/renderer/src/lib/exportPayload.ts），
// 用 Node 单测钉死两件事：
//   1. 传进去的**代理对象**不会被原样带出（产物必须能 structuredClone）；
//   2. 四个通道的字段与选项与 preload 的类型逐字对齐。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exportRequest } from '../src/renderer/src/lib/exportPayload.ts'

const DOC = { title: '文档', html: '<p>正文</p>', css: 'body{}' }

/** 模拟 Pinia 的响应式代理：structuredClone 对 Proxy 会抛 DataCloneError */
function reactive(obj) {
  return new Proxy(obj, {
    get(t, k) {
      if (k === '__v_isReactive') return true
      return t[k]
    }
  })
}

test('先证明这个测试是有牙齿的：Proxy 本身 clone 不了', () => {
  const proxy = reactive({ margin: 20 })
  assert.throws(() => structuredClone(proxy), /could not be cloned|could not be cloned/i)
})

test('pdf：载荷与选项都是普通对象，且能 structuredClone（设置是响应式代理）', () => {
  const settings = reactive({
    export: { pdf: reactive({ margin: 20, pageSize: 'A4' }) },
    language: 'zh-CN'
  })
  const req = exportRequest('pdf', DOC, {
    pdfMargin: settings.export.pdf.margin,
    pdfPageSize: settings.export.pdf.pageSize,
    language: settings.language,
    author: 'Lumin'
  })
  assert.doesNotThrow(() => structuredClone(req.args))
  assert.doesNotThrow(() => structuredClone(req.options))
  assert.deepEqual(structuredClone(req.args), { title: '文档', html: '<p>正文</p>', css: 'body{}' })
  assert.deepEqual(structuredClone(req.options), { margin: 20, pageSize: 'A4' })
  // 产物必须是**普通对象**（不是代理）：getPrototypeOf 是 Object.prototype
  assert.equal(Object.getPrototypeOf(req.args), Object.prototype)
  assert.equal(Object.getPrototypeOf(req.options), Object.prototype)
})

test('html / word：单参数载荷，没有 options', () => {
  for (const format of ['html', 'word']) {
    const req = exportRequest(format, DOC, {
      pdfMargin: 20,
      pdfPageSize: 'A4',
      language: 'en-US',
      author: 'Lumin'
    })
    assert.equal(req.options, null, format)
    assert.deepEqual(structuredClone(req.args), {
      title: '文档',
      html: '<p>正文</p>',
      css: 'body{}'
    })
  }
})

test('epub：带 author / lang 的元数据，且 clone 得动', () => {
  const req = exportRequest('epub', DOC, {
    pdfMargin: 20,
    pdfPageSize: 'A4',
    language: 'ru-RU',
    author: 'Lumin'
  })
  assert.equal(req.options, null)
  assert.deepEqual(structuredClone(req.args), {
    title: '文档',
    author: 'Lumin',
    lang: 'ru-RU',
    html: '<p>正文</p>',
    css: 'body{}'
  })
})

test('四个通道的 args 键集合与 preload 类型一致（防止漏字段）', () => {
  const keySets = {
    pdf: ['css', 'html', 'title'],
    html: ['css', 'html', 'title'],
    word: ['css', 'html', 'title'],
    epub: ['author', 'css', 'html', 'lang', 'title']
  }
  for (const [format, expect] of Object.entries(keySets)) {
    const req = exportRequest(format, DOC, {
      pdfMargin: 20,
      pdfPageSize: 'A4',
      language: 'zh-CN',
      author: 'Lumin'
    })
    assert.deepEqual(Object.keys(req.args).sort(), expect, format)
  }
})
