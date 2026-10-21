// ─── API Key 的**加解密存取**（纯逻辑，依赖注入，可单测）────────────────────
//
// 硬性约束：渲染层永远拿不到明文 Key。
//   * 明文只在这一层的内存里出现一次（save/load 的瞬间）；
//   * 落库的是 `{ v, alg, data }` —— `data` 是 `safeStorage.encryptString()` 的
//     base64；**不落明文、不回显、不写日志**；
//   * safeStorage 不可用时**拒绝保存**（绝不退化成明文/弱混淆）—— 返回
//     `key-unavailable`，界面如实告诉用户。
//
// 这里刻意不 import electron：主进程把真实的 `safeStorage` 与 `db` 的 kv 适配器注入，
// 单测用假实现（见 tests/ai.test.mjs）验证同一套逻辑。

/** 数据库 kv 表里的键名（形态：加密串记录） */
export const AI_KEY_KV = 'aiApiKey'
/** 当前记录的算法标记（将来换算法时据此迁移/拒绝） */
export const AI_KEY_SCHEME = 'safeStorage'

export interface EncryptedRecord {
  /** 结构版本 */
  v: 1
  /** 加密方式；只认 'safeStorage' */
  alg: typeof AI_KEY_SCHEME
  /** safeStorage.encryptString() 的 base64 */
  data: string
  /** 写入时间（只用于状态显示/诊断，不含明文） */
  updatedAt: number
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface KvLike {
  get<T>(key: string, fallback: T): T
  set(key: string, value: unknown): void
  delete(key: string): void
}

export type AiKeySaveResult =
  { ok: true; updatedAt: number } | { ok: false; code: 'empty-key' | 'key-unavailable' }

export interface AiKeyStore {
  /** 只返回布尔与时间，绝不返回明文 */
  status(): { hasKey: boolean; updatedAt: number | null; scheme: typeof AI_KEY_SCHEME | null }
  /** 取明文：只给主进程的请求组装用（渲染层不可达） */
  load(): string | null
  save(raw: string): AiKeySaveResult
  clear(): void
}

function isRecord(v: unknown): v is EncryptedRecord {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return (
    r.v === 1 &&
    r.alg === AI_KEY_SCHEME &&
    typeof r.data === 'string' &&
    r.data.length > 0 &&
    typeof r.updatedAt === 'number'
  )
}

export function createAiKeyStore(crypto: SafeStorageLike, kv: KvLike): AiKeyStore {
  const readRecord = (): EncryptedRecord | null => {
    const value = kv.get<unknown>(AI_KEY_KV, null)
    return isRecord(value) ? value : null
  }

  return {
    status() {
      const record = readRecord()
      return {
        hasKey: !!record,
        updatedAt: record?.updatedAt ?? null,
        scheme: record ? AI_KEY_SCHEME : null
      }
    },

    load() {
      const record = readRecord()
      if (!record) return null
      // 换机器/换用户后 DPAPI 解不开：当作没有 Key（下次保存会覆盖），
      // 不抛、也不把密文回给渲染层。
      try {
        if (!crypto.isEncryptionAvailable()) return null
        const plain = crypto.decryptString(Buffer.from(record.data, 'base64'))
        return plain.trim() || null
      } catch {
        return null
      }
    },

    save(raw: string) {
      const plain = String(raw ?? '').trim()
      if (!plain) return { ok: false, code: 'empty-key' }
      // 只允许可打印 ASCII 作为 Key（避免把中文/换行误存；各家 Key 都是 ASCII）
      if (!/^[\x21-\x7e]+$/.test(plain)) {
        // 不单独造错误码：这属于"空/非法 Key"，界面按空 Key 处理
        return { ok: false, code: 'empty-key' }
      }
      if (!crypto.isEncryptionAvailable()) return { ok: false, code: 'key-unavailable' }
      try {
        const data = crypto.encryptString(plain).toString('base64')
        const updatedAt = Date.now()
        const record: EncryptedRecord = { v: 1, alg: AI_KEY_SCHEME, data, updatedAt }
        kv.set(AI_KEY_KV, record)
        return { ok: true, updatedAt }
      } catch {
        return { ok: false, code: 'key-unavailable' }
      }
    },

    clear() {
      kv.delete(AI_KEY_KV)
    }
  }
}
