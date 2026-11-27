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
    families: () => { throw new Error('family store not used by fixture routes') },
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

test('family routes authenticate, validate invitation inputs, and derive the joining role server-side', async () => {
  const id = '83b297e3-e9b2-4fdd-85c2-76ccaf8f40a1'
  const code = '83b297e3e9b24fdd85c276ccaf8f40a1'
  const app = createApp({
    uid: async header => {
      if (!header) throw new HttpError(401, 'unauthenticated')
      return header
    },
    store: () => { throw new Error('fixture store not used by family routes') },
    families: () => ({
      async membership(uid) {
        assert.equal(uid, 'tester')
        return null
      },
      async createFamily(uid, name) {
        assert.equal(uid, 'tester')
        assert.equal(name, 'すくすく家')
        return { id, name, role: 'admin' }
      },
      async createInvite(uid, family, role) {
        assert.equal(uid, 'tester')
        assert.equal(family, id)
        assert.equal(role, 'maternal')
        return { code, expiresAt: '2026-12-01T00:00:00.000Z' }
      },
      async joinFamily(uid, received) {
        assert.equal(uid, 'tester')
        assert.equal(received, code)
        return { id, name: 'すくすく家', role: 'grandparent', side: 'maternal' }
      },
    }),
  })
  const env = { APP_ENV: 'dev' } as Bindings
  const base = 'https://example.invalid/v1/families'
  const post = (path: string, body: unknown, testEnv = env) => app.fetch(new Request(base + path, {
    method: 'POST',
    headers: { Authorization: 'tester', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), testEnv)
  const invitePath = '/' + id + '/invites'

  assert.equal((await app.fetch(new Request(base + '/current'), env)).status, 401)
  assert.equal((await post('', { name: 'すくすく家' }, { ...env, APP_ENV: 'prod' })).status, 404)
  const current = await app.fetch(new Request(base + '/current', { headers: { Authorization: 'tester' } }), env)
  assert.deepEqual(await current.json(), { family: null })
  assert.equal((await post('', { name: '' })).status, 400)
  assert.equal((await post('', { name: 'a'.repeat(1100) })).status, 413)
  assert.equal((await post('', { name: ' すくすく家 ' })).status, 201)
  assert.equal((await post(invitePath, { role: 'admin' })).status, 400)
  assert.equal((await post(invitePath, { role: 'maternal' })).status, 201)
  assert.equal((await post('/join', { code: 'invalid' })).status, 400)
  const joined = await post('/join', { code: code.toUpperCase(), role: 'admin' })
  assert.equal(joined.status, 200)
  assert.deepEqual(await joined.json(), {
    family: { id, name: 'すくすく家', role: 'grandparent', side: 'maternal' },
  })
})

test('public invitation landing page does not expose the token or album details', async () => {
  const app = createApp({
    uid: async () => { throw new Error('public routes do not authenticate') },
    store: () => { throw new Error('public routes do not read posts') },
    families: () => { throw new Error('public routes do not read families') },
  })
  const cert = Array(32).fill('AF').join(':')
  const env = { APP_ENV: 'dev', ANDROID_APP_CERTS: cert, IOS_TEAM_ID: 'ABCD123456',
    IOS_STORE_URL: 'https://testflight.apple.com/join/example' } as Bindings
  const open = (path: string, agent = '') =>
    app.fetch(new Request('https://example.invalid' + path, { headers: { 'User-Agent': agent } }), env)
  const code = 'a'.repeat(32)
  const landing = await open('/invite/' + code)
  assert.equal(landing.status, 200)
  assert.equal(landing.headers.get('referrer-policy'), 'no-referrer')
  assert.doesNotMatch(await landing.text(), new RegExp(code))
  const android = await open('/invite/' + code, 'Mozilla/5.0 (Linux; Android 16) Chrome/141 Safari/537.36')
  assert.equal(android.status, 302)
  assert.equal(android.headers.get('location'), 'https://play.google.com/store/apps/details?id=biz.wisemap.family_share')
  assert.equal(android.headers.get('referrer-policy'), 'no-referrer')
  const ios = await open('/invite/' + code, 'Mozilla/5.0 (iPhone) Safari/605.1.15')
  assert.equal(ios.status, 200)
  assert.equal(ios.headers.get('location'), null)
  const iosHtml = await ios.text()
  assert.match(iosHtml, /招待リンクをコピー/)
  assert.match(iosHtml, /TestFlightでインストール/)
  assert.doesNotMatch(iosHtml, new RegExp(code))
  const iosEmbedded = await open('/invite/' + code, 'Mozilla/5.0 (iPhone) Line/15.1')
  assert.match(await iosEmbedded.text(), /招待リンクをコピー/)
  const embedded = await open('/invite/' + code, 'Mozilla/5.0 (Linux; Android 16; wv) Line/15.1')
  assert.equal(embedded.status, 200)
  const html = await embedded.text()
  assert.match(html, /すくすくで開く/)
  assert.match(html, /Google Playでインストール/)
  assert.doesNotMatch(html, new RegExp(code))
  const helper = await open('/invite-open.js')
  assert.match(helper.headers.get('content-type')!, /application\/javascript/)
  const button = { hidden: true, href: '' }
  const document = { getElementById: (id: string) =>
    id === 'open-app' ? button : id === 'android-store' ? { href: android.headers.get('location') } : null }
  const runHelper = new Function('document', 'location', 'navigator', await helper.text())
  runHelper(document, { href: 'https://example.invalid/invite/' + code }, {})
  let click: (() => Promise<void>) | undefined
  let copied: string | undefined
  const status = { textContent: '' }
  const copy = { hidden: true, addEventListener: (_event: string, callback: () => Promise<void>) => { click = callback } }
  runHelper({ getElementById: (id: string) => id === 'copy-invite' ? copy : id === 'copy-status' ? status : null },
    { href: 'https://example.invalid/invite/' + code + '?tracking=1' },
    { clipboard: { writeText: async (value: string) => { copied = value } } })
  assert.equal(copy.hidden, false)
  await click!()
  assert.equal(copied, 'https://example.invalid/invite/' + code)
  assert.match(status.textContent, /コピーしました/)
  assert.equal(button.hidden, false)
  assert.match(button.href, new RegExp('^intent://example\\.invalid/invite/' + code + '#Intent;scheme=https;package='))
  const assetlinks = await (await open('/.well-known/assetlinks.json')).json()
  assert.deepEqual(assetlinks[0].target, {
    namespace: 'android_app', package_name: 'biz.wisemap.family_share', sha256_cert_fingerprints: [cert],
  })
  const aasa = await (await open('/.well-known/apple-app-site-association')).json()
  assert.deepEqual(aasa.applinks.details[0], {
    appIDs: ['ABCD123456.biz.wisemap.familyShare'], components: [{ '/': '/invite/*' }],
  })
})
