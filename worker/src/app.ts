import { Hono, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HttpError, MAX_UPLOAD, inviteRoles, memberAvatar, type InviteRole, validateMedia } from './domain.ts'
import { registerInviteLinks } from './invite_links.ts'
import type { FamilyStore, Store, JoinProfile, ParentRelationship } from './firestore.ts'
import type { FamilyContent } from './family_content.ts'
import { registerContent } from './content_routes.ts'
import { registerDeletionPage } from './deletion_page.ts'

import { latestStoreBuild, type StoreUpdateBindings } from './store_updates.ts'

export type Bindings = StoreUpdateBindings & {
  APP_ENV: string
  FIREBASE_PROJECT_ID: string
  GOOGLE_CLIENT_EMAIL: string
  GOOGLE_PRIVATE_KEY: string
  MEDIA: R2Bucket
  ANDROID_APP_CERTS?: string
  IOS_TEAM_ID?: string
  ANDROID_STORE_URL?: string
  IOS_STORE_URL?: string
  ANDROID_LATEST_BUILD?: string
  IOS_LATEST_BUILD?: string
  TESTFLIGHT_LATEST_BUILD?: string
}
type Dependencies = {
  uid: (header: string | undefined, project: string) => Promise<string>
  store: (env: Bindings) => Store
  families: (env: Bindings) => FamilyStore
  content?: (env: Bindings) => FamilyContent
  recentUid?: Dependencies['uid']
}
export type AppEnv = { Bindings: Bindings; Variables: { uid: string } }
const noCache = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const uploadId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const inviteCode = /^[0-9a-f]{32}$/

const parentLabels = ['father', 'mother']
const relativeLabels = ['grandfather', 'grandmother', 'sibling', 'other']

function nickname(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 60 ||
      /[\u0000-\u001f\u007f]/.test(value)) throw new HttpError(400, 'invalid nickname')
  return value.trim()
}

function birthday(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value ||
      value < '1900-01-01') {
    throw new HttpError(400, 'invalid birthday')
  }
  return value
}

async function jsonRecord(request: Request): Promise<Record<string, unknown>> {
  const input: unknown = await request.json().catch(() => null)
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'invalid JSON body')
  }
  return input as Record<string, unknown>
}

// Bound actual bytes even when the declared length is incorrect.
async function readBody(body: ReadableStream<Uint8Array> | null, size: number) {
  if (!body) throw new HttpError(400, 'empty body')
  const result = new Uint8Array(size)
  const reader = body.getReader()
  let offset = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (offset + value.length > size) {
        await reader.cancel()
        throw new HttpError(413, 'upload exceeds declared length')
      }
      result.set(value, offset)
      offset += value.length
    }
  } finally { reader.releaseLock() }
  if (offset !== size) throw new HttpError(400, 'upload length mismatch')
  return result.buffer
}

export function createApp(dependencies: Dependencies) {
  const app = new Hono<AppEnv>()
  app.onError((error, c) => {
    if (error instanceof HttpError) {
      if (error.status === 413 && c.req.path.startsWith('/v0/families/phase0-quota/')) {
        console.warn('Quota test rejected', error.message)
      }
      return c.json({ error: error.message }, error.status, noCache)
    }
    return c.json({ error: 'service unavailable' }, 503, noCache)
  })
  registerInviteLinks(app)
  app.get('/health', c => c.json({ status: 'ok' }, 200, noCache))
  app.get('/app-update', async c => {
    const latestBuild = await latestStoreBuild(c.env, c.req.query('distribution'))
    return c.json({ latestBuild }, 200, noCache)
  })

  const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (c.env.APP_ENV !== 'dev') throw new HttpError(404, 'route disabled')
    c.set('uid', await dependencies.uid(c.req.header('Authorization'), c.env.FIREBASE_PROJECT_ID))
    await next()
  }
  app.use('/v0/*', authenticate)
  app.use('/v1/*', authenticate)
  if (dependencies.content) {
    registerContent(app, dependencies.content, jsonRecord, readBody, dependencies.recentUid)
    registerDeletionPage(app, dependencies.content)
  }
  const smallBody = bodyLimit({
    maxSize: 1024,
    onError: () => { throw new HttpError(413, 'request too large') },
  })
  app.get('/v1/families/current', async c => {
    const family = await dependencies.families(c.env).membership(c.get('uid'))
    return c.json({ family }, 200, noCache)
  })
  app.post('/v1/families', smallBody, async c => {
    const { name, relationship, nickname: memberName, childName, birthday: birth, avatar } = await jsonRecord(c.req.raw)
    const normalized = name === undefined ? '家族のアルバム' : typeof name === 'string' ? name.trim() : ''
    if (!normalized || normalized.length > 60 || /[\u0000-\u001f\u007f]/.test(normalized)) {
      throw new HttpError(400, 'invalid family name')
    }
    const hasProfile = [relationship, memberName, childName, birth, avatar].some(value => value !== undefined)
    if (hasProfile && (typeof relationship !== 'string' || !parentLabels.includes(relationship))) {
      throw new HttpError(400, 'invalid parent relationship')
    }
    const profile = hasProfile ? { relationship: relationship as ParentRelationship,
      nickname: nickname(memberName), childName: nickname(childName), birthday: birthday(birth), avatar: memberAvatar(avatar) } : undefined
    const family = await dependencies.families(c.env).createFamily(c.get('uid'), normalized, profile)
    return c.json({ family }, 201, noCache)
  })
  app.post('/v1/families/:id/invites', smallBody, async c => {
    const { role } = await jsonRecord(c.req.raw)
    const family = c.req.param('id')
    if (!uploadId.test(family) || !inviteRoles.includes(role as InviteRole)) {
      throw new HttpError(400, 'invalid family or invite role')
    }
    const invite = await dependencies.families(c.env).createInvite(c.get('uid'), family, role as InviteRole)
    return c.json(invite, 201, noCache)
  })
  app.post('/v1/families/invite-details', smallBody, async c => {
    const { code } = await jsonRecord(c.req.raw)
    if (typeof code !== 'string' || !inviteCode.test(code)) throw new HttpError(400, 'invalid invite code')
    const store = dependencies.families(c.env)
    if (!store.inviteType) throw new HttpError(503, 'invite details unavailable')
    return c.json({ type: await store.inviteType(c.get('uid'), code) }, 200, noCache)
  })
  app.post('/v1/families/join', smallBody, async c => {
    const { code, relationship, nickname: memberName, avatar } = await jsonRecord(c.req.raw)
    const normalized = typeof code === 'string' ? code.trim().toLowerCase() : ''
    if (!inviteCode.test(normalized)) throw new HttpError(400, 'invalid invite code')
    const hasProfile = relationship !== undefined || memberName !== undefined || avatar !== undefined
    if (hasProfile && (typeof relationship !== 'string' || ![...parentLabels, ...relativeLabels].includes(relationship))) {
      throw new HttpError(400, 'invalid relationship')
    }
    const profile = hasProfile ? { relationship: relationship as JoinProfile['relationship'],
      nickname: nickname(memberName), avatar: memberAvatar(avatar) } : undefined
    const family = await dependencies.families(c.env).joinFamily(c.get('uid'), normalized, profile)
    return c.json({ family }, 200, noCache)
  })
  app.get('/v0/me', c => c.json({ uid: c.get('uid') }, 200, noCache))
  const route = '/v0/families/:family/posts/:post/media/:id'
  function access({ family, post, id }: { family: string; post: string; id: string }, uid: string) {
    if (!idPattern.test(family) || !idPattern.test(post) || !uploadId.test(id)) {
      throw new HttpError(400, 'invalid fixture or upload ID')
    }
    return { family, post, uid }
  }
  app.put(route, async c => {
    const params = c.req.param()
    const scoped = access(params, c.get('uid'))
    const type = c.req.header('Content-Type')
    if (type !== 'image/jpeg' && type !== 'video/mp4') throw new HttpError(415, 'expected JPEG or MP4')
    const length = c.req.header('Content-Length')
    if (!length || !/^\d+$/.test(length)) throw new HttpError(411, 'Content-Length required')
    const size = Number(length)
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_UPLOAD) throw new HttpError(413, 'upload size out of bounds')
    const store = dependencies.store(c.env)
    const body = await readBody(c.req.raw.body, size)
    try {
      validateMedia(body, type)
    } catch (error) {
      if (error instanceof HttpError && error.status === 422) {
        console.warn('Media validation rejected:', error.message)
      }
      throw error
    }
    const media = await store.reserve(scoped, params.id, type, size)
    const written = await c.env.MEDIA.put(media.key, body, {
      onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: type },
    })
    if (!written) throw new HttpError(409, 'object already exists')
    await store.complete(scoped, params.id)
    return c.json({ id: params.id, bytes: size }, 201, noCache)
  })
  app.get(route, async c => {
    const params = c.req.param()
    const media = await dependencies.store(c.env).read(access(params, c.get('uid')), params.id)
    const object = await c.env.MEDIA.get(media.key)
    if (!object || object.size !== media.bytes) throw new HttpError(404, 'media not found')
    return new Response(object.body, { headers: { ...noCache,
      'Content-Type': media.type, 'Content-Length': String(object.size),
    } })
  })
  return app
}
