import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * 页面可见性（用于过渡动画开关）。
 * 窗口被遮挡/最小化时 Chromium 会暂停 CSS 过渡，导致
 * mode="out-in" 的路由切换永远等不到 transitionend 而死锁；
 * 隐藏时关闭过渡 CSS 即可瞬时完成切换。
 */
export function usePageVisible(): { pageVisible: Readonly<ReturnType<typeof ref<boolean>>> } {
  const pageVisible = ref(document.visibilityState === 'visible')
  const onChange = (): void => {
    pageVisible.value = document.visibilityState === 'visible'
  }
  onMounted(() => document.addEventListener('visibilitychange', onChange))
  onBeforeUnmount(() => document.removeEventListener('visibilitychange', onChange))
  return { pageVisible }
}
