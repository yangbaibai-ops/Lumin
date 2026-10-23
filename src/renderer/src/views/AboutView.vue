<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import Icon from '../components/Icon.vue'
import { APP_ICON_PNG_BASE64 } from '../assets/iconPng'
import { exportStartupDiagnostics } from '../lib/startupDiagnostics'
import { REPO_MIRRORS } from '../../../shared/appLinks'

const { t } = useI18n()
const router = useRouter()
const version = ref('')
const platform = ref('')
/**
 * 技术栈**不再是硬编码数组**：从构建产物里的 `package.json` 读真实依赖（见 app:getAbout）。
 * 原先那张表里写着 `Marked.js` 与 `highlight.js` —— 本仓库根本没有这两个依赖，
 * 而 Tiptap / KaTeX / Mermaid / CodeMirror 这些真正的重头一个没提。陈述失实比没有更糟。
 */
const deps = ref<{ name: string; version: string }[]>([])
/** 第三方许可声明全文（`THIRD-PARTY-NOTICES.md`，由 `npm run notices` 生成） */
const notices = ref<string | null>(null)
const showLicenses = ref(false)
/**
 * 诊断日志路径（主进程算好，渲染层不拼路径）：用户报「启动慢/闪退」时，
 * 界面上直接能看到该发哪个文件。取不到就不显示这一块。
 */
const logPaths = ref<{ dir: string; app: string; startup: string } | null>(null)

/** 应用标识 = 应用图标本身（内嵌位图，与桌面图标同源；不依赖外部文件） */
const appIconSrc = `data:image/png;base64,${APP_ICON_PNG_BASE64}`

/** 返回进入「关于」之前的界面（无历史则回首页） */
function goBack(): void {
  if (window.history.length > 1) router.back()
  else router.push('/')
}

/** 依赖名去掉 scope 前缀，只用于展示（`@tiptap/starter-kit` → `starter-kit`） */
const depLabel = (name: string): string => name.replace(/^@[^/]+\//, '')

/** 许可清单按需渲染：全文 300 行，塞进 DOM 会拖慢这一页 */
const noticesBlocks = computed(() => (notices.value ? notices.value.split('\n') : []))

onMounted(async () => {
  const info = await window.luminAPI.app.getAbout()
  version.value = info.version
  platform.value = info.platform
  deps.value = info.deps
  notices.value = info.notices
  try {
    logPaths.value = await window.luminAPI.app.getLogPaths()
  } catch {
    /* 日志路径拿不到不影响这一页 */
  }
})

/** 导出启动诊断（与设置页/帮助菜单/状态栏共用同一份实现） */
function exportDiagnostics(): void {
  void exportStartupDiagnostics()
}

/** 打开日志目录（主进程固定打开我们自己的目录，不接受参数） */
function openLogDir(): void {
  void window.luminAPI.app.openLogDir()
}

/**
 * 打开仓库镜像（GitHub 主仓库 / Gitee / GitCode）。
 * 走 `'project'` scope → 主进程 `safeProjectUrl` 的协议 + 域名白名单，
 * 与「帮助 → 项目主页」和原生菜单是同一份清单、同一条通道。
 */
function openMirror(url: string): void {
  window.luminAPI.shell.openExternal(url, 'project')
}
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="mx-auto flex max-w-[560px] flex-col items-center px-8 pb-16 pt-16 text-center">
      <!-- 应用图标：直接展示图标位图本身（原先是一个渐变方块 + 线性 logo，与桌面图标不同源） -->
      <img
        :src="appIconSrc"
        :alt="t('app.name')"
        class="mb-6 h-20 w-20 rounded-[22px]"
        :style="{
          animation: 'lm-pop 0.5s cubic-bezier(0.2, 0.9, 0.3, 1.2)',
          boxShadow: '0 12px 40px var(--glow)'
        }"
      />
      <h1 class="text-[28px] font-bold tracking-tight text-ink">{{ t('app.name') }}</h1>
      <p class="mt-1 text-[13.5px] font-medium uppercase tracking-[0.25em] text-accent-ink">
        {{ t('app.tagline') }}
      </p>

      <p class="mt-6 max-w-[440px] text-[13.5px] leading-relaxed text-ink-2">
        {{ t('about.desc') }}
      </p>

      <div class="mt-8 grid w-full grid-cols-2 gap-3">
        <div class="surface p-4">
          <p class="text-[11px] uppercase tracking-[0.12em] text-ink-2b">
            {{ t('about.version') }}
          </p>
          <p class="mt-1 text-[15px] font-semibold text-ink">v{{ version }}</p>
        </div>
        <div class="surface p-4">
          <p class="text-[11px] uppercase tracking-[0.12em] text-ink-2b">
            {{ t('about.platform') }}
          </p>
          <p class="mt-1 text-[15px] font-semibold text-ink capitalize">{{ platform }}</p>
        </div>
      </div>

      <!-- 仓库镜像：GitHub（主仓库）+ Gitee / GitCode。清单只来自 shared/appLinks.ts
           （模板里不写 URL），点击走主进程 `safeProjectUrl` 的域名白名单。 -->
      <div class="mt-8 w-full text-left" data-about-mirrors>
        <h2 class="mb-1 text-center text-ui-sm font-semibold uppercase tracking-wide text-ink-2b">
          {{ t('about.mirrors') }}
        </h2>
        <p class="mb-3 text-center text-ui-sm text-ink-2b">{{ t('about.mirrorsHint') }}</p>
        <div class="flex flex-col gap-2">
          <button
            v-for="mirror in REPO_MIRRORS"
            :key="mirror.id"
            class="surface flex items-center gap-2 px-3 py-2 text-left transition-colors duration-150 hover:border-accent"
            :data-about-mirror="mirror.id"
            :title="mirror.url"
            @click="openMirror(mirror.url)"
          >
            <Icon name="globe" :size="14" class="flex-none text-ink-2b" />
            <span class="flex-none text-ui font-medium text-ink">{{ mirror.name }}</span>
            <span class="min-w-0 flex-1 truncate font-mono text-ui-sm text-accent-ink">
              {{ mirror.url }}
            </span>
          </button>
        </div>
      </div>

      <div class="mt-8 w-full" data-about-deps>
        <h2 class="mb-3 text-ui-sm font-semibold uppercase tracking-[0.14em] text-ink-2b">
          {{ t('about.stack') }}
          <!-- 审计 P2「关于页 12px 版本号对比度 2.56:1」：原先是 --ink-3 再叠 80% 透明，
               羊皮纸主题实测 2.56:1。改用不透明的 --ink-2b（三主题实测 5.32 / 7.06 / 5.11:1）。 -->
          <span class="ml-1 font-normal normal-case tracking-normal text-ink-2b">
            {{ t('about.stackCount', { n: deps.length }) }}
          </span>
        </h2>
        <div class="flex flex-wrap justify-center gap-2">
          <span
            v-for="d in deps"
            :key="d.name"
            data-about-dep
            class="rounded-full border border-edge bg-panel px-3 py-1 text-[11.5px] text-ink-2 transition-colors duration-150 hover:border-accent hover:text-accent-ink"
            :title="`${d.name}@${d.version}`"
          >
            {{ depLabel(d.name) }}
          </span>
        </div>
      </div>

      <!-- 开源许可：全文来自 THIRD-PARTY-NOTICES.md（npm run notices 生成），
           按需展开 —— 300 个包的表格直接塞进 DOM 会让这一页变重 -->
      <div v-if="notices" class="mt-8 w-full" data-about-licenses>
        <button
          class="flex w-full items-center justify-center gap-1.5 text-ui-sm font-semibold uppercase tracking-[0.14em] text-ink-2b transition-colors hover:text-accent-ink"
          :aria-expanded="showLicenses ? 'true' : 'false'"
          data-about-licenses-toggle
          @click="showLicenses = !showLicenses"
        >
          {{ t('about.licenses') }}
          <Icon
            name="chevron-right"
            :size="13"
            class="transition-transform duration-150"
            :class="showLicenses ? 'rotate-90' : ''"
          />
        </button>
        <p v-if="!showLicenses" class="mt-2 text-ui-sm text-ink-2b">
          {{ t('about.licensesHint') }}
        </p>
        <div
          v-else
          class="mt-2 max-h-[320px] overflow-y-auto rounded-lg border border-edge bg-panel p-3 text-left"
          data-about-notices
        >
          <pre class="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-ink-2">{{
            noticesBlocks.join('\n')
          }}</pre>
        </div>
      </div>

      <!-- 诊断日志：用户报「启动慢/闪退」时的取证入口。路径来自主进程（脱敏展示），
           导出与设置页/帮助菜单/状态栏共用同一份实现 -->
      <div v-if="logPaths" class="mt-8 w-full text-left" data-about-logs>
        <h2 class="mb-3 text-ui-sm font-semibold uppercase tracking-[0.14em] text-ink-2b">
          {{ t('about.logs') }}
        </h2>
        <div class="surface p-4">
          <p class="text-ui-sm text-ink-2">{{ t('about.logsHint') }}</p>
          <p class="mt-2 break-all font-mono text-ui-sm leading-relaxed text-ink-2b">
            {{ t('about.logPath') }}: {{ logPaths.startup }}
          </p>
          <div class="mt-3 flex flex-wrap gap-2">
            <button
              class="btn btn-outline px-3 py-1.5 text-ui-sm"
              data-about-export-startup
              @click="exportDiagnostics"
            >
              <Icon name="download" :size="13" />
              {{ t('menu.exportStartupDiagnostics') }}
            </button>
            <button
              class="btn btn-outline px-3 py-1.5 text-ui-sm"
              data-about-open-logs
              @click="openLogDir"
            >
              <Icon name="folder" :size="13" />
              {{ t('settings.openLogDir') }}
            </button>
          </div>
        </div>
      </div>

      <p class="mt-10 text-ui-sm text-ink-2b">{{ t('about.license') }}</p>

      <button class="btn btn-outline mt-6 px-5 py-2 text-[13px]" @click="goBack">
        <Icon name="chevron-right" :size="14" class="rotate-180" />
        {{ t('about.back') }}
      </button>
    </div>
  </div>
</template>
