import { Hono } from 'hono'
import { HttpError, MAX_UPLOAD, validateMedia } from './domain.ts'
import type { Store } from './firestore.ts'

export type Bindings = {
  APP_ENV: string
  FIREBASE_PROJECT_ID: string
  GOOGLE_CLIENT_EMAIL: string
  GOOGLE_PRIVATE_KEY: string
  MEDIA: R2Bucket
}
type Dependencies = {
  uid: (header: string | undefined, project: string) => Promise<string>
  store: (env: Bindings) => Store
}
const noCache = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const uploadId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

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
  const app = new Hono<{ Bindings: Bindings; Variables: { uid: string } }>()
  app.onError((error, c) => {
    if (error instanceof HttpError) {
      if (error.status === 413 && c.req.path.startsWith('/v0/families/phase0-quota/')) {
        console.warn('Quota test rejected', error.message)
      }
      return c.json({ error: error.message }, error.status, noCache)
    }
    return c.json({ error: 'service unavailable' }, 503, noCache)
  })
  app.get('/health', c => c.json({ status: 'ok' }, 200, noCache))

  app.use('/v0/*', async (c, next) => {
    if (c.env.APP_ENV !== 'dev') throw new HttpError(404, 'route disabled')
    c.set('uid', await dependencies.uid(c.req.header('Authorization'), c.env.FIREBASE_PROJECT_ID))
    await next()
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
