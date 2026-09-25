<script setup lang="ts">
// ─── 设置 · 快捷键 ──────────────────────────────────────────────────────────
// 数据来源是命令注册表的解析结果（lib/keymap/service.ts）：默认键 + 用户覆盖。
// 交互：搜索 / 按分组浏览 / 点「修改」进入录制 / 单条恢复默认 / 清除绑定 / 全部恢复默认。
// 录制期间通过 setKeymapRecording(true) 让全局快捷键服务整体让行，避免「录 Ctrl+N 时真的新建了文档」。
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../stores/settings'
import { currentKeymap, setKeymapRecording, type ResolvedCommand } from '../lib/keymap/service'
import { eventToSpec, parseKeybinding, specToChips } from '../lib/keymap/keys'
import Icon from './Icon.vue'

const { t } = useI18n()
const settings = useSettingsStore()

/** 正在录制的命令 id（null = 未录制） */
const recordingId = ref<string | null>(null)
const filter = ref('')

/** 解析结果：依赖 settings.keybindings，改键后自动重算 */
const commands = computed<ResolvedCommand[]>(() => {
  void settings.keybindings
  return currentKeymap()?.resolved() ?? []
})

const titleOf = (c: ResolvedCommand): string => t(c.titleKey)

const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase()
  if (!q) return commands.value
  return commands.value.filter((c) => {
    const keys = (c.keys ?? '').toLowerCase()
    return (
      titleOf(c).toLowerCase().includes(q) || keys.includes(q) || c.id.toLowerCase().includes(q)
    )
  })
})

/** 按分组聚合（保持命令表里的出现顺序，分组名走 i18n） */
const groups = computed(() => {
  const out: { key: string; label: string; items: ResolvedCommand[] }[] = []
  for (const cmd of filtered.value) {
    let g = out.find((x) => x.key === cmd.groupKey)
    if (!g) {
      g = { key: cmd.groupKey, label: t(cmd.groupKey), items: [] }
      out.push(g)
    }
    g.items.push(cmd)
  }
  return out
})

const customizedCount = computed(() => commands.value.filter((c) => c.customized).length)

function startRecording(id: string): void {
  recordingId.value = id
  setKeymapRecording(true)
  window.addEventListener('keydown', onRecordKey, true)
}

function stopRecording(): void {
  recordingId.value = null
  setKeymapRecording(false)
  window.removeEventListener('keydown', onRecordKey, true)
}

/** 录制：Esc 取消、Backspace/Delete 解绑、其余合法组合写入 */
function onRecordKey(e: KeyboardEvent): void {
  const id = recordingId.value
  if (!id) return
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Escape') {
    stopRecording()
    return
  }
  if (e.key === 'Backspace' || e.key === 'Delete') {
    settings.setKeybinding(id, null)
    stopRecording()
    return
  }
  const spec = eventToSpec(e)
  if (!spec) return // 只按了修饰键：继续等主键
  settings.setKeybinding(id, spec)
  stopRecording()
}

function resetOne(id: string): void {
  settings.resetKeybinding(id)
}

function resetAll(): void {
  settings.resetAllKeybindings()
}

onBeforeUnmount(() => {
  if (recordingId.value) stopRecording()
})

/** 冲突提示里的其他命令名 */
function conflictNames(c: ResolvedCommand): string {
  return c.conflictWith
    .map((id) => commands.value.find((x) => x.id === id))
    .filter(Boolean)
    .map((x) => titleOf(x as ResolvedCommand))
    .join(' / ')
}

/** 表达式是否合法（用户可能手改成非法值；非法时按未绑定展示并提示） */
function isValid(c: ResolvedCommand): boolean {
  return !c.keys || parseKeybinding(c.keys) !== null
}
</script>

<template>
  <div>
    <section class="surface mb-4 p-5">
      <div class="mb-3 flex items-start gap-3">
        <span
          class="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-accent-soft text-accent"
        >
          <Icon name="keyboard" :size="16" />
        </span>
        <div class="min-w-0 flex-1">
          <h3 class="text-[13.5px] text-ink">{{ t('keymap.title') }}</h3>
          <p class="mt-1 text-[12px] leading-relaxed text-ink-2b">{{ t('keymap.desc') }}</p>
        </div>
        <button
          class="btn btn-outline flex-none px-3 py-1.5 text-[12.5px]"
          :disabled="customizedCount === 0"
          :title="t('keymap.resetAll')"
          @click="resetAll"
        >
          <Icon name="refresh" :size="13" />
          {{ t('keymap.resetAll') }}
        </button>
      </div>

      <div
        class="flex min-w-0 items-center gap-2 rounded-lg border border-edge bg-panel px-2.5 py-1.5 transition-colors focus-within:border-accent"
      >
        <Icon name="search" :size="13" class="flex-none text-ink-3" />
        <input
          v-model="filter"
          class="keymap-search w-full bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-2b"
          :placeholder="t('keymap.searchPlaceholder')"
        />
        <button v-if="filter" class="flex-none text-ink-2b hover:text-ink" @click="filter = ''">
          <Icon name="x" :size="12" />
        </button>
        <span class="flex-none text-[11.5px] text-ink-2b">
          {{ t('keymap.customizedCount', { n: customizedCount }) }}
        </span>
      </div>
    </section>

    <section v-for="g in groups" :key="g.key" class="surface mb-4 p-5">
      <h3 class="mb-3 text-[13.5px] text-ink">{{ g.label }}</h3>
      <div class="flex flex-col gap-1">
        <div
          v-for="c in g.items"
          :key="c.id"
          class="key-row flex items-center gap-3 rounded-lg px-2 py-1.5"
          :data-command="c.id"
        >
          <span class="min-w-0 flex-1 truncate text-[13px] text-ink">{{ titleOf(c) }}</span>

          <!-- 冲突：同一个键被多条命令占用 -->
          <span
            v-if="c.conflictWith.length"
            class="flex flex-none items-center gap-1 text-[11.5px] text-warning"
            :title="t('keymap.conflictWith', { names: conflictNames(c) })"
          >
            <Icon name="alert-triangle" :size="12" />
            {{ t('keymap.conflict') }}
          </span>
          <span v-else-if="c.customized" class="flex-none text-[11.5px] text-accent">{{
            t('keymap.customized')
          }}</span>

          <!-- 当前键位 -->
          <span class="flex flex-none items-center gap-1">
            <template v-if="recordingId === c.id">
              <span
                class="key-recording rounded-md border border-accent px-2 py-0.5 text-[11.5px] text-accent"
              >
                {{ t('keymap.pressKeys') }}
              </span>
            </template>
            <template v-else-if="c.keys && isValid(c)">
              <kbd v-for="k in specToChips(c.keys)" :key="k" class="key-chip">{{ k }}</kbd>
            </template>
            <span v-else class="text-[11.5px] text-ink-2b">{{ t('keymap.unbound') }}</span>
          </span>

          <span class="flex flex-none items-center gap-1">
            <button
              class="icon-btn h-6 w-6"
              :title="t('keymap.edit')"
              :aria-label="t('keymap.edit')"
              @click="recordingId === c.id ? stopRecording() : startRecording(c.id)"
            >
              <Icon :name="recordingId === c.id ? 'x' : 'keyboard'" :size="12" />
            </button>
            <button
              class="icon-btn h-6 w-6"
              :class="{ 'opacity-40': !c.customized }"
              :disabled="!c.customized"
              :title="t('keymap.resetOne')"
              :aria-label="t('keymap.resetOne')"
              @click="resetOne(c.id)"
            >
              <Icon name="refresh" :size="12" />
            </button>
          </span>
        </div>
        <p v-if="!g.items.length" class="px-2 py-3 text-[12px] text-ink-2b">
          {{ t('keymap.noMatch') }}
        </p>
      </div>
    </section>

    <p class="px-1 text-[11.5px] leading-relaxed text-ink-2b">{{ t('keymap.hint') }}</p>
  </div>
</template>

<style scoped>
.key-row:hover {
  background: var(--panel-2);
}
.key-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  padding: 2px 6px;
  border: 1px solid var(--edge-strong);
  border-radius: 6px;
  background: var(--panel-2);
  font-size: 11.5px;
  font-family: var(--font-sans);
  color: var(--ink-2);
}
.key-recording {
  animation: keymap-pulse 1.1s ease-in-out infinite;
}
@keyframes keymap-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}
@media (prefers-reduced-motion: reduce) {
  .key-recording {
    animation: none;
  }
}
</style>
