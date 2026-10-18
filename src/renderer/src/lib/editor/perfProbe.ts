// ─── 性能探针（默认**关闭**，只在测量实例里打开）────────────────────────────────
//
// 为什么不是 `localStorage` 开关：渲染层是 `file://` 生产构建，每次测量都改 profile
// 再 reload 会把「打开文档」也重走一遍，基线不可比。这里在模块初始化时挂一个
// `window.__LPERF`，测量脚本跑起来后把 `on` 置 true —— **关闭时只有一次布尔判断**，
// 既不影响用户路径，也不改变任何 DOM / 编辑语义。
//
// 计数点（见 imageToolbar.ts）：
//   * `paint`       paintSelBands 调用次数
//   * `visible`     visibleFrags 全文档文本节点遍历次数
//   * `collect`     collectImgSources 真正扫描文档次数
//   * `collectHit`  命中 doc 缓存的次数
//   * `decoCall`    decorations() 被 PM 请求次数
//   * `decoBuild`   其中重建整个装饰集的次数
//   * `decoHit`     直接返回缓存集（doc + open/editing + 选区状态都没变）的次数
//   * `paintLive`   拖动期 live 绘制真正执行的次数
//   * `paintSkip`   同帧重复请求被合并掉的次数
export interface PerfCounts {
  paint: number
  visible: number
  collect: number
  collectHit: number
  decoCall: number
  decoBuild: number
  decoHit: number
  paintLive: number
  paintSkip: number
}

export interface PerfToggles {
  /** 选区带绘制（paintSelBands / CSS.highlights）总开关 */
  selBand: boolean
  /** 图片/公式 decoration 重建（关 = decorations 返回 null） */
  imgDeco: boolean
  /** update() 里的逐帧 live 重绘（关 = 只靠 mousemove 那一路） */
  livePaint: boolean
  /** collectImgSources 按 doc 缓存（关 = 每次全文档扫描，A/B 用） */
  imgCache: boolean
  /** 拖动期绘制按帧合并（关 = 每次调用都立即画） */
  paintCoalesce: boolean
  /** 光标本来就在视口内时跳过 PM 的 scrollRectIntoView 逐层量矩形（关 = 恢复旧路径） */
  fastScroll: boolean
}

export interface PerfProbe {
  on: boolean
  counts: PerfCounts
  toggles: PerfToggles
}

const probe: PerfProbe = {
  on: false,
  counts: {
    paint: 0,
    visible: 0,
    collect: 0,
    collectHit: 0,
    decoCall: 0,
    decoBuild: 0,
    decoHit: 0,
    paintLive: 0,
    paintSkip: 0
  },
  toggles: {
    selBand: true,
    imgDeco: true,
    livePaint: true,
    imgCache: true,
    paintCoalesce: true,
    fastScroll: true
  }
}

try {
  if (typeof window !== 'undefined') {
    ;(window as unknown as { __LPERF?: PerfProbe }).__LPERF = probe
  }
} catch {
  /* 非渲染环境（单测 import）：忽略 */
}

/** 计数（关闭时是一次属性读取 + 判空，不分配） */
export function perfCount(k: keyof PerfCounts, n = 1): void {
  if (probe.on) probe.counts[k] += n
}

/** A/B 开关：测量未开启时恒为 true（= 既有行为） */
export function perfFlag(k: keyof PerfToggles): boolean {
  return !probe.on || probe.toggles[k]
}

export { probe as perfProbe }
