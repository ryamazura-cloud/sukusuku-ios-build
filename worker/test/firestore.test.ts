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
