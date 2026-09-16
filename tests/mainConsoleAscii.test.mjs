// 主进程 console 输出必须是纯 ASCII。
//
// 为什么要有这条：Windows 控制台按**代码页**解读写出去的字节（中文系统是 936/GBK），而我们写的是
// UTF-8 —— 中文必然乱码，而且行尾那个非法尾字节会把**换行一起吃掉**（实测：「已有实例在运行」
// 在用户终端里显示成「宸叉湁瀹炰緥鍦ㄨ繍琛?」，并把它后面的换行吞了）。
// 想不乱码就得先认出「这是控制台」再交给 Node 转码（WriteConsoleW），但 Electron 主进程在
// Windows 上判断不了：Electron 自己把 `isTTY` 的 spec 标成「on some machines 不可靠」压掉了
// （electron/electron@62b1034），本机实测控制台/管道两种落点都拿不到可信信号。
//
// 所以规矩是：**主进程的 console 输出一律 ASCII**，中文说明留在界面与文档里。
// 违反这条规矩不会有任何报错，只会在用户终端里显示成乱码 —— 而乱码又很容易被误判成
// 「用户环境有问题」，所以拿一条测试钉住它（比 review 时的肉眼检查可靠）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MAIN_DIR = new URL('../src/main/', import.meta.url)

/** src/main 下的所有 .ts（递归） */
function tsFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsFiles(p))
    else if (entry.name.endsWith('.ts')) out.push(p)
  }
  return out
}

const CALL = /console\.(?:log|warn|error|info|debug)\s*\(/g

/** 去掉注释（字符串字面量原样保留；防止 `// console.log('中文')` 这种注释被误判成真调用） */
function stripComments(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      out += c
      i += 1
      while (i < src.length) {
        const ch = src[i]
        out += ch
        if (ch === '\\') {
          out += src[i + 1] ?? ''
          i += 2
          continue
        }
        i += 1
        if (ch === c) break
      }
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += c
    i += 1
  }
  return out
}

/**
 * 取出每个 `console.xxx(...)` 的**实参文本**（不含外层括号）。
 * 细节：跳过字符串字面量里的括号（但它本身要保留，被检查的就是它）；剥掉实参里的注释。
 */
function consoleArgTexts(src) {
  const out = []
  CALL.lastIndex = 0
  let m
  while ((m = CALL.exec(src)) !== null) {
    let i = m.index + m[0].length
    let depth = 1
    let text = ''
    while (i < src.length && depth > 0) {
      const c = src[i]
      if (c === "'" || c === '"' || c === '`') {
        text += c
        i += 1
        while (i < src.length) {
          const ch = src[i]
          text += ch
          if (ch === '\\') {
            text += src[i + 1] ?? ''
            i += 2
            continue
          }
          i += 1
          if (ch === c) break
        }
        continue
      }
      if (c === '/' && src[i + 1] === '/') {
        while (i < src.length && src[i] !== '\n') i += 1
        continue
      }
      if (c === '/' && src[i + 1] === '*') {
        i += 2
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1
        i += 2
        continue
      }
      if (c === '(') depth += 1
      else if (c === ')') {
        depth -= 1
        if (depth === 0) break
      }
      text += c
      i += 1
    }
    out.push(text)
  }
  return out
}

/** 找出源码里 console 实参中的非 ASCII（返回可读片段） */
function nonAsciiConsoleArgs(src) {
  const offenders = []
  for (const text of consoleArgTexts(stripComments(src))) {
    if ([...text].some((c) => c.codePointAt(0) > 0x7f)) {
      offenders.push(text.trim().replace(/\s+/g, ' ').slice(0, 80))
    }
  }
  return offenders
}

test('扫描器本身先自证：能捞到 console 调用，并认出其中的中文', () => {
  const sample = `
    // console.log('注释里的中文不算')
    console.warn(\`[x] 中文 \${a} (括号)\`)
    /* console.error('中文') */
  `
  const texts = consoleArgTexts(stripComments(sample))
  assert.equal(texts.length, 1, '注释里的 console 调用不该被算进来')
  assert.match(texts[0], /中文/)
  assert.equal(nonAsciiConsoleArgs(sample).length, 1, '中文实参必须被认出来')
  assert.deepEqual(nonAsciiConsoleArgs(`console.log('[ok] ascii only')`), [])
})

test('主进程 console 输出没有非 ASCII 字符（Windows 控制台代码页安全）', () => {
  const files = tsFiles(MAIN_DIR.pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  // 扫不到文件说明路径写错了：这条测试必须真的覆盖到主进程，不能「空扫通过」
  assert.ok(files.length >= 10, `src/main 下只扫到 ${files.length} 个 .ts，路径可能写错了`)

  const offenders = []
  for (const file of files) {
    for (const text of nonAsciiConsoleArgs(readFileSync(file, 'utf-8'))) {
      offenders.push(`${file.split(/[\\/]/).pop()}: ${text}`)
    }
  }
  assert.deepEqual(offenders, [], 'console 输出里出现非 ASCII 字符，会在用户终端里变乱码')
})
