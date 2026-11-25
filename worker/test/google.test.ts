import assert from 'node:assert/strict'
import test from 'node:test'
import { FirebaseVerifier } from '../src/google.ts'

test('verifies RSA signature and checks issuer, audience, future timestamps and expiry', async () => {
  const pair = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256',
    modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]),
  }, true, ['sign', 'verify'])
  const key = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'fixture' }
  let requests = 0
  const verifier = new FirebaseVerifier(async () => {
    requests++
    return Response.json({ keys: [key] }, { headers: { 'Cache-Control': 'max-age=120' } })
  })
  const now = 5_000
  const example = { sub: 'fake-parent', aud: 'dev-project', iss: 'https://securetoken.google.com/dev-project',
    iat: now - 10, auth_time: now - 90, exp: now + 300 }
  async function jwt(changes = {}, algorithm = 'RS256', kid = 'fixture') {
    const header = Buffer.from(JSON.stringify({ alg: algorithm, kid })).toString('base64url')
    const claims = Buffer.from(JSON.stringify({ ...example, ...changes })).toString('base64url')
    const message = header + '.' + claims
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, Buffer.from(message))
    return 'Bearer ' + message + '.' + Buffer.from(signature).toString('base64url')
  }
  const bearer = await jwt()
  assert.equal(await verifier.uid(bearer, 'dev-project', now), 'fake-parent')
  await assert.rejects(verifier.uid(bearer, 'prod-project', now), { status: 401 })
  for (const change of [{ iss: 'wrong' }, { auth_time: now + 1 }, { iat: now + 1 },
    { exp: now }, { sub: '' }, { exp: String(now + 3) }]) {
    await assert.rejects(verifier.uid(await jwt(change), 'dev-project', now), { status: 401 })
  }
  await assert.rejects(verifier.uid(await jwt({}, 'none'), 'dev-project', now), { status: 401 })
  await assert.rejects(verifier.uid(await jwt({}, 'RS256', 'unknown'), 'dev-project', now), { status: 401 })
  await assert.rejects(verifier.uid(bearer.slice(0, bearer.lastIndexOf('.') + 1) + 'AAAA', 'dev-project', now), { status: 401 })
  await assert.rejects(verifier.uid(undefined, 'dev-project', now), { status: 401 })
  assert.equal(requests, 1)
})
