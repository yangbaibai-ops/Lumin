<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSettingsStore } from '../stores/settings'
import { FONT_OPTIONS } from '../../../shared/defaults'
import type { EditorMode, ThemeMode } from '../../../shared/types'
import Icon from '../components/Icon.vue'

const route = useRoute()
const router = useRouter()
const settings = useSettingsStore()

const tabs = [
  { id: 'general', label: '通用', icon: 'settings' },
  { id: 'editor', label: '编辑器', icon: 'pencil' },
  { id: 'appearance', label: '外观', icon: 'sun' },
  { id: 'export', label: '导出', icon: 'download' }
] as const

const activeTab = computed(() => {
  const t = String(route.params.section ?? 'general')
  return tabs.some((x) => x.id === t) ? t : 'general'
})

function switchTab(id: string): void {
  void router.replace(`/settings/${id}`)
}

const themes: { mode: ThemeMode; icon: string; label: string; desc: string; colors: string[] }[] = [
  { mode: 'auto', icon: 'monitor', label: '跟随系统', desc: '随系统外观自动切换', colors: ['#f5f6f8', '#0f1116'] },
  { mode: 'light', icon: 'sun', label: '浅色', desc: '明亮清爽的日间主题', colors: ['#f5f6f8', '#ffffff'] },
  { mode: 'dark', icon: 'moon', label: '深色', desc: '护眼的夜间主题', colors: ['#0f1116', '#16181f'] },
  { mode: 'sepia', icon: 'book', label: '羊皮纸', desc: '温暖的阅读护眼模式', colors: ['#f1e9d5', '#faf4e4'] }
]

const modes: { mode: EditorMode; icon: string; label: string; desc: string }[] = [
  { mode: 'wysiwyg', icon: 'eye', label: '实时渲染', desc: '所见即所得，点击块即可编辑' },
  { mode: 'source', icon: 'source', label: '源码模式', desc: '显示原始 Markdown 语法' }
]

const fontLabel = computed(() => {
  const f = FONT_OPTIONS.find((x) => x.value === settings.fontFamily)
  return f ? (f.label === 'sans' ? '无衬线（现代）' : f.label === 'serif' ? '衬线（典雅）' : '等宽（极客）') : '自定义'
})

function sectionTitle(id: string): string {
  const t = tabs.find((x) => x.id === id)
  return t ? t.label : ''
}
</script>

<template>
  <div class="flex h-full min-h-0">
    <!-- 左侧导航 -->
    <nav class="flex w-[190px] flex-none flex-col gap-1 border-r border-edge bg-panel/50 p-3">
      <div class="px-2 pb-2 pt-1">
        <h1 class="text-[15px] font-semibold text-ink">设置</h1>
        <p class="text-[11.5px] text-ink-3">个性化你的 Lumin</p>
      </div>
      <button
        v-for="t in tabs"
        :key="t.id"
        class="flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition-all duration-150"
        :class="activeTab === t.id ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:bg-panel-2 hover:text-ink'"
        @click="switchTab(t.id)"
      >
        <Icon :name="t.icon" :size="14" />
        {{ t.label }}
      </button>
      <div class="flex-1" />
      <button
        class="flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] text-ink-3 transition-colors hover:bg-panel-2 hover:text-ink"
        @click="router.push('/about')"
      >
        <Icon name="info" :size="14" />
        关于 Lumin
      </button>
    </nav>

    <!-- 内容 -->
    <div class="min-w-0 flex-1 overflow-y-auto">
      <div class="mx-auto max-w-[640px] px-8 py-8">
        <Transition name="page" mode="out-in">
          <div :key="activeTab">
            <h2 class="mb-6 text-[20px] font-bold tracking-tight text-ink">{{ sectionTitle(activeTab) }}</h2>

            <!-- ── 通用 ── -->
            <template v-if="activeTab === 'general'">
              <section class="surface mb-4 p-5">
                <h3 class="mb-4 text-[13px] font-semibold text-ink">语言</h3>
                <div class="flex items-center justify-between gap-4">
                  <div>
                    <p class="text-[13.5px] text-ink">界面语言</p>
                    <p class="mt-0.5 text-[12px] text-ink-3">界面显示语言</p>
                  </div>
                  <div class="flex rounded-lg bg-panel-2 p-0.5">
                    <button
                      v-for="lang in (['zh-CN', 'en-US'] as const)"
                      :key="lang"
                      class="rounded-md px-3 py-1 text-[12.5px] font-medium transition-all"
                      :class="settings.language === lang ? 'bg-panel text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'"
                      @click="settings.setLanguage(lang)"
                    >
                      {{ lang === 'zh-CN' ? '简体中文' : 'English' }}
                    </button>
                  </div>
                </div>
              </section>

              <section class="surface mb-4 p-5">
                <div class="flex items-center justify-between gap-4">
                  <div>
                    <p class="text-[13.5px] text-ink">自动保存</p>
                    <p class="mt-0.5 text-[12px] text-ink-3">编辑时自动保存到磁盘（间隔 {{ settings.autoSaveInterval }} 秒）</p>
                  </div>
                  <button class="switch" :class="{ on: settings.autoSave }" @click="settings.set('autoSave', !settings.autoSave)" />
                </div>
                <div v-if="settings.autoSave" class="mt-5">
                  <div class="mb-2 flex items-center justify-between">
                    <span class="text-[12.5px] text-ink-2">自动保存间隔</span>
                    <span class="rounded-md bg-accent-soft px-2 py-0.5 text-[12px] font-semibold text-accent">{{ settings.autoSaveInterval }}s</span>
                  </div>
                  <input
                    type="range"
                    class="range w-full"
                    min="1"
                    max="30"
                    :value="settings.autoSaveInterval"
                    @input="settings.set('autoSaveInterval', Number(($event.target as HTMLInputElement).value))"
                  />
                </div>
              </section>

              <section class="surface p-5">
                <div class="flex items-center justify-between gap-4">
                  <div>
                    <p class="text-[13.5px] text-ink">侧边栏</p>
                    <p class="mt-0.5 text-[12px] text-ink-3">默认显示左侧边栏</p>
                  </div>
                  <button class="switch" :class="{ on: settings.sidebarVisible }" @click="settings.set('sidebarVisible', !settings.sidebarVisible)" />
                </div>
              </section>
            </template>

            <!-- ── 编辑器 ── -->
            <template v-else-if="activeTab === 'editor'">
              <section class="surface mb-4 p-5">
                <h3 class="mb-4 text-[13px] font-semibold text-ink">默认编辑器模式</h3>
                <div class="grid grid-cols-2 gap-2.5">
                  <button
                    v-for="m in modes"
                    :key="m.mode"
                    class="flex items-start gap-3 rounded-xl border p-3.5 text-left transition-all duration-200"
                    :class="settings.editorMode === m.mode ? 'border-accent bg-accent-soft' : 'border-edge hover:border-edge-strong'"
                    @click="settings.set('editorMode', m.mode)"
                  >
                    <span class="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg" :class="settings.editorMode === m.mode ? 'bg-accent/15 text-accent' : 'bg-panel-2 text-ink-3'">
                      <Icon :name="m.icon" :size="15" />
                    </span>
                    <span>
                      <span class="block text-[13.5px] font-medium text-ink">{{ m.label }}</span>
                      <span class="mt-0.5 block text-[11.5px] leading-snug text-ink-3">{{ m.desc }}</span>
                    </span>
                  </button>
                </div>
              </section>

              <section class="surface mb-4 p-5">
                <h3 class="mb-4 text-[13px] font-semibold text-ink">字体与排版</h3>
                <div class="mb-5">
                  <div class="mb-2 flex items-center justify-between">
                    <span class="text-[12.5px] text-ink-2">字号</span>
                    <span class="rounded-md bg-accent-soft px-2 py-0.5 text-[12px] font-semibold text-accent">{{ settings.fontSize }}px</span>
                  </div>
                  <input
                    type="range"
                    class="range w-full"
                    min="13"
                    max="26"
                    :value="settings.fontSize"
                    @input="settings.set('fontSize', Number(($event.target as HTMLInputElement).value))"
                  />
                </div>
                <div class="mb-5">
                  <div class="mb-2 flex items-center justify-between">
                    <span class="text-[12.5px] text-ink-2">行高</span>
                    <span class="rounded-md bg-accent-soft px-2 py-0.5 text-[12px] font-semibold text-accent">{{ settings.lineHeight.toFixed(1) }}</span>
                  </div>
                  <input
                    type="range"
                    class="range w-full"
                    min="1.3"
                    max="2.6"
                    step="0.1"
                    :value="settings.lineHeight"
                    @input="settings.set('lineHeight', Number(($event.target as HTMLInputElement).value))"
                  />
                </div>
                <div>
                  <div class="mb-2 flex items-center justify-between">
                    <span class="text-[12.5px] text-ink-2">正文字体</span>
                    <span class="text-[12px] text-ink-3">{{ fontLabel }}</span>
                  </div>
                  <div class="flex gap-2">
                    <button
                      v-for="f in FONT_OPTIONS"
                      :key="f.label"
                      class="flex-1 rounded-lg border px-2 py-2.5 text-[12.5px] transition-all duration-150"
                      :class="settings.fontFamily === f.value ? 'border-accent bg-accent-soft text-accent' : 'border-edge text-ink-2 hover:border-edge-strong'"
                      @click="settings.set('fontFamily', f.value)"
                    >
                      {{ f.label === 'sans' ? '无衬线' : f.label === 'serif' ? '衬线' : '等宽' }}
                    </button>
                  </div>
                </div>
              </section>

              <section class="surface p-5">
                <h3 class="mb-4 text-[13px] font-semibold text-ink">预览效果</h3>
                <div
                  class="md-preview rounded-xl border border-edge bg-app/60 p-5"
                  :style="{ '--editor-size': settings.fontSize + 'px', '--editor-lh': String(settings.lineHeight), '--editor-font': settings.fontFamily }"
                >
                  <h3 style="font-size: 1.22em; font-weight: 700; margin: 0 0 0.4em; letter-spacing: -0.01em">标题示例 Heading</h3>
                  <p style="margin: 0.3em 0">所见即所得的正文排版，支持 <strong>加粗</strong>、<em>斜体</em> 与 <code>行内代码</code>。</p>
                </div>
              </section>
            </template>

            <!-- ── 外观 ── -->
            <template v-else-if="activeTab === 'appearance'">
              <section class="surface p-5">
                <h3 class="mb-1 text-[13px] font-semibold text-ink">主题</h3>
                <p class="mb-4 text-[12px] text-ink-3">切换主题会立即生效，并伴随平滑过渡</p>
                <div class="grid grid-cols-2 gap-3">
                  <button
                    v-for="t in themes"
                    :key="t.mode"
                    class="group overflow-hidden rounded-xl border text-left transition-all duration-200 hover:-translate-y-0.5"
                    :class="settings.theme === t.mode ? 'border-accent shadow-lg' : 'border-edge hover:border-edge-strong'"
                    :style="settings.theme === t.mode ? { boxShadow: '0 4px 16px var(--glow)' } : {}"
                    @click="settings.setTheme(t.mode)"
                  >
                    <div class="flex h-16 items-center justify-center gap-1.5" :style="{ background: t.colors[0] }">
                      <div class="h-9 w-16 rounded-md border border-black/5" :style="{ background: t.colors[1] }">
                        <div class="mt-2 h-1 w-8 rounded-sm bg-black/15" style="margin-left: 5px" />
                        <div class="mt-1.5 h-1 w-12 rounded-sm bg-black/10" style="margin-left: 5px" />
                        <div class="mt-1.5 h-1 w-9 rounded-sm bg-black/10" style="margin-left: 5px" />
                      </div>
                    </div>
                    <div class="flex items-center gap-2.5 border-t border-edge p-3">
                      <Icon :name="t.icon" :size="14" :class="settings.theme === t.mode ? 'text-accent' : 'text-ink-3'" />
                      <div class="min-w-0 flex-1">
                        <p class="text-[13px] font-medium text-ink">{{ t.label }}</p>
                        <p class="text-[11px] text-ink-3">{{ t.desc }}</p>
                      </div>
                      <span
                        class="flex h-4 w-4 items-center justify-center rounded-full border-2 transition-all"
                        :class="settings.theme === t.mode ? 'border-accent bg-accent' : 'border-edge-strong'"
                      >
                        <Icon v-if="settings.theme === t.mode" name="check" :size="10" class="text-white" />
                      </span>
                    </div>
                  </button>
                </div>
              </section>
            </template>

            <!-- ── 导出 ── -->
            <template v-else-if="activeTab === 'export'">
              <section class="surface mb-4 p-5">
                <h3 class="mb-4 text-[13px] font-semibold text-ink">PDF 导出</h3>
                <div class="mb-5">
                  <div class="mb-2 flex items-center justify-between">
                    <span class="text-[12.5px] text-ink-2">页边距</span>
                    <span class="rounded-md bg-accent-soft px-2 py-0.5 text-[12px] font-semibold text-accent">{{ settings.export.pdf.margin }}mm</span>
                  </div>
                  <input
                    type="range"
                    class="range w-full"
                    min="8"
                    max="50"
                    :value="settings.export.pdf.margin"
                    @input="settings.set('export', { ...settings.export, pdf: { ...settings.export.pdf, margin: Number(($event.target as HTMLInputElement).value) } })"
                  />
                </div>
                <div>
                  <span class="mb-2 block text-[12.5px] text-ink-2">页面尺寸</span>
                  <div class="flex gap-2">
                    <button
                      v-for="size in (['A4', 'A5', 'Letter'] as const)"
                      :key="size"
                      class="rounded-lg border px-4 py-2 text-[12.5px] transition-all duration-150"
                      :class="settings.export.pdf.pageSize === size ? 'border-accent bg-accent-soft text-accent' : 'border-edge text-ink-2 hover:border-edge-strong'"
                      @click="settings.set('export', { ...settings.export, pdf: { ...settings.export.pdf, pageSize: size } })"
                    >
                      {{ size }}
                    </button>
                  </div>
                </div>
              </section>

              <section class="surface p-5">
                <h3 class="mb-4 text-[13px] font-semibold text-ink">支持的格式</h3>
                <div class="space-y-2.5">
                  <div v-for="row in [
                    { icon: 'file', name: 'PDF', desc: '矢量排版，适合打印与分享' },
                    { icon: 'code', name: 'HTML', desc: '保留完整样式与交互的网页文件' },
                    { icon: 'file', name: 'Word (.doc)', desc: 'Word 可直接打开编辑' },
                    { icon: 'book', name: 'EPUB', desc: '标准 epub 3 电子书格式' }
                  ]" :key="row.name" class="flex items-center gap-3 rounded-xl border border-edge px-3.5 py-2.5">
                    <span class="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-accent-soft text-accent">
                      <Icon :name="row.icon" :size="14" />
                    </span>
                    <div class="min-w-0 flex-1">
                      <p class="text-[13px] font-medium text-ink">{{ row.name }}</p>
                      <p class="text-[11.5px] text-ink-3">{{ row.desc }}</p>
                    </div>
                  </div>
                </div>
                <p class="mt-4 text-[11.5px] leading-relaxed text-ink-3">
                  Word 导出使用 Word 兼容的 HTML 文档格式；EPUB 为标准 epub 3 格式。在编辑器工具栏点击「导出」即可使用。
                </p>
              </section>
            </template>
          </div>
        </Transition>
      </div>
    </div>
  </div>
</template>
