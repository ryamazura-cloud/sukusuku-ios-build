export const MAX_UPLOAD = 16_000_000
export function memberAvatar(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^(person|animal)-(0[1-9]|[1-4]\d|50)$/.test(value)) {
    throw new HttpError(400, 'invalid member avatar')
  }
  return value
}

export const MAX_STORAGE = 5_000_000_000
export const MAX_MONTH = 300_000_000
export const MAX_VIDEO_MS = 60_000

export class HttpError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 411 | 413 | 415 | 422 | 429 | 503
  constructor(status: HttpError['status'], message: string) {
    super(message)
    this.status = status
  }
}

export type Scope = 'parents' | 'all' | 'paternal' | 'maternal'
export type Member = { role: 'parent' | 'admin' | 'grandparent'; side?: 'paternal' | 'maternal' }
export type MediaType = 'image/jpeg' | 'video/mp4'

export const inviteRoles = ['parent', 'paternal', 'maternal'] as const
export type InviteRole = typeof inviteRoles[number]
export type FamilyMembership = Member & { id: string; name: string; relationship?: string }
export type FamilyInvite = { code: string; expiresAt: string }

export function mayPost(member: Member | null) {
  return member?.role === 'parent' || member?.role === 'admin'
}

export function mayView(member: Member | null, scope: Scope) {
  if (!member || !['parents', 'all', 'paternal', 'maternal'].includes(scope)) return false
  if (mayPost(member)) return true
  return member.role === 'grandparent' &&
    (scope === 'all' || (scope !== 'parents' && member.side === scope))
}

export function reserveBytes(total: number, month: number, bytes: number) {
  if (![total, month, bytes].every(Number.isSafeInteger) || total < 0 || month < 0 ||
      bytes < 1 || bytes > MAX_UPLOAD) throw new HttpError(400, 'invalid bytes')
  if (total + bytes > MAX_STORAGE) {
    throw new HttpError(413, 'family total storage quota exceeded')
  }
  if (month + bytes > MAX_MONTH) {
    throw new HttpError(413, 'family monthly upload quota exceeded')
  }
  return { total: total + bytes, month: month + bytes }
}

export function validateMedia(buffer: ArrayBuffer, type: MediaType, stripMetadata = false) {
  const bytes = new Uint8Array(buffer)
  if (type === 'image/jpeg') {
    if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 ||
        bytes.at(-2) !== 255 || bytes.at(-1) !== 217) {
      throw new HttpError(422, 'invalid JPEG envelope')
    }
    return
  }
  const view = new DataView(buffer)
  // The development spike accepts regular, non-fragmented MP4 only.
  function boxes(start: number, end: number) {
    const result: { type: string; start: number; body: number; end: number }[] = []
    while (start + 8 <= end && result.length < 512) {
      const sizeField = view.getUint32(start)
      const type = String.fromCharCode(...bytes.subarray(start + 4, start + 8))
      const headerBytes = (sizeField === 1 ? 16 : 8) + (type === 'uuid' ? 16 : 0)
      const remaining = end - start
      if (headerBytes > remaining) break
      let size = sizeField
      if (sizeField === 1) {
        const extendedSize = view.getBigUint64(start + 8)
        if (extendedSize > BigInt(remaining)) break
        size = Number(extendedSize)
      } else if (sizeField === 0) {
        // A zero size extends to the end of the file, including in a final parent.
        if (end !== bytes.length) break
        size = remaining
      }
      if (size < headerBytes || size > remaining) break
      result.push({ type, start, body: start + headerBytes, end: start + size })
      start += size
    }
    if (start !== end) throw new HttpError(422, 'invalid MP4 boxes')
    return result
  }
  const top = boxes(0, bytes.length)
  const movie = top.find(box => box.type === 'moov')
  if (top[0]?.type !== 'ftyp' || !movie || !top.some(box => box.type === 'mdat') ||
      top.some(box => box.type === 'moof')) throw new HttpError(422, 'invalid or fragmented MP4')
  const header = boxes(movie.body, movie.end).find(box => box.type === 'mvhd')
  if (!header) throw new HttpError(422, 'missing MP4 duration')
  const version = bytes[header.body]
  const offset = header.body + (version === 0 ? 12 : 20)
  if ((version !== 0 && version !== 1) || offset + (version === 0 ? 8 : 12) > header.end) {
    throw new HttpError(422, 'invalid MP4 duration')
  }
  const scale = view.getUint32(offset)
  const duration = version === 0 ? BigInt(view.getUint32(offset + 4)) : view.getBigUint64(offset + 4)
  if (scale === 0 || duration === 0n || duration * 1000n > BigInt(scale) * BigInt(MAX_VIDEO_MS)) {
    throw new HttpError(422, 'video must be at most 60 seconds')
  }
  if (stripMetadata) {
    function clearMetadata(entries: ReturnType<typeof boxes>) {
      for (const entry of entries) {
        if (['udta', 'meta', 'loci', '\u00a9xyz'].includes(entry.type)) {
          bytes.set([102, 114, 101, 101], entry.start + 4) // free
          bytes.fill(0, entry.body, entry.end)
        } else if (entry.type === 'moov' || entry.type === 'trak' || entry.type === 'mdia') {
          clearMetadata(boxes(entry.body, entry.end))
        }
      }
    }
    clearMetadata(top)
  }
}
