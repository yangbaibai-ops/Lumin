// ─── 最小 ZIP 写入器（无依赖）────────────────────────────────────────────────
//
// 两个用途：
//   * **EPUB**（`export.ts`）：规范要求 `mimetype` 是第一个条目且**不压缩** →
//     用 `zipStore`（STORE）；其余条目也可以 STORE，阅读器照样认。
//   * **工作区快照备份**（`services/workspaceBackup.ts`）：一堆 Markdown / 图片，
//     压缩后小一个数量级 → 用 `zipDeflate`（DEFLATE）。
//
// 从 `export.ts` 抽出来是为了第二个用途能复用（并让"ZIP 写对了没有"这件事有单测：
// `tests/zip.test.mjs` 用 Node 自带的 zlib 反向解压验证）。
import { deflateRawSync } from 'zlib'

export interface ZipEntry {
  name: string
  data: Buffer
}

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32（ZIP 条目头要它） */
export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** DOS 时间戳（ZIP 头用；精度 2 秒，够用） */
function dosStamp(now: Date): { time: number; date: number } {
  const time = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff
  const date =
    (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff
  return { time, date }
}

/**
 * 打包成 ZIP。
 * @param compress false = STORE（不压缩，EPUB 的 mimetype 必须这样）；true = DEFLATE
 */
export function zip(entries: ZipEntry[], compress = false): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  const { time: dosTime, date: dosDate } = dosStamp(new Date())

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf-8')
    const crc = crc32(entry.data)
    // 压不小就别压（DEFLATE 对已压缩的图片反而会变大）
    const deflated = compress ? deflateRawSync(entry.data) : null
    const useDeflate = !!deflated && deflated.length < entry.data.length
    const payload = useDeflate ? deflated! : entry.data
    const method = useDeflate ? 8 : 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 文件名标志
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18) // 压缩后大小
    local.writeUInt32LE(entry.data.length, 22) // 原始大小
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBuf, payload)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4) // version made by
    cen.writeUInt16LE(20, 6) // version needed
    cen.writeUInt16LE(0x0800, 8)
    cen.writeUInt16LE(method, 10)
    cen.writeUInt16LE(dosTime, 12)
    cen.writeUInt16LE(dosDate, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(payload.length, 20)
    cen.writeUInt32LE(entry.data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, nameBuf)
    offset += 30 + nameBuf.length + payload.length
  }

  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, centralBuf, end])
}

/** STORE（不压缩）：EPUB 的 mimetype 条目必须用它 */
export function zipStore(entries: ZipEntry[]): Buffer {
  return zip(entries, false)
}

/** DEFLATE（压缩）：工作区快照这类纯文本多的归档用它 */
export function zipDeflate(entries: ZipEntry[]): Buffer {
  return zip(entries, true)
}
