import { HttpError, mayPost, mayView, reserveBytes, type MediaType, type Scope } from './domain.ts'
import { Firestore, FirestorePrecondition, integer, n, s, string, userKey, type Doc, type Write } from './firestore.ts'

type Actor = { uid: string; family: string }
type Attachment = { id: string; type: MediaType }
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
    if (await this.get('retired_users/' + userKey(uid))) throw new HttpError(403, 'account retirement in progress')
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
      if (await this.get('retired_users/' + userKey(uid), tx)) throw new HttpError(403, 'account inactive')
      return { result: { name }, writes: [this.write(path, { name: s(name) })] }
    })
  }

  async members(actor: Actor) {
    await this.member(actor)
    const list: { id: string; name: string; role: string; side?: string; relationship?: string }[] = []
    for await (const doc of this.documents(this.family(actor) + '/members')) {
      const member = this.familyMember(doc)
      if (!member) continue
      const id = idOf(doc)
      const profile = await this.get('profiles/' + id)
      list.push({ id, name: string(profile, 'name') ?? '', ...member, relationship: string(doc, 'relationship') })
    }
    return list
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
    for (const collection of ['comments', 'reactions']) {
      for await (const item of this.documents(path + '/' + collection)) {
        await this.send('commit', { writes: [{ delete: item.name }] })
      }
    }
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
    const event = await this.transaction(async tx => {
      const { doc, path } = await this.post(actor, id, tx)
      const user = userKey(actor.uid)
      const location = path + '/comments/' + key
      if (commentId) {
        const previous = await this.get(location, tx)
        if (!previous) throw new HttpError(404, 'comment not found')
        const admin = (await this.member(actor, tx)).member.role === 'admin'
        if (string(previous, 'author') !== user && !(body === null && admin)) {
          throw new HttpError(403, 'comment author required')
        }
        return { result: null, writes: [body === null ? this.remove(location)
          : this.write(location, { ...previous.fields, body: s(body) })] }
      }
      const profile = await this.get('profiles/' + user, tx)
      return { result: { owner: string(doc, 'author')! }, writes: [
        this.write(location, { author: s(user), name: s(string(profile, 'name') || '家族'),
          body: s(body!), at: s(now()) }, true),
      ] }
    })
    if (event) await this.notify(actor, id, 'comment', 'comment-' + key, event.owner).catch(() => {})
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

  async refreshNotificationToken(actor: Actor, token: string) {
    await this.transaction(async tx => {
      const { doc } = await this.member(actor, tx)
      const current = string(doc, 'deviceToken')
      return { result: undefined, writes: current && current !== token ? [
        this.write(this.memberPath(actor), { ...doc.fields, deviceToken: s(token) }),
      ] : [] }
    })
  }

  async notificationSettings(actor: Actor, token?: string, preferences?: string[]) {
    return this.transaction(async tx => {
      const { doc } = await this.member(actor, tx)
      if (token === undefined || preferences === undefined) return { result: {
        enabled: !!string(doc, 'deviceToken'), preferences: string(doc, 'preferences') ?
          asJson<string[]>(doc, 'preferences') : ['post', 'comment', 'reaction', 'join'],
      }, writes: [] }
      return { result: { enabled: !!token, preferences }, writes: [
        this.write(this.memberPath(actor), { ...doc.fields, deviceToken: s(token), preferences: s(JSON.stringify(preferences)) }),
      ] }
    })
  }

  protected override async onJoined(uid: string, family: string) {
    await this.notify({ family, uid }, null, 'join', 'join-' + userKey(uid)).catch(() => {})
  }

  private async notify(actor: Actor, id: string | null, kind: string, event: string, pushRecipient?: string) {
    const members = this.family(actor) + '/members'
    const user = userKey(actor.uid)
    const [profile, post] = await Promise.all([
      this.get('profiles/' + user),
      id ? this.get(this.postPath(actor, id)) : Promise.resolve(null),
    ])
    if (id && string(post, 'state') !== ready) return
    const writes: Write[] = []
    const tokens: string[] = []
    const noticeId = timeId() + '-' + event
    const fields = { ...(id ? { post: s(id) } : {}), kind: s(kind), at: s(now()),
      actor: s(string(profile, 'name') || '家族のメンバー') }
    for await (const candidate of this.documents(members)) {
      const key = idOf(candidate)
      const member = this.familyMember(candidate)
      if (key === user || !member || (id && !mayView(member, string(post, 'scope') as Scope))) continue
      writes.push(this.write(members + '/' + key + '/notices/' + noticeId, fields, true))
      const preference = kind === 'commentReaction' ? 'reaction' : kind
      const enabled = string(candidate, 'preferences')
      const token = string(candidate, 'deviceToken')
      if (token && (!pushRecipient || key === pushRecipient) &&
          (!enabled || asJson<string[]>(candidate, 'preferences').includes(preference))) {
        tokens.push(token)
      }
    }
    if (writes.length) await this.send('commit', { writes })
    if (!tokens.length) return
    const project = this.root.split('/')[1]
    const credential = await this.google.token()
    await Promise.all(tokens.map(async token => {
      try {
        const response = await this.fetcher('https://fcm.googleapis.com/v1/projects/' + project + '/messages:send', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: { token, notification: {
            title: 'すくすく', body: '家族のアルバムに新しいお知らせがあります。',
          },
          android: { priority: 'HIGH', notification: { channel_id: 'sukusuku_album' } },
          apns: { payload: { aps: { sound: 'default' } } },
          data: { album: 'notices' } } }),
        })
        if (!response.ok) {
          const body = await response.json().catch(() => null) as {
            error?: { status?: string; details?: { errorCode?: string }[] }
          } | null
          const code = body?.error?.details?.find(detail => detail.errorCode)?.errorCode ?? body?.error?.status
          console.warn('FCM notification delivery rejected', response.status,
            code && /^[A-Z_]+$/.test(code) ? code : 'UNKNOWN')
        }
      } catch { console.warn('FCM notification delivery unavailable') }
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

  async retire(uid: string, bucket: R2Bucket) {
    const user = userKey(uid)
    const marker = 'retired_users/' + user
    const membershipPath = 'family_memberships/' + user
    const family = await this.transaction(async tx => {
      const existing = await this.get(marker, tx)
      if (existing) return { result: string(existing, 'family') ?? '', writes: [] }
      const id = string(await this.get(membershipPath, tx), 'familyId') ?? ''
      const writes: Write[] = [this.write(marker, { family: s(id) }, true)]
      if (id) {
        const familyPath = 'families/' + id
        const memberPath = familyPath + '/members/' + user
        const member = await this.get(memberPath, tx)
        if (this.familyMember(member)?.role === 'admin') {
          let anotherAdmin = false
          for await (const candidate of this.documents(familyPath + '/members', tx)) {
            if (idOf(candidate) !== user && this.familyMember(candidate)?.role === 'admin') {
              anotherAdmin = true
              break
            }
          }
          if (!anotherAdmin) throw new HttpError(409, 'another administrator required')
        }
        const family = await this.get(familyPath, tx)
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
      writes.push(this.remove('profiles/' + user))
      return { result: id, writes }
    })
    if (!family) return
    const familyPath = 'families/' + family
    for await (const doc of this.documents(familyPath + '/timeline')) {
      const id = idOf(doc)
      const path = familyPath + '/timeline/' + id
      if (string(doc, 'author') === user) {
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
    const memberPath = familyPath + '/members/' + user
    for await (const notice of this.documents(memberPath + '/notices')) {
      await this.send('commit', { writes: [{ delete: notice.name }] })
    }
    await this.send('commit', { writes: [this.remove(memberPath), this.write(marker, { family: s(''), complete: flags })] })
  }
}
