import assert from 'node:assert/strict'
import test from 'node:test'
import { Firestore } from '../src/firestore.ts'
import { FirebaseVerifier } from '../src/google.ts'

test('default Firebase and Firestore fetchers keep the runtime receiver', async t => {
  const calls: URL[] = []
  t.mock.method(globalThis, 'fetch', async function (this: typeof globalThis, input: string) {
    assert.equal(this, globalThis)
    const url = new URL(input)
    calls.push(url)
    if (url.hostname === 'www.googleapis.com') {
      return Response.json({ keys: [{ kid: 'different-key', kty: 'RSA' }] })
    }
    return new Response(null, { status: 404 })
  })
  const now = 5000
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const header = encode({ alg: 'RS256', kid: 'unknown' })
  const claims = encode({ aud: 'fixture', iss: 'https://securetoken.google.com/fixture',
    sub: 'parent', auth_time: now - 1, iat: now - 1, exp: now + 10 })
  await assert.rejects(new FirebaseVerifier().uid('Bearer ' + header + '.' + claims + '.AAAA',
    'fixture', now), { status: 401 })
  const firestore = new Firestore('fixture', { token: async () => 'fixture' })
  await assert.rejects(firestore.read({ family: 'phase0', post: 'family', uid: 'parent' },
    'fixture'), { status: 403 })
  assert.deepEqual(calls.map(url => url.hostname), ['www.googleapis.com', 'firestore.googleapis.com'])
})
