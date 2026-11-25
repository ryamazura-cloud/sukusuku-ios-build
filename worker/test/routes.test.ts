import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp, type Bindings } from '../src/app.ts'
import { HttpError } from '../src/domain.ts'

test('Hono upload round trip requires authorization and hides unfinished objects', async () => {
  let reservation = false
  let ready = false
  let failCompletion = false
  let blob: Uint8Array | undefined
  const env = { APP_ENV: 'dev', FIREBASE_PROJECT_ID: 'fixture', MEDIA: {
    put(_key, body) { blob = new Uint8Array(body); return {} },
    get() { return blob && { body: blob, size: blob.length } },
  } } as Bindings
  const app = createApp({
    uid: async header => {
      if (!header) throw new HttpError(401, 'unauthenticated')
      return header
    },
    store: () => ({
      async reserve(access, _id, type, bytes) {
        if (access.uid !== 'parent') throw new HttpError(403, 'post access denied')
        if (reservation) throw new HttpError(409, 'duplicate')
        reservation = true
        return { type, bytes, key: 'fixture' }
      },
      async complete() {
        if (failCompletion) throw new HttpError(503, 'unavailable')
        ready = true
      },
      async read(access) {
        if (access.uid === 'unrelated') throw new HttpError(403, 'no membership')
        if (!ready) throw new HttpError(404, 'not ready')
        return { type: 'image/jpeg', bytes: 4, key: 'fixture' }
      },
    }),
  })
  const route = '/v0/families/phase0/posts/family/media/83b297e3-e9b2-4fdd-85c2-76ccaf8f40a1'
  const body = new Uint8Array([255, 216, 255, 217])
  const put = (user = 'parent', length = '4') => new Request('https://example.invalid' + route, {
    method: 'PUT', body, headers: { Authorization: user, 'Content-Length': length, 'Content-Type': 'image/jpeg' },
  })
  const get = (user?: string) => new Request('https://example.invalid' + route,
    { headers: user ? { Authorization: user } : {} })
  assert.equal((await app.fetch(get(), env)).status, 401)
  assert.equal((await app.fetch(get('parent'), { ...env, APP_ENV: 'prod' })).status, 404)
  assert.equal((await app.fetch(put('grandparent'), env)).status, 403)
  assert.equal((await app.fetch(put('parent', '3'), env)).status, 413)
  assert.equal((await app.fetch(put('parent', '5'), env)).status, 400)
  assert.equal((await app.fetch(put(), env)).status, 201)
  assert.equal((await app.fetch(put(), env)).status, 409)
  assert.equal((await app.fetch(get('unrelated'), env)).status, 403)
  const download = await app.fetch(get('grandparent'), env)
  assert.equal(download.status, 200)
  assert.equal(download.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), body)
  ready = false
  reservation = false
  failCompletion = true
  assert.equal((await app.fetch(put(), env)).status, 503)
  assert.equal((await app.fetch(get('parent'), env)).status, 404)
})
