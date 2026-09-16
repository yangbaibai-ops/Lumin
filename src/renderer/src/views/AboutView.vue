<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'

const router = useRouter()
const version = ref('')
const platform = ref('')

/** 返回进入「关于」之前的界面（无历史则回首页） */
function goBack(): void {
  if (window.history.length > 1) router.back()
  else router.push('/')
}

const stack = [
  'Electron',
  'Vue 3',
  'CodeMirror 6',
  'Marked.js',
  'KaTeX',
  'Mermaid',
  'highlight.js',
  'Tailwind CSS v4',
  'Pinia',
  'Vue Router'
]

onMounted(async () => {
  version.value = await window.luminAPI.app.getVersion()
  platform.value = await window.luminAPI.app.getPlatform()
})
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="mx-auto flex max-w-[560px] flex-col items-center px-8 pb-16 pt-16 text-center">
      <div
        class="relative mb-6 flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-accent to-accent-2 text-white"
        :style="{
          animation: 'lm-pop 0.5s cubic-bezier(0.2, 0.9, 0.3, 1.2)',
          boxShadow: '0 12px 40px var(--glow)'
        }"
      >
        <Icon name="logo" :size="40" :stroke-width="4" />
      </div>
      <h1 class="text-[28px] font-bold tracking-tight text-ink">Lumin</h1>
      <p class="mt-1 text-[13.5px] font-medium tracking-[0.25em] text-accent">WRITE IN LIGHT.</p>

      <p class="mt-6 max-w-[440px] text-[13.5px] leading-relaxed text-ink-2">
        Lumin 是一款基于 Electron 构建的跨平台桌面 Markdown
        编辑器，以「所见即所得」为核心设计理念，致力于提供媲美 Typora 的沉浸式写作体验。
      </p>

      <div class="mt-8 grid w-full grid-cols-2 gap-3">
        <div class="surface p-4">
          <p class="text-[11px] uppercase tracking-[0.12em] text-ink-3">版本</p>
          <p class="mt-1 text-[15px] font-semibold text-ink">v{{ version }}</p>
        </div>
        <div class="surface p-4">
          <p class="text-[11px] uppercase tracking-[0.12em] text-ink-3">平台</p>
          <p class="mt-1 text-[15px] font-semibold text-ink capitalize">{{ platform }}</p>
        </div>
      </div>

      <div class="mt-8 w-full">
        <h2 class="mb-3 text-[12px] font-semibold uppercase tracking-[0.14em] text-ink-3">
          技术栈
        </h2>
        <div class="flex flex-wrap justify-center gap-2">
          <span
            v-for="s in stack"
            :key="s"
            class="rounded-full border border-edge bg-panel px-3 py-1 text-[12px] text-ink-2 transition-colors duration-150 hover:border-accent hover:text-accent"
          >
            {{ s }}
          </span>
        </div>
      </div>

      <p class="mt-10 text-[12px] text-ink-3">免费 · 开源 · 现代化 — 让写作如光般通透</p>

      <button class="btn btn-outline mt-6 px-5 py-2 text-[13px]" @click="goBack">
        <Icon name="chevron-right" :size="14" class="rotate-180" />
        返回
      </button>
    </div>
  </div>
</template>
