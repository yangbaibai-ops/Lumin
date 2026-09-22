<script setup lang="ts">
// 轻量内联 SVG 图标集（lucide 风格描边图标）
const props = withDefaults(defineProps<{ name: string; size?: number; strokeWidth?: number }>(), {
  size: 16,
  strokeWidth: 1.8
})

// 每个图标 = 元素数组；'p:...' 为 path，'c:cx,cy,r' 为 circle
const ICONS: Record<string, string[]> = {
  // 应用标识：与应用图标同一份几何（32 网格那笔 L 折线，折算到 24 viewBox）。
  // 调用方要给较粗的 stroke-width，它才像「标识」而不是一枚普通线性图标。
  logo: ['p:M9 8 V16.5 H15.5'],
  bold: ['p:M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8'],
  italic: ['p:M19 4h-9', 'p:M14 20H5', 'p:M15 4L9 20'],
  underline: ['p:M6 4v6a6 6 0 0 0 12 0V4', 'p:M4 20h16'],
  strike: ['p:M16 4H9a3 3 0 0 0-2.83 4', 'p:M14 12a4 4 0 0 1 0 8H6', 'p:M4 12h16'],
  code: ['p:m18 16 4-4-4-4', 'p:M6 8l-4 4 4 4', 'p:M14.5 4l-5 16'],
  heading: ['p:M6 12h12', 'p:M6 20V4', 'p:M18 20V4'],
  /**
   * 一到三级标题：**H + 数字都画成描边**（沿用 lucide `heading-1/2/3` 的几何）。
   *
   * 为什么不用「H 图标 + 一个 `<span>1</span>`」那种拼法（本轮改掉的旧写法）：
   * 图标是 1.8px 描边、数字是 10px **粗体**正文，两者字重/颜色/基线都对不齐，
   * 放大看就是「H 1」两个元素并排（实测数字基线偏移 8px、字重 700 对描边 1.8），
   * 用户口径是「很怪、不好看」。画成同一套描边之后，整枚按钮就是一个字形。
   */
  'heading-1': ['p:M4 12h8', 'p:M4 18V6', 'p:M12 18V6', 'p:m17 12 3-2v8'],
  'heading-2': ['p:M4 12h8', 'p:M4 18V6', 'p:M12 18V6', 'p:M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1'],
  'heading-3': [
    'p:M4 12h8',
    'p:M4 18V6',
    'p:M12 18V6',
    'p:M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2',
    'p:M17 17.5c2 1.5 4 .3 4-1.5a2 2 0 0 0-2-2'
  ],
  quote: [
    'p:M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z',
    'p:M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z'
  ],
  list: ['p:M3 12h.01', 'p:M3 18h.01', 'p:M3 6h.01', 'p:M8 12h13', 'p:M8 18h13', 'p:M8 6h13'],
  /**
   * 「树视图」：竖干线 + 两条右侧分支（Lucide `list-tree`）。
   * 侧栏「树 / 列表」切换原来给树用的是 `chevron-right` —— 那是「展开」的语义，
   * 和「树」不是一回事，两个图标摆在一起也看不出是「同一份数据的两种排布」。
   */
  'list-tree': [
    'p:M21 6h-8',
    'p:M21 12h-8',
    'p:M21 18h-8',
    'p:M3 6v4c0 1.1.9 2 2 2h3',
    'p:M3 10v6c0 1.1.9 2 2 2h3'
  ],
  'list-ordered': [
    'p:M10 12h11',
    'p:M10 18h11',
    'p:M10 6h11',
    'p:M4 10h2',
    'p:M4 6h1v4',
    'p:M6 18H4c0-1 2-2 2-3s-1-1.5-2-1'
  ],
  'list-checks': ['p:M3 17 5 19l4-4', 'p:M3 7l2 2 4-4', 'p:M13 6h8', 'p:M13 12h8', 'p:M13 18h8'],
  braces: [
    'p:M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1',
    'p:M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1'
  ],
  link: [
    'p:M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71',
    'p:M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'
  ],
  image: [
    'p:M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z',
    'c:12,13,3'
  ],
  table: ['p:M12 3v18', 'p:M3 12h18', 'rect:3,3,18,18,2'],
  hr: ['p:M5 12h14'],
  sigma: ['p:M18 7V4H6l6 8-6 8h12v-3'],
  undo: ['p:M3 7v6h6', 'p:M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13'],
  redo: ['p:M21 7v6h-6', 'p:M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13'],
  download: ['p:M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'p:M7 10l5 5 5-5', 'p:M12 15V3'],
  settings: [
    'p:M4 21v-7',
    'p:M4 10V3',
    'p:M12 21v-9',
    'p:M12 8V3',
    'p:M20 21v-5',
    'p:M20 12V3',
    'p:M1 14h6',
    'p:M9 8h6',
    'p:M17 16h6'
  ],
  info: ['c:12,12,9', 'p:M12 16v-4', 'p:M12 8h.01'],
  'alert-triangle': [
    'p:m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3',
    'p:M12 9v4',
    'p:M12 17h.01'
  ],
  'alert-circle': ['c:12,12,10', 'p:M12 8v4', 'p:M12 16h.01'],
  sun: [
    'c:12,12,4',
    'p:M12 2v2',
    'p:M12 20v2',
    'p:m4.93 4.93 1.41 1.41',
    'p:m17.66 17.66 1.41 1.41',
    'p:M2 12h2',
    'p:M20 12h2',
    'p:m6.34 17.66-1.41 1.41',
    'p:m19.07 4.93-1.41 1.41'
  ],
  moon: ['p:M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z'],
  book: ['p:M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20'],
  monitor: ['rect:2,3,20,14,2', 'p:M8 21h8', 'p:M12 17v4'],
  maximize: [
    'p:M8 3H5a2 2 0 0 0-2 2v3',
    'p:M21 8V5a2 2 0 0 0-2-2h-3',
    'p:M3 16v3a2 2 0 0 0 2 2h3',
    'p:M16 21h3a2 2 0 0 0 2-2v-3'
  ],
  'align-center': ['p:M21 6H3', 'p:M17 12H7', 'p:M19 18H5'],
  eye: ['p:M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z', 'c:12,12,3'],
  source: ['p:m18 16 4-4-4-4', 'p:M6 8l-4 4 4 4'],
  columns: ['rect:3,3,7.5,18,2', 'rect:13.5,3,7.5,18,2', 'p:M10.5 3v18'],
  'sync-scroll': ['p:M8 3 4 7l4 4', 'p:M4 7h16', 'p:M16 21l4-4-4-4', 'p:M20 17H4'],
  'external-link': [
    'p:M15 3h6v6',
    'p:M10 14 21 3',
    'p:M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'
  ],
  clock: ['c:12,12,9', 'p:M12 6v6l4 2'],
  check: ['p:M20 6 9 17l-5-5'],
  sparkles: [
    'p:M12 3l1.9 5.8L19.7 10l-5.8 1.9L12 17.7l-1.9-5.8L4.3 10l5.8-1.9L12 3z',
    'p:M5 3v4',
    'p:M3 5h4',
    'p:M19 17v4',
    'p:M17 19h4'
  ],
  refresh: [
    'p:M3 12a9 9 0 0 1 15-6.7L21 8',
    'p:M21 12a9 9 0 0 1-15 6.7L3 16',
    'p:M21 3v5h-5',
    'p:M3 21v-5h5'
  ],
  globe: [
    'c:12,12,9',
    'p:M2 12h20',
    'p:M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z'
  ],
  'file-plus': [
    'p:M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z',
    'p:M14 2v4a2 2 0 0 0 2 2h4',
    'p:M12 18v-6',
    'p:M9 15h6'
  ],
  'folder-plus': [
    'p:M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
    'p:M12 10v6',
    'p:M9 13h6'
  ],
  file: [
    'p:M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z',
    'p:M14 2v4a2 2 0 0 0 2 2h4'
  ],
  folder: [
    'p:M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'
  ],
  'chevron-right': ['p:m9 18 6-6-6-6'],
  'chevron-left': ['p:m15 18-6-6 6-6'],
  'chevron-down': ['p:m6 9 6 6 6-6'],
  'chevron-up': ['p:m18 15-6-6-6 6'],
  plus: ['p:M5 12h14', 'p:M12 5v14'],
  trash: [
    'p:M3 6h18',
    'p:M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
    'p:M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'
  ],
  pencil: ['p:M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z'],
  x: ['p:M18 6 6 18', 'p:M6 6l12 12'],
  pin: [
    'p:M12 17v5',
    'p:M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z'
  ],
  more: ['c:5,12,1', 'c:12,12,1', 'c:19,12,1'],
  'panel-left': ['rect:3,3,18,18,2', 'p:M9 3v18'],
  search: ['c:11,11,7', 'p:m21 21-4.3-4.3'],
  copy: ['rect:9,9,13,13,2', 'p:M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
  scissors: [
    'c:6,6,3',
    'c:6,18,3',
    'p:M20 4 8.12 15.88',
    'p:M14.47 14.48 20 20',
    'p:M8.12 8.12 12 12'
  ],
  clipboard: [
    'rect:8,2,8,4,1',
    'p:M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2'
  ],
  dot: ['c:12,12,4.5'],
  folderOpen: [
    'p:M6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2'
  ],
  save: [
    'p:M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z',
    'p:M17 21v-8H7v8',
    'p:M7 3v5h8'
  ],
  keyboard: [
    'rect:2,6,20,12,2',
    'p:M6 10h.01',
    'p:M10 10h.01',
    'p:M14 10h.01',
    'p:M18 10h.01',
    'p:M6 14h.01',
    'p:M18 14h.01',
    'p:M9 14h4'
  ]
}

const elements = ICONS[props.name] || ICONS.info

function parts(): {
  paths: string[]
  circles: { cx: number; cy: number; r: number }[]
  rects: { x: number; y: number; w: number; h: number; rx: number }[]
} {
  const paths: string[] = []
  const circles: { cx: number; cy: number; r: number }[] = []
  const rects: { x: number; y: number; w: number; h: number; rx: number }[] = []
  for (const el of elements) {
    if (el.startsWith('p:')) paths.push(el.slice(2))
    else if (el.startsWith('c:')) {
      const [cx, cy, r] = el.slice(2).split(',').map(Number)
      circles.push({ cx, cy, r })
    } else if (el.startsWith('rect:')) {
      const [x, y, w, h, rx] = el.slice(5).split(',').map(Number)
      rects.push({ x, y, w, h, rx })
    }
  }
  return { paths, circles, rects }
}

const { paths, circles, rects } = parts()
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="shrink-0"
  >
    <path v-for="(d, i) in paths" :key="'p' + i" :d="d" />
    <circle v-for="(c, i) in circles" :key="'c' + i" :cx="c.cx" :cy="c.cy" :r="c.r" />
    <rect
      v-for="(r, i) in rects"
      :key="'r' + i"
      :x="r.x"
      :y="r.y"
      :width="r.w"
      :height="r.h"
      :rx="r.rx"
    />
  </svg>
</template>
