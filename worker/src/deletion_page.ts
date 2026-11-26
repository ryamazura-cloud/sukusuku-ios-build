import { bodyLimit } from 'hono/body-limit'
import type { Hono } from 'hono'
import type { AppEnv, Bindings } from './app.ts'
import { HttpError } from './domain.ts'
import type { FamilyContent } from './family_content.ts'

const path = '/account-deletion'
const policy = 'https://sukusuku.wisemap.biz/privacy-policy/#account-deletion'
const headers = {
  'Cache-Control': 'private, no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}
const form = `<p>設定画面で保存した削除用コードを入力してください。</p>
<form method="post" action="${path}"><label for="code">削除用コード</label>
<input id="code" name="code" required maxlength="64" autocomplete="off" autocapitalize="off" spellcheck="false">
<button name="action" value="preview">削除内容を確認</button></form>`

function page(content: string) {
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>すくすく｜アカウントとデータの削除</title>
<style>body{background:#f8f1e7;color:#3b2820;font:1rem/1.7 system-ui,sans-serif}main{max-width:36rem;margin:8vh auto;padding:1.5rem}label,input,button{display:block}input,button{font:inherit;margin:.5rem 0 1rem;padding:.6rem}input{width:min(100%,30rem);box-sizing:border-box}button{background:#76513d;color:white;border:0;border-radius:.5rem}a{color:#67432f}</style>
<main><h1>すくすくのアカウントとデータの削除</h1>${content}
<p><a href="${policy}">削除用コードがない場合・プライバシーポリシー</a></p></main></html>`
}

export function registerDeletionPage(app: Hono<AppEnv>, store: (env: Bindings) => FamilyContent) {
  app.get(path, c => c.html(page(form), 200, headers))
  app.post(path, bodyLimit({ maxSize: 512 }), async c => {
    const body = await c.req.parseBody().catch(() => ({} as Record<string, unknown>))
    const code = typeof body.code === 'string' ? body.code.trim().toLowerCase() : ''
    if (!/^[0-9a-f]{64}$/.test(code)) {
      return c.html(page('<p>削除用コードを確認してください。</p>' + form), 400, headers)
    }
    const db = store(c.env)
    try {
      const uid = await db.deletionCodeOwner(code)
      if (body.action === 'delete') {
        const done = await db.retire(uid, c.env.MEDIA, body.closeAlbum === 'yes', code)
        if (done) return c.html(page('<p>アカウントとデータの削除が完了しました。</p>'), 200, headers)
        const nonce = crypto.randomUUID()
        return c.html(page(`<p>データを削除しています。このページを開いたままお待ちください。</p>
<form id="deletion-progress" method="post" action="${path}"><input type="hidden" name="code" value="${code}">
<input type="hidden" name="action" value="delete"><button>削除を続ける</button></form>
<script nonce="${nonce}">setTimeout(() => document.getElementById('deletion-progress').submit(), 400)</script>`), 202, {
          ...headers,
          'Content-Security-Policy': headers['Content-Security-Policy'] + `; script-src 'nonce-${nonce}'`,
        })
      }
      const info = await db.retirementInfo(uid)
      const explanation = info.closesAlbum
        ? 'あなたが最後の管理者のため、ほかの家族の写真・動画・コメントを含むアルバム全体を削除します。'
        : 'あなたのアカウント、プロフィール、投稿・写真・動画・コメント・リアクションを削除します。'
      return c.html(page(`<p>${explanation} 削除したデータは元に戻せません。</p>
<form method="post" action="${path}"><input type="hidden" name="code" value="${code}">
<input type="hidden" name="closeAlbum" value="${info.closesAlbum ? 'yes' : 'no'}">
<button name="action" value="delete">削除を確定する</button></form>`), 200, headers)
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        return c.html(page('<p>削除用コードが無効か、すでに使われています。</p>' + form), 404, headers)
      }
      return c.html(page('<p>削除を完了できませんでした。少し時間をおいて、同じコードでやり直してください。</p>' + form), 503, headers)
    }
  })
}
