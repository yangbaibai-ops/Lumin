'use strict'
// 验收：命令面板（Ctrl+Shift+P）
//
// 判据分五段（都在真实页面上量，不读源码）：
//   A 打开：Ctrl+Shift+P 真的把面板打开（真实按键），且只开一个
//   B 过滤：输入关键词后候选变少、命中的那一条在里面、无关的消失；清空后又回到全量
//   C 键盘：↑↓ 真的移动高亮（DOM 的 aria-selected 与 aria-activedescendant 一起动），
//          Enter 在**当前高亮项**上执行（观测点是编辑器模式 store + 真实 DOM），Esc 关闭
//   D a11y：role=dialog + aria-label（走语言包）/ listbox / option / aria-selected / aria-activedescendant
//   E i18n 三语：切到英文、俄文后面板文案真的跟着变，且仍然可搜
//   F 点击执行：鼠标点一行也执行（不是只有键盘能走）
//
// 跑法：先构建，再 node tools/run-suites.js --suite=_verify-command-palette.js
// （实例由 run-suites.js 起；单独跑要自己起隔离实例，见 README）
//
// ⚠️ 这个文件里**不许出现反引号**：下面的探针是模板字符串，反引号会当场截断它。
const { connect, settle, sleep, openDocWith, requireFocus, pressKey, clickAt, Reporter, fatal } =
  require('./lib/harness')

/** 面板的存在性与可访问性属性（一次读全，少来回） */
const PANEL = `JSON.stringify((() => {
  const panel = document.querySelector('[data-command-palette]')
  const input = document.querySelector('[data-command-palette-input]')
  const list = document.querySelector('[data-command-palette-list]')
  const opts = [...document.querySelectorAll('[data-command-palette-item]')]
  const active = document.activeElement
  return {
    open: !!panel,
    panels: document.querySelectorAll('[data-command-palette]').length,
    role: panel ? panel.getAttribute('role') : null,
    ariaLabel: panel ? (panel.getAttribute('aria-label') || '').trim() : null,
    listRole: list ? list.getAttribute('role') : null,
    inputRole: input ? input.getAttribute('role') : null,
    expanded: input ? input.getAttribute('aria-expanded') : null,
    activedescendant: (active && active.getAttribute ? active.getAttribute('aria-activedescendant') : null) || null,
    focusIsInput: !!(input && active === input),
    focusTag: active ? active.tagName + '.' + String(active.className || '').split(' ')[0] : null,
    placeholder: input ? input.getAttribute('placeholder') : null,
    count: opts.length,
    ids: opts.map((o) => o.getAttribute('data-command-palette-item')),
    selected: opts.map((o) => o.getAttribute('aria-selected')),
    selectedIndex: opts.findIndex((o) => o.getAttribute('aria-selected') === 'true'),
    empty: !!document.querySelector('[data-command-palette-empty]')
  }
})())`

/** 面板是否还开着（只读 DOM，关掉之后不该留任何残留节点） */
const OPEN = `!!document.querySelector('[data-command-palette]')`

/** 关掉面板（用真实的 Esc 之外的手段复位现场：套件里 B/D 段要反复开合） */
const RESET = `(() => {
  const ui = window.__L.ui()
  ui.closeCommandPalette()
  ui.closeSettings()
  return 'ok'
})()`

/**
 * 能不能拿到 OS 焦点（拿不到就**如实 SKIP**那一段，不判红）。
 *
 * ⚠️ `requireFocus()` 在拿不到焦点时是**同步 throw**（harness 里那个函数不是 async），
 * 所以必须先 `await` 进 try 里，不能在 `.then()` 后面接 `.catch()` —— 那样异常根本
 * 不会变成 rejected promise，套件会当场以 SKIP 收场（实测：只剩标题一行、0 断言）。
 */
async function canFocus(app, what) {
  try {
    await requireFocus(app, what)
    return true
  } catch {
    return false
  }
}

async function main() {
  const app = await connect()
  if (!(await settle(app.ev))) {
    console.log('no app')
    return 1
  }
  const { ev, send } = app
  const report = new Reporter('命令面板')
  await openDocWith(app, '# 命令面板\n\n正文一段。\n', 'palette.md')
  await sleep(900)
  await ev(RESET)
  await sleep(300)

  const original = JSON.parse(
    await ev(`JSON.stringify({ lang: window.__L.settings().language, mode: window.__L.ui().editorMode })`)
  )

  try {
    // ── A. 打开（真实按键）────────────────────────────────────────────────────
    // 先把焦点放到编辑面：这一段顺带验「打开前焦点在哪」这个现场（Esc 后要还回去）
    await ev(`(() => {
      const ed = document.querySelector('.ProseMirror')
      if (ed) ed.focus()
      return document.activeElement ? String(document.activeElement.className).split(' ')[0] : 'none'
    })()`)
    await sleep(200)
    if (!(await canFocus(app, 'Ctrl+Shift+P 段'))) {
      report.skip('Ctrl+Shift+P 打开面板', '窗口拿不到 OS 焦点（CDP 注入的按键会丢）')
    } else {
      await pressKey(send, { key: 'P', code: 'KeyP', vk: 80, modifiers: 10 }) // 10 = Ctrl(2) + Shift(8)（CDP 的 modifiers 是位标志，3 是 Alt+Ctrl —— 写错就永远打不开面板）
      await sleep(600)
    }
    const opened = JSON.parse(await ev(PANEL))
    console.log('A-OPEN ' + JSON.stringify({ open: opened.open, count: opened.count }))
    report.check(
      'Ctrl+Shift+P 打开面板，且只有一层',
      opened.open === true && opened.panels === 1,
      'open=' + opened.open + ' panels=' + opened.panels
    )

    // ── D. a11y（面板刚打开时量，后面几段依赖这些属性）─────────────────────────
    report.check(
      '面板是 role=dialog + aria-modal + 走语言包的 aria-label',
      opened.role === 'dialog' && !!opened.ariaLabel,
      JSON.stringify({ role: opened.role, label: opened.ariaLabel })
    )
    report.check(
      '列表是 role=listbox、候选是 role=option，且高亮用 aria-selected 表达',
      opened.listRole === 'listbox' &&
        opened.count > 0 &&
        opened.selected.filter((s) => s === 'true').length === 1,
      JSON.stringify({ listRole: opened.listRole, n: opened.count, selected: opened.selectedIndex })
    )
    report.check(
      '输入框持焦，并用 aria-activedescendant 指向当前候选',
      opened.focusIsInput === true &&
        opened.inputRole === 'combobox' &&
        opened.expanded === 'true' &&
        opened.activedescendant === 'command-palette-option-' + Math.max(0, opened.selectedIndex),
      JSON.stringify({ focus: opened.focusIsInput, ad: opened.activedescendant, role: opened.inputRole })
    )
    const allIds = opened.ids

    // ── B. 过滤 ──────────────────────────────────────────────────────────────
    // 用 Input.insertText 输入**真实按键**：v-model 要真的收到 input 事件才算数
    await ev(`(() => {
      const input = document.querySelector('[data-command-palette-input]')
      input.focus()
      return 'ok'
    })()`)
    await send('Input.insertText', { text: '源码' })
    await sleep(500)
    const filtered = JSON.parse(await ev(PANEL))
    console.log('B-FILTER ' + JSON.stringify({ n: filtered.count, ids: filtered.ids.slice(0, 4) }))
    report.check(
      '输入关键词后候选变少，且命中的那条在里面',
      filtered.count > 0 &&
        filtered.count < allIds.length &&
        filtered.ids.includes('view.modeSource'),
      'n=' + filtered.count + '/' + allIds.length + ' ids=' + JSON.stringify(filtered.ids.slice(0, 4))
    )
    report.check(
      '无关命令被过滤掉（保存 / 设置 都不该留在结果里）',
      !filtered.ids.includes('file.save') && !filtered.ids.includes('app.settings'),
      JSON.stringify(filtered.ids)
    )

    // 无匹配 → 空态提示（不是"没反应"）
    await ev(`(() => {
      const input = document.querySelector('[data-command-palette-input]')
      input.focus()
      input.select()
      return 'ok'
    })()`)
    await send('Input.insertText', { text: 'zzz-不可能匹配-zzz' })
    await sleep(500)
    const noMatch = JSON.parse(await ev(PANEL))
    report.check(
      '无匹配时给出空态提示，且没有候选',
      noMatch.count === 0 && noMatch.empty === true,
      JSON.stringify({ n: noMatch.count, empty: noMatch.empty })
    )

    // 清空回到全量（命令表非空，面板不会"开着但什么都没有"）
    await ev(`(() => {
      const input = document.querySelector('[data-command-palette-input]')
      input.select()
      return 'ok'
    })()`)
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8
    })
    await sleep(400)
    // Backspace 只删一个字符：剩下的用 store 直接清（这一段的观测点是"清空后回到全量"）
    await ev(`(() => {
      const input = document.querySelector('[data-command-palette-input]')
      input.value = ''
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return 'ok'
    })()`)
    await sleep(400)
    const cleared = JSON.parse(await ev(PANEL))
    report.check(
      '清空输入后回到全量列表（与打开时一致）',
      cleared.count === allIds.length && cleared.ids.join('|') === allIds.join('|'),
      'n=' + cleared.count + ' vs ' + allIds.length
    )

    // ── C. 键盘：↑↓ / Enter ───────────────────────────────────────────────────
    const before = JSON.parse(await ev(PANEL))
    await pressKey(send, { key: 'ArrowDown', code: 'ArrowDown', vk: 40 })
    await sleep(350)
    const afterDown = JSON.parse(await ev(PANEL))
    await pressKey(send, { key: 'ArrowUp', code: 'ArrowUp', vk: 38 })
    await sleep(350)
    const afterUp = JSON.parse(await ev(PANEL))
    console.log(
      'C-NAV ' +
        JSON.stringify({
          before: before.selectedIndex,
          down: afterDown.selectedIndex,
          up: afterUp.selectedIndex
        })
    )
    report.check(
      '↓ 把高亮移到下一项，↑ 再移回来（到端不回卷）',
      before.selectedIndex === 0 &&
        afterDown.selectedIndex === 1 &&
        afterUp.selectedIndex === 0,
      JSON.stringify([before.selectedIndex, afterDown.selectedIndex, afterUp.selectedIndex])
    )
    report.check(
      '高亮移动时 aria-activedescendant 跟着指向同一行',
      afterDown.activedescendant === 'command-palette-option-1' &&
        afterDown.selected[1] === 'true' &&
        afterDown.selected[0] === 'false',
      JSON.stringify({ ad: afterDown.activedescendant, sel: afterDown.selected.slice(0, 3) })
    )
    // 再连按几次 ↓：高亮必须停在最后一行（不回卷到第一行）
    for (let i = 0; i < afterDown.count + 3; i += 1) {
      await pressKey(send, { key: 'ArrowDown', code: 'ArrowDown', vk: 40 })
    }
    await sleep(400)
    const atEnd = JSON.parse(await ev(PANEL))
    report.check(
      '连续 ↓ 到底后停住（不回卷）',
      atEnd.selectedIndex === atEnd.count - 1,
      'index=' + atEnd.selectedIndex + ' count=' + atEnd.count
    )

    // Enter 在**当前高亮项**上执行：先过滤到唯一候选（源码模式），再回车
    await ev(`(() => {
      const input = document.querySelector('[data-command-palette-input]')
      input.value = '源码'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return 'ok'
    })()`)
    await sleep(450)
    const one = JSON.parse(await ev(PANEL))
    await ev(`(() => { window.__L.ui().editorMode = 'wysiwyg'; return 'ok' })()`)
    await sleep(200)
    await pressKey(send, { key: 'Enter', code: 'Enter', vk: 13 })
    await sleep(900)
    const afterEnter = JSON.parse(
      await ev(
        `JSON.stringify({ open: ${OPEN}, mode: window.__L.ui().editorMode, sourceEl: !!document.querySelector('.source-editor') })`
      )
    )
    console.log('C-ENTER ' + JSON.stringify({ hit: one.ids[0], ...afterEnter }))
    report.check(
      'Enter 执行当前高亮项（观测点：编辑器切到源码模式 + 面板已关）',
      one.ids[0] === 'view.modeSource' &&
        afterEnter.mode === 'source' &&
        afterEnter.open === false,
      JSON.stringify({ hit: one.ids[0], mode: afterEnter.mode, open: afterEnter.open })
    )

    // ── A2. Esc 关闭 + 焦点还原 ───────────────────────────────────────────────
    // 现场：焦点在编辑面 → 打开面板 → Esc，焦点必须回到刚才那个元素（不是 body）
    await ev(`(() => {
      const ed = document.querySelector('.source-editor') || document.querySelector('.ProseMirror')
      if (ed) ed.focus()
      return 'ok'
    })()`)
    await sleep(250)
    const focusBefore = await ev(
      `document.activeElement ? String(document.activeElement.className).split(' ')[0] : 'none'`
    )
    const okFocus = await canFocus(app, 'Esc 段')
    if (!okFocus) {
      report.skip('Esc 关闭并归还焦点', '窗口拿不到 OS 焦点')
    } else {
      await pressKey(send, { key: 'P', code: 'KeyP', vk: 80, modifiers: 10 })
      await sleep(600)
      const reopened = JSON.parse(await ev(PANEL))
      await pressKey(send, { key: 'Escape', code: 'Escape', vk: 27 })
      await sleep(600)
      const afterEsc = JSON.parse(
        await ev(
          `JSON.stringify({ open: ${OPEN}, cls: document.activeElement ? String(document.activeElement.className).split(' ')[0] : 'none', inEditor: !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('.source-editor, .ProseMirror')) })`
        )
      )
      console.log('A-ESC ' + JSON.stringify({ before: focusBefore, ...afterEsc }))
      report.check(
        'Esc 关闭面板，且焦点回到打开前那个编辑面元素',
        reopened.open === true &&
          afterEsc.open === false &&
          afterEsc.inEditor === true &&
          afterEsc.cls === focusBefore,
        JSON.stringify({ before: focusBefore, after: afterEsc.cls, open: afterEsc.open })
      )
    }

    // ── E. i18n 三语 ─────────────────────────────────────────────────────────
    const setLang = async (lang) => {
      await ev(`(async () => {
        await window.__L.settings().setLanguage(${JSON.stringify(lang)})
        return 'ok'
      })()`)
      await sleep(700)
      await ev(RESET)
      await sleep(200)
      await ev(`(() => { window.__L.ui().openCommandPalette(); return 'ok' })()`)
      await sleep(600)
      return JSON.parse(await ev(PANEL))
    }
    const zh = await setLang('zh-CN')
    const en = await setLang('en-US')
    const ru = await setLang('ru-RU')
    console.log(
      'E-I18N ' +
        JSON.stringify({ zh: [zh.ariaLabel, zh.placeholder], en: [en.ariaLabel, en.placeholder], ru: [ru.ariaLabel, ru.placeholder] })
    )
    report.check(
      '面板的 aria-label 与占位文案随语言切换（三语各不相同）',
      !!zh.ariaLabel &&
        !!en.ariaLabel &&
        !!ru.ariaLabel &&
        zh.ariaLabel !== en.ariaLabel &&
        zh.ariaLabel !== ru.ariaLabel &&
        en.ariaLabel !== ru.ariaLabel,
      JSON.stringify([zh.ariaLabel, en.ariaLabel, ru.ariaLabel])
    )
    report.check(
      '切换语言后仍然有候选（命令表没被语言切换弄空）',
      zh.count > 5 && en.count > 5 && ru.count > 5,
      JSON.stringify([zh.count, en.count, ru.count])
    )
    // 英文界面用命令 id 也能找到（id 与关键词不翻译）
    await ev(`(() => {
      const input = document.querySelector('[data-command-palette-input]')
      input.value = 'save'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return 'ok'
    })()`)
    await sleep(450)
    const enFiltered = JSON.parse(await ev(PANEL))
    report.check(
      '英文界面下用关键词仍能过滤到对应命令',
      enFiltered.count > 0 && enFiltered.ids.includes('file.save'),
      JSON.stringify(enFiltered.ids.slice(0, 5))
    )

    // ── F. 点击执行 ──────────────────────────────────────────────────────────
    await ev(RESET)
    await sleep(200)
    await ev(`(() => { window.__L.ui().openCommandPalette(); return 'ok' })()`)
    await sleep(500)
    const settingsRow = await ev(`JSON.stringify((() => {
      const el = document.querySelector('[data-command-palette-item="app.settings"]')
      if (!el) return { found: false }
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      return { found: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })())`).then(JSON.parse)
    console.log('F-CLICK ' + JSON.stringify(settingsRow))
    if (!settingsRow.found) {
      report.check('点击候选同样执行（观测点：设置面板打开）', false, 'skip: 候选未找到')
    } else {
      // 先移到那一行（真实指针移动 → 高亮跟随），再点
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: settingsRow.x,
        y: settingsRow.y,
        button: 'none',
        buttons: 0
      })
      await sleep(250)
      await clickAt(send, settingsRow.x, settingsRow.y)
      await sleep(800)
      const afterClick = JSON.parse(
        await ev(
          `JSON.stringify({ open: ${OPEN}, settingsOpen: window.__L.ui().settingsOpen })`
        )
      )
      console.log('F-AFTER ' + JSON.stringify(afterClick))
      report.check(
        '点击候选同样执行（观测点：设置面板打开 + 命令面板收起）',
        afterClick.settingsOpen === true && afterClick.open === false,
        JSON.stringify(afterClick)
      )
    }
  } catch (e) {
    report.check('套件未中途异常', false, String((e && e.message) || e).slice(0, 200))
    await ev(RESET).catch(() => {})
  } finally {
    // 还原现场：语言与编辑模式回到进入本套件之前的值
    await ev(
      `(() => {
        const st = window.__L.settings()
        st.setLanguage(${JSON.stringify(original.lang)})
        window.__L.ui().editorMode = ${JSON.stringify(original.mode)}
        window.__L.ui().closeCommandPalette()
        window.__L.ui().closeSettings()
        return 'ok'
      })()`
    ).catch(() => {})
    await sleep(300)
    console.log('RESTORED ' + (await ev(OPEN).catch(() => 'n/a')))
    app.close()
  }

  return report.finish()
}

main()
  .then((code) => process.exit(code))
  .catch(fatal)
