import type { Hono } from 'hono'
import type { AppEnv } from './app.ts'

const privacy = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}
const fingerprint = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/
const packageName = 'biz.wisemap.family_share'
const bundleId = 'biz.wisemap.familyShare'

const playStore = 'https://play.google.com/store/apps/details?id=' + packageName

function distributionUrl(value: string | undefined, platform: 'android' | 'ios') {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return undefined
    if (platform === 'android') {
      return url.host === 'play.google.com' ? url.href : undefined
    }
    if (url.host === 'apps.apple.com' ||
        (url.host === 'testflight.apple.com' && /^\/join\/[A-Za-z0-9]+\/?$/.test(url.pathname))) {
      return url.href
    }
  } catch { return undefined }
}

function escapeAttribute(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

function storeLink(value: string | undefined, label: string) {
  return value ? '<a class="button" href="' + escapeAttribute(value) + '">' + label + '</a>' : ''
}

export function registerInviteLinks(app: Hono<AppEnv>) {
  app.get('/.well-known/assetlinks.json', c => {
    const certs = (c.env.ANDROID_APP_CERTS ?? '').split(',').map(s => s.trim().toUpperCase())
      .filter(cert => fingerprint.test(cert))
    return c.json(certs.length ? [{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: packageName, sha256_cert_fingerprints: certs },
    }] : [], 200, privacy)
  })
  app.get('/.well-known/apple-app-site-association', c => {
    const team = c.env.IOS_TEAM_ID ?? ''
    return c.json({ applinks: { details: /^[A-Z0-9]{10}$/.test(team) ? [{
      appIDs: [team + '.' + bundleId], components: [{ '/': '/invite/*' }],
    }] : [] } }, 200, privacy)
  })
  app.get('/invite-open.js', c => c.body(`
const button = document.getElementById('open-app');
const link = new URL(location.href);
if (button && /^\\/invite\\/[a-f0-9]{32}$/.test(link.pathname) && link.protocol === 'https:') {
  const fallback = document.getElementById('android-store').href;
  button.href = 'intent://' + link.host + link.pathname +
    '#Intent;scheme=https;package=biz.wisemap.family_share;S.browser_fallback_url=' +
    encodeURIComponent(fallback) + ';end';
  button.hidden = false;
}
`, 200, { ...privacy, 'Content-Type': 'application/javascript; charset=utf-8' }))

  app.get('/invite/:code', c => {
    if (!/^[a-f0-9]{32}$/.test(c.req.param('code'))) return c.notFound()
    const ua = c.req.header('User-Agent') ?? ''
    const android = /Android/i.test(ua)
    const ios = /iPhone|iPad|iPod/i.test(ua)
    const embedded = /Line\/|FBAN|FBAV|Instagram|;\s*wv\)|MicroMessenger|TikTok/i.test(ua) ||
      (ios && !/Safari\//i.test(ua))
    const androidStore = distributionUrl(c.env.ANDROID_STORE_URL, 'android') ?? playStore
    const iosStore = distributionUrl(c.env.IOS_STORE_URL, 'ios')
    const store = android ? androidStore : ios ? iosStore : undefined
    // A verified HTTPS link is handled by the operating system before requesting this page.
    // In-app browsers may keep it inside their web view, so leave both actions available there.
    if (store && !embedded) {
      return c.body(null, 302, { ...privacy, Location: store, Vary: 'User-Agent' })
    }
    c.header('Vary', 'User-Agent')
    c.header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
    return c.html(`<!doctype html><html lang="ja"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>すくすくへの招待</title><style>body{margin:3rem auto;max-width:32rem;padding:0 1.25rem;font:1rem/1.7 system-ui;background:#f8f2e9;color:#292520}h1{font-size:1.7rem}.button{display:block;margin:.75rem 0;padding:.75rem 1rem;border-radius:1.5rem;background:#794d39;color:white;text-align:center;text-decoration:none;font-weight:600}[hidden]{display:none!important}</style>
<main><h1>すくすくへの招待</h1>
${android ? '<a id="open-app" class="button" hidden>すくすくで開く</a><script src="/invite-open.js" defer></script>' : ''}
${!android ? storeLink(iosStore, iosStore?.startsWith('https://testflight.apple.com/') ? 'TestFlightでインストール' : 'App Storeでインストール') : ''}
${!ios ? '<a id="android-store" class="button" href="' + escapeAttribute(androidStore) + '">Google Playでインストール</a>' : ''}
<p>インストール後、メッセージに届いた元の招待リンクをもう一度開いてください。</p>
<p>インストール済みで開かない場合は、元の招待リンクを長押しして「すくすくで開く」を選んでください。メッセージアプリ内で開いている場合は、リンクをSafariまたはChromeで開くこともできます。</p>
</main></html>`, 200, privacy)
  })
}
