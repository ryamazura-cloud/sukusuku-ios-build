import { GoogleAccess, encodeJson, encode, decodePem } from './google.ts'
import type { Bindings } from './app.ts'

const playApp = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/biz.wisemap.family_share'
const appleApi = 'https://api.appstoreconnect.apple.com'
const appleVersions = '/v1/apps/6839227117/appStoreVersions'
const maxSnapshotAge = 48 * 60 * 60 * 1000

export type StoreUpdateBindings = {
  PLAY_UPDATE_TRACK?: string
  PLAY_UPDATE_CLIENT_EMAIL?: string
  PLAY_UPDATE_PRIVATE_KEY?: string
  ASC_UPDATE_ISSUER_ID?: string
  ASC_UPDATE_KEY_ID?: string
  ASC_UPDATE_PRIVATE_KEY?: string
}

function buildNumber(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return
  if (!/^[1-9]\d*$/.test(String(value))) return
  const number = Number(value)
  if (Number.isSafeInteger(number)) return number
}

async function storeRequest(url: string, token: string, method = 'GET') {
  return fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: method === 'POST' ? '{}' : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  })
}

async function storeJson<T>(url: string, token: string, method = 'GET'): Promise<T> {
  const response = await storeRequest(url, token, method)
  if (!response.ok) throw new Error('Store API HTTP ' + response.status)
  return response.json<T>()
}

type PlayRelease = { status?: string; versionCodes?: string[] }

export async function playBuild(track: string, token: string) {
  const edit = await storeJson<{ id?: string }>(playApp + '/edits', token, 'POST')
  if (!edit.id || !/^[\w-]+$/.test(edit.id)) throw new Error('Invalid Play edit ID')
  const editUrl = playApp + '/edits/' + edit.id
  try {
    const data = await storeJson<{ track?: string; releases?: PlayRelease[] }>(
      editUrl + '/tracks/' + encodeURIComponent(track), token,
    )
    if (data.track !== track) throw new Error('Unexpected Play track')
    let latest = 0
    for (const release of data.releases ?? []) {
      if (release.status !== 'completed') continue
      for (const code of release.versionCodes ?? []) {
        const build = buildNumber(code)
        if (build === undefined) throw new Error('Invalid Play version code')
        latest = Math.max(latest, build)
      }
    }
    return latest
  } finally {
    try {
      const response = await storeRequest(editUrl, token, 'DELETE')
      if (!response.ok && response.status !== 404) throw new Error('HTTP ' + response.status)
    } catch {
      console.warn('Could not discard the read-only Play edit')
    }
  }
}

async function appleToken(env: Bindings) {
  const now = Math.floor(Date.now() / 1000)
  const jwt = encodeJson({ alg: 'ES256', kid: env.ASC_UPDATE_KEY_ID, typ: 'JWT' }) + '.' + encodeJson({
    iss: env.ASC_UPDATE_ISSUER_ID, iat: now, exp: now + 300, aud: 'appstoreconnect-v1',
  })
  const key = await crypto.subtle.importKey('pkcs8', decodePem(env.ASC_UPDATE_PRIVATE_KEY!),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(jwt))
  return jwt + '.' + encode(new Uint8Array(signature))
}

type AppleResource = {
  id: string
  type: string
  attributes?: { appVersionState?: string; appStoreState?: string; downloadable?: boolean; version?: string }
  relationships?: { build?: { data?: { id: string } | null } }
}

export async function appleBuild(token: string) {
  const first = new URL(appleVersions, appleApi)
  first.search = new URLSearchParams({
    'filter[platform]': 'IOS',
    'fields[appStoreVersions]': 'appVersionState,appStoreState,downloadable,build',
    'fields[builds]': 'version', include: 'build', limit: '50',
  }).toString()
  let next: string | undefined = first.href
  let latest = 0
  const pages = new Set<string>()
  while (next) {
    const url: URL = new URL(next, appleApi)
    if (url.origin !== appleApi || url.pathname !== appleVersions || pages.has(url.href) || pages.size >= 10) {
      throw new Error('Invalid App Store pagination')
    }
    pages.add(url.href)
    const page = await storeJson<{ data: AppleResource[]; included?: AppleResource[]; links?: { next?: string } }>(url.href, token)
    for (const version of page.data) {
      const state = version.attributes
      const released = state?.appVersionState === 'READY_FOR_DISTRIBUTION' ||
        (!state?.appVersionState && state?.appStoreState === 'READY_FOR_SALE')
      if (!released || state?.downloadable === false) continue
      const id = version.relationships?.build?.data?.id
      const build = page.included?.find(item => item.type === 'builds' && item.id === id)
      const number = buildNumber(build?.attributes?.version)
      if (number === undefined) throw new Error('App Store release needs an integer build number')
      latest = Math.max(latest, number)
    }
    next = page.links?.next
  }
  return latest
}

function snapshotKey(env: Bindings, distribution: string | undefined) {
  if (distribution === 'android' && env.PLAY_UPDATE_TRACK && env.PLAY_UPDATE_CLIENT_EMAIL && env.PLAY_UPDATE_PRIVATE_KEY) {
    return 'internal/store-updates/play-' + env.PLAY_UPDATE_TRACK + '.json'
  }
  if (distribution === 'app-store' && env.ASC_UPDATE_ISSUER_ID && env.ASC_UPDATE_KEY_ID && env.ASC_UPDATE_PRIVATE_KEY) {
    return 'internal/store-updates/app-store.json'
  }
}

export async function latestStoreBuild(env: Bindings, distribution: string | undefined) {
  const key = snapshotKey(env, distribution)
  if (key) {
    try {
      const state = await (await env.MEDIA.get(key))?.json<{ build: number; checkedAt: number }>()
      if (!state || !Number.isFinite(state.checkedAt) || Date.now() - state.checkedAt > maxSnapshotAge) return 0
      return buildNumber(state.build) ?? 0
    } catch {
      return 0
    }
  }
  const manual = distribution === 'android' ? env.ANDROID_LATEST_BUILD
    : distribution === 'app-store' ? env.IOS_LATEST_BUILD
    : distribution === 'testflight' ? env.TESTFLIGHT_LATEST_BUILD : undefined
  return buildNumber(manual) ?? 0
}

export async function syncStoreBuilds(env: Bindings) {
  async function sync(distribution: 'android' | 'app-store', check: () => Promise<number>) {
    const key = snapshotKey(env, distribution)
    if (!key) return
    try {
      const build = await check()
      await env.MEDIA.put(key, JSON.stringify({ build, checkedAt: Date.now() }))
      console.info('Store update synchronized', distribution, build)
    } catch (error) {
      console.warn('Store update synchronization failed', distribution, error instanceof Error ? error.message : 'unknown error')
      throw error
    }
  }
  const results = await Promise.allSettled([
    sync('android', async () => {
      const access = new GoogleAccess({ email: env.PLAY_UPDATE_CLIENT_EMAIL!, key: env.PLAY_UPDATE_PRIVATE_KEY! },
        'https://www.googleapis.com/auth/androidpublisher')
      return playBuild(env.PLAY_UPDATE_TRACK!, await access.token())
    }),
    sync('app-store', async () => appleBuild(await appleToken(env))),
  ])
  if (results.some(result => result.status === 'rejected')) throw new Error('Store synchronization incomplete')
}

