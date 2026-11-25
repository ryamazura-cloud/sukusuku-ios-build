import { HttpError } from './domain.ts'

const encoder = new TextEncoder()
const jwksUrl = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
const oauthUrl = 'https://oauth2.googleapis.com/token'

function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const encodeJson = (obj: object) => encode(encoder.encode(JSON.stringify(obj)))
function decode(value: string) {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0))
}
function fromJson(value: string) {
  return JSON.parse(new TextDecoder().decode(decode(value)))
}

type SigningJwk = JsonWebKey & { kid?: string }
type Fetcher = typeof fetch
const signatureAlgorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
const invalid = () => new HttpError(401, 'invalid Firebase ID token')

export class FirebaseVerifier {
  private keys: SigningJwk[] = []
  private validUntil = 0
  private readonly fetcher: Fetcher
  constructor(fetcher: Fetcher = fetch.bind(globalThis)) { this.fetcher = fetcher }
  private async refresh(now: number) {
    if (this.validUntil > now) return
    const response = await this.fetcher(jwksUrl)
    if (!response.ok) throw new HttpError(503, 'signing keys unavailable')
    const { keys } = await response.json() as { keys: SigningJwk[] }
    if (!Array.isArray(keys) || !keys.length) throw new HttpError(503, 'signing keys unavailable')
    this.keys = keys
    const ttl = Number(response.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1] ?? 60)
    this.validUntil = now + Math.min(ttl, 86_400)
  }
  async uid(header: string | undefined, project: string, now = Math.floor(Date.now() / 1000)) {
    const token = header?.match(/^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/i)?.[1]
    if (!token || token.length > 8192 || !project) throw invalid()
    const [head, payload, signature] = token.split('.')
    let meta: { alg?: string; kid?: string }
    let claims: Record<string, unknown>
    let sig: Uint8Array
    try {
      meta = fromJson(head)
      claims = fromJson(payload)
      sig = decode(signature)
    } catch { throw invalid() }
    if (!meta || meta.alg !== 'RS256' || typeof meta.kid !== 'string' || !claims ||
        claims.aud !== project || claims.iss !== 'https://securetoken.google.com/' + project ||
        typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128 ||
        !['iat', 'exp', 'auth_time'].every(key => Number.isSafeInteger(claims[key])) ||
        (claims.iat as number) > now || (claims.auth_time as number) > now ||
        (claims.exp as number) <= now) throw invalid()
    await this.refresh(now)
    const jwk = this.keys.find(key => key.kid === meta.kid && key.kty === 'RSA')
    if (!jwk) throw invalid()
    const key = await crypto.subtle.importKey('jwk', jwk, signatureAlgorithm, false, ['verify'])
    if (!await crypto.subtle.verify(signatureAlgorithm, key, sig, encoder.encode(head + '.' + payload))) {
      throw invalid()
    }
    return claims.sub
  }
}

export class GoogleAccess {
  private cached?: { token: string; until: number }
  private readonly account: { email: string; key: string }
  constructor(account: { email: string; key: string }) { this.account = account }
  async token() {
    const now = Math.floor(Date.now() / 1000)
    if (this.cached && this.cached.until > now) return this.cached.token
    return this.exchange(now)
  }
  private async exchange(now: number) {
    const { email, key } = this.account
    if (!email || !key) throw new HttpError(503, 'Firestore credentials are not configured')
    const privateKey = await crypto.subtle.importKey('pkcs8',
      decode(key.replace(/\\n/g, '\n').replace(/-----[^-]+-----|\s/g, '')),
      signatureAlgorithm, false, ['sign'])
    const jwt = encodeJson({ alg: 'RS256', typ: 'JWT' }) + '.' + encodeJson({
      iss: email, aud: oauthUrl, iat: now, exp: now + 3600,
      scope: 'https://www.googleapis.com/auth/datastore',
    })
    const signature = await crypto.subtle.sign(signatureAlgorithm, privateKey, encoder.encode(jwt))
    const response = await fetch(oauthUrl, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt + '.' + encode(new Uint8Array(signature)),
      }),
    })
    if (!response.ok) throw new HttpError(503, 'Google OAuth unavailable')
    const body = await response.json() as { access_token?: string; expires_in?: number }
    if (!body.access_token || !body.expires_in) throw new HttpError(503, 'invalid Google OAuth response')
    this.cached = { token: body.access_token, until: now + body.expires_in - 60 }
    return this.cached.token
  }
}
