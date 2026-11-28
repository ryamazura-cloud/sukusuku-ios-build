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
const appStore = 'https://apps.apple.com/app/id6839227117'

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

function storeLink(id: string, value: string, label: string) {
  return '<a class="button store" id="' + id + '" href="' + escapeAttribute(value) + '">' + label + '</a>'
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
const iosButton = document.getElementById('open-ios');
const copy = document.getElementById('copy-invite');
const link = new URL(location.href);
if (copy && navigator.clipboard && /^\\/invite\\/[a-f0-9]{32}$/.test(link.pathname) && link.protocol === 'https:') {
  copy.hidden = false;
  copy.addEventListener('click', async () => {
    const status = document.getElementById('copy-status');
    try {
      await navigator.clipboard.writeText(link.origin + link.pathname);
      status.textContent = 'コピーしました。メッセージなどに貼り付け、そのリンクを開いてください。';
    } catch {
      status.textContent = 'コピーできませんでした。メッセージに届いた元の招待リンクを長押ししてコピーしてください。';
    }
  });
}
if (button && /^\\/invite\\/[a-f0-9]{32}$/.test(link.pathname) && link.protocol === 'https:') {
  const fallback = document.getElementById('android-store').href;
  button.href = 'intent://' + link.host + link.pathname +
    '#Intent;scheme=https;package=biz.wisemap.family_share;S.browser_fallback_url=' +
    encodeURIComponent(fallback) + ';end';
  button.hidden = false;
}
if (iosButton && /^\\/invite\\/[a-f0-9]{32}$/.test(link.pathname) && link.protocol === 'https:') {
  iosButton.href = 'sukusuku://app' + link.pathname;
  iosButton.hidden = false;
}
`, 200, { ...privacy, 'Content-Type': 'application/javascript; charset=utf-8' }))

  app.get('/invite/:code', c => {
    if (!/^[a-f0-9]{32}$/.test(c.req.param('code'))) return c.notFound()
    const ua = c.req.header('User-Agent') ?? ''
    const android = /Android/i.test(ua)
    const ios = /iPhone|iPad|iPod/i.test(ua)
    const androidStore = distributionUrl(c.env.ANDROID_STORE_URL, 'android') ?? playStore
    const iosStore = distributionUrl(c.env.IOS_STORE_URL, 'ios') ?? appStore
    const iosStoreLabel = iosStore.startsWith('https://testflight.apple.com/')
      ? 'TestFlightでインストール'
      : 'Apple Storeでインストール'
    c.header('Vary', 'User-Agent')
    c.header('Content-Security-Policy', "default-src 'none'; img-src 'self'; script-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
    return c.html(`<!doctype html><html lang="ja"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>すくすくへの招待</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#e8d9c5;color:#392920;font:1rem/1.55 system-ui,sans-serif}
main{max-width:28rem;min-height:100vh;min-height:100svh;margin:auto;padding:24px 24px max(20px,env(safe-area-inset-bottom));display:flex;flex-direction:column;align-items:center;text-align:center}
.brand{display:flex;align-items:center;justify-content:center;gap:12px;font-size:1.65rem;font-weight:750}
.brand img{border-radius:12px}
h1{margin:12px 0 4px;font-size:2rem;letter-spacing:.08em}
p{margin:0}
.collage{display:block;width:min(100%,20rem);height:auto;margin:auto 0;box-sizing:content-box;padding:18px 0}
.actions{width:100%;display:grid;gap:9px}
.button{display:grid;place-items:center;min-height:48px;padding:8px 14px;border:1px solid #825a46;border-radius:26px;background:#784e3b;color:#fff;font-weight:650;text-decoration:none}
.store{background:#fcf4e7;color:#624332}
.copy{border:0;background:none;color:#624332;font:inherit;font-size:.875rem;padding:5px;min-height:32px;text-decoration:underline;cursor:pointer}
.help,#copy-status{color:#624332;font-size:.75rem}
#copy-status:empty{display:none}
a:focus-visible,button:focus-visible{outline:3px solid #51382a;outline-offset:2px}
[hidden]{display:none!important}
</style>
<main>
<header><div class="brand"><img src="/invite-art/app-icon.png" width="48" height="48" alt="">すくすく</div><h1>招待状</h1><p>家族のアルバムに招待されました。</p></header>
<img class="collage" src="/invite-art/family-collage.jpg" width="860" height="860" alt="家族の思い出の写真">
<div class="actions">
${android ? '<a id="open-app" class="button" hidden>すくすくで開く</a>' : ''}
${ios ? '<a id="open-ios" class="button" hidden>すくすくで開く</a>' : ''}
${!android ? storeLink('ios-store', iosStore, iosStoreLabel) : ''}
${!ios ? storeLink('android-store', androidStore, 'Google Playでインストール') : ''}
<button id="copy-invite" class="copy" type="button" hidden>招待リンクをコピー</button>
<p id="copy-status" role="status"></p>
<p class="help">インストール後は、家族から届いた元の招待リンクをもう一度開いてください。アプリが開かないときは、SafariまたはChromeで開いてから「すくすくで開く」を押してください。</p>
</div>
<script src="/invite-open.js" defer></script>
</main></html>`, 200, privacy)
  })
}
