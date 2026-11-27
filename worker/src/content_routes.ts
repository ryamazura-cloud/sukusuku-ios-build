import { bodyLimit } from 'hono/body-limit'
import type { Context, Hono } from 'hono'
import { HttpError, MAX_UPLOAD, validateMedia, type Scope } from './domain.ts'
import type { AppEnv, Bindings } from './app.ts'
import type { FamilyContent, PostInput } from './family_content.ts'

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const chronId = /^[a-z0-9]{10}-[0-9a-f-]{36}$/
const scopes = ['parents', 'all', 'paternal', 'maternal']
const reactions = ['like', 'love', 'cute', 'clap', 'smile', 'flower', 'party', 'heartEyes', 'sparkles', 'hug']
const kinds = ['post', 'comment', 'reaction', 'join']
const small = bodyLimit({ maxSize: 16384, onError: () => { throw new HttpError(413, 'request too large') } })

function ensureId(value: unknown, pattern = uuid): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new HttpError(400, 'invalid identifier')
  return value
}

function text(value: unknown, max: number, empty = false) {
  if (typeof value !== 'string') throw new HttpError(400, 'invalid text')
  const normalized = value.trim()
  if ((!empty && !normalized) || normalized.length > max) throw new HttpError(400, 'invalid text length')
  return normalized
}

function date(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, 'invalid date')
  }
  return value
}

function input(fields: Record<string, unknown>): PostInput {
  const { body, scope, capturedAt, childIds } = fields
  if (typeof scope !== 'string' || !scopes.includes(scope) || !Array.isArray(childIds) || childIds.length > 20) {
    throw new HttpError(400, 'invalid post settings')
  }
  return { body: text(body === undefined ? '' : body, 1200, true), scope: scope as Scope,
    childIds: [...new Set(childIds.map(id => ensureId(id)))], capturedAt: date(capturedAt) }
}

export function registerContent(
  app: Hono<AppEnv>,
  store: (env: Bindings) => FamilyContent,
  json: (request: Request) => Promise<Record<string, unknown>>,
  readBody: (body: ReadableStream<Uint8Array> | null, size: number) => Promise<ArrayBuffer>,
  recentUid?: (header: string | undefined, project: string) => Promise<string>,
) {
  const family = '/v1/families/:family'
  const post = family + '/posts/:post'
  const actor = (c: Context<AppEnv>) => ({ uid: c.get('uid'), family: ensureId(c.req.param('family')) })
  const postId = (c: Context<AppEnv>) => ensureId(c.req.param('post'), chronId)
  const cursor = (c: Context<AppEnv>) => text(c.req.query('cursor') ?? '', 2048, true)
  const db = (c: Context<AppEnv>) => store(c.env)
  const deletionUser = (c: Context<AppEnv>) => recentUid
    ? recentUid(c.req.header('Authorization'), c.env.FIREBASE_PROJECT_ID) : c.get('uid')

  app.use('/v1/*', async (c, next) => {
    if (c.req.path !== '/v1/account') await db(c).requireAccount(c.get('uid'))
    await next()
  })
  app.get('/v1/profile', async c => c.json(await db(c).profile(c.get('uid')), 200, headers))
  app.put('/v1/profile', small, async c => {
    const { name } = await json(c.req.raw)
    return c.json(await db(c).profile(c.get('uid'), text(name, 60)), 200, headers)
  })
  app.get('/v1/account', async c => c.json(await db(c).retirementInfo(c.get('uid')), 200, headers))
  app.put('/v1/account/deletion-code', small, async c => {
    const { code } = await json(c.req.raw)
    await db(c).issueDeletionCode(await deletionUser(c), ensureId(code, /^[0-9a-f]{64}$/))
    return c.json({ ok: true }, 200, headers)
  })
  app.delete('/v1/account', small, async c => {
    const input = c.req.raw.body ? await json(c.req.raw) : {}
    const done = await db(c).retire(await deletionUser(c), c.env.MEDIA, input.closeAlbum === true)
    return done ? c.json({ ok: true }, 200, headers) : c.json({ pending: true }, 202, headers)
  })
  app.get(family + '/members', async c => c.json({ members: await db(c).members(actor(c)) }, 200, headers))
  app.delete(family + '/members/:member', async c => {
    await db(c).removeMember(actor(c), ensureId(c.req.param('member'), /^u-[\w-]{1,700}$/))
    return c.json({ ok: true }, 200, headers)
  })
  app.put(family + '/members/:member/grandparent', small, async c => {
    const { side } = await json(c.req.raw)
    if (side !== 'paternal' && side !== 'maternal') throw new HttpError(400, 'invalid grandparent side')
    const target = ensureId(c.req.param('member'), /^u-[\w-]{1,700}$/)
    await db(c).correctGrandparent(actor(c), target, side)
    return c.json({ ok: true }, 200, headers)
  })
  app.put(family + '/administrator', small, async c => {
    const { successor } = await json(c.req.raw)
    await db(c).transfer(actor(c), ensureId(successor, /^u-[\w-]{1,700}$/))
    return c.json({ ok: true }, 200, headers)
  })
  app.put(family + '/name', small, async c => {
    const { name } = await json(c.req.raw)
    const normalized = text(name, 60)
    await db(c).renameFamily(actor(c), normalized)
    return c.json({ name: normalized }, 200, headers)
  })
  app.put(family + '/children/:id/avatar', small, async c => {
    const { avatar } = await json(c.req.raw)
    const id = ensureId(c.req.param('id'))
    if (avatar !== null) {
      if (typeof avatar !== 'string' || avatar.length > 14000) {
        throw new HttpError(400, 'invalid child avatar')
      }
      let bytes: ArrayBuffer
      try {
        bytes = Uint8Array.from(atob(avatar), char => char.charCodeAt(0)).buffer
      } catch {
        throw new HttpError(400, 'invalid child avatar')
      }
      validateMedia(bytes, 'image/jpeg')
    }
    await db(c).changeChildAvatar(actor(c), id, avatar)
    return c.json({ ok: true }, 200, headers)
  })
  app.get(family + '/children', async c => c.json({ children: await db(c).children(actor(c)) }, 200, headers))
  app.put(family + '/children/:id', small, async c => {
    const { name, birthday } = await json(c.req.raw)
    const day = date(birthday)
    if (day < '1900-01-01') throw new HttpError(400, 'invalid birthday')
    await db(c).changeChild(actor(c), ensureId(c.req.param('id')), { name: text(name, 60), birthday: day })
    return c.json({ ok: true }, 200, headers)
  })
  app.delete(family + '/children/:id', async c => {
    await db(c).changeChild(actor(c), ensureId(c.req.param('id')), null)
    return c.json({ ok: true }, 200, headers)
  })
  app.get(family + '/posts', async c => {
    const child = c.req.query('child')
    return c.json(await db(c).timeline(actor(c), cursor(c), child && ensureId(child)), 200, headers)
  })
  app.get(post, async c => c.json(await db(c).detail(actor(c), postId(c)), 200, headers))
  app.post(family + '/posts', small, async c => {
    const fields = await json(c.req.raw)
    const { media } = fields
    if (!Array.isArray(media) || media.length < 1 || media.length > 10) throw new HttpError(400, 'choose 1–10 attachments')
    const attachments = media.map(item => {
      if (!item || (item.type !== 'image/jpeg' && item.type !== 'video/mp4')) {
        throw new HttpError(415, 'expected JPEG or MP4')
      }
      return { id: ensureId(item.id), type: item.type as 'image/jpeg' | 'video/mp4' }
    })
    if (new Set(attachments.map(item => item.id)).size !== media.length) throw new HttpError(400, 'duplicate attachments')
    return c.json({ id: await db(c).draft(actor(c), input(fields), attachments) }, 201, headers)
  })
  app.put(post + '/media/:id', async c => {
    const scoped = actor(c)
    const id = postId(c)
    const attachment = ensureId(c.req.param('id'))
    const type = c.req.header('Content-Type')
    if (type !== 'image/jpeg' && type !== 'video/mp4') throw new HttpError(415, 'expected JPEG or MP4')
    const length = c.req.header('Content-Length')
    if (!length || !/^\d+$/.test(length)) throw new HttpError(411, 'Content-Length required')
    const size = Number(length)
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_UPLOAD) throw new HttpError(413, 'upload size out of bounds')
    await db(c).checkUpload(scoped, id)
    const bytes = await readBody(c.req.raw.body, size)
    validateMedia(bytes, type, true)
    await db(c).upload(scoped, id, attachment, type, bytes, c.env.MEDIA)
    return c.json({ ok: true }, 200, headers)
  })
  app.get(post + '/media/:id', async c => {
    const { object, type } = await db(c).download(actor(c), postId(c), ensureId(c.req.param('id')), c.env.MEDIA)
    return new Response(object.body, { headers: { ...headers,
      'Content-Type': type, 'Content-Length': String(object.size),
    } })
  })
  app.post(post + '/publish', async c => {
    await db(c).publish(actor(c), postId(c))
    return c.json({ ok: true }, 200, headers)
  })
  app.put(post, small, async c => {
    await db(c).edit(actor(c), postId(c), input(await json(c.req.raw)))
    return c.json({ ok: true }, 200, headers)
  })
  app.delete(post, async c => {
    await db(c).deletePost(actor(c), postId(c), c.env.MEDIA)
    return c.json({ ok: true }, 200, headers)
  })
  app.get(post + '/discussion', async c => c.json(await db(c).discussion(actor(c), postId(c), cursor(c)), 200, headers))
  app.post(post + '/comments', small, async c => {
    const { body } = await json(c.req.raw)
    await db(c).comment(actor(c), postId(c), text(body, 800))
    return c.json({ ok: true }, 201, headers)
  })
  app.put(post + '/comments/:id', small, async c => {
    const { body } = await json(c.req.raw)
    await db(c).comment(actor(c), postId(c), text(body, 800), ensureId(c.req.param('id'), chronId))
    return c.json({ ok: true }, 200, headers)
  })
  app.delete(post + '/comments/:id', async c => {
    await db(c).comment(actor(c), postId(c), null, ensureId(c.req.param('id'), chronId))
    return c.json({ ok: true }, 200, headers)
  })
  app.put(post + '/reactions/:kind', small, async c => {
    const kind = c.req.param('kind') ?? ''
    const { enabled } = await json(c.req.raw)
    if (!reactions.includes(kind) || typeof enabled !== 'boolean') throw new HttpError(400, 'invalid reaction')
    await db(c).react(actor(c), postId(c), kind, enabled)
    return c.json({ ok: true }, 200, headers)
  })
  app.put(post + '/comments/:comment/reactions/:kind', small, async c => {
    const kind = c.req.param('kind') ?? ''
    const { enabled } = await json(c.req.raw)
    if (!reactions.includes(kind) || typeof enabled !== 'boolean') throw new HttpError(400, 'invalid reaction')
    await db(c).reactToComment(actor(c), postId(c), ensureId(c.req.param('comment'), chronId), kind, enabled)
    return c.json({ ok: true }, 200, headers)
  })
  app.get(family + '/notifications', async c => c.json(await db(c).notices(actor(c), cursor(c)), 200, headers))
  app.get(family + '/notification-settings', async c => c.json(await db(c).notificationSettings(actor(c)), 200, headers))
  app.post(family + '/notification-test', async c => {
    await db(c).testNotification(actor(c))
    return c.json({ ok: true }, 200, headers)
  })
  app.put(family + '/notification-settings', small, async c => {
    const { token, fid, preferences } = await json(c.req.raw)
    const useFid = fid !== undefined
    if (useFid && fid !== '' && (typeof fid !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(fid))) {
      throw new HttpError(400, 'invalid installation ID')
    }
    const value = useFid ? fid : token
    if (preferences === undefined) {
      await db(c).refreshNotificationToken(actor(c), text(value, 1024), useFid)
      return c.json({ ok: true }, 200, headers)
    }
    if (!Array.isArray(preferences) || preferences.length > kinds.length ||
        !preferences.every(kind => typeof kind === 'string' && kinds.includes(kind))) {
      throw new HttpError(400, 'invalid preferences')
    }
    return c.json(await db(c).notificationSettings(actor(c), text(value, 1024, true), [...new Set(preferences)], useFid), 200, headers)
  })
}
