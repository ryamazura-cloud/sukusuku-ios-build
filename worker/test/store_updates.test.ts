import assert from 'node:assert/strict'
import test from 'node:test'
import { appleBuild, latestStoreBuild, playBuild, syncStoreBuilds } from '../src/store_updates.ts'
import type { Bindings } from '../src/app.ts'

test('Play reads only the selected track and ignores staged or draft releases', async t => {
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    const path = new URL(input).pathname
    calls.push(init.method + ' ' + path.split('/biz.wisemap.family_share')[1])
    if (init.method === 'POST') return Response.json({ id: 'edit-id' })
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    return Response.json({ track: 'internal', releases: [
      { status: 'completed', versionCodes: ['6', '7'] },
      { status: 'inProgress', versionCodes: ['8'] },
      { status: 'halted', versionCodes: ['9'] },
      { status: 'draft', versionCodes: ['10'] },
    ] })
  })
  assert.equal(await playBuild('internal', 'token'), 7)
  assert.deepEqual(calls, ['POST /edits', 'GET /edits/edit-id/tracks/internal', 'DELETE /edits/edit-id'])
})

test('App Store reports the released build number and ignores builds awaiting release', async t => {
  const response = (build: string, appVersionState: string) => ({
    attributes: { appVersionState },
    relationships: { build: { data: { id: 'build-' + build } } },
  })
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input)
    assert.equal(url.hostname, 'api.appstoreconnect.apple.com')
    assert.equal(url.pathname, '/v1/apps/6839227117/appStoreVersions')
    if (url.searchParams.get('cursor')) {
      return Response.json({
        data: [response('7', 'READY_FOR_DISTRIBUTION')],
        included: [{ type: 'builds', id: 'build-7', attributes: { version: '7' } }],
      })
    }
    assert.equal(url.searchParams.get('filter[platform]'), 'IOS')
    return Response.json({
      data: [response('8', 'PENDING_DEVELOPER_RELEASE'), response('9', 'IN_REVIEW')],
      links: { next: url.pathname + '?cursor=next' },
    })
  })
  assert.equal(await appleBuild('token'), 7)
})

test('automatic snapshots replace manual values and survive a failed synchronization', async () => {
  const objects = new Map<string, string>()
  const env = {
    PLAY_UPDATE_TRACK: 'internal', PLAY_UPDATE_CLIENT_EMAIL: 'fixture@example.test',
    PLAY_UPDATE_PRIVATE_KEY: 'invalid-key', ANDROID_LATEST_BUILD: '10',
    IOS_LATEST_BUILD: '8', TESTFLIGHT_LATEST_BUILD: '12',
    MEDIA: { get: async (key: string) => {
      const value = objects.get(key)
      return value ? { json: async () => JSON.parse(value) } : null
    } },
  } as unknown as Bindings
  const key = 'internal/store-updates/play-internal.json'
  assert.equal(await latestStoreBuild(env, 'android'), 0)
  objects.set(key, JSON.stringify({ build: 7, checkedAt: Date.now() }))
  await assert.rejects(syncStoreBuilds(env), /Store synchronization incomplete/)
  assert.equal(await latestStoreBuild(env, 'android'), 7)
  assert.equal(await latestStoreBuild(env, 'app-store'), 8)
  assert.equal(await latestStoreBuild(env, 'testflight'), 12)
  objects.set(key, JSON.stringify({ build: 7, checkedAt: Date.now() - 49 * 3600_000 }))
  assert.equal(await latestStoreBuild(env, 'android'), 0)
})


test('store requests reject a redirect without sending the bearer token to its destination', async t => {
  const requests = t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    assert.ok(['androidpublisher.googleapis.com', 'api.appstoreconnect.apple.com'].includes(new URL(input).hostname))
    assert.equal(init.redirect, 'manual')
    return new Response(null, {
      status: 302, headers: { Location: 'https://example.invalid/redirect' },
    })
  })
  await assert.rejects(playBuild('internal', 'test-token'), /Store API HTTP 302/)
  await assert.rejects(appleBuild('test-token'), /Store API HTTP 302/)
  assert.equal(requests.mock.callCount(), 2)
})

