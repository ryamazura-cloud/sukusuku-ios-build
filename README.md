# すくすく | 家族向け写真・動画共有

Flutterの検証アプリとCloudflare Workers APIをひとつのリポジトリで管理します。開発環境で合成画像・動画を使い、認証、共有範囲、アップロードと取得、通知を検証します。

| ディレクトリ | 内容 |
| --- | --- |
| `mobile/` | iOS・Android、Riverpod、GoRouter、共通テーマ、認証、端末圧縮、FCM |
| `worker/` | Hono、Firebase IDトークン検証、Firestore REST、非公開R2、容量予約 |
| `firebase/` | Flutterからの直接アクセスを全面拒否するFirestoreルール |
| `.github/workflows/` | Workersの型検査・テスト・バンドル、Android・iOSのビルドCI |

[環境構築と検証手順](docs/phase0-development.md)

## ローカルで再現できるテスト

Node.js 24があればリポジトリ直下で実行できます。

```sh
node --test worker/test/domain.test.ts worker/test/google.test.ts worker/test/firestore.test.ts
```

レジストリに接続できる環境で、WorkersとFlutterの依存取得後に完全なチェックを実行します。

```sh
cd worker
npm install
npm run types
npm run check
npm test
cd ../mobile
flutter pub get
flutter analyze
flutter test
```

## Phase 1の家族作成・招待を開発環境で確認する

1. `worker/` の更新版を開発環境にデプロイし、同じ開発用FirebaseプロジェクトとWorkers URLでアプリをビルドする。
2. 所属先のない開発用Firebaseアカウントでログインし、家族を作成する。
3. 管理者画面で招待先（親・父方の祖父母・母方の祖父母）を選び、招待コードをコピーする。
4. 別の開発用アカウントでコードを入力し、家族名と招待された権限を確認する。

招待コードは24時間有効で、1アカウントにだけ使用できます。現段階では1アカウントにつき1家族、1家族につき最大10人です。参加に使用するログインアカウントは開発用Firebaseで用意します。

写真・動画の技術検証は家族画面下部の「Phase 0 技術検証」から開けます。Phase 0の試験用APIは開発環境に限定し、Firestoreで明示的に用意した試験投稿だけを処理します。対象素材は合成メディアです。

## 家族内テスト用の主要機能

現在の開発ビルドでは、メール登録・パスワード再設定、家族招待、子どものプロフィール、写真・動画の投稿とタイムライン、閲覧範囲、投稿単位のコメント・リアクション、通知を使えます。ファイルは従来の非公開R2バケットに保存されます。

- 開発用Firebaseのメール・パスワード認証を有効にし、アプリとWorkerに同じ開発用プロジェクトを設定してください。
- 端末への通知は、お知らせ画面で有効にします。Workerのサービスアカウントには、既存のFirestore権限に加えてFCMの送信権限（`cloudmessaging.messages.create`）が必要です。アプリ内の通知履歴は端末へのプッシュを無効にしても利用できます。
- 写真・動画は、投稿の公開が完了してから家族のタイムラインに表示されます。端末に取り出す場合はメディア詳細の「保存・共有」を使います。
- 管理者の退会には別の親への引き継ぎが必要です。退会時は本人の投稿・添付メディア・他の投稿へのコメントとリアクションを削除します。削除処理が中断した場合は、同じアカウント設定から再実行できます。

## 招待リンク版を開発環境で確認する

1. Firebase Authenticationのログイン方法で「匿名」を有効にします。新規インストール後はアルバム作成または招待参加のときに匿名認証を開始します。
2. `worker/` で `npx wrangler deploy --env dev` を実行します。開発APK用の署名フィンガープリントは `ANDROID_APP_CERTS` に設定済みです。別署名のAPKやGoogle Play配信では、対応するフィンガープリントを登録します。
3. iOSを配布する場合は、Apple Developerの対象App IDでAssociated Domainsを有効にし、App Store Connect用プロファイルを再生成します。Workerの開発環境に `IOS_TEAM_ID` として既存の `APPLE_TEAM_ID` と同じ値を設定してからデプロイします。
4. アルバム作成後、アルバム画面の設定から招待リンクを発行します。別の未参加端末でメッセージからリンクを開きます。未インストール端末では、アプリをインストールしたあと、元のリンクを再度開きます。
5. 発行したリンクの閲覧範囲と実際の表示、再起動後に直接アルバムが開くことを確認します。

公開ストアで配信するときはWorkerの `IOS_STORE_URL` と `ANDROID_STORE_URL` に公開済みの掲載URLを設定できます。親用と閲覧用の招待は管理者のみ発行でき、1人が1回、24時間以内に使用できます。機種変更後は稼働中の管理者から新しい招待を受けます。唯一の管理者が端末を変更する場合、旧端末を手放す前に別の親へ管理を移せます。
## 内部テスト配信

Android と iOS のテストビルドは開発用 Worker と Firebase を使用します。

### Google Play

- アプリのパッケージ名は `biz.wisemap.family_share` です。初回の AAB は Play Console の「テスト > 内部テスト」からアップロードし、Play App Signing の設定後、テスター用のリリースを作成します。
- GitHub Actions の **Android Play Internal AAB** で、署名済みの AAB を生成できます。GitHub の `android-play-internal` 環境に、開発用 Android 設定 JSON の Base64 を `ANDROID_DEV_CONFIG_BASE64`、アップロード用 PKCS#12 の Base64 を `ANDROID_UPLOAD_KEYSTORE_BASE64`、パスワードを `ANDROID_UPLOAD_PASSWORD` として登録します。キーストアの別名は `sukusuku-upload` です。アップロードごとにバージョンコードを増やします。
- Play Console の「アプリの署名鍵の証明書」の SHA-256 を取得したら、`worker/wrangler.jsonc` の開発環境の `ANDROID_APP_CERTS` に既存値に続けてカンマ区切りで追加し、Worker を再デプロイします。Play 経由で入れたアプリで、届いた招待リンクから参加フォームが開くことを確認します。

### TestFlight

- アプリの Bundle ID は `biz.wisemap.familyShare` です。GitHub Actions の **iPhone TestFlight** を既定ブランチで実行し、App Store Connect で使用済みの番号より大きいビルド番号を指定します。
- `ios-testflight-dev` 環境には、変数 `APPLE_TEAM_ID` と、Secrets の `IOS_DEV_CONFIG_BASE64`、`BUILD_CERTIFICATE_BASE64`、`P12_PASSWORD`、`BUILD_PROVISION_PROFILE_BASE64`、`ASC_KEY_ID`、`ASC_ISSUER_ID`、`ASC_PRIVATE_KEY_BASE64` が必要です。配布プロファイルは Push Notifications と Associated Domains の両方を有効にします。
- Action が署名済み IPA を App Store Connect に送信します。処理が完了したら TestFlight の内部グループに追加します。Worker の `IOS_TEAM_ID` が正しいことを確認し、TestFlight 版でも招待リンクの起動を確認します。
