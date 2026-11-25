# WindowsからiPhoneでPhase 0を確認する

GitHub ActionsのmacOSランナーが署名・ビルド・アップロードを行います。iPhoneにはApp Store Connectの内部TestFlightグループからインストールします。アプリの接続先はAndroid試験と同じ開発環境です。

## Apple側の準備

1. Apple Developerの「Certificates, IDs & Profiles → Identifiers」で、Bundle ID `biz.wisemap.familyShare` のApp IDを確認し、Push Notificationsを有効にします。
2. App Store Connectの「マイApp → ＋ → 新規App」でiOSを選択し、同じBundle IDで新規アプリレコードを作成します。アプリ名とSKUは利用者が指定します。
3. 同じチームの有効なApple Distribution証明書と秘密鍵を含む `.p12` を用意します。すでに持っている同じチームの配布証明書を使えます。このApp ID用のApp Store Connect配布プロファイルを作り、その証明書を選択します。Push Notifications有効化後のプロファイルを使用します。
4. App Store Connectのアップロード権限を持つチームAPIキーのKey ID、Issuer ID、対応する `.p8` を用意します。これは通知用のAPNsキーと別です。
5. Firebaseの開発プロジェクト `photoshare-e1336` の「プロジェクトの設定 → Cloud Messaging」で対象iOSアプリを開き、**本番APNsに対応した**認証キーとKey ID、Team IDを登録します。TestFlightビルドは本番APNsを使います。

## GitHub側の準備

最新版のプロジェクトを、自分のGitHubリポジトリの既定ブランチに登録してください。GitHub Actionsの利用可能枠を先に確認してください。

「Settings → Environments」で `ios-testflight-dev` を作り、次を登録します。

| 種類 | 名前 | 内容 |
| --- | --- | --- |
| Variable | `APPLE_TEAM_ID` | Apple DeveloperのTeam ID |
| Secret | `IOS_DEV_CONFIG_BASE64` | 動作確認済みの `mobile/config/local.dev.json` をBase64に変換した値 |
| Secret | `BUILD_CERTIFICATE_BASE64` | Apple Distributionの `.p12` をBase64に変換した値 |
| Secret | `P12_PASSWORD` | `.p12` のパスワード |
| Secret | `BUILD_PROVISION_PROFILE_BASE64` | このアプリのApp Store Connect用 `.mobileprovision` をBase64に変換した値 |
| Secret | `ASC_KEY_ID` | App Store Connect APIのKey ID |
| Secret | `ASC_ISSUER_ID` | App Store Connect APIのIssuer ID |
| Secret | `ASC_PRIVATE_KEY_BASE64` | 上記APIキーの `.p8` をBase64に変換した値 |

Windows PowerShellでは、たとえば次の1行で設定ファイルのBase64をクリップボードにコピーできます。各バイナリファイルもパスを置き換えて同様に変換し、対応するGitHub Secret欄へ直接貼り付けます。

```powershell
Set-Clipboard -Value ([Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\workspace\family-share-android\mobile\config\local.dev.json')))
```

`local.dev.json` の `APP_ENV` は `dev`、Firebaseプロジェクトは `photoshare-e1336`、Workerは `https://family-share-dev.wisemap.workers.dev` です。iOS App ID、iOS APIキー、Sender IDが必要です。`.p12`、`.p8`、プロファイル、個別設定はコミットせず、上のSecretを使ってください。

## 実行と受け入れ

1. GitHubの「Actions → Phase 0 iPhone TestFlight → Run workflow」で、未使用のビルド番号を指定します。このワークフローはApp Store Connectにアップロードします。
2. App Store Connectで処理が終わったら、TestFlightの内部テストグループにビルドと自分のアカウントを追加します。iPhoneのTestFlightからインストールします。
3. 親アカウントでログインして「認証を確認」を押し、家族ID `phase0`、投稿ID `family` で合成JPEGと短い合成動画を送受信します。どちらも「取得データが一致しました」と表示されればOKです。
4. iPhoneで通知を許可し、iPhoneで取得したFCMトークンを使ってFirebaseのテスト通知を送ります。アプリを表示中は画面の受信メッセージ、ホームに戻った状態では通知欄を確認します。
