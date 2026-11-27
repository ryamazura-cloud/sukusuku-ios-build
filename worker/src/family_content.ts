import { HttpError, mayPost, mayView, reserveBytes, type MediaType, type Scope } from './domain.ts'
import { Firestore, FirestorePrecondition, digest, formerAlbums, integer, n, s, string, usageFields, userKey, type Doc, type Write } from './firestore.ts'

type Actor = { uid: string; family: string }
const pushMessages = {
  post: '新しい投稿がありました。',
  comment: '新しいコメントがありました。',
  reaction: '投稿にリアクションがありました。',
  commentReaction: 'コメントにリアクションがありました。',
  join: '家族のメンバーが参加しました。',
  test: 'テスト通知です。',
} as const
type NoticeKind = Exclude<keyof typeof pushMessages, 'test'>
type Attachment = { id: string; type: MediaType }
type PushTarget = { token: string } | { fid: string }
const pushTarget = (doc: Doc | null): PushTarget | undefined => {
  const fid = string(doc, 'deviceFid')
  const token = string(doc, 'deviceToken')
  return fid ? { fid } : token ? { token } : undefined
}
const pushFields = (value: string, useFid: boolean) => ({
  deviceFid: s(useFid ? value : ''), deviceToken: s(useFid ? '' : value),
})
export type PostInput = { body: string; scope: Scope; childIds: string[]; capturedAt: string }
const ready = 'published'
const now = () => new Date().toISOString()
const idOf = (doc: Doc) => doc.name.split('/').at(-1)!
const timeId = () => Date.now().toString(36).padStart(10, '0') + '-' + crypto.randomUUID()
const flags = { booleanValue: true }
const asJson = <T>(doc: Doc, key: string): T => JSON.parse(string(doc, key) ?? '[]') as T

export class FamilyContent extends Firestore {
  private remove(path: string): Write { return { delete: this.root + '/' + path } }

  private listPage(path: string, cursor: string, order: string, size: number, tx?: string) {
    const params = new URLSearchParams({ pageSize: String(size), orderBy: order })
    if (cursor) params.set('pageToken', cursor)
    if (tx) params.set('transaction', tx)
    return this.call<{ documents?: Doc[]; nextPageToken?: string }>('/' + path + '?' + params)
  }

  private async newestPage(path: string, cursor: string) {
    const fallbackPrefix = 'asc:'
    if (!cursor.startsWith(fallbackPrefix)) {
      try {
        return await this.listPage(path, cursor, '__name__ desc', 20)
      } catch (error) {
        // Firestore page tokens are tied to their original ordering.
        if (cursor || !(error instanceof FirestorePrecondition)) throw error
      }
    }
    const page = await this.listPage(path, cursor.slice(fallbackPrefix.length), '__name__ asc', 20)
    return {
      documents: page.documents?.reverse(),
      nextPageToken: page.nextPageToken ? fallbackPrefix + page.nextPageToken : undefined,
    }
  }

  private async *documents(path: string, tx?: string) {
    let cursor = ''
    do {
      const page = await this.listPage(path, cursor, '__name__ asc', 100, tx)
      yield* page.documents ?? []
      cursor = page.nextPageToken ?? ''
    } while (cursor)
  }

  private family(actor: Actor) { return 'families/' + actor.family }
  private memberPath(actor: Actor) { return this.family(actor) + '/members/' + userKey(actor.uid) }
  private postPath(actor: Actor, post: string) { return this.family(actor) + '/timeline/' + post }

  async requireAccount(uid: string) {
    const { existing } = await this.retirementMarker(uid)
    if (existing) throw new HttpError(403, existing.fields?.complete?.booleanValue === true
      ? 'account deleted' : 'account retirement in progress')
  }

  private async member(actor: Actor, tx?: string) {
    const doc = await this.get(this.memberPath(actor), tx)
    const member = this.familyMember(doc)
    if (!member || !doc) throw new HttpError(403, 'family membership required')
    return { doc, member }
  }

  private async posting(actor: Actor, tx: string) {
    if (!mayPost((await this.member(actor, tx)).member)) throw new HttpError(403, 'parent required')
  }

  private async post(actor: Actor, id: string, tx?: string, write = false) {
    const { member } = await this.member(actor, tx)
    const path = this.postPath(actor, id)
    const doc = await this.get(path, tx)
    if (!doc) throw new HttpError(404, 'post not found')
    if (write) {
      if (!mayPost(member) || (member.role !== 'admin' && string(doc, 'author') !== userKey(actor.uid))) {
        throw new HttpError(403, 'post writer required')
      }
    } else if (string(doc, 'state') !== ready || !mayView(member, string(doc, 'scope') as Scope)) {
      throw new HttpError(404, 'post not found')
    }
    return { doc, path, member }
  }

  async profile(uid: string, name?: string) {
    const path = 'profiles/' + userKey(uid)
    if (name === undefined) return { name: string(await this.get(path), 'name') ?? '' }
    return this.transaction(async tx => {
      if ((await this.retirementMarker(uid, tx)).existing) throw new HttpError(403, 'account inactive')
      return { result: { name }, writes: [this.write(path, { name: s(name) })] }
    })
  }

  async members(actor: Actor) {
    await this.member(actor)
    const list: { id: string; name: string; role: string; side?: string; relationship?: string;
      mine: boolean }[] = []
    for await (const doc of this.documents(this.family(actor) + '/members')) {
      const member = this.familyMember(doc)
      if (!member) continue
      const id = idOf(doc)
      const profile = await this.get('profiles/' + id)
      list.push({ id, name: string(profile, 'name') ?? '', ...member, relationship: string(doc, 'relationship'),
        mine: id === userKey(actor.uid),
      })
    }
    return list
  }

  async removeMember(actor: Actor, target: string) {
    const user = userKey(actor.uid)
    if (target === user) throw new HttpError(409, 'cannot remove yourself')
    const familyPath = this.family(actor)
    const path = familyPath + '/members/' + target
    await this.transaction(async tx => {
      if ((await this.member(actor, tx)).member.role !== 'admin') {
        throw new HttpError(403, 'administrator required')
      }
      const targetMember = await this.get(path, tx)
      if (!this.familyMember(targetMember)) return { result: undefined, writes: [] }
      const indexPath = 'family_memberships/' + target
      const index = await this.get(indexPath, tx)
      const family = await this.get(familyPath, tx)
      const count = integer(family, 'memberCount')
      if (!family || !Number.isSafeInteger(count) || count <= 1 || string(index, 'familyId') !== actor.family) {
        throw new HttpError(503, 'member count invalid')
      }
      const invite = string(targetMember, 'joinedVia')
      return { result: undefined, writes: [
        this.write(path, { ...usageFields(targetMember), active: { booleanValue: false } }),
        this.write(indexPath, { formerAlbums: s(JSON.stringify([...new Set([...formerAlbums(index), actor.family])])) }),
        this.write(familyPath, { ...family.fields, memberCount: n(count - 1) }),
        ...(invite ? [this.remove('family_invites/' + invite)] : []),
      ] }
    })
  }

  async transfer(actor: Actor, successor: string) {
    return this.transaction(async tx => {
      const { member } = await this.member(actor, tx)
      if (member.role !== 'admin') throw new HttpError(403, 'administrator required')
      const path = this.family(actor) + '/members/' + successor
      const next = await this.get(path, tx)
      if (this.familyMember(next)?.role !== 'admin') throw new HttpError(409, 'choose an active parent')
      return { result: undefined, writes: [] }
    })
  }

  async correctGrandparent(actor: Actor, target: string, side: 'paternal' | 'maternal') {
    return this.transaction(async tx => {
      if ((await this.member(actor, tx)).member.role !== 'admin') {
        throw new HttpError(403, 'administrator required')
      }
      const path = this.family(actor) + '/members/' + target
      const doc = await this.get(path, tx)
      const member = this.familyMember(doc)
      if (!member || member.role === 'admin') throw new HttpError(409, 'choose an active non-administrator')
      return { result: undefined, writes: [
        this.write(path, { ...doc?.fields, role: s('grandparent'), side: s(side) }),
      ] }
    })
  }

  async renameFamily(actor: Actor, name: string) {
    const path = this.family(actor)
    await this.transaction(async tx => {
      const { member } = await this.member(actor, tx)
      if (member.role !== 'admin') throw new HttpError(403, 'administrator required')
      const family = await this.get(path, tx)
      if (!family) throw new HttpError(404, 'family not found')
      return { result: undefined, writes: [this.write(path, { ...family.fields, name: s(name) })] }
    })
  }

  async changeChildAvatar(actor: Actor, id: string, avatar: string | null) {
    const path = this.family(actor) + '/children/' + id
    await this.transaction(async tx => {
      await this.posting(actor, tx)
      const child = await this.get(path, tx)
      if (!child) throw new HttpError(404, 'child not found')
      const fields = { ...child.fields }
      if (avatar === null) delete fields.avatar
      else fields.avatar = s(avatar)
      return { result: undefined, writes: [this.write(path, fields)] }
    })
  }

  async children(actor: Actor) {
    await this.member(actor)
    const result: { id: string; name: string; birthday: string; avatar?: string }[] = []
    for await (const child of this.documents(this.family(actor) + '/children')) {
      const avatar = string(child, 'avatar')
      result.push({ id: idOf(child), name: string(child, 'name')!, birthday: string(child, 'birthday')!,
        ...(avatar ? { avatar } : {}) })
    }
    return result
  }

  async changeChild(actor: Actor, id: string, child: { name: string; birthday: string } | null) {
    const path = this.family(actor) + '/children/' + id
    return this.transaction(async tx => {
      await this.posting(actor, tx)
      const previous = child ? await this.get(path, tx) : null
      return { result: undefined, writes: [child
        ? this.write(path, { ...previous?.fields, name: s(child.name), birthday: s(child.birthday) })
        : this.remove(path)] }
    })
  }

  private async validateChildren(actor: Actor, ids: string[], tx: string) {
    for (const id of ids) {
      if (!await this.get(this.family(actor) + '/children/' + id, tx)) {
        throw new HttpError(400, 'child does not exist in this family')
      }
    }
  }

  async draft(actor: Actor, input: PostInput, media: Attachment[]) {
    const id = timeId()
    return this.transaction(async tx => {
      await this.posting(actor, tx)
      await this.validateChildren(actor, input.childIds, tx)
      const profile = await this.get('profiles/' + userKey(actor.uid), tx)
      const path = this.postPath(actor, id)
      return { result: id, writes: [this.write(path, {
        author: s(userKey(actor.uid)), authorName: s(string(profile, 'name') || '家族'),
        scope: s(input.scope), body: s(input.body), capturedAt: s(input.capturedAt),
        childIds: s(JSON.stringify(input.childIds)), media: s(JSON.stringify(media)),
        createdAt: s(now()), state: s('draft'),
      }, true)] }
    })
  }

  async upload(actor: Actor, id: string, item: string, type: MediaType, body: ArrayBuffer, bucket: R2Bucket) {
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', body)),
      byte => byte.toString(16).padStart(2, '0')).join('')
    const bytes = body.byteLength
    const key = 'timeline/' + actor.family + '/' + id + '/' + item
    const month = now().slice(0, 7)
    const savedObject = await bucket.head(key)
    const uploadState = await this.transaction(async tx => {
      const { doc, path } = await this.post(actor, id, tx, true)
      if (string(doc, 'state') !== 'draft' || string(doc, 'author') !== userKey(actor.uid)) {
        throw new HttpError(409, 'draft unavailable')
      }
      if (!asJson<Attachment[]>(doc, 'media').some(media => media.id === item && media.type === type)) {
        throw new HttpError(400, 'attachment does not match draft')
      }
      const mediaPath = path + '/files/' + item
      const previous = await this.get(mediaPath, tx)
      if (previous) {
        if (string(previous, 'digest') !== digest || integer(previous, 'bytes') !== bytes) {
          throw new HttpError(409, 'different upload already reserved')
        }
        if (string(previous, 'state') === 'ready') return { result: 'ready', writes: [] }
        if (savedObject?.customMetadata?.digest === digest) return { result: 'stored', writes: [] }
        if (Date.now() - Date.parse(string(previous, 'touchedAt') ?? '') < 300_000) {
          throw new HttpError(409, 'upload is being processed')
        }
        return { result: 'upload', writes: [this.write(mediaPath, { ...previous.fields, touchedAt: s(now()) })] }
      }
      const storagePath = this.family(actor) + '/quota/storage'
      const monthPath = this.family(actor) + '/quota/' + month
      const limits = reserveBytes(integer(await this.get(storagePath, tx), 'bytes'),
        integer(await this.get(monthPath, tx), 'bytes'), bytes)
      return { result: 'upload', writes: [
        this.write(storagePath, { bytes: n(limits.total) }),
        this.write(monthPath, { bytes: n(limits.month) }),
        this.write(mediaPath, { bytes: n(bytes), month: s(month), type: s(type),
          state: s('writing'), touchedAt: s(now()), digest: s(digest) }, true),
      ] }
    })
    if (uploadState === 'ready') return
    const written = uploadState === 'stored' || await bucket.put(key, body, {
      onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: type },
      customMetadata: { digest },
    })
    if (!written && (await bucket.head(key))?.customMetadata?.digest !== digest) {
      throw new HttpError(503, 'upload could not be verified')
    }
    await this.transaction(async tx => {
      const { doc, path } = await this.post(actor, id, tx, true)
      if (string(doc, 'state') !== 'draft') throw new HttpError(409, 'draft unavailable')
      const mediaPath = path + '/files/' + item
      const file = await this.get(mediaPath, tx)
      if (!file || string(file, 'digest') !== digest) throw new HttpError(409, 'upload not reserved')
      return { result: undefined, writes: [this.write(mediaPath, { ...file.fields, state: s('ready') })] }
    })
  }

  async publish(actor: Actor, id: string) {
    const scope = await this.transaction(async tx => {
      const { doc, path } = await this.post(actor, id, tx, true)
      if (string(doc, 'state') === ready) return { result: null, writes: [] }
      if (string(doc, 'state') !== 'draft') throw new HttpError(409, 'draft unavailable')
      for (const media of asJson<Attachment[]>(doc, 'media')) {
        const file = await this.get(path + '/files/' + media.id, tx)
        if (string(file, 'state') !== 'ready') throw new HttpError(409, 'media upload incomplete')
      }
      return { result: string(doc, 'scope') as Scope, writes: [
        this.write(path, { ...doc.fields, state: s(ready), publishedAt: s(now()) }),
      ] }
    })
    if (scope) await this.notify(actor, id, 'post', 'post-' + id).catch(() => {})
  }

  private summary(doc: Doc, actor: Actor, admin: boolean) {
    return {
      id: idOf(doc), author: string(doc, 'authorName'), body: string(doc, 'body'),
      createdAt: string(doc, 'publishedAt') ?? string(doc, 'createdAt'),
      capturedAt: string(doc, 'capturedAt'), scope: string(doc, 'scope'),
      childIds: asJson<string[]>(doc, 'childIds'), media: asJson<Attachment[]>(doc, 'media'),
      mine: string(doc, 'author') === userKey(actor.uid),
      canDelete: admin || string(doc, 'author') === userKey(actor.uid),
    }
  }

  async timeline(actor: Actor, cursor: string, child?: string) {
    const { member } = await this.member(actor)
    const page = await this.newestPage(this.family(actor) + '/timeline', cursor)
    const posts = (page.documents ?? []).filter(doc =>
      string(doc, 'state') === ready && mayView(member, string(doc, 'scope') as Scope) &&
      (!child || asJson<string[]>(doc, 'childIds').includes(child)))
    return { posts: posts.map(doc => this.summary(doc, actor, member.role === 'admin')),
      next: page.nextPageToken ?? '' }
  }

  async edit(actor: Actor, id: string, input: PostInput) {
    return this.transaction(async tx => {
      const { doc, path } = await this.post(actor, id, tx, true)
      if (string(doc, 'state') !== ready || string(doc, 'author') !== userKey(actor.uid)) {
        throw new HttpError(403, 'post author required')
      }
      await this.validateChildren(actor, input.childIds, tx)
      return { result: undefined, writes: [
        this.write(path, { ...doc.fields, scope: s(input.scope), body: s(input.body),
          capturedAt: s(input.capturedAt), childIds: s(JSON.stringify(input.childIds)) }),
      ] }
    })
  }

  async checkUpload(actor: Actor, id: string) {
    const { doc } = await this.post(actor, id, undefined, true)
    if (string(doc, 'state') !== 'draft') throw new HttpError(409, 'draft unavailable')
  }

  async detail(actor: Actor, id: string) {
    const { doc, member } = await this.post(actor, id)
    return this.summary(doc, actor, member.role === 'admin')
  }

  async download(actor: Actor, id: string, item: string, bucket: R2Bucket) {
    const { doc } = await this.post(actor, id)
    const found = asJson<Attachment[]>(doc, 'media').find(media => media.id === item)
    if (!found) throw new HttpError(404, 'media not found')
    const object = await bucket.get('timeline/' + actor.family + '/' + id + '/' + item)
    if (!object) throw new HttpError(404, 'media not found')
    return { object, type: found.type }
  }

  private async erasePost(family: string, id: string, bucket: R2Bucket) {
    const path = 'families/' + family + '/timeline/' + id
    const storage = 'families/' + family + '/quota/storage'
    const doc = await this.get(path)
    if (!doc || string(doc, 'state') !== 'deleting') return
    const media = asJson<Attachment[]>(doc, 'media')
    for (const item of media) {
      await bucket.delete('timeline/' + family + '/' + id + '/' + item.id)
      await this.transaction(async tx => {
        const filePath = path + '/files/' + item.id
        const file = await this.get(filePath, tx)
        if (!file) return { result: undefined, writes: [] }
        const reserved = integer(file, 'bytes')
        const total = integer(await this.get(storage, tx), 'bytes')
        if (!Number.isSafeInteger(reserved) || !Number.isSafeInteger(total) || total < reserved) {
          throw new HttpError(503, 'storage counter invalid')
        }
        const writes: Write[] = [this.remove(filePath), this.write(storage, { bytes: n(total - reserved) })]
        // An unpublished draft did not count as a completed upload.
        if (!string(doc, 'publishedAt')) {
          const monthly = 'families/' + family + '/quota/' + string(file, 'month')
          const used = integer(await this.get(monthly, tx), 'bytes')
          if (!Number.isSafeInteger(used) || used < reserved) throw new HttpError(503, 'monthly counter invalid')
          writes.push(this.write(monthly, { bytes: n(used - reserved) }))
        }
        return { result: undefined, writes }
      })
    }
    for (const collection of ['comments', 'reactions']) await this.clearCollection(path + '/' + collection)
    await this.send('commit', { writes: [this.remove(path)] })
  }

  private async markDeleting(path: string, doc: Doc, tx: string) {
    if (string(doc, 'state') === 'draft') {
      for (const item of asJson<Attachment[]>(doc, 'media')) {
        const file = await this.get(path + '/files/' + item.id, tx)
        if (string(file, 'state') === 'writing' &&
            Date.now() - Date.parse(string(file, 'touchedAt') ?? '') < 300_000) {
          throw new HttpError(409, 'upload in progress; retry deletion later')
        }
      }
    }
    return this.write(path, { ...doc.fields, state: s('deleting') })
  }

  async deletePost(actor: Actor, id: string, bucket: R2Bucket) {
    await this.transaction(async tx => {
      const { doc, path } = await this.post(actor, id, tx, true)
      return { result: undefined, writes: [await this.markDeleting(path, doc, tx)] }
    })
    await this.erasePost(actor.family, id, bucket)
  }

  async discussion(actor: Actor, id: string, cursor: string) {
    const { path } = await this.post(actor, id)
    const page = await this.newestPage(path + '/comments', cursor)
    const user = userKey(actor.uid)
    const comments = (page.documents ?? []).map(doc => {
      const byUser = asJson<Record<string, string[]>>(doc, 'reactionMembers')
      const reactions: Record<string, number> = {}
      for (const kinds of Object.values(byUser)) {
        for (const kind of kinds) reactions[kind] = (reactions[kind] ?? 0) + 1
      }
      return { id: idOf(doc), name: string(doc, 'name'), body: string(doc, 'body'),
        mine: string(doc, 'author') === user, at: string(doc, 'at'),
        reactions, own: byUser[user] ?? [] }
    })
    const reactions: Record<string, number> = {}
    const own: string[] = []
    for await (const doc of this.documents(path + '/reactions')) {
      const kind = string(doc, 'kind')!
      reactions[kind] = (reactions[kind] ?? 0) + 1
      if (string(doc, 'author') === userKey(actor.uid)) own.push(kind)
    }
    return { comments, reactions, own, next: page.nextPageToken ?? '' }
  }

  async comment(actor: Actor, id: string, body: string | null, commentId?: string) {
    const key = commentId ?? timeId()
    const created = await this.transaction(async tx => {
      const { path, member } = await this.post(actor, id, tx)
      const user = userKey(actor.uid)
      const location = path + '/comments/' + key
      if (commentId) {
        const previous = await this.get(location, tx)
        if (!previous) throw new HttpError(404, 'comment not found')
        if (string(previous, 'author') !== user && !(body === null && member.role === 'admin')) {
          throw new HttpError(403, 'comment author required')
        }
        return { result: false, writes: [body === null ? this.remove(location)
          : this.write(location, { ...previous.fields, body: s(body) })] }
      }
      const profile = await this.get('profiles/' + user, tx)
      return { result: true, writes: [
        this.write(location, { author: s(user), name: s(string(profile, 'name') || '家族'),
          body: s(body!), at: s(now()) }, true),
      ] }
    })
    if (created) await this.notify(actor, id, 'comment', 'comment-' + key).catch(() => {})
  }

  async react(actor: Actor, id: string, kind: string, enabled: boolean) {
    const event = await this.transaction(async tx => {
      const { doc, path } = await this.post(actor, id, tx)
      const user = userKey(actor.uid)
      const location = path + '/reactions/' + user + '-' + kind
      const existing = await this.get(location, tx)
      if (!!existing === enabled) return { result: null, writes: [] }
      return { result: enabled ? { owner: string(doc, 'author')! } : null,
        writes: [enabled ? this.write(location, { author: s(user), kind: s(kind) }, true) : this.remove(location)] }
    })
    if (event) await this.notify(actor, id, 'reaction', 'reaction-' + crypto.randomUUID(), event.owner).catch(() => {})
  }

  async reactToComment(actor: Actor, id: string, commentId: string, kind: string, enabled: boolean) {
    const owner = await this.transaction(async tx => {
      const { path } = await this.post(actor, id, tx)
      const location = path + '/comments/' + commentId
      const comment = await this.get(location, tx)
      if (!comment) throw new HttpError(404, 'comment not found')
      const user = userKey(actor.uid)
      const byUser = { ...asJson<Record<string, string[]>>(comment, 'reactionMembers') }
      const own = new Set(byUser[user] ?? [])
      if (own.has(kind) === enabled) return { result: null, writes: [] }
      if (enabled) own.add(kind)
      else own.delete(kind)
      if (own.size) byUser[user] = [...own]
      else delete byUser[user]
      return { result: enabled ? string(comment, 'author') ?? null : null, writes: [
        this.write(location, { ...comment.fields, reactionMembers: s(JSON.stringify(byUser)) }),
      ] }
    })
    if (owner) await this.notify(actor, id, 'commentReaction', 'reaction-' + crypto.randomUUID(), owner).catch(() => {})
  }

  async refreshNotificationToken(actor: Actor, value: string, useFid = false) {
    await this.transaction(async tx => {
      const { doc } = await this.member(actor, tx)
      const current = pushTarget(doc)
      const optedOut = doc.fields?.pushEnabled?.booleanValue === false ||
        (doc.fields?.pushEnabled === undefined && !current && string(doc, 'preferences') !== undefined)
      return { result: undefined, writes: !optedOut && (useFid ? string(doc, 'deviceFid') : string(doc, 'deviceToken')) !== value ? [
        this.write(this.memberPath(actor), { ...doc.fields, ...pushFields(value, useFid), pushEnabled: flags }),
      ] : [] }
    })
  }

  async notificationSettings(actor: Actor, token?: string, preferences?: string[], useFid = false) {
    return this.transaction(async tx => {
      const { doc } = await this.member(actor, tx)
      if (token === undefined || preferences === undefined) return { result: {
        enabled: doc.fields?.pushEnabled?.booleanValue ?? !!pushTarget(doc),
        registered: !!pushTarget(doc), preferences: string(doc, 'preferences') ?
          asJson<string[]>(doc, 'preferences') : ['post', 'comment', 'reaction', 'join'],
      }, writes: [] }
      return { result: { enabled: !!token, registered: !!token, preferences }, writes: [
        this.write(this.memberPath(actor), { ...doc.fields, ...pushFields(token, useFid),
          pushEnabled: { booleanValue: !!token }, preferences: s(JSON.stringify(preferences)) }),
      ] }
    })
  }

  async testNotification(actor: Actor) {
    const token = await this.transaction(async tx => {
      const { doc } = await this.member(actor, tx)
      const result = pushTarget(doc)
      if (!result) throw new HttpError(409, 'notification device not registered')
      if (Date.now() - Date.parse(string(doc, 'lastPushTest') ?? '') < 30_000) {
        throw new HttpError(429, 'notification test rate limited')
      }
      return { result, writes: [
        this.write(this.memberPath(actor), { ...doc.fields, lastPushTest: s(now()) }),
      ] }
    })
    const error = await this.sendPush(token, 'test')
    if (error) throw new HttpError(503, 'notification delivery ' + error)
  }

  private async sendPush(target: PushTarget, kind: NoticeKind | 'test', postId?: string) {
    const project = this.root.split('/')[1]
    try {
      const response = await this.fetcher('https://fcm.googleapis.com/v1/projects/' + project + '/messages:send', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + await this.google.token(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { ...target, notification: {
          title: 'すくすく', body: pushMessages[kind],
        },
        android: { priority: 'HIGH', notification: { channel_id: 'sukusuku_album' } },
        apns: { headers: { 'apns-push-type': 'alert', 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
        data: { album: 'notices', ...(postId ? { post: postId } : {}), ...(kind === 'test' ? { test: 'true' } : {}) } } }),
      })
      if (response.ok) return
      const body = await response.json().catch(() => null) as {
        error?: { status?: string; details?: { errorCode?: string }[] }
      } | null
      const code = body?.error?.details?.find(detail => detail.errorCode)?.errorCode ?? body?.error?.status
      const safeCode = code && /^[A-Z_]+$/.test(code) ? code : 'UNKNOWN'
      console.warn('FCM notification delivery rejected', response.status, safeCode)
      return safeCode
    } catch {
      console.warn('FCM notification delivery unavailable')
      return 'UNAVAILABLE'
    }
  }

  protected override async onJoined(uid: string, family: string) {
    await this.notify({ family, uid }, null, 'join', 'join-' + userKey(uid)).catch(() => {})
  }

  private async notify(actor: Actor, id: string | null, kind: NoticeKind, event: string, pushRecipient?: string) {
    const members = this.family(actor) + '/members'
    const user = userKey(actor.uid)
    const [profile, post] = await Promise.all([
      this.get('profiles/' + user),
      id ? this.get(this.postPath(actor, id)) : Promise.resolve(null),
    ])
    if (id && string(post, 'state') !== ready) return
    const writes: Write[] = []
    const recipients = new Map<string, PushTarget>()
    const noticeId = timeId() + '-' + event
    const fields = { ...(id ? { post: s(id) } : {}), kind: s(kind), at: s(now()), actorId: s(user),
      actor: s(string(profile, 'name') || '家族のメンバー') }
    for await (const candidate of this.documents(members)) {
      const key = idOf(candidate)
      const member = this.familyMember(candidate)
      if (key === user || !member || (id && !mayView(member, string(post, 'scope') as Scope))) continue
      writes.push(this.write(members + '/' + key + '/notices/' + noticeId, fields, true))
      const preference = kind === 'commentReaction' ? 'reaction' : kind
      const enabled = string(candidate, 'preferences')
      const token = pushTarget(candidate)
      if (token && (!pushRecipient || key === pushRecipient) &&
          (!enabled || asJson<string[]>(candidate, 'preferences').includes(preference))) {
        recipients.set(key, token)
      }
    }
    if (writes.length) await this.send('commit', { writes })
    if (!recipients.size) return
    await Promise.all([...recipients].map(async ([key, token]) => {
      if (await this.sendPush(token, kind, id ?? undefined) !== 'UNREGISTERED') return
      const path = members + '/' + key
      await this.transaction(async tx => {
        const current = await this.get(path, tx)
        return { result: undefined, writes: this.familyMember(current) &&
            JSON.stringify(pushTarget(current)) === JSON.stringify(token)
          ? [this.write(path, { ...current?.fields, ...pushFields('', false), pushEnabled: flags })] : [] }
      })
    }))
  }

  async notices(actor: Actor, cursor: string) {
    const { member } = await this.member(actor)
    const page = await this.newestPage(this.memberPath(actor) + '/notices', cursor)
    const records = page.documents ?? []
    const posts = new Map<string, Promise<Doc | null>>()
    for (const item of records) {
      const id = string(item, 'post')
      if (id && !posts.has(id)) posts.set(id, this.get(this.postPath(actor, id)))
    }
    await Promise.all(posts.values())
    const notices: { post?: string; kind: string; at: string; actor?: string }[] = []
    for (const item of records) {
      const id = string(item, 'post')
      const kind = string(item, 'kind')!
      if (id) {
        const post = await posts.get(id)!
        if (string(post, 'state') !== ready || !mayView(member, string(post, 'scope') as Scope)) continue
      } else if (kind !== 'join') {
        continue
      }
      notices.push({ post: id, kind, at: string(item, 'at')!, actor: string(item, 'actor') })
    }
    return { notices, next: page.nextPageToken ?? '' }
  }

  private async closesAlbum(uid: string, family: string, tx?: string) {
    const members = 'families/' + family + '/members'
    const user = userKey(uid)
    if (this.familyMember(await this.get(members + '/' + user, tx))?.role !== 'admin') return false
    for await (const candidate of this.documents(members, tx)) {
      if (idOf(candidate) !== user && this.familyMember(candidate)?.role === 'admin') return false
    }
    return true
  }

  async retirementInfo(uid: string) {
    const { existing } = await this.retirementMarker(uid)
    if (existing) return { pending: true, closesAlbum: existing.fields?.closesAlbum?.booleanValue === true }
    const family = string(await this.get('family_memberships/' + userKey(uid)), 'familyId')
    return { pending: false, closesAlbum: family ? await this.closesAlbum(uid, family) : false }
  }

  async issueDeletionCode(uid: string, code: string) {
    const hash = await digest(code)
    const path = 'deletion_codes/' + hash
    const index = 'account_deletion_codes/' + userKey(uid)
    await this.transaction(async tx => {
      if ((await this.retirementMarker(uid, tx)).existing) throw new HttpError(403, 'account inactive')
      const previous = string(await this.get(index, tx), 'hash')
      return { result: undefined, writes: [
        ...(previous && previous !== hash ? [this.remove('deletion_codes/' + previous)] : []),
        this.write(path, { uid: s(uid) }),
        this.write(index, { hash: s(hash) }),
      ] }
    })
  }

  async deletionCodeOwner(code: string) {
    const uid = string(await this.get('deletion_codes/' + await digest(code)), 'uid')
    if (!uid) throw new HttpError(404, 'deletion code unavailable')
    return uid
  }

  private async forgetFirebaseUser(uid: string) {
    const project = this.root.split('/')[1]
    const response = await this.fetcher(
      'https://identitytoolkit.googleapis.com/v1/accounts:delete', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + await this.google.token(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ localId: uid, targetProjectId: project }),
      },
    )
    if (response.ok) return
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null
    if (body?.error?.message === 'USER_NOT_FOUND') return
    console.warn('Firebase account deletion rejected', response.status)
    throw new HttpError(503, 'Firebase account deletion unavailable')
  }

  private async clearCollection(path: string) {
    const writes: Write[] = []
    for await (const doc of this.documents(path)) {
      writes.push({ delete: doc.name })
      if (writes.length === 100) await this.send('commit', { writes: writes.splice(0) })
    }
    if (writes.length) await this.send('commit', { writes })
  }

  private async clearInvites(family: string, issuer?: string) {
    const result = await this.send<{ document?: Doc }[]>('runQuery', { structuredQuery: {
      from: [{ collectionId: 'family_invites' }],
      where: { fieldFilter: { field: { fieldPath: 'familyId' }, op: 'EQUAL', value: s(family) } },
    } })
    const writes: Write[] = []
    for (const { document } of result) {
      if (!document || (issuer && string(document, 'issuer') !== issuer)) continue
      writes.push({ delete: document.name })
      if (writes.length === 100) await this.send('commit', { writes: writes.splice(0) })
    }
    if (writes.length) await this.send('commit', { writes })
  }

  async retire(uid: string, bucket: R2Bucket, allowAlbumClosure = false, code?: string) {
    const user = userKey(uid)
    const membershipPath = 'family_memberships/' + user
    const codeIndex = 'account_deletion_codes/' + user
    const { family, closesAlbum, marker, cursor, nickname, remaining } = await this.transaction(async tx => {
      if (code && string(await this.get(codeIndex, tx), 'hash') !== await digest(code)) {
        throw new HttpError(404, 'deletion code unavailable')
      }
      const { path: marker, existing } = await this.retirementMarker(uid, tx)
      if (existing) return { result: { family: string(existing, 'family') ?? '', marker,
        closesAlbum: existing.fields?.closesAlbum?.booleanValue === true,
        cursor: string(existing, 'cursor') ?? '', nickname: string(existing, 'nickname'),
        remaining: asJson<string[]>(existing, 'remaining') }, writes: [] }
      const index = await this.get(membershipPath, tx)
      const id = string(index, 'familyId') ?? ''
      const history = [...new Set(formerAlbums(index))].filter(album => album !== id)
      const familyToErase = id || history.shift() || ''
      const closesAlbum = id ? await this.closesAlbum(uid, id, tx) : false
      if (closesAlbum && !allowAlbumClosure) throw new HttpError(409, 'confirm album closure')
      const nickname = string(await this.get('profiles/' + user, tx), 'name')
      const writes: Write[] = [this.write(marker, { family: s(familyToErase), closesAlbum: { booleanValue: closesAlbum },
        remaining: s(JSON.stringify(history)),
        ...(nickname ? { nickname: s(nickname) } : {}),
      }, true)]
      if (id) {
        const familyPath = 'families/' + id
        const memberPath = familyPath + '/members/' + user
        const member = await this.get(memberPath, tx)
        const family = await this.get(familyPath, tx)
        if (closesAlbum) {
          // Remove the album name to close outstanding invitations in the same transaction.
          writes.push(this.write(familyPath, { closed: flags }))
          for await (const candidate of this.documents(familyPath + '/members', tx)) {
            const key = idOf(candidate)
            if (this.familyMember(candidate)) {
              const candidateIndex = 'family_memberships/' + key
              const former = key === user ? [] : formerAlbums(await this.get(candidateIndex, tx))
              writes.push(former.length
                ? this.write(candidateIndex, { formerAlbums: s(JSON.stringify(former)) })
                : this.remove(candidateIndex))
              writes.push(this.write(familyPath + '/members/' + key, { active: { booleanValue: false } }))
              const used = string(candidate, 'joinedVia')
              if (used) writes.push(this.remove('family_invites/' + used))
            }
          }
        } else {
          if (family && this.familyMember(member)) {
            const count = integer(family, 'memberCount')
            if (!Number.isSafeInteger(count) || count <= 1) throw new HttpError(503, 'member count invalid')
            writes.push(this.write(familyPath, { ...family.fields, memberCount: n(count - 1) }))
          }
          const usedInvite = string(member, 'joinedVia')
          if (usedInvite) writes.push(this.remove('family_invites/' + usedInvite))
          if (member) writes.push(this.write(memberPath, { active: { booleanValue: false } }))
          writes.push(this.remove(membershipPath))
        }
      }
      if (!id) writes.push(this.remove(membershipPath))
      writes.push(this.remove('profiles/' + user))
      return { result: { family: familyToErase, closesAlbum, marker, cursor: '', nickname, remaining: history }, writes }
    })
    if (family) {
      const next = await this.eraseRetiredPosts(family, user, closesAlbum, bucket, cursor)
      if (!next) await this.eraseRetiredAlbumData(family, user, closesAlbum, nickname)
      const pending = next ? family : remaining[0] ?? ''
      const later = next ? remaining : remaining.slice(1)
      const advanced = await this.transaction(async tx => {
        const current = await this.get(marker, tx)
        if (string(current, 'family') !== family || (string(current, 'cursor') ?? '') !== cursor) {
          return { result: false, writes: [] }
        }
        return { result: true, writes: [this.write(marker, {
          closesAlbum: { booleanValue: !!next && closesAlbum },
          ...(pending ? { family: s(pending), cursor: s(next ?? ''), remaining: s(JSON.stringify(later)),
            ...(nickname ? { nickname: s(nickname) } : {}) } : {}),
        })] }
      })
      if (!advanced || pending) return false
    }
    await this.forgetFirebaseUser(uid)
    await this.transaction(async tx => {
      const hash = string(await this.get(codeIndex, tx), 'hash')
      return { result: undefined, writes: [
        ...(hash ? [this.remove('deletion_codes/' + hash), this.remove(codeIndex)] : []),
        this.write(marker, { complete: flags }),
      ] }
    })
    return true
  }

  private async eraseRetiredPosts(family: string, user: string, closesAlbum: boolean, bucket: R2Bucket, cursor: string) {
    const familyPath = 'families/' + family
    // Keep deletion resumable within the Worker's per-request subrequest budget.
    const page = await this.listPage(familyPath + '/timeline', cursor, '__name__ asc', 2)
    for (const doc of page.documents ?? []) {
      const id = idOf(doc)
      const path = familyPath + '/timeline/' + id
      if (closesAlbum || string(doc, 'author') === user) {
        await this.transaction(async tx => {
          const fresh = await this.get(path, tx)
          return { result: undefined, writes: fresh ? [await this.markDeleting(path, fresh, tx)] : [] }
        })
        await this.erasePost(family, id, bucket)
        continue
      }
      for (const collection of ['comments', 'reactions']) {
        for await (const item of this.documents(path + '/' + collection)) {
          if (string(item, 'author') === user) {
            await this.send('commit', { writes: [{ delete: item.name }] })
          } else if (collection === 'comments' && asJson<Record<string, string[]>>(item, 'reactionMembers')[user]) {
            const location = path + '/comments/' + idOf(item)
            await this.transaction(async tx => {
              const current = await this.get(location, tx)
              if (!current) return { result: undefined, writes: [] }
              const byUser = { ...asJson<Record<string, string[]>>(current, 'reactionMembers') }
              delete byUser[user]
              return { result: undefined, writes: [
                this.write(location, { ...current.fields, reactionMembers: s(JSON.stringify(byUser)) }),
              ] }
            })
          }
        }
      }
    }
    return page.nextPageToken
  }

  private async eraseRetiredAlbumData(family: string, user: string, closesAlbum: boolean, nickname?: string) {
    const familyPath = 'families/' + family
    const members = familyPath + '/members'
    for await (const member of this.documents(members)) {
      const path = members + '/' + idOf(member)
      if (closesAlbum || idOf(member) === user) {
        await this.clearCollection(path + '/notices')
        await this.send('commit', { writes: [this.remove(path)] })
      } else {
        const writes: Write[] = []
        for await (const notice of this.documents(path + '/notices')) {
          const actorId = string(notice, 'actorId')
          if (actorId === user || idOf(notice).endsWith('-join-' + user)) {
            writes.push({ delete: notice.name })
          } else if (!actorId && nickname && string(notice, 'actor') === nickname) {
            // Older notifications only stored the display name.
            writes.push(this.write(path + '/notices/' + idOf(notice), { ...notice.fields, actor: s('家族のメンバー') }))
          }
          if (writes.length === 100) await this.send('commit', { writes: writes.splice(0) })
        }
        if (writes.length) await this.send('commit', { writes })
      }
    }
    await this.clearInvites(family, closesAlbum ? undefined : user)
    if (closesAlbum) {
      await this.clearCollection(familyPath + '/children')
      await this.clearCollection(familyPath + '/quota')
      await this.send('commit', { writes: [this.remove(familyPath)] })
    }
  }
}
