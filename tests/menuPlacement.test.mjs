// 浮层落点几何（`src/renderer/src/lib/menuPlacement.ts`）。
//
// 这段几何此前在三个组件里各写了一遍（审计 §10 P1「重复实现：菜单定位 3 份」），
// 而它踩过的坑是**功能性**的：子菜单与父面板之间留过 2px 空档，配合 mouseleave 立即收起，
// 表现成"怎么都移不到二级菜单上"。所以单测要钉住的不是"公式对不对"，而是这几条**用户可见**的规则：
//   * 一级菜单贴边不溢出；
//   * 子菜单与父面板**重叠**（不留空档），右侧放不下就翻到左侧且仍然贴死；
//   * 子菜单上沿对齐父项行（并夹在视口内）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  MENU_MARGIN,
  SUBMENU_OVERLAP,
  SUBMENU_ROW_OFFSET,
  placeAtPoint,
  placeSubmenu,
  placeSubmenuX
} from '../src/renderer/src/lib/menuPlacement.ts'

const VP = { width: 1000, height: 800 }

test('一级菜单：正常位置原样，右下越界时夹到 margin 内', () => {
  assert.deepEqual(placeAtPoint(100, 200, { width: 200, height: 300 }, VP), { left: 100, top: 200 })
  const br = placeAtPoint(950, 780, { width: 200, height: 300 }, VP)
  assert.deepEqual(br, { left: VP.width - 200 - MENU_MARGIN, top: VP.height - 300 - MENU_MARGIN })
  // 左上越界同样夹住（负坐标）
  assert.deepEqual(placeAtPoint(-50, -50, { width: 200, height: 300 }, VP), {
    left: MENU_MARGIN,
    top: MENU_MARGIN
  })
  // 元素比视口还大：仍然给 margin（不能算出负数）
  const huge = placeAtPoint(10, 10, { width: 1200, height: 900 }, VP)
  assert.equal(huge.left, MENU_MARGIN)
  assert.equal(huge.top, MENU_MARGIN)
})

test('子菜单横向：右侧放得下就贴死父面板（重叠 1px）', () => {
  const r = placeSubmenuX({ parentLeft: 100, parentRight: 260, width: 200, viewportWidth: 1000 })
  assert.equal(r.flipped, false)
  assert.equal(r.left, 260 - SUBMENU_OVERLAP, '必须重叠 1px：留空档会让指针移不进去')
})

test('子菜单横向：右侧放不下就翻到左侧，且同样贴死', () => {
  const r = placeSubmenuX({ parentLeft: 700, parentRight: 900, width: 220, viewportWidth: 1000 })
  assert.equal(r.flipped, true)
  assert.equal(r.left, 700 - 220 + SUBMENU_OVERLAP)
  // 翻过去仍然不该小于 margin
  const narrow = placeSubmenuX({
    parentLeft: 10,
    parentRight: 900,
    width: 400,
    viewportWidth: 1000
  })
  assert.equal(narrow.flipped, true)
  assert.equal(narrow.left, MENU_MARGIN)
})

test('子菜单完整定位：上沿对齐父项行（带固定偏移）并夹在视口内', () => {
  const fits = placeSubmenu({
    parentLeft: 100,
    parentRight: 260,
    rowTop: 300,
    size: { width: 200, height: 240 },
    viewport: VP
  })
  assert.equal(fits.top, 300 + SUBMENU_ROW_OFFSET)
  assert.equal(fits.flipped, false)
  assert.equal(fits.left, 260 - SUBMENU_OVERLAP)

  // 靠近底部：夹到 height - h - margin
  const bottom = placeSubmenu({
    parentLeft: 100,
    parentRight: 260,
    rowTop: 780,
    size: { width: 200, height: 240 },
    viewport: VP
  })
  assert.equal(bottom.top, VP.height - 240 - MENU_MARGIN)
  // 靠近顶部（rowTop 很小 + 负偏移）：夹到 margin
  const top = placeSubmenu({
    parentLeft: 100,
    parentRight: 260,
    rowTop: 2,
    size: { width: 200, height: 240 },
    viewport: VP
  })
  assert.equal(top.top, MENU_MARGIN)
})

test('三个入口共用这一份几何：组件里不许再出现自己的翻转/钳制公式', () => {
  /**
   * 这条是"去重"的守卫。重复的代价不是难看：上一次修"子菜单移不进去"时只改了其中一份。
   * 判据：三个组件都必须 import `lib/menuPlacement`，且不再出现本地公式特征串。
   */
  const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const files = [
    'src/renderer/src/components/ContextMenu.vue',
    'src/renderer/src/components/EditorContextMenu.vue',
    'src/renderer/src/components/TopMenuBar.vue'
  ]
  const FORBIDDEN = [/panelRect\.right \+ w >/, /base\.right \+ w >/, /innerWidth - w - margin/]
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf-8')
    assert.match(src, /from '\.\.\/lib\/menuPlacement'/, `${f} 没有 import lib/menuPlacement`)
    for (const re of FORBIDDEN) {
      assert.doesNotMatch(src, re, `${f} 里还有本地写的定位公式（${re}）—— 几何应当只有一处实现`)
    }
  }
  // 这两个常量是"贴死"与"留白"的口径，改动要显式（并同步更新的测试期望）
  assert.equal(SUBMENU_OVERLAP, 1)
  assert.equal(MENU_MARGIN, 8)
})
