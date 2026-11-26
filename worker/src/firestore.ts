import {
  HttpError, type FamilyInvite, type FamilyMembership, type InviteRole,
  type MediaType, type Member, type Scope, mayPost, mayView, reserveBytes,
} from './domain.ts'
import { GoogleAccess } from './google.ts'

export type Value = { stringValue?: string; integerValue?: string; booleanValue?: boolean }
export type Doc = { name: string; fields?: Record<string, Value> }
export type Write = { update: Doc; currentDocument?: { exists: boolean } } | { delete: string }
type Media = { type: MediaType; bytes: number; key: string }
type Access = { family: string; post: string; uid: string }
export interface Store {
  reserve(access: Access, id: string, type: MediaType, bytes: number): Promise<Media>
  complete(access: Access, id: string): Promise<void>
  read(access: Access, id: string): Promise<Media>
}
export type ParentRelationship = 'father' | 'mother'
export type GuestRelationship = 'grandfather' | 'grandmother' | 'sibling' | 'other'
export type JoinProfile = { nickname: string; relationship: ParentRelationship | GuestRelationship }
export type NewAlbum = JoinProfile & { relationship: ParentRelationship; childName: string; birthday: string }

export interface FamilyStore {
  inviteType?(uid: string, code: string): Promise<'parent' | 'viewer'>
  membership(uid: string): Promise<FamilyMembership | null>
  createFamily(uid: string, name: string, profile?: NewAlbum): Promise<FamilyMembership>
  createInvite(uid: string, family: string, role: InviteRole): Promise<FamilyInvite>
  joinFamily(uid: string, code: string, profile?: JoinProfile): Promise<FamilyMembership>
}
class Contention extends Error {}
export class FirestorePrecondition extends HttpError {
  constructor() { super(503, 'Firestore request failed') }
}

export const string = (doc: Doc | null, key: string) => doc?.fields?.[key]?.stringValue
export const integer = (doc: Doc | null, key: string) => Number(doc?.fields?.[key]?.integerValue ?? (doc ? NaN : 0))
export const s = (stringValue: string) => ({ stringValue })
export const n = (value: number) => ({ integerValue: String(value) })
const active = { booleanValue: true }
const inviteLifetime = 24 * 60 * 60 * 1000
const familyMemberLimit = 10
export const userKey = (uid: string) => 'u-' + btoa(String.fromCharCode(...new TextEncoder().encode(uid)))
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

export class Firestore implements Store, FamilyStore {
  protected readonly root: string
  protected readonly google: Pick<GoogleAccess, 'token'>
  protected readonly fetcher: typeof fetch
  constructor(project: string, google: Pick<GoogleAccess, 'token'>, fetcher: typeof fetch = fetch.bind(globalThis)) {
    this.google = google
    this.fetcher = fetcher
    this.root = 'projects/' + project + '/databases/(default)/documents'
  }

  protected async call<T>(path: string, init?: RequestInit, missing = false): Promise<T> {
    const response = await this.fetcher('https://firestore.googleapis.com/v1/' + this.root + path, {
      ...init,
      headers: { Authorization: 'Bearer ' + await this.google.token(), 'Content-Type': 'application/json' },
    })
    if (response.status === 404 && missing) return null as T
    if (!response.ok) {
      const detail = await response.json().catch(() => null) as { error?: { status?: string; message?: string } } | null
      if (detail?.error?.status === 'ABORTED') throw new Contention()
      if (detail?.error?.status === 'ALREADY_EXISTS') throw new HttpError(409, 'record already exists')
      // Report only the operation and status. Paths and response bodies may contain private data.
      const operation = path.includes('pageSize=') ? 'list' : path.startsWith(':') ? path : 'get'
      const upstream = detail?.error?.status
      console.warn('Firestore request failed', operation, response.status,
        upstream && /^[A-Z_]+$/.test(upstream) ? upstream : 'UNKNOWN')
      if (operation === 'list' && upstream === 'FAILED_PRECONDITION') {
        if (/requires an index|index is (?:still )?building/i.test(detail?.error?.message ?? '')) {
          console.warn('Firestore list index is missing or building')
        }
        throw new FirestorePrecondition()
      }
      throw new HttpError(503, 'Firestore request failed')
    }
    return await response.json() as T
  }

  protected send<T>(action: string, body: object) {
    return this.call<T>(':' + action, { method: 'POST', body: JSON.stringify(body) })
  }

  protected get(path: string, tx?: string) {
    return this.call<Doc | null>('/' + path + (tx ? '?transaction=' + encodeURIComponent(tx) : ''), undefined, true)
  }

  protected write(path: string, fields: Record<string, Value>, create = false): Write {
    const update = { name: this.root + '/' + path, fields }
    return create ? { update, currentDocument: { exists: false } } : { update }
  }

  protected async transaction<T>(fn: (tx: string) => Promise<{ result: T; writes: Write[] }>) {
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

  protected familyMember(doc: Doc | null): Member | null {
    if (doc?.fields?.active?.booleanValue !== true) return null
    const role = string(doc, 'role')
    const side = string(doc, 'side')
    if (role === 'admin' || role === 'parent') return { role }
    if (role === 'grandparent' && (side === 'paternal' || side === 'maternal')) {
      return { role, side }
    }
    return null
  }

  async membership(uid: string): Promise<FamilyMembership | null> {
    const user = userKey(uid)
    const index = await this.get('family_memberships/' + user)
    const id = string(index, 'familyId')
    if (!id) return null
    const path = 'families/' + id
    const [family, membership] = await Promise.all([
      this.get(path), this.get(path + '/members/' + user),
    ])
    const member = this.familyMember(membership)
    const name = string(family, 'name')
    return member && name ? this.describeMembership(id, name, member, membership) : null
  }

  private describeMembership(id: string, name: string, member: Member, doc: Doc | null): FamilyMembership {
    const relationship = string(doc, 'relationship')
    return { id, name, ...member, ...(relationship ? { relationship } : {}) }
  }

  async inviteType(uid: string, code: string): Promise<'parent' | 'viewer'> {
    const invite = await this.get('family_invites/' + code)
    const role = string(invite, 'role')
    const usedBy = string(invite, 'usedBy')
    if ((role !== 'parent' && role !== 'paternal' && role !== 'maternal') ||
        (usedBy ? usedBy !== uid : !(Date.parse(string(invite, 'expiresAt') ?? '') > Date.now()))) {
      throw new HttpError(404, 'invite unavailable')
    }
    return role === 'parent' ? 'parent' : 'viewer'
  }

  async createFamily(uid: string, name: string, profile?: NewAlbum): Promise<FamilyMembership> {
    const id = crypto.randomUUID()
    const child = crypto.randomUUID()
    const path = 'families/' + id
    const user = userKey(uid)
    const index = 'family_memberships/' + user
    return this.transaction<FamilyMembership>(async tx => {
      if (await this.get('retired_users/' + user, tx)) throw new HttpError(403, 'account inactive')
      if (await this.get(index, tx)) throw new HttpError(409, 'already belongs to a family')
      return { result: { id, name, role: 'admin', ...(profile ? { relationship: profile.relationship } : {}) }, writes: [
        this.write(path, { name: s(name), memberCount: n(1) }, true),
        this.write(path + '/members/' + user, { role: s('admin'), active,
          ...(profile ? { relationship: s(profile.relationship) } : {}) }, true),
        ...(profile ? [
          this.write('profiles/' + user, { name: s(profile.nickname) }, true),
          this.write(path + '/children/' + child, { name: s(profile.childName), birthday: s(profile.birthday) }, true),
        ] : []),
        this.write(index, { familyId: s(id) }, true),
      ] }
    })
  }

  async createInvite(uid: string, family: string, role: InviteRole): Promise<FamilyInvite> {
    const path = 'families/' + family
    const code = crypto.randomUUID().replaceAll('-', '')
    return this.transaction(async tx => {
      const member = this.familyMember(await this.get(path + '/members/' + userKey(uid), tx))
      if (member?.role !== 'admin') throw new HttpError(403, 'family admin required')
      const expiresAt = new Date(Date.now() + inviteLifetime).toISOString()
      return { result: { code, expiresAt }, writes: [
        this.write('family_invites/' + code, { familyId: s(family), role: s(role), expiresAt: s(expiresAt) }, true),
      ] }
    })
  }

  protected async onJoined(_uid: string, _family: string) {}

  async joinFamily(uid: string, code: string, profile?: JoinProfile): Promise<FamilyMembership> {
    const user = userKey(uid)
    const index = 'family_memberships/' + user
    const invitePath = 'family_invites/' + code
    const { family, joined } = await this.transaction<{ family: FamilyMembership; joined: boolean }>(async tx => {
      if (await this.get('retired_users/' + user, tx)) throw new HttpError(403, 'account inactive')
      const invite = await this.get(invitePath, tx)
      const id = string(invite, 'familyId')
      const role = string(invite, 'role')
      const usedBy = string(invite, 'usedBy')
      const expiresAt = Date.parse(string(invite, 'expiresAt') ?? '')
      if (!invite || !id || (role !== 'parent' && role !== 'paternal' && role !== 'maternal') ||
          (usedBy ? usedBy !== uid : !(expiresAt > Date.now()))) {
        throw new HttpError(404, 'invite unavailable')
      }
      const familyPath = 'families/' + id
      const existing = await this.get(index, tx)
      const family = await this.get(familyPath, tx)
      const name = string(family, 'name')
      if (!family || !name) throw new HttpError(404, 'invite unavailable')
      const memberPath = familyPath + '/members/' + user
      if (usedBy === uid && string(existing, 'familyId') === id) {
        const doc = await this.get(memberPath, tx)
        const member = this.familyMember(doc)
        if (member) return { result: { family: this.describeMembership(id, name, member, doc), joined: false }, writes: [] }
      }
      if (existing) throw new HttpError(409, 'already belongs to a family')
      if (usedBy) throw new HttpError(404, 'invite unavailable')
      const count = integer(family, 'memberCount')
      if (!Number.isSafeInteger(count) || count < 1) throw new HttpError(503, 'invalid family member count')
      if (count >= familyMemberLimit) throw new HttpError(409, 'family is full')
      const chosenParent = profile?.relationship === 'father' || profile?.relationship === 'mother'
      if (profile && (role === 'parent') !== chosenParent) {
        throw new HttpError(400, 'relationship does not match invitation')
      }
      const member: Member = role === 'parent' ? { role } : { role: 'grandparent', side: role }
      return { result: { family: { id, name, ...member, ...(profile ? { relationship: profile.relationship } : {}) }, joined: true }, writes: [
        this.write(familyPath, { ...family.fields, memberCount: n(count + 1) }),
        this.write(memberPath, {
          role: s(member.role), active, joinedVia: s(code), ...(member.side ? { side: s(member.side) } : {}),
          ...(profile ? { relationship: s(profile.relationship) } : {}),
        }, true),
        this.write(index, { familyId: s(id) }, true),
        this.write(invitePath, { ...invite.fields, usedBy: s(uid) }),
        ...(profile ? [this.write('profiles/' + user, { name: s(profile.nickname) })] : []),
      ] }
    })
    if (joined) await this.onJoined(uid, family.id)
    return family
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
