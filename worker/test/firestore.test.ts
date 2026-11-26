import assert from 'node:assert/strict'
import test from 'node:test'
import { Firestore } from '../src/firestore.ts'

test('reserves both counters and media atomically, retries contention, rejects repeat ID', async () => {
  const actions: string[] = []
  let commits = 0
  let next = 0
  let mediaExists = false
  const store = new Firestore('fixture', { token: async () => 'mock' }, async (input, init) => {
    const url = new URL(String(input))
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer mock')
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    const path = url.pathname.split('/documents')[1]
    actions.push(path)
    if (path === ':beginTransaction') {
      assert.deepEqual(body, { options: { readWrite: {} } })
      return Response.json({ transaction: 'tx' + ++next })
    }
    if (path === ':commit') {
      assert.equal(body.transaction, 'tx' + next)
      assert.equal(body.writes.length, 3)
      for (const counter of body.writes.slice(0, 2)) {
        assert.equal(counter.update.fields.bytes.integerValue, '4')
      }
      assert.equal(body.writes[2].update.fields.state.stringValue, 'reserved')
      assert.deepEqual(body.writes[2].currentDocument, { exists: false })
      if (++commits === 1) return Response.json({ error: { status: 'ABORTED' } }, { status: 409 })
      mediaExists = true
      return Response.json({})
    }
    if (path === ':rollback') return Response.json({})
    assert.equal(url.searchParams.get('transaction'), 'tx' + next)
    if (path.endsWith('/members/parent')) return Response.json({ fields: {
      active: { booleanValue: true }, role: { stringValue: 'parent' },
    } })
    if (path.endsWith('/posts/family')) return Response.json({ fields: {
      phase0Fixture: { booleanValue: true }, scope: { stringValue: 'all' },
    } })
    if (path.endsWith('/media/test') && mediaExists) return Response.json({ fields: {} })
    return Response.json({}, { status: 404 })
  })
  const access = { family: 'phase0', post: 'family', uid: 'parent' }
  assert.deepEqual(await store.reserve(access, 'test', 'image/jpeg', 4),
    { type: 'image/jpeg', bytes: 4, key: 'phase0/family/test' })
  await assert.rejects(store.reserve(access, 'test', 'image/jpeg', 4), { status: 409 })
  assert.equal(commits, 2)
  assert.equal(actions.filter(action => action === ':rollback').length, 2)
})

test('inactive or unrelated membership denies reads before fetching post or media', async () => {
  let calls = 0
  const store = new Firestore('fixture', { token: async () => 'mock' }, async () => {
    calls++
    return Response.json({ fields: { active: { booleanValue: false } } })
  })
  await assert.rejects(store.read({ family: 'phase0', post: 'family', uid: 'unrelated' }, 'test'), { status: 403 })
  assert.equal(calls, 1)
})

test('creates a family and grants only the invited role once', async () => {
  const documents = new Map<string, { fields: Record<string, unknown> }>()
  const store = new Firestore('fixture', { token: async () => 'mock' }, async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith(':beginTransaction')) return Response.json({ transaction: 'tx' })
    if (url.pathname.endsWith(':rollback')) return Response.json({})
    if (url.pathname.endsWith(':commit')) {
      const { writes } = JSON.parse(String(init?.body))
      for (const write of writes) {
        if (write.currentDocument?.exists === false && documents.has(write.update.name)) {
          return Response.json({ error: { status: 'ALREADY_EXISTS' } }, { status: 409 })
        }
      }
      for (const write of writes) documents.set(write.update.name, write.update)
      return Response.json({})
    }
    const doc = documents.get(url.pathname.slice('/v1/'.length))
    return doc ? Response.json(doc) : Response.json({}, { status: 404 })
  })
  assert.equal(await store.membership('owner'), null)
  const family = await store.createFamily('owner', 'すくすく家')
  assert.deepEqual(await store.membership('owner'), family)
  assert.equal(family.role, 'admin')
  await assert.rejects(store.createFamily('owner', '二つ目'), { status: 409 })
  await assert.rejects(store.createInvite('outside', family.id, 'parent'), { status: 403 })

  const fatherSide = await store.createInvite('owner', family.id, 'paternal')
  assert.match(fatherSide.code, /^[0-9a-f]{32}$/)
  const viewer = await store.joinFamily('viewer', fatherSide.code)
  assert.deepEqual(viewer, { ...family, role: 'grandparent', side: 'paternal' })
  assert.deepEqual(await store.membership('viewer'), viewer)
  assert.deepEqual(await store.joinFamily('viewer', fatherSide.code), viewer)
  await assert.rejects(store.joinFamily('outside', fatherSide.code), { status: 404 })
  await assert.rejects(store.createInvite('viewer', family.id, 'parent'), { status: 403 })

  const otherParent = await store.createInvite('owner', family.id, 'parent')
  await assert.rejects(store.joinFamily('viewer', otherParent.code), { status: 409 })
  assert.deepEqual(await store.joinFamily('parent', otherParent.code), family)
  assert.match((await store.createInvite('parent', family.id, 'maternal')).code, /^[0-9a-f]{32}$/)

  const expired = await store.createInvite('owner', family.id, 'maternal')
  const invite = documents.get('projects/fixture/databases/(default)/documents/family_invites/' + expired.code)
  assert.ok(invite)
  invite.fields.expiresAt = { stringValue: '2000-01-01T00:00:00.000Z' }
  await assert.rejects(store.joinFamily('outside', expired.code), { status: 404 })
  assert.equal(await store.membership('outside'), null)
})
