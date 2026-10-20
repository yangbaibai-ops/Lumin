# Lumin

**A WYSIWYG Markdown editor for writers — math, mermaid, code, spell check.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) ![Platform: Windows 10 / 11](https://img.shields.io/badge/Platform-Windows%2010%20%7C%2011-0078D6.svg) ![Electron 39](https://img.shields.io/badge/Electron-39-47848F.svg) ![Vue 3](https://img.shields.io/badge/Vue-3-42B883.svg)

**English** | [简体中文](README.zh-CN.md)

![Lumin main window: a Markdown document with a title, KaTeX math, and a table](docs/screenshots/hero.png)

Lumin opens `.md` files as typeset prose. Click the sentence you want to change and the Markdown marks appear around the caret; move the caret away and they disappear. Tables, formulas, diagrams, and code blocks are edited in place — there is no source/preview round trip.

## Screenshots

| Mermaid diagrams | Code blocks |
| :---: | :---: |
|  |  |

| Spell check | Application menu |
| :---: | :---: |
|  |  |

![Settings, Shortcuts page: every keyboard binding can be reassigned](docs/screenshots/settings.png)

## Features

### Editing

- Markdown formatting rendered inline: headings, bold, italic, strikethrough, inline code, blockquotes, ordered / unordered / task lists, tables, images, links, and horizontal rules.
- Syntax markers stay hidden until the caret enters a construct, so the page reads like the finished document. A setting can keep inline markers hidden at all times.
- Multi-cursor editing, drag selection, undo / redo, and find & replace.
- CJK input methods work in the body; the status bar shows word and character counts, the current line and column, encoding, and line endings (CRLF / LF can be switched there).

### Math

- Inline `$…$` and block `$$…$$` formulas rendered with KaTeX.
- KaTeX and its fonts ship with the app: no CDN requests and no network needed.
- Click a formula to edit its source with a live preview; the source stays Markdown.

### Mermaid

- A fenced block tagged `mermaid` renders as a diagram in place.
- Diagrams are loaded lazily; clicking one opens its fence source with a live preview below it.
- If a diagram fails to parse, the source is kept and the error is reported.

### Code blocks

- CodeMirror 6 is embedded inside the block: syntax highlighting, line numbers, bracket completion, autocompletion, and line wrapping.
- The language picker sits outside the block. It accepts free-form language names and detects the language when the fence has none.
- Code content is never rewritten by a Markdown round trip.

### Spell check

- English uses the dictionaries shipped with Electron / the operating system; right-clicking a flagged word offers suggestions.
- Chinese uses heuristic rules, not a dictionary: repeated characters and words, half-width punctuation inside Chinese text, unbalanced bracket pairs, a short list of common character confusions, and optional CJK–Latin spacing hints.
- Code blocks, math source, and mermaid source are excluded from spell check.

### Tables, images, and structure

- Insert or delete rows and columns, and set a column's alignment (left / center / right).
- Insert and paste images; resize them in place.
- Outline pane, split view, and a folder file tree for workspaces.

### Stability and recovery

- Paste-size guard for very large clipboard content, with a notice before the editor locks up.
- A heartbeat watchdog detects an unresponsive window and offers to wait or reload, flushing the draft first; a crashed renderer is reloaded automatically (throttled).
- Drafts survive an unexpected exit and are offered for recovery on the next start.
- Native confirmation dialogs for closing with unsaved changes.
- Global undo: `Ctrl+Z` still works after focus has left the editor.

### Interface

- Light, dark, and sepia themes; English, Simplified Chinese, and Russian UI.
- Every keyboard binding can be reassigned or unbound in Settings → Shortcuts.
- Command palette for running commands by name.
- Export to PDF, HTML, Word, and EPUB.

## Install

### Download the installer

1. Open the [Releases](https://github.com/yangbaibai-ops/Lumin/releases) page and download the latest `Lumin-1.0.0-setup.exe`.
2. Run the installer and choose an install location. It creates Start menu and desktop shortcuts.
3. The installer is **not code-signed** yet, so Windows SmartScreen may show “Windows protected your PC”. Choose **More info → Run anyway** to continue.

### Requirements

- Windows 10 or Windows 11, 64-bit.
- To build from source: Node.js 22 (`>= 22 < 25`) and a Windows desktop session.

### Build from source

```powershell
npm install
npm run build:win
```

The installer and update metadata are written to `dist/` (`Lumin-1.0.0-setup.exe`, `latest.yml`, and the `.blockmap` files). For development with hot reload:

```powershell
npm run dev
```

## Keyboard shortcuts

These are the factory defaults. `Mod` is `Ctrl` on Windows. The application commands are declared in `[src/renderer/src/composables/useKeymap.ts](src/renderer/src/composables/useKeymap.ts)`; the editor-level bindings live in `[src/renderer/src/lib/editor/inlineMarks.ts](src/renderer/src/lib/editor/inlineMarks.ts)` and `[src/renderer/src/lib/editor/keymap.ts](src/renderer/src/lib/editor/keymap.ts)`. Every binding can be changed or unbound in **Settings → Shortcuts**.

| Action | Shortcut |
| --- | --- |
| New / New window | `Ctrl+N` / `Ctrl+Shift+N` |
| Open file / Open folder | `Ctrl+O` / `Ctrl+Shift+O` |
| Save / Save as | `Ctrl+S` / `Ctrl+Shift+S` |
| Print / Export PDF | `Ctrl+P` / `Ctrl+Shift+E` |
| Find / Replace | `Ctrl+F` / `Ctrl+H` |
| Paste as plain text | `Ctrl+Shift+V` |
| Bold / Italic | `Ctrl+B` / `Ctrl+I` |
| Strikethrough / Inline code | `Ctrl+Shift+X` / `Ctrl+E` |
| Insert link | `Ctrl+Alt+K` |
| Insert table / Horizontal rule | `Ctrl+Alt+T` / `Ctrl+Alt+H` |
| Insert image / Code block | `Ctrl+Alt+Shift+I` / `Ctrl+Alt+Shift+C` |
| Insert block math / Mermaid | `Ctrl+Alt+M` / `Ctrl+Alt+G` |
| Insert paragraph above / below | `Ctrl+Alt+↑` / `Ctrl+Alt+↓` |
| Toggle sidebar / Focus mode | `Ctrl+Shift+B` / `Ctrl+Shift+F` |
| Command palette | `Ctrl+Shift+P` |
| Settings / Shortcut settings | `Ctrl+,` / `Ctrl+K` |
| Cycle editor mode (live / split / source) | `Ctrl+/` |
| Next / previous window | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Y` |

## Development

```powershell
npm install
npm run dev            # development with hot reload
npm run typecheck      # type-check the main process and the renderer
npm run test:unit      # unit tests (node --test)
npm run ci             # typecheck + lint + unit tests + notices/docs checks + production build
npm run build          # production build into out/
npm run test:suites    # default CDP acceptance matrix (run `npm run build` first)
```

`npm run test:suites` launches the built app from `out/` in isolated profiles and drives it over the DevTools protocol. It needs a real Windows desktop session; each suite gets a fresh user-data directory and its own debugging port. `npm run test:suites:all` runs the full matrix.

## Architecture

Lumin is an Electron application with a context-isolated bridge between the main process and a Vue renderer.

- **Main process** (`src/main`): window and session management, file I/O, native menus, export and print pipelines, update checks, and the freeze / crash guards.
- **Preload** (`src/preload`): the only bridge to the main process, exposed to pages as `window.luminAPI`.
- **Renderer** (`src/renderer`): Vue 3 UI. Tiptap / ProseMirror is the document model, CodeMirror 6 edits code blocks, KaTeX renders math, and Mermaid renders diagrams.
- **Shared** (`src/shared`): settings schema, i18n bundles, and Markdown, export, encoding, and spell-check rules used by both sides.

| Path | Contents |
| --- | --- |
| `src/main/` | Electron main process, IPC handlers, services |
| `src/preload/` | Context-isolated `window.luminAPI` bridge |
| `src/renderer/src/` | Vue app, Tiptap editor, CodeMirror, KaTeX, Mermaid |
| `src/shared/` | Settings, i18n, and format rules shared by both processes |
| `tools/` | CDP acceptance suites and release / documentation scripts |
| `tests/` | Unit tests (`node --test`) |
| `docs/` | Manual, design notes, and screenshots |

## Contributing

Contributions are welcome. Read `[CONTRIBUTING.md](CONTRIBUTING.md)` for the workflow, commit message format, and test expectations before opening a pull request. By taking part you agree to the `[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)`. Please report security issues privately as described in `[SECURITY.md](SECURITY.md)`.

## License

Lumin is released under the MIT License. See `[LICENSE](LICENSE)` and `[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)` for the full texts and third-party notices.

## Acknowledgements

Built with [Electron](https://www.electronjs.org/), [Vue](https://vuejs.org/), [Tiptap](https://tiptap.dev/), [ProseMirror](https://prosemirror.net/), [CodeMirror](https://codemirror.net/), [KaTeX](https://katex.org/), and [Mermaid](https://mermaid.js.org/).
