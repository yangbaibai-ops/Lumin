<script setup lang="ts">
import Icon from './Icon.vue'
</script>

<template>
  <div class="fixed inset-0 z-[300] flex flex-col bg-app">
    <!-- 顶部占位 -->
    <div class="flex h-12 items-center gap-3 border-b border-edge px-4">
      <div class="skeleton h-5 w-24" />
      <div class="skeleton h-5 w-16" />
      <div class="ml-auto flex gap-2">
        <div class="skeleton h-7 w-7 rounded-lg" />
        <div class="skeleton h-7 w-7 rounded-lg" />
      </div>
    </div>
    <div class="flex flex-1 min-h-0">
      <!-- 侧边栏骨架 -->
      <div class="w-[264px] shrink-0 border-r border-edge p-3 space-y-2.5">
        <div class="skeleton h-6 w-3/4" />
        <div class="skeleton h-4 w-full" />
        <div class="skeleton h-4 w-5/6" />
        <div class="skeleton h-4 w-full" />
        <div class="skeleton h-4 w-2/3" />
      </div>
      <!-- 主区骨架 = 写作区：铺纸（--paper），与外壳灰一起构成启动瞬间的「灰 chrome + 白纸」
           两段式；主进程窗口底色（themeBackground）也取同一个纸色，避免启动先闪一下别的颜色 -->
      <div class="flex flex-1 flex-col items-center bg-paper px-8 py-10">
        <div class="w-full max-w-3xl space-y-4">
          <div class="skeleton h-9 w-1/2" />
          <div class="skeleton h-4 w-full" />
          <div class="skeleton h-4 w-11/12" />
          <div class="skeleton h-4 w-4/5" />
          <div class="skeleton my-6 h-24 w-full rounded-xl" />
          <div class="skeleton h-4 w-full" />
          <div class="skeleton h-4 w-3/4" />
        </div>
      </div>
    </div>
    <!-- Logo 呼吸灯 -->
    <div class="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div
        class="flex flex-col items-center gap-3"
        style="animation: lm-breathe 1.6s ease-in-out infinite"
      >
        <Icon name="logo" :size="46" class="text-accent" :stroke-width="4.2" />
        <span class="text-sm font-semibold tracking-[0.3em] text-ink-3">LUMIN</span>
      </div>
    </div>
  </div>
</template>
