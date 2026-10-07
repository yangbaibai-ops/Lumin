// 可打开的文本类型清单（`src/shared/textFiles.ts`）：**唯一真相源**的单测。
//
// 为什么这一条值得单独钉住（第七轮）：这条清单以前散在六处（文件树扫描 / 索引 / 链接 /
// 对话框 filters / 拖入白名单 / 重命名与导出标题），抄出来的副本一旦漂移就会出现
// "对话框里能选、拖进来提示不支持"或者"能拖进来打开、树里却看不见"这类自相矛盾。
// 所以本文件既验**判据本身**，也验**接线只有一处**（静态：清单字面量只许出现在 textFiles.ts）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MARKDOWN_EXTENSIONS,
  MARKDOWN_EXT_RE,
  PLAIN_TEXT_EXTENSIONS,
  TEXT_FILE_EXTENSIONS,
  fileExtension,
  isMarkdownName,
  isPlainTextExtension,
  isPlainTextName,
  isTextExtension,
  isTextFileName,
  openFileDialogFilters,
  saveDefaultName,
  stripTextExtension
} from '../src/shared/textFiles.ts'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

test('清单：含 .txt（用户口径）与已核定的纯文本族', () => {
  for (const ext of ['txt', 'text', 'log', 'ini', 'cfg']) {
    assert.ok(TEXT_FILE_EXTENSIONS.includes(ext), `清单里必须有 ${ext}`)
  }
  for (const ext of ['md', 'markdown', 'mdown', 'mkd']) {
    assert.ok(MARKDOWN_EXTENSIONS.includes(ext), `Markdown 家族必须有 ${ext}`)
  }
  // 两个家族**不相交**，"是不是纯文本"才有一个唯一答案
  for (const ext of PLAIN_TEXT_EXTENSIONS) {
    assert.ok(!MARKDOWN_EXTENSIONS.includes(ext), `${ext} 不该同时在两个家族里`)
  }
})

test('清单：结构化数据 / 标记语言 / 源码**故意不在**里面（保守口径，写进断言免得被顺手加进来）', () => {
  const banned = [
    'json',
    'jsonc',
    'yaml',
    'yml',
    'toml',
    'csv',
    'tsv',
    'html',
    'htm',
    'xml',
    'svg',
    'js',
    'ts',
    'py',
    'go',
    'rs',
    'rst',
    'adoc',
    'tex'
  ]
  for (const ext of banned) {
    assert.ok(
      !TEXT_FILE_EXTENSIONS.includes(ext),
      `${ext} 不该被当成"可打开的纯文本"（理由见 shared/textFiles.ts 的注释；svg 更是本项目的图片类型）`
    )
  }
})

test('fileExtension：与 node:path.extname 同口径（前导点不算扩展名、大小写折叠、带路径也行）', () => {
  assert.equal(fileExtension('a.txt'), 'txt')
  assert.equal(fileExtension('A.TXT'), 'txt')
  assert.equal(fileExtension('D:\\ws\\note.log'), 'log')
  assert.equal(fileExtension('/ws/note.INI'), 'ini')
  assert.equal(fileExtension('.env'), '', '前导点（dotfile）没有扩展名')
  assert.equal(fileExtension('README'), '')
  assert.equal(fileExtension('a.tar.gz'), 'gz')
  assert.equal(fileExtension(null), '')
  assert.equal(fileExtension(undefined), '')
})

test('判据：isTextFileName / isMarkdownName / isPlainTextName 三者的关系', () => {
  assert.equal(isTextFileName('a.txt'), true)
  assert.equal(isTextFileName('a.log'), true)
  assert.equal(isTextFileName('a.md'), true)
  assert.equal(isTextFileName('a.json'), false)
  assert.equal(isTextFileName('a.svg'), false)
  assert.equal(isMarkdownName('a.md'), true)
  assert.equal(isMarkdownName('a.markdown'), true)
  assert.equal(isMarkdownName('a.txt'), false, 'txt 不是 Markdown 家族（渲染面会曲解它）')
  assert.equal(isPlainTextName('a.txt'), true)
  assert.equal(isPlainTextName('a.log'), true)
  assert.equal(isPlainTextName('a.md'), false)
  assert.equal(isPlainTextName('a.json'), false)
  assert.equal(isPlainTextExtension('CFG'), true)
  assert.equal(isTextExtension('TXT'), true)
  // 大小写不敏感（Windows 用户可能存成 A.TXT）
  assert.equal(isTextFileName('A.TXT'), true)
  assert.equal(MARKDOWN_EXT_RE.test('B.MARKDOWN'), true)
})

test('stripTextExtension：只去掉**已知文本类型**的后缀（重命名选中主干 / 导出标题共用）', () => {
  assert.equal(stripTextExtension('a.txt'), 'a')
  assert.equal(stripTextExtension('a.markdown'), 'a')
  assert.equal(stripTextExtension('我的日志.log'), '我的日志')
  assert.equal(stripTextExtension('a.json'), 'a.json', '不在清单里的后缀原样保留（不能顺手剥掉）')
  assert.equal(stripTextExtension('README'), 'README')
  assert.equal(stripTextExtension('.env'), '.env')
  assert.equal(stripTextExtension('a.b.txt'), 'a.b', '只剥最后一个后缀')
})

test('saveDefaultName：另存为**保留原扩展名**（a.txt 不许变成 a.txt.md / a.md）', () => {
  assert.deepEqual(saveDefaultName('a.txt'), { name: 'a.txt', ext: 'txt' })
  assert.deepEqual(saveDefaultName('run.log'), { name: 'run.log', ext: 'log' })
  assert.deepEqual(saveDefaultName('app.ini'), { name: 'app.ini', ext: 'ini' })
  assert.deepEqual(saveDefaultName('notes.md'), { name: 'notes.md', ext: 'md' })
  // 未命名缓冲区：名字里本来就有 .md → 保持
  assert.deepEqual(saveDefaultName('Untitled-3.md'), { name: 'Untitled-3.md', ext: 'md' })
  // 名字里确实没有已知文本后缀 → 兜底按 .md（新建文档的既有口径）
  assert.deepEqual(saveDefaultName('Untitled-3'), { name: 'Untitled-3.md', ext: 'md' })
  // 别的后缀（例如用户把 a.json 另存为）不接盘 → 仍按 .md 兜底，不假装支持 json
  assert.deepEqual(saveDefaultName('a.json'), { name: 'a.json.md', ext: 'md' })
})

test('对话框过滤器**派生自**同一份清单（不是又抄一份数组）', () => {
  const filters = openFileDialogFilters('文本文档')
  assert.equal(filters.length, 1)
  assert.deepEqual(filters[0].extensions, [...TEXT_FILE_EXTENSIONS])
  assert.equal(filters[0].name, '文本文档', '过滤器标题由调用方给（i18n），扩展名清单由这里给')
  // 过滤器必须与判据同源：清单里每个后缀都能被 isTextFileName 认，反之亦然
  for (const ext of filters[0].extensions) {
    assert.equal(isTextFileName(`x.${ext}`), true, `过滤器里的 ${ext} 必须能被判据认出来`)
  }
})

test('接线守卫：扩展名清单只许出现在 textFiles.ts（六处副本不许长回来）', () => {
  /**
   * 判据：`md|markdown|mdown|mkd` 这种"Markdown 家族字面量"除了真相源之外，
   * src 下任何文件都不该再有；`['md', ...]` 这种数组同理。
   * 注释里**提到**这些后缀是允许的（上面多处注释就在解释清单），所以先剥注释再判。
   */
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\w])\/\/[^\n]*/g, '$1')
  const offenders = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) walk(rel)
      else if (/\.(ts|vue)$/.test(e.name)) {
        if (rel.endsWith('src/shared/textFiles.ts')) continue
        const body = strip(fs.readFileSync(path.join(ROOT, rel), 'utf-8'))
        if (/markdown\|mdown|mdown\|mkd|'md',\s*'markdown'|"md",\s*"markdown"/.test(body)) {
          offenders.push(rel)
        }
      }
    }
  }
  walk('src')
  assert.deepEqual(
    offenders,
    [],
    `这些文件里又抄了一份扩展名清单（应该从 src/shared/textFiles.ts 派生）：\n${offenders.join('\n')}`
  )

  // 关键接线点各自用的是真相源，而不是就地写死的判据
  const dropped = fs.readFileSync(
    path.join(ROOT, 'src', 'renderer', 'src', 'lib', 'droppedPath.ts'),
    'utf-8'
  )
  assert.match(dropped, /isTextFileName/, '拖入白名单必须用真相源的判据')
  const ipc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc.ts'), 'utf-8')
  assert.match(ipc, /openFileDialogFilters\(/, '「打开文件」对话框的 filters 必须由真相源派生')
  const files = fs.readFileSync(
    path.join(ROOT, 'src', 'renderer', 'src', 'stores', 'files.ts'),
    'utf-8'
  )
  assert.match(files, /saveDefaultName\(/, '另存为的默认名/扩展名必须走真相源（保留原扩展名）')
  assert.match(files, /isPlainTextName\(/, '纯文本族要以源码模式打开（渲染面会曲解纯文本）')
  const tree = fs.readFileSync(
    path.join(ROOT, 'src', 'renderer', 'src', 'components', 'TreeNode.vue'),
    'utf-8'
  )
  assert.match(tree, /stripTextExtension\(/, '重命名选中主干要去真相源问后缀')
  const exp = fs.readFileSync(
    path.join(ROOT, 'src', 'renderer', 'src', 'composables', 'useExport.ts'),
    'utf-8'
  )
  assert.match(exp, /stripTextExtension\(/, '导出标题去后缀同样只有一份口径')
})

test('i18n：新增的两个 key 三语齐全（打开对话框的过滤器名 + 纯文本源码模式提示）', () => {
  for (const lang of ['zh-CN', 'en-US', 'ru-RU']) {
    const pack = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'src/shared/i18n', `${lang}.json`), 'utf-8')
    )
    assert.equal(typeof pack.dialog.textFiles, 'string', `${lang} 缺 dialog.textFiles`)
    assert.ok(pack.dialog.textFiles.length > 0, `${lang} 的 dialog.textFiles 不能是空串`)
    assert.equal(
      typeof pack.toast.plainTextSourceMode,
      'string',
      `${lang} 缺 toast.plainTextSourceMode`
    )
    assert.ok(
      pack.toast.plainTextSourceMode.includes('{name}'),
      `${lang} 的 toast.plainTextSourceMode 要带 {name} 占位`
    )
  }
})
