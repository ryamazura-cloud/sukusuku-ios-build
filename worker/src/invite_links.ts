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

function storeLink(value: string | undefined, host: string, label: string) {
  if (!value) return ''
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.host !== host || url.username || url.password) return ''
    const link = url.href.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
    return '<p><a href="' + link + '">' + label + '</a></p>'
  } catch { return '' }
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
  app.get('/invite/:code', c => {
    if (!/^[a-f0-9]{32}$/.test(c.req.param('code'))) return c.notFound()
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
    return c.html(`<!doctype html><html lang="ja"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>すくすくへの招待</title><style>body{margin:3rem auto;max-width:32rem;padding:0 1.25rem;font:1rem/1.7 system-ui;background:#f8f2e9;color:#292520}h1{font-size:1.7rem}a{color:#842a16}</style>
<main><h1>すくすくへの招待</h1><p>すくすくをインストールしてから、メッセージに届いた招待リンクをもう一度開いてください。</p>
${storeLink(c.env.IOS_STORE_URL, 'apps.apple.com', 'App Storeで開く')}
${storeLink(c.env.ANDROID_STORE_URL, 'play.google.com', 'Google Playで開く')}
<p>アプリが開かない場合は、招待リンクを長押しして「すくすくで開く」を選ぶか、ブラウザで開いてからアプリへ切り替えてください。</p>
</main></html>`, 200, privacy)
  })
}
