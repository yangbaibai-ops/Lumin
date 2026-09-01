<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useFilesStore } from '../stores/files'
import { analyzeDoc, replaceBlock } from '../lib/markdown'
import Icon from './Icon.vue'

const props = defineProps<{ target: { scrollEl: HTMLElement | null } | null }>()
const emit = defineEmits<{ close: [] }>()

const files = useFilesStore()
const query = ref('')
const replacement = ref('')
const caseSensitive = ref(false)
const matchCount = ref(0)
const current = ref(0)
const inputEl = ref<HTMLInputElement | null>(null)
const replaceEl = ref<HTMLInputElement | null>(null)
let marks: HTMLElement[] = []

function flags(): string {
  return caseSensitive.value ? 'g' : 'gi'
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function clearMarks(): void {
  for (const m of marks) {
    const parent = m.parentNode
    if (!parent) continue
    parent.replaceChild(document.createTextNode(m.textContent || ''), m)
    parent.normalize()
  }
  marks = []
}

function doSearch(): void {
  clearMarks()
  matchCount.value = 0
  current.value = 0
  const root = props.target?.scrollEl
  if (!root || !query.value) return
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  let node: Text | null
  while ((node = walker.nextNode() as Text | null)) {
    const el = node.parentElement
    if (el && !el.closest('textarea, .md-raw, mark')) texts.push(node)
  }
  const q = query.value
  const flagsStr = caseSensitive.value ? 'g' : 'gi'
  for (const text of texts) {
    const re = new RegExp(esc(q), flagsStr)
    const hits: { idx: number; len: number }[] = []
    let m: RegExpExecArray | null
    while ((m = re.exec(text.data))) {
      hits.push({ idx: m.index, len: m[0].length })
      if (m.index === re.lastIndex) re.lastIndex++
    }
    for (let i = hits.length - 1; i >= 0; i--) {
      const { idx, len } = hits[i]
      const range = document.createRange()
      range.setStart(text, idx)
      range.setEnd(text, idx + len)
      const mark = document.createElement('mark')
      mark.className = 'lm-find-mark'
      mark.dataset.ordinal = String(matchCount.value)
      range.surroundContents(mark)
      marks.push(mark)
      matchCount.value++
    }
  }
  if (matchCount.value) navigate(0)
}

function navigate(dir: number): void {
  if (!matchCount.value) return
  current.value = (current.value + dir + matchCount.value) % matchCount.value
  marks.forEach((m, i) => m.classList.toggle('lm-current', i === current.value))
  marks[current.value]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

function replaceCurrent(): void {
  if (!matchCount.value || !query.value) return
  const mark = marks[current.value]
  const blockEl = mark?.closest<HTMLElement>('[data-block]')
  if (!mark || !blockEl) return
  const content = files.current?.content ?? ''
  const analysis = analyzeDoc(content)
  const block = analysis.blocks[Number(blockEl.dataset.block)]
  if (!block) return
  // 该块内的第几个匹配
  const siblings = Array.from(blockEl.querySelectorAll('mark.lm-find-mark'))
  const ordinal = siblings.indexOf(mark)
  const re = new RegExp(esc(query.value), flags())
  let found = 0
  const newText = block.text.replace(re, (m) => {
    if (found === ordinal) {
      found++
      return replacement.value
    }
    found++
    return m
  })
  files.setContent(replaceBlock(content, block, newText))
  void nextTick(() => {
    doSearch()
    replaceEl.value?.focus()
  })
}

function replaceAll(): void {
  if (!query.value) return
  const content = files.current?.content ?? ''
  const re = new RegExp(esc(query.value), flags())
  files.setContent(content.replace(re, replacement.value))
  void nextTick(doSearch)
}

function close(): void {
  clearMarks()
  query.value = ''
  emit('close')
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (e.target === inputEl.value) {
      if (e.shiftKey) navigate(-1)
      else navigate(1)
    } else {
      replaceCurrent()
    }
  }
}

watch(query, () => void nextTick(doSearch))
watch(caseSensitive, () => void nextTick(doSearch))
watch(
  () => props.target,
  () => void nextTick(doSearch)
)

defineExpose({ focus: () => inputEl.value?.focus() })
</script>

<template>
  <div
    class="absolute right-4 top-3 z-40 flex items-center gap-2 rounded-xl border border-edge bg-elevate px-3 py-2 shadow-xl"
    :style="{ boxShadow: 'var(--shadow-2)' }"
    @keydown="onKeydown"
  >
    <Icon name="search" :size="14" class="text-ink-3" />
    <input
      ref="inputEl"
      v-model="query"
      class="w-[180px] bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
      :placeholder="'查找'"
    />
    <span v-if="query" class="text-[11px] tabular-nums text-ink-3">
      {{ matchCount ? current + 1 + ' / ' + matchCount : '0 / 0' }}
    </span>
    <button
      class="icon-btn !h-6 !w-6"
      :class="{ active: caseSensitive }"
      :title="'Aa'"
      @click="caseSensitive = !caseSensitive"
    >
      <span class="text-[10px] font-bold">Aa</span>
    </button>
    <button class="icon-btn !h-6 !w-6" title="上一个" @click="navigate(-1)">
      <Icon name="chevron-down" :size="13" class="rotate-180" />
    </button>
    <button class="icon-btn !h-6 !w-6" title="下一个" @click="navigate(1)">
      <Icon name="chevron-down" :size="13" />
    </button>
    <div class="mx-1 h-5 w-px bg-edge" />
    <input
      ref="replaceEl"
      v-model="replacement"
      class="w-[140px] bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
      placeholder="替换为"
    />
    <button class="btn btn-outline !px-2 !py-1 !text-[12px]" @click="replaceCurrent">替换</button>
    <button class="btn btn-outline !px-2 !py-1 !text-[12px]" @click="replaceAll">全部</button>
    <button class="icon-btn !h-6 !w-6" @click="close">
      <Icon name="x" :size="13" />
    </button>
  </div>
</template>
