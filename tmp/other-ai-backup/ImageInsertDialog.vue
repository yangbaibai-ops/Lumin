<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUiStore } from '../stores/ui'
import { useSettingsStore } from '../stores/settings'
import Icon from './Icon.vue'
import { insertImageFromPath, insertImageFromBytes, insertImageFromUrl } from '../lib/insertImage'
import { IMAGE_EXT_RE } from '../lib/imageAsset'
import type { InsertImageSrc } from '../lib/insertImage'

const { t } = useI18n()
const ui = useUiStore()
const settings = useSettingsStore()

interface ImagePreview {
  id: string
  file?: File
  url?: string
  preview: string
  name: string
  size?: number
  alt: string
  width?: number | string
  align: 'left' | 'center' | 'right' | 'none'
}

const dropzoneEl = ref<HTMLElement | null>(null)
const fileInputEl = ref<HTMLInputElement | null>(null)
const urlInputEl = ref<HTMLInputElement | null>(null)

const activeTab = ref<'file' | 'url' | 'clipboard'>('file')
const isDragging = ref(false)
const isProcessing = ref(false)
const images = ref<ImagePreview[]>([])
const imageUrl = ref('')
const urlError = ref('')

// URL 历史记录（存储在设置中）
const imageUrlHistory = computed({
  get: () => settings.imageUrlHistory || [],
  set: (val) => {
    settings.set('imageUrlHistory', val)
  }
})

const isOpen = computed(() => ui.imageDialogState !== null)
const canInsert = computed(() => {
  if (activeTab.value === 'url') {
    return imageUrl.value.trim().length > 0 && !urlError.value
  }
  return images.value.length > 0
})

let insertCallback: InsertImageSrc | null = null

// 监听对话框状态
watch(
  () => ui.imageDialogState,
  (state) => {
    if (state) {
      insertCallback = state.insert
      // 重置状态
      resetDialog()
      void nextTick(() => {
        if (activeTab.value === 'url' && urlInputEl.value) {
          urlInputEl.value.focus()
        }
      })
    }
  }
)

function resetDialog(): void {
  images.value = []
  imageUrl.value = ''
  urlError.value = ''
  activeTab.value = 'file'
  isDragging.value = false
  isProcessing.value = false
}

function close(): void {
  ui.closeImageDialog()
  insertCallback = null
}

// ─── 文件选择 ────────────────────────────────────────────────────────────

function openFilePicker(): void {
  fileInputEl.value?.click()
}

async function handleFileInput(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  if (!input.files?.length) return
  await processFiles(Array.from(input.files))
  // 重置 input，允许重复选择同一文件
  input.value = ''
}

async function processFiles(files: File[]): Promise<void> {
  const imageFiles = files.filter((f) => 
    f.type.startsWith('image/') || IMAGE_EXT_RE.test(f.name)
  )
  
  if (!imageFiles.length) {
    ui.toast(t('toast.imageInvalidFormat'), 'warning')
    return
  }

  isProcessing.value = true
  
  for (const file of imageFiles) {
    try {
      const preview = await createImagePreview(file)
      images.value.push({
        id: `${Date.now()}-${Math.random()}`,
        file,
        preview,
        name: file.name,
        size: file.size,
        alt: file.name.replace(/\.[^.]+$/, ''),
        width: 'auto',
        align: 'center'
      })
    } catch (err) {
      console.error('Failed to preview image:', err)
    }
  }
  
  isProcessing.value = false
}

function createImagePreview(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      if (e.target?.result) {
        resolve(e.target.result as string)
      } else {
        reject(new Error('Failed to read file'))
      }
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function removeImage(id: string): void {
  const index = images.value.findIndex((img) => img.id === id)
  if (index >= 0) {
    images.value.splice(index, 1)
  }
}

// ─── 拖拽上传 ────────────────────────────────────────────────────────────

function handleDragEnter(e: DragEvent): void {
  e.preventDefault()
  isDragging.value = true
}

function handleDragLeave(e: DragEvent): void {
  e.preventDefault()
  // 只在离开对话框时才重置
  if (e.target === dropzoneEl.value) {
    isDragging.value = false
  }
}

function handleDragOver(e: DragEvent): void {
  e.preventDefault()
}

async function handleDrop(e: DragEvent): Promise<void> {
  e.preventDefault()
  isDragging.value = false
  
  const files = Array.from(e.dataTransfer?.files || [])
  if (files.length) {
    await processFiles(files)
  }
}

// ─── URL 输入 ────────────────────────────────────────────────────────────

function validateUrl(url: string): boolean {
  urlError.value = ''
  
  if (!url.trim()) {
    return false
  }
  
  // 检查是否是有效的 URL
  if (!/^(https?:\/\/|data:image\/)/.test(url.trim())) {
    urlError.value = t('toast.imageInvalidUrl')
    return false
  }
  
  return true
}

watch(imageUrl, (val) => {
  if (val.trim()) {
    validateUrl(val)
  } else {
    urlError.value = ''
  }
})

function selectFromHistory(url: string): void {
  imageUrl.value = url
  void nextTick(() => {
    urlInputEl.value?.focus()
  })
}

function addToHistory(url: string): void {
  const history = imageUrlHistory.value.slice()
  // 去重并添加到开头
  const index = history.indexOf(url)
  if (index >= 0) {
    history.splice(index, 1)
  }
  history.unshift(url)
  // 最多保留 10 条
  imageUrlHistory.value = history.slice(0, 10)
}

// ─── 剪贴板粘贴 ──────────────────────────────────────────────────────────

async function pasteFromClipboard(): Promise<void> {
  try {
    const items = await navigator.clipboard.read()
    
    for (const item of items) {
      const imageType = item.types.find((type) => type.startsWith('image/'))
      if (imageType) {
        const blob = await item.getType(imageType)
        const file = new File([blob], 'clipboard.png', { type: imageType })
        await processFiles([file])
        return
      }
    }
    
    ui.toast(t('toast.imageNoClipboard'), 'info')
  } catch (err) {
    console.error('Failed to paste from clipboard:', err)
    ui.toast(t('toast.imageClipboardFailed'), 'error')
  }
}

// ─── 插入操作 ────────────────────────────────────────────────────────────

async function insertImages(): Promise<void> {
  if (!canInsert.value || !insertCallback) return
  
  isProcessing.value = true
  
  try {
    if (activeTab.value === 'url') {
      const url = imageUrl.value.trim()
      if (insertImageFromUrl(insertCallback, url)) {
        addToHistory(url)
      }
    } else {
      // 插入所有选中的图片
      for (const img of images.value) {
        if (img.file) {
          const path = getPathForFile(img.file)
          if (path) {
            await window.luminAPI.file.authorizeUserPath(path)
            await insertImageFromPath(insertCallback, path, img.file.name)
          } else {
            const bytes = new Uint8Array(await img.file.arrayBuffer())
            await insertImageFromBytes(insertCallback, bytes, img.name)
          }
        }
      }
    }
    
    close()
  } catch (err) {
    console.error('Failed to insert images:', err)
    const reason = err instanceof Error ? err.message : String(err)
    ui.toast(t('toast.imageInsertFailed', { reason }), 'error')
  } finally {
    isProcessing.value = false
  }
}

function getPathForFile(file: File): string | null {
  try {
    return window.luminAPI?.file?.getPathForFile?.(file) ?? null
  } catch {
    return null
  }
}

// ─── 键盘事件 ────────────────────────────────────────────────────────────

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    close()
  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    void insertImages()
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleKeydown)
})

// ─── 格式化文件大小 ──────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog-fade">
      <div
        v-if="isOpen"
        class="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm"
        @click.self="close"
      >
        <div
          ref="dialogEl"
          class="relative flex max-h-[85vh] w-full max-w-3xl flex-col rounded-xl bg-white shadow-2xl dark:bg-gray-800"
          @click.stop
        >
          <!-- 标题栏 -->
          <div class="flex items-center justify-between border-b border-gray-200 px-6 py-4 dark:border-gray-700">
            <h2 class="text-xl font-semibold text-gray-900 dark:text-gray-100">
              {{ t('editor.imageDialogTitle') }}
            </h2>
            <button
              class="rounded-lg p-1 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
              :aria-label="t('common.close')"
              @click="close"
            >
              <Icon name="close" class="h-5 w-5" />
            </button>
          </div>

          <!-- 标签页 -->
          <div class="flex border-b border-gray-200 px-6 dark:border-gray-700">
            <button
              class="relative px-4 py-3 text-sm font-medium transition-colors"
              :class="[
                activeTab === 'file'
                  ? 'text-blue-600 dark:text-blue-400'
                  : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200'
              ]"
              @click="activeTab = 'file'"
            >
              <Icon name="folder" class="mr-2 inline h-4 w-4" />
              {{ t('editor.imageFromFile') }}
              <div
                v-if="activeTab === 'file'"
                class="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600 dark:bg-blue-400"
              />
            </button>
            <button
              class="relative px-4 py-3 text-sm font-medium transition-colors"
              :class="[
                activeTab === 'url'
                  ? 'text-blue-600 dark:text-blue-400'
                  : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200'
              ]"
              @click="activeTab = 'url'"
            >
              <Icon name="link" class="mr-2 inline h-4 w-4" />
              {{ t('editor.imageFromUrl') }}
              <div
                v-if="activeTab === 'url'"
                class="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600 dark:bg-blue-400"
              />
            </button>
            <button
              class="relative px-4 py-3 text-sm font-medium transition-colors"
              :class="[
                activeTab === 'clipboard'
                  ? 'text-blue-600 dark:text-blue-400'
                  : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200'
              ]"
              @click="activeTab = 'clipboard'"
            >
              <Icon name="clipboard" class="mr-2 inline h-4 w-4" />
              {{ t('editor.imageFromClipboard') }}
              <div
                v-if="activeTab === 'clipboard'"
                class="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600 dark:bg-blue-400"
              />
            </button>
          </div>

          <!-- 内容区域 -->
          <div class="flex-1 overflow-y-auto p-6">
            <!-- 本地文件标签页 -->
            <div v-show="activeTab === 'file'" class="space-y-4">
              <!-- 拖拽上传区域 -->
              <div
                ref="dropzoneEl"
                class="relative rounded-lg border-2 border-dashed transition-colors"
                :class="[
                  isDragging
                    ? 'border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-900/20'
                    : 'border-gray-300 bg-gray-50 hover:border-gray-400 dark:border-gray-600 dark:bg-gray-900/20 dark:hover:border-gray-500'
                ]"
                @dragenter="handleDragEnter"
                @dragleave="handleDragLeave"
                @dragover="handleDragOver"
                @drop="handleDrop"
              >
                <div class="flex flex-col items-center justify-center py-12">
                  <Icon
                    name="image"
                    class="mb-4 h-16 w-16"
                    :class="isDragging ? 'text-blue-500 dark:text-blue-400' : 'text-gray-400'"
                  />
                  <p class="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                    {{ t('editor.imageDragHint') }}
                  </p>
                  <p class="mb-4 text-xs text-gray-500 dark:text-gray-400">
                    {{ t('editor.imageFormatHint') }}
                  </p>
                  <button
                    type="button"
                    class="rounded-lg bg-blue-600 px-6 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:bg-blue-500 dark:hover:bg-blue-600"
                    @click="openFilePicker"
                  >
                    {{ t('editor.imageSelectFiles') }}
                  </button>
                </div>
                <input
                  ref="fileInputEl"
                  type="file"
                  multiple
                  accept="image/*"
                  class="hidden"
                  @change="handleFileInput"
                />
              </div>

              <!-- 图片预览列表 -->
              <div v-if="images.length" class="space-y-3">
                <div class="flex items-center justify-between">
                  <h3 class="text-sm font-medium text-gray-700 dark:text-gray-300">
                    {{ t('editor.imageSelectedCount', { count: images.length }) }}
                  </h3>
                  <button
                    class="text-xs text-gray-500 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400"
                    @click="images = []"
                  >
                    {{ t('editor.imageClearAll') }}
                  </button>
                </div>
                <div class="space-y-2">
                  <div
                    v-for="img in images"
                    :key="img.id"
                    class="flex items-center gap-3 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900"
                  >
                    <img
                      :src="img.preview"
                      :alt="img.alt"
                      class="h-16 w-16 rounded object-cover"
                    />
                    <div class="flex-1 overflow-hidden">
                      <p class="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                        {{ img.name }}
                      </p>
                      <p v-if="img.size" class="text-xs text-gray-500 dark:text-gray-400">
                        {{ formatSize(img.size) }}
                      </p>
                    </div>
                    <button
                      class="rounded p-1 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-400"
                      :aria-label="t('common.delete')"
                      @click="removeImage(img.id)"
                    >
                      <Icon name="close" class="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <!-- URL 标签页 -->
            <div v-show="activeTab === 'url'" class="space-y-4">
              <div>
                <label class="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {{ t('editor.imageUrlInput') }}
                </label>
                <input
                  ref="urlInputEl"
                  v-model="imageUrl"
                  type="text"
                  class="w-full rounded-lg border px-4 py-2.5 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
                  :class="[
                    urlError
                      ? 'border-red-500 bg-red-50 dark:border-red-400 dark:bg-red-900/20'
                      : 'border-gray-300 bg-white dark:border-gray-600 dark:bg-gray-900'
                  ]"
                  :placeholder="t('editor.imageUrlPlaceholder')"
                  @keydown.enter="insertImages"
                />
                <p v-if="urlError" class="mt-1 text-xs text-red-600 dark:text-red-400">
                  {{ urlError }}
                </p>
              </div>

              <!-- URL 历史记录 -->
              <div v-if="imageUrlHistory.length" class="space-y-2">
                <h3 class="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {{ t('editor.imageUrlHistory') }}
                </h3>
                <div class="space-y-1">
                  <button
                    v-for="(url, idx) in imageUrlHistory"
                    :key="idx"
                    class="block w-full truncate rounded bg-gray-100 px-3 py-2 text-left text-xs text-gray-700 transition-colors hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
                    @click="selectFromHistory(url)"
                  >
                    {{ url }}
                  </button>
                </div>
              </div>
            </div>

            <!-- 剪贴板标签页 -->
            <div v-show="activeTab === 'clipboard'" class="space-y-4">
              <div class="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-300 bg-gray-50 py-16 dark:border-gray-600 dark:bg-gray-900/20">
                <Icon name="clipboard" class="mb-4 h-16 w-16 text-gray-400" />
                <p class="mb-4 text-sm text-gray-700 dark:text-gray-300">
                  {{ t('editor.imageClipboardHint') }}
                </p>
                <button
                  type="button"
                  class="rounded-lg bg-blue-600 px-6 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:bg-blue-500 dark:hover:bg-blue-600"
                  @click="pasteFromClipboard"
                >
                  {{ t('editor.imagePasteFromClipboard') }}
                </button>
              </div>

              <!-- 剪贴板图片预览 -->
              <div v-if="images.length" class="space-y-3">
                <div
                  v-for="img in images"
                  :key="img.id"
                  class="flex items-center gap-3 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900"
                >
                  <img
                    :src="img.preview"
                    :alt="img.alt"
                    class="h-16 w-16 rounded object-cover"
                  />
                  <div class="flex-1">
                    <p class="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {{ img.name }}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 底部操作栏 -->
          <div class="flex items-center justify-between border-t border-gray-200 px-6 py-4 dark:border-gray-700">
            <p class="text-xs text-gray-500 dark:text-gray-400">
              {{ t('editor.imageInsertHint') }}
            </p>
            <div class="flex gap-2">
              <button
                class="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                @click="close"
              >
                {{ t('common.cancel') }}
              </button>
              <button
                class="rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                :class="[
                  canInsert && !isProcessing
                    ? 'bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600'
                    : 'cursor-not-allowed bg-gray-400 dark:bg-gray-600'
                ]"
                :disabled="!canInsert || isProcessing"
                @click="insertImages"
              >
                <span v-if="isProcessing" class="inline-flex items-center gap-2">
                  <span class="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  {{ t('editor.imageInserting') }}
                </span>
                <span v-else>
                  {{ t('editor.imageInsertButton') }}
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.dialog-fade-enter-active,
.dialog-fade-leave-active {
  transition: opacity 0.2s ease;
}

.dialog-fade-enter-from,
.dialog-fade-leave-to {
  opacity: 0;
}

.dialog-fade-enter-active .relative,
.dialog-fade-leave-active .relative {
  transition: transform 0.2s ease;
}

.dialog-fade-enter-from .relative {
  transform: scale(0.95);
}

.dialog-fade-leave-to .relative {
  transform: scale(0.95);
}
</style>
