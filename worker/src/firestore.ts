import { HttpError, type MediaType, type Member, type Scope, mayPost, mayView, reserveBytes } from './domain.ts'
import { GoogleAccess } from './google.ts'

type Value = { stringValue?: string; integerValue?: string; booleanValue?: boolean }
type Doc = { name: string; fields?: Record<string, Value> }
type Write = { update: Doc; currentDocument?: { exists: boolean } }
type Media = { type: MediaType; bytes: number; key: string }
type Access = { family: string; post: string; uid: string }
export interface Store {
  reserve(access: Access, id: string, type: MediaType, bytes: number): Promise<Media>
  complete(access: Access, id: string): Promise<void>
  read(access: Access, id: string): Promise<Media>
}
class Contention extends Error {}

const string = (doc: Doc | null, key: string) => doc?.fields?.[key]?.stringValue
const integer = (doc: Doc | null, key: string) => Number(doc?.fields?.[key]?.integerValue ?? (doc ? NaN : 0))
const s = (stringValue: string) => ({ stringValue })
const n = (value: number) => ({ integerValue: String(value) })

export class Firestore implements Store {
  private readonly root: string
  private readonly google: Pick<GoogleAccess, 'token'>
  private readonly fetcher: typeof fetch
  constructor(project: string, google: Pick<GoogleAccess, 'token'>, fetcher: typeof fetch = fetch.bind(globalThis)) {
    this.google = google
    this.fetcher = fetcher
    this.root = 'projects/' + project + '/databases/(default)/documents'
  }

  private async call<T>(path: string, init?: RequestInit, missing = false): Promise<T> {
    const response = await this.fetcher('https://firestore.googleapis.com/v1/' + this.root + path, {
      ...init,
      headers: { Authorization: 'Bearer ' + await this.google.token(), 'Content-Type': 'application/json' },
    })
    if (response.status === 404 && missing) return null as T
    if (!response.ok) {
      const detail = await response.json().catch(() => null) as { error?: { status?: string } } | null
      if (detail?.error?.status === 'ABORTED') throw new Contention()
      if (detail?.error?.status === 'ALREADY_EXISTS') throw new HttpError(409, 'upload ID already used')
      throw new HttpError(503, 'Firestore request failed')
    }
    return await response.json() as T
  }

  private send<T>(action: string, body: object) {
    return this.call<T>(':' + action, { method: 'POST', body: JSON.stringify(body) })
  }

  private get(path: string, tx?: string) {
    return this.call<Doc | null>('/' + path + (tx ? '?transaction=' + encodeURIComponent(tx) : ''), undefined, true)
  }

  private write(path: string, fields: Record<string, Value>, create = false): Write {
    const update = { name: this.root + '/' + path, fields }
    return create ? { update, currentDocument: { exists: false } } : { update }
  }

  private async transaction<T>(fn: (tx: string) => Promise<{ result: T; writes: Write[] }>) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let tx: string | undefined
      try {
        tx = (await this.send<{ transaction: string }>('beginTransaction', { options: { readWrite: {} } })).transaction
        const { result, writes } = await fn(tx)
        await this.send('commit', { transaction: tx, writes })
        return result
      } catch (error) {
        if (tx) await this.send('rollback', { transaction: tx }).catch(() => {})
        if (!(error instanceof Contention)) throw error
      }
    }
    throw new HttpError(503, 'Firestore transaction busy')
  }

  private paths(access: Access, id: string) {
    const family = 'families/' + access.family
    const post = family + '/posts/' + access.post
    return { family, post, media: post + '/media/' + id, member: family + '/members/' + encodeURIComponent(access.uid) }
  }

  private async authorize(access: Access, id: string, write: boolean, tx?: string) {
    const paths = this.paths(access, id)
    const memberDoc = await this.get(paths.member, tx)
    if (memberDoc?.fields?.active?.booleanValue !== true) throw new HttpError(403, 'family membership required')
    const member = { role: string(memberDoc, 'role'), side: string(memberDoc, 'side') } as Member
    const post = await this.get(paths.post, tx)
    if (!post || post.fields?.phase0Fixture?.booleanValue !== true) throw new HttpError(404, 'test post not found')
    if (!mayView(member, string(post, 'scope') as Scope) || (write && !mayPost(member))) {
      throw new HttpError(403, 'post access denied')
    }
    return paths
  }

  async reserve(access: Access, id: string, type: MediaType, bytes: number) {
    const month = new Date().toISOString().slice(0, 7)
    return this.transaction(async tx => {
      const paths = await this.authorize(access, id, true, tx)
      if (await this.get(paths.media, tx)) throw new HttpError(409, 'upload ID already used')
      const totalPath = paths.family + '/quota/storage'
      const monthPath = paths.family + '/quota/' + month
      const total = await this.get(totalPath, tx)
      const monthly = await this.get(monthPath, tx)
      const storageBytes = integer(total, 'bytes')
      const monthlyBytes = integer(monthly, 'bytes')
      if (access.family === 'phase0-quota') {
        console.info('Quota test before reservation', { month, storageBytes, monthlyBytes, uploadBytes: bytes })
      }
      const limits = reserveBytes(storageBytes, monthlyBytes, bytes)
      const media = { type, bytes, key: access.family + '/' + access.post + '/' + id }
      return { result: media, writes: [
        this.write(totalPath, { bytes: n(limits.total) }),
        this.write(monthPath, { bytes: n(limits.month) }),
        this.write(paths.media, {
          type: s(type), bytes: n(bytes), key: s(media.key), state: s('reserved'),
          uid: s(access.uid), month: s(month), reservedAt: s(new Date().toISOString()),
        }, true),
      ] }
    })
  }

  async complete(access: Access, id: string) {
    return this.transaction(async tx => {
      const paths = await this.authorize(access, id, true, tx)
      const doc = await this.get(paths.media, tx)
      if (!doc || string(doc, 'uid') !== access.uid || string(doc, 'state') !== 'reserved') {
        throw new HttpError(409, 'reservation unavailable')
      }
      return { result: undefined, writes: [this.write(paths.media, { ...doc.fields, state: s('ready') })] }
    })
  }

  async read(access: Access, id: string): Promise<Media> {
    const paths = await this.authorize(access, id, false)
    const doc = await this.get(paths.media)
    if (!doc || string(doc, 'state') !== 'ready') throw new HttpError(404, 'media not found')
    const type = string(doc, 'type')
    const key = access.family + '/' + access.post + '/' + id
    if ((type !== 'image/jpeg' && type !== 'video/mp4') || string(doc, 'key') !== key) {
      throw new HttpError(503, 'invalid media record')
    }
    return { type, key, bytes: integer(doc, 'bytes') }
  }
}
