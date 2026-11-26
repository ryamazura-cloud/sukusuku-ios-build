import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp, type Bindings } from '../src/app.ts'
import { HttpError } from '../src/domain.ts'
import { FamilyContent } from '../src/family_content.ts'
import { userKey } from '../src/firestore.ts'

test('family content stays private, supports discussion, and purges only the retiring user', async () => {
  const docs = new Map()
  const files = new Map()
  const removedAccounts = new Set<string>()
  let firebaseDeleteAvailable = true
  const pushes: { token: string; android: { notification: { channel_id: string } }; apns: { payload: { aps: { sound: string } } } }[] = []
  const root = 'projects/fixture/databases/(default)/documents'
  const db = new FamilyContent('fixture', { token: async () => 'oauth' }, async (request, init) => {
    const url = new URL(String(request))
    const path = url.pathname.slice('/v1/'.length)
    if (url.hostname === 'identitytoolkit.googleapis.com') {
      const { localId, targetProjectId } = JSON.parse(String(init?.body))
      assert.equal(url.pathname, '/v1/accounts:delete')
      assert.equal(targetProjectId, 'fixture')
      if (!firebaseDeleteAvailable) return Response.json({}, { status: 403 })
      removedAccounts.add(localId)
      return Response.json({})
    }
    if (path.endsWith(':runQuery')) {
      const { structuredQuery } = JSON.parse(String(init?.body))
      const family = structuredQuery.where.fieldFilter.value.stringValue
      return Response.json([...docs.values()].filter(doc =>
        doc.name.startsWith(root + '/family_invites/') && doc.fields.familyId.stringValue === family,
      ).map(document => ({ document })))
    }
    if (url.hostname === 'fcm.googleapis.com') {
      pushes.push(JSON.parse(String(init?.body)).message)
      return Response.json({ name: 'messages/mock' })
    }
    if (path.endsWith(':beginTransaction')) return Response.json({ transaction: 'tx' })
    if (path.endsWith(':rollback')) return Response.json({})
    if (path.endsWith(':commit')) {
      const { writes } = JSON.parse(String(init?.body))
      for (const write of writes) {
        if (write.currentDocument && docs.has(write.update.name)) {
          return Response.json({ error: { status: 'ALREADY_EXISTS' } }, { status: 409 })
        }
      }
      for (const write of writes) {
        if (write.delete) docs.delete(write.delete)
        else docs.set(write.update.name, write.update)
      }
      return Response.json({})
    }
    if (url.searchParams.has('pageSize')) {
      if (path.endsWith('/timeline')) assert.match(url.searchParams.get('orderBy')!, /^__name__ (asc|desc)$/)
      const documents = [...docs.keys()]
        .filter(name => name.startsWith(path + '/') && !name.slice(path.length + 1).includes('/'))
        .sort().map(name => docs.get(name))
      if (url.searchParams.get('pageSize') === '2' && path.endsWith('/timeline')) {
        const after = url.searchParams.get('pageToken') ?? ''
        const remaining = documents.filter(doc => doc.name > after)
        return Response.json({
          documents: remaining.slice(0, 2),
          ...(remaining.length > 2 ? { nextPageToken: remaining[1].name } : {}),
        })
      }
      return Response.json({ documents })
    }
    return docs.has(path) ? Response.json(docs.get(path)) : Response.json({}, { status: 404 })
  })
  const bucket = {
    async put(key, body, options) {
      if (files.has(key)) return null
      files.set(key, { body, size: body.byteLength, customMetadata: options.customMetadata })
      return {}
    },
    async get(key) { return files.get(key) ?? null },
    async head(key) { return files.get(key) ?? null },
    async delete(key) { files.delete(key) },
  } as R2Bucket
  const func = async (header: string | undefined) => {
    if (!header) throw new HttpError(401, 'no user')
    return header
  }
  const app = createApp({ uid: func, store: () => db, families: () => db, content: () => db })
  const env = { APP_ENV: 'dev', MEDIA: bucket } as Bindings
  const family = await db.createFamily('owner', 'Our family')
  const actor = (uid: string) => ({ family: family.id, uid })
  for (const [uid, role] of [['fatherSide', 'paternal'], ['motherSide', 'maternal'], ['parent', 'parent']] as const) {
    const invite = await db.createInvite('owner', family.id, role)
    await db.joinFamily(uid, invite.code)
  }
  const url = '/v1/families/' + family.id
  const request = (uid: string, endpoint: string, method = 'GET', body?: object | Uint8Array) => {
    const headers = new Headers({ Authorization: uid })
    const file = body instanceof Uint8Array
    if (file) {
      headers.set('Content-Type', 'image/jpeg')
      headers.set('Content-Length', String(body.byteLength))
    } else if (body) headers.set('Content-Type', 'application/json')
    return app.fetch(new Request('https://example.invalid' + endpoint, {
      method, headers, body: file ? body : body ? JSON.stringify(body) : undefined,
    }), env)
  }
  const anonAlbum = await request('anon-admin', '/v1/families', 'POST', {
    name: 'Test album', relationship: 'mother', nickname: 'Mama',
    childName: 'Baby', birthday: '2090-02-28',
  })
  assert.equal(anonAlbum.status, 201)
  const { family: created } = await anonAlbum.json()
  assert.equal(created.role, 'admin')
  assert.equal(created.relationship, 'mother')
  const anonUrl = '/v1/families/' + created.id
  const scheduledChild = await (await request('anon-admin', anonUrl + '/children')).json()
  assert.equal(scheduledChild.children[0].birthday, '2090-02-28')
  const childPath = anonUrl + '/children/' + scheduledChild.children[0].id
  assert.equal((await request('anon-admin', childPath, 'PUT', { name: 'Baby', birthday: '2090-03-01' })).status, 200)
  assert.equal((await request('anon-admin', childPath, 'PUT', { name: 'Baby', birthday: '2090-02-29' })).status, 400)
  assert.equal((await (await request('anon-admin', anonUrl + '/children')).json()).children[0].name, 'Baby')
  const { code: token } = await (await request('anon-admin', anonUrl + '/invites', 'POST', { role: 'maternal' })).json()
  const detail = '/v1/families/invite-details'
  const join = '/v1/families/join'
  assert.deepEqual(await (await request('anon-viewer', detail, 'POST', { code: token })).json(), { type: 'viewer' })
  assert.equal((await request('anon-viewer', join, 'POST', { code: token, relationship: 'father', nickname: 'Dad' })).status, 400)
  const joined = await request('anon-viewer', join, 'POST', { code: token, relationship: 'sibling', nickname: 'Sibling' })
  assert.equal(joined.status, 200)
  assert.deepEqual((await joined.json()).family, { id: created.id, name: 'Test album', role: 'grandparent', side: 'maternal', relationship: 'sibling' })
  assert.equal((await request('anon-outsider', detail, 'POST', { code: token })).status, 404)
  assert.equal((await request('anon-viewer', anonUrl + '/invites', 'POST', { role: 'parent' })).status, 403)
  const { code: parentToken } = await (await request('anon-admin', anonUrl + '/invites', 'POST', { role: 'parent' })).json()
  assert.deepEqual(await (await request('anon-parent', detail, 'POST', { code: parentToken })).json(), { type: 'parent' })
  const parentJoin = await request('anon-parent', join, 'POST', { code: parentToken, relationship: 'father', nickname: 'Dad' })
  assert.equal(parentJoin.status, 200)
  assert.equal((await parentJoin.json()).family.role, 'admin')

  const renamePath = anonUrl + '/name'
  assert.equal((await request('anon-viewer', renamePath, 'PUT', { name: 'Denied' })).status, 403)
  assert.equal((await request('anon-admin', renamePath, 'PUT', { name: '  ' })).status, 400)
  assert.equal((await request('anon-admin', renamePath, 'PUT', { name: ' New album ' })).status, 200)
  assert.equal((await (await request('anon-viewer', '/v1/families/current')).json()).family.name, 'New album')

  const avatar = '/9j/2Q=='
  const avatarPath = childPath + '/avatar'
  assert.equal((await request('anon-viewer', avatarPath, 'PUT', { avatar })).status, 403)
  assert.equal((await request('anon-parent', avatarPath, 'PUT', { avatar: '!' })).status, 400)
  assert.equal((await request('anon-parent', avatarPath, 'PUT', { avatar })).status, 200)
  assert.equal((await request('anon-admin', childPath, 'PUT', { name: 'Baby', birthday: '2090-03-02' })).status, 200)
  assert.equal((await request('anon-outsider', anonUrl + '/children')).status, 403)
  assert.equal((await (await request('anon-viewer', anonUrl + '/children')).json()).children[0].avatar, avatar)
  assert.equal((await request('anon-admin', avatarPath, 'PUT', { avatar: null })).status, 200)
  assert.equal((await (await request('anon-viewer', anonUrl + '/children')).json()).children[0].avatar, undefined)

  const getNotices = async (uid: string, root = url) =>
    (await (await request(uid, root + '/notifications')).json()).notices as { kind: string; actor?: string; post?: string }[]
  const joins = (await getNotices('anon-admin', anonUrl)).filter(item => item.kind === 'join')
  assert.deepEqual(joins.map(item => item.actor).sort(), ['Dad', 'Sibling'])
  assert.equal(joins.every(item => item.post === undefined), true)
  await request('anon-parent', join, 'POST', { code: parentToken, relationship: 'father', nickname: 'Dad' })
  assert.equal((await getNotices('anon-admin', anonUrl)).filter(item => item.kind === 'join').length, 2)
  assert.equal((await getNotices('anon-parent', anonUrl)).some(item => item.kind === 'join'), false)

  const child = crypto.randomUUID()
  assert.equal((await request('fatherSide', url + '/children/' + child, 'PUT', {
    name: 'Baby', birthday: '2020-02-29',
  })).status, 403)
  assert.equal((await request('owner', url + '/children/' + child, 'PUT', {
    name: 'Baby', birthday: '2020-02-29',
  })).status, 200)
  const media = crypto.randomUUID()
  const fields = { body: 'Private', scope: 'paternal', capturedAt: '2020-03-29', childIds: [child] }
  const payload = { ...fields, media: [{ id: media, type: 'image/jpeg' }] }
  assert.equal((await request('fatherSide', url + '/posts', 'POST', payload)).status, 403)
  for (const invalid of [{body: 7}, {scope: ''}, {capturedAt: ''}]) {
    assert.equal((await request('owner', url + '/posts', 'POST', { ...payload, ...invalid })).status, 400)
  }
  assert.equal((await request('owner', url + '/posts', 'POST', { ...payload, body: undefined })).status, 201)
  const draft = await request('owner', url + '/posts', 'POST', payload)
  assert.equal(draft.status, 201)
  const { id } = await draft.json()
  const path = url + '/posts/' + id
  const object = path + '/media/' + media
  assert.equal((await request('owner', path + '/publish', 'POST')).status, 409)
  const jpeg = new Uint8Array([255, 216, 255, 217])
  assert.equal((await request('owner', object, 'PUT', jpeg)).status, 200)
  assert.equal((await request('owner', object, 'PUT', jpeg)).status, 200)
  assert.equal((await request('fatherSide', object)).status, 404)
  const settings = url + '/notification-settings'
  assert.equal((await request('fatherSide', settings, 'PUT', { token: 'first-registration' })).status, 200)
  assert.equal((await (await request('fatherSide', settings)).json()).enabled, true)
  assert.equal((await request('fatherSide', url + '/notification-test', 'POST')).status, 200)
  assert.equal(pushes.pop()?.token, 'first-registration')
  assert.equal((await request('fatherSide', url + '/notification-test', 'POST')).status, 429)
  assert.equal((await request('fatherSide', settings, 'PUT', { token: '', preferences: ['post'] })).status, 200)
  assert.equal((await request('fatherSide', settings, 'PUT', { token: 'no-opt-in' })).status, 200)
  assert.equal((await (await request('fatherSide', settings)).json()).enabled, false)
  assert.equal((await request('parent', settings, 'PUT', { token: 'old', preferences: ['post'] })).status, 200)
  assert.equal((await request('parent', settings, 'PUT', { token: 'updated' })).status, 200)
  assert.deepEqual((await (await request('parent', settings)).json()).preferences, ['post'])
  assert.equal((await request('owner', path + '/publish', 'POST')).status, 200)
  assert.equal(pushes.length, 1)
  assert.equal(pushes[0].token, 'updated')
  assert.equal(pushes[0].android.notification.channel_id, 'sukusuku_album')
  assert.equal(pushes[0].apns.payload.aps.sound, 'default')
  for (const uid of ['owner', 'parent', 'fatherSide']) {
    assert.equal((await request(uid, object)).status, 200)
  }
  assert.equal((await request('outsider', object)).status, 403)
  for (const endpoint of [path, object, path + '/discussion']) {
    assert.equal((await request('motherSide', endpoint)).status, 404)
  }
  const list = await (await request('motherSide', url + '/posts')).json()
  assert.equal(list.posts.length, 0)
  assert.equal((await getNotices('fatherSide')).filter(item => item.kind === 'post').length, 1)
  assert.equal((await getNotices('motherSide')).filter(item => item.post).length, 0)
  assert.equal((await request('fatherSide', path + '/comments', 'POST', { body: 'Lovely' })).status, 201)
  assert.equal((await request('fatherSide', path + '/reactions/love', 'PUT', { enabled: true })).status, 200)
  assert.equal((await (await request('owner', path + '/discussion')).json()).reactions.love, 1)
  const initial = await (await request('owner', path + '/discussion')).json()
  const commentId = initial.comments[0].id
  const commentReaction = path + '/comments/' + commentId + '/reactions/like'
  assert.equal((await request('motherSide', commentReaction, 'PUT', { enabled: true })).status, 404)
  assert.equal((await request('owner', commentReaction, 'PUT', { enabled: true })).status, 200)
  assert.equal((await request('owner', commentReaction, 'PUT', { enabled: true })).status, 200)
  const afterReaction = await (await request('owner', path + '/discussion')).json()
  assert.deepEqual(afterReaction.reactions, { love: 1 })
  assert.deepEqual(afterReaction.comments[0].reactions, { like: 1 })
  assert.deepEqual(afterReaction.comments[0].own, ['like'])
  const parentActivity = (await getNotices('parent')).filter(item => item.post === id)
  assert.deepEqual(parentActivity.map(item => item.kind).sort(), ['comment', 'commentReaction', 'post', 'reaction'].sort())
  assert.equal((await getNotices('owner')).some(item => item.kind === 'commentReaction'), false)
  assert.equal((await getNotices('motherSide')).some(item => item.post === id), false)
  assert.equal((await request('owner', commentReaction, 'PUT', { enabled: false })).status, 200)
  assert.deepEqual((await (await request('owner', path + '/discussion')).json()).comments[0].reactions, {})
  assert.equal((await request('owner', path, 'PUT', { ...fields, scope: 'parents' })).status, 200)
  assert.equal((await request('fatherSide', object)).status, 404)
  assert.equal((await getNotices('fatherSide')).filter(item => item.kind === 'post').length, 0)

  assert.equal((await request('anon-admin', '/v1/account', 'DELETE')).status, 200)
  assert.equal((await request('anon-parent', '/v1/account', 'DELETE')).status, 409)
  assert.equal((await request('fatherSide', '/v1/account', 'DELETE')).status, 200)
  const discussion = await (await request('parent', path + '/discussion')).json()
  assert.equal(discussion.comments.length, 0)
  assert.deepEqual(discussion.reactions, {})
  assert.equal((await request('owner', '/v1/account', 'DELETE')).status, 200)
  assert.equal(files.size, 0)
  assert.equal(docs.get(root + '/families/' + family.id + '/quota/storage').fields.bytes.integerValue, '0')
  assert.equal((await request('parent', url + '/members')).status, 200)
  const incorrectInvite = await db.createInvite('parent', family.id, 'paternal')
  await db.joinFamily('incorrect', incorrectInvite.code)
  const correction = url + '/members/' + userKey('incorrect') + '/grandparent'
  assert.equal((await request('motherSide', correction, 'PUT', { side: 'maternal' })).status, 403)
  assert.equal((await request('parent', correction, 'PUT', { side: 'maternal' })).status, 200)
  assert.deepEqual(await db.membership('incorrect'), {
    id: family.id, name: family.name, role: 'grandparent', side: 'maternal',
  })
  assert.equal((await request('incorrect', url + '/posts', 'POST', payload)).status, 403)
  assert.equal((await request('parent', url + '/members/' + userKey('parent') +
    '/grandparent', 'PUT', { side: 'maternal' })).status, 409)
  assert.equal((await request('owner', '/v1/families/current')).status, 403)
  assert.equal((await request('owner', '/v1/account', 'DELETE')).status, 200)
  assert.ok(removedAccounts.has('owner'))
  const code = 'e'.repeat(64)
  assert.equal((await request('anon-parent', '/v1/account/deletion-code', 'PUT', { code: 'd'.repeat(64) })).status, 200)
  assert.equal((await request('anon-parent', '/v1/account/deletion-code', 'PUT', { code })).status, 200)
  const web = (code: string, action: string, closeAlbum = 'no') => app.fetch(new Request(
    'https://example.invalid/account-deletion', {
      method: 'POST', body: new URLSearchParams({ code, action, closeAlbum }),
    }), env)
  assert.equal((await web('d'.repeat(64), 'delete', 'yes')).status, 404)
  assert.match(await (await web(code, 'preview')).text(), /アルバム全体を削除/)
  assert.equal((await web(code, 'delete')).status, 503)
  assert.ok(await db.membership('anon-viewer'))
  const fid = 'd123456789abcdefghijkl'
  assert.equal((await request('anon-viewer', anonUrl + '/notification-settings', 'PUT', { fid })).status, 200)
  assert.equal((await request('anon-viewer', anonUrl + '/notification-test', 'POST')).status, 200)
  assert.equal((pushes.pop() as { fid?: string } | undefined)?.fid, fid)
  for (let index = 0; index < 3; index++) {
    const response = await request('anon-parent', anonUrl + '/posts', 'POST', {
      ...payload, scope: 'all', childIds: [scheduledChild.children[0].id],
    })
    assert.equal(response.status, 201)
    if (index === 2) {
      const { id } = await response.json()
      assert.equal((await request('anon-parent', anonUrl + '/posts/' + id + '/media/' + media, 'PUT', jpeg)).status, 200)
      assert.equal((await request('anon-parent', anonUrl + '/posts/' + id + '/publish', 'POST')).status, 200)
      assert.equal((await request('anon-viewer', anonUrl + '/posts/' + id + '/comments', 'POST', { body: 'Good!' })).status, 201)
    }
  }
  firebaseDeleteAvailable = false
  const firstDeletion = await web(code, 'delete', 'yes')
  assert.equal(firstDeletion.status, 202)
  assert.match(firstDeletion.headers.get('Content-Security-Policy') ?? '', /script-src 'nonce-/)
  assert.equal((await web(code, 'delete')).status, 503)
  assert.equal(files.size, 0)
  assert.equal([...docs.keys()].some(key => key.includes('/families/' + created.id + '/timeline/')), false)
  assert.equal(await db.membership('anon-viewer'), null)
  assert.equal(docs.has(root + '/profiles/' + userKey('anon-viewer')), true)
  assert.equal(docs.has(root + '/families/' + created.id), false)
  assert.equal(docs.has(root + '/families/' + created.id + '/children/' + scheduledChild.children[0].id), false)
  firebaseDeleteAvailable = true
  assert.equal((await web(code, 'delete', 'yes')).status, 200)
  assert.ok(removedAccounts.has('anon-parent'))
  assert.equal((await web(code, 'delete', 'yes')).status, 404)
})

test('timeline recovers from a descending list precondition failure and preserves the fallback cursor', async () => {
  const calls: (string | null)[][] = []
  const db = new FamilyContent('fixture', { token: async () => 'oauth' }, async (request) => {
    const url = new URL(String(request))
    if (url.pathname.includes('/members/')) {
      return Response.json({ fields: {
        active: { booleanValue: true }, role: { stringValue: 'grandparent' },
        side: { stringValue: 'maternal' },
      } })
    }
    const order = url.searchParams.get('orderBy')
    const cursor = url.searchParams.get('pageToken')
    calls.push([order, cursor])
    if (order === '__name__ desc') {
      return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 400 })
    }
    const doc = (id: string, scope: string) => ({
      name: url.pathname + '/' + id,
      fields: { scope: { stringValue: scope }, state: { stringValue: 'published' } },
    })
    return Response.json(cursor
      ? { documents: [doc('four', 'all')] }
      : { documents: [doc('one', 'maternal'), doc('two', 'paternal'), doc('three', 'all')], nextPageToken: 'page-two' })
  })
  const actor = { family: 'fixture', uid: 'viewer' }
  const first = await db.timeline(actor, '')
  assert.deepEqual(first.posts.map(item => item.id), ['three', 'one'])
  assert.equal(first.next, 'asc:page-two')
  const second = await db.timeline(actor, first.next)
  assert.deepEqual(second.posts.map(item => item.id), ['four'])
  assert.equal(second.next, '')
  assert.deepEqual(calls, [['__name__ desc', null], ['__name__ asc', null], ['__name__ asc', 'page-two']])
})
