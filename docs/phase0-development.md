# Phase 0 開発・検証手順

## 前提

- Flutter 3.47.9 / Dart 3.13.7、Node.js 24 / npm、Android SDKとJDK 17、iOSはmacOSとXcode。Swift Package Manager非対応プラグインがある場合はCocoaPodsも用意します。
- 設定例の識別子は検証用です。AndroidアプリIDは `biz.wisemap.family_share`、iOS Bundle IDは `biz.wisemap.familyShare`。開発・本番はFirebaseプロジェクト、Workers、R2、サービスアカウントを分けます。モバイルのパッケージIDは共通なので、同じ端末に開発・本番を同時インストールする構成は後で決めます。
- Phase 0の試験アカウントはFirebaseコンソールで作るメール・パスワード方式。新規登録画面や本番の認証方式の決定はありません。
- R2が未契約の場合、サブスクリプションの有効化を承認してから進めます。既存の有効なR2を使う場合でも、まず残り無料枠を確認します。

## 開発環境の外部設定

1. Firebaseに開発用プロジェクトを作成し、Spark、Authenticationのメール・パスワード、Cloud Firestore Standardの既定データベースを使います。アプリをAndroidとiOSで登録し、合成データ専用の親・父方祖父母・母方祖父母・未所属のユーザーを作ってUIDを控えます。
2. `firebase/`に移動し、Firebase CLIで `firebase deploy --only firestore:rules --project DEV_PROJECT_ID` を実行します。モバイル用IDトークンで直接Firestoreへアクセスすると拒否され、Workersの専用サービスアカウントはIAMで操作します。
3. 開発プロジェクトに専用のGoogleサービスアカウントを作り、Cloud Datastore User（`roles/datastore.user`）を付与します。現行アプリの通知配信には Firebase Cloud Messaging API Admin（`roles/firebasecloudmessaging.admin`）、アカウント削除には `firebaseauth.users.delete` を含むカスタムロール（または Firebase Authentication Admin）を同じサービスアカウントへ付与します。Firebase Cloud Messaging API を有効にします。開発と本番でアカウントと鍵を共有しません。JSONキーの作成が組織で禁止されている場合は、設定を緩和する前に許可された認証方法を確認してください。
4. CloudflareでStandardバケット `family-share-dev` を作成します。R2公開開発URLとカスタムドメインは無効にします。名前を変更する場合は `worker/wrangler.jsonc` の開発バインディングも合わせ、`env.dev.vars.FIREBASE_PROJECT_ID` を開発プロジェクトIDに置き換えます。
5. `worker/`で `npm install` と `npx wrangler login` を実行します。`npx wrangler secret put GOOGLE_CLIENT_EMAIL --env dev` と `npx wrangler secret put GOOGLE_PRIVATE_KEY --env dev` に、専用鍵の `client_email` と `private_key` を入力します。PEMの改行は実改行・エスケープの両方に対応します。複数行の入力が難しい場合は一時ファイルへPEMを抽出し、Wranglerの標準入力へ渡します。キーはチャット、コミット、画面ログに貼らないでください。
6. `npx wrangler deploy --env dev` を実行して開発用HTTPS URLを控えます。`GET /health` の200は起動確認です。FirestoreとR2の確認には下の送受信試験も必要です。
7. `mobile/config/dev.example.json` を `mobile/config/local.dev.json` にコピーし、API URL（パスなし）、FirebaseプロジェクトID、Sender ID、各OSのApp IDとAPIキーを入力します。Androidでは正しいプロジェクトの `google-services.json` を `mobile/android/app/` に置くとビルド時にネイティブ設定が生成されます。iOSはDartのFirebaseOptionsで初期化します。
8. それぞれの実機で `flutter run --dart-define-from-file=config/local.dev.json` を実行します。GitHub Actionsは実サービスの秘密情報なしでアナライズ・テスト・デバッグビルドを行います。初回の依存取得成功後、`pubspec.lock` と `package-lock.json` をコミットしてください。

## 現行アプリの通知と削除の確認

1. AndroidとiPhoneの新しいビルドで、設定の「通知設定」を開き、「端末に通知する」をオンにして保存します。「テスト通知を送る」で各端末の配信を確認し、別の端末から投稿した場合もOSの通知欄に届くことを確認します。TestFlightには対象iOSアプリの本番APNs認証情報が必要です。
2. テスト専用アルバムで「アカウントとデータの削除」を開き、取り消しと確定、ほかに管理者がいる場合と最後の管理者の場合を確認します。最後の管理者が削除すると、参加者の投稿を含めてアルバムが削除されます。
3. Webからの削除は、テストアカウントで「削除用コードを発行」して控え、アプリをアンインストールした状態でWorkerの `/account-deletion` を開いて確認します。公開中のプライバシーポリシーの削除申請欄へWeb削除のリンクを設置する前に、コードの入力から削除完了までを検証します。

## 更新バナーとアルバム管理の確認

1. WorkerをデプロイしてからAndroid・iPhoneの新しいビルドを配信します。Google PlayとApp Storeの自動同期、TestFlightの手動設定は下記を参照してください。
2. 対応済みの一つ前のビルドでアルバムを開き、バナーから対象の配信先が開くことと、更新後にバナーが消えることを確認します。iOSを手元でTestFlight用にビルドするときは `--dart-define=APP_DISTRIBUTION=testflight` を付けます。CIでは設定済みです。
3. 初回画面と設定の「アプリについて」から、公式サイトのプライバシーポリシーと利用規約が開くことを確認します。旧ビルドからの利用時間送信は、更新済みのWorkerで受け付けません。
4. 管理者は自身以外のメンバーを退出させられます。アカウントや過去の投稿・コメントは保持され、同じアルバムに再参加するには新しい招待コードが必要です。利用者本人がアカウントを削除した場合は、退出済みのアルバムも含めて関連データを削除します。

## Google Play・App Storeの更新番号を自動同期する

開発用Worker（`--env dev`）が30分ごとに配信状況を確認し、取得した番号をR2に保存します。アプリは従来どおり `/app-update` から番号を取得するため、同期を有効にするためのアプリの再ビルドは不要です。

- Google Playは現在の配信先に合わせ、`PLAY_UPDATE_TRACK` を `internal` に設定しています。一般公開に切り替えるときは `production` に変更してください。コードでは選択したトラックの `completed` リリースを採用します。配信トラックの対象資格や実際のストア反映には、利用者ごとの差が出る場合があります。
- App Storeは iOS の配信可能なバージョンに紐づくビルド番号を採用します。ビルド番号は、アプリバージョンを変更した場合も整数の連番で運用してください。
- 設定済みのストアでAPIエラーが続く場合は、最後に確認できた番号を48時間保持し、その後は更新案内を非表示にします。初回同期の完了前、または配信済みビルドを取得できない場合は `0` を返します。API認証を未設定のストアでは従来の手動設定を使います。TestFlightは `TESTFLIGHT_LATEST_BUILD` で管理します。

### 初回の設定

1. Google Cloudで **Google Play Android Developer API** を有効にします。同期専用のサービスアカウントを作成し、Play Consoleの「ユーザーと権限」で、すくすくに対する「アプリ情報の表示（読み取り専用）」を付与します。Play APIで一時編集を開き、トラックを参照後に破棄するため、同アカウントはリリース作業と共用しません。サービスアカウントのメールアドレスと秘密鍵を、Workerの `PLAY_UPDATE_CLIENT_EMAIL`、`PLAY_UPDATE_PRIVATE_KEY` に登録します。
2. App Store Connectの「ユーザとアクセス」→「統合」で、配信情報の参照に使うApp Store Connect APIのチームキーを用意します。Issuer ID、Key ID、`.p8` の内容をそれぞれ `ASC_UPDATE_ISSUER_ID`、`ASC_UPDATE_KEY_ID`、`ASC_UPDATE_PRIVATE_KEY` に登録します。
3. Cloudflareの `family-share-dev` の「設定」→「変数とシークレット」で、上記5項目をシークレットとして設定します。CLIからは `npx.cmd wrangler secret put シークレット名 --env dev` でも登録できます。Workerフォルダで `npx.cmd wrangler deploy --env dev --keep-vars` を実行します。
4. Cron実行後、下記の応答を確認します。Cloudflareのログでは `Store update synchronized` と取得番号を確認できます。

   - [Google Playの現在の番号](https://family-share-dev.wisemap.workers.dev/app-update?distribution=android)
   - [App Storeの現在の番号](https://family-share-dev.wisemap.workers.dev/app-update?distribution=app-store)

## Firestore試験データ

FirebaseコンソールのFirestore画面から、次の文書を作成します。フィールド型は厳密に合わせます。親・祖父母のUIDはFirebase Authenticationが発行したものです。

| パス | フィールド |
| --- | --- |
| `families/phase0` | `fixture` = true（ブール） |
| `families/phase0/members/<親UID>` | `active` = true（ブール）、`role` = `parent`（文字列） |
| `families/phase0/members/<父方UID>` | `active` = true、`role` = `grandparent`、`side` = `paternal` |
| `families/phase0/members/<母方UID>` | `active` = true、`role` = `grandparent`、`side` = `maternal` |
| `families/phase0/posts/family` | `phase0Fixture` = true（ブール）、`scope` = `all`（文字列） |
| `families/phase0/posts/parents` | `phase0Fixture` = true、`scope` = `parents` |
| `families/phase0/posts/father` | `phase0Fixture` = true、`scope` = `paternal` |
| `families/phase0/posts/mother` | `phase0Fixture` = true、`scope` = `maternal` |

未所属アカウントのメンバー文書は作りません。Phase 0で `admin` を検証する場合は親を兼ねる試験アカウントにのみ設定します。容量カウンターとメディア文書はWorkerが作成します。月区切りは試験用にUTC、単位は十進バイトです。

## 受け入れテスト

1. 画像・動画は、実際の家族や個人が含まれない色見本やテストパターンを使います。FFmpegが使える場合は次の素材を作り、各端末の写真ライブラリに取り込みます。
   
   ```sh
   ffmpeg -f lavfi -i testsrc2=size=1920x1080:rate=1 -frames:v 1 -update 1 fixture.jpg
   ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=30 -t 5 -c:v libx264 -pix_fmt yuv420p -movflags +faststart fixture.mp4
   ffmpeg -f lavfi -i testsrc2=size=320x180:rate=10 -t 61 -c:v libx264 -pix_fmt yuv420p fixture-over-60s.mp4
   ```
2. 親でログインし、「認証を確認」を実行します。合成画像と5秒動画をそれぞれ圧縮して送受信し、元と圧縮後の容量・動画時間・取得バイト一致を記録します。61秒動画が端末で拒否されることを確認します。iOS・Androidそれぞれで再生テストも実施します。
3. メディアIDを使い、`GET /v0/families/phase0/posts/<投稿ID>/media/<メディアID>` を確認します。Authorizationに同一プロジェクトの試験ユーザーのFirebase IDトークンを指定します。試験ユーザーのトークンはFirebase Auth SDKかIdentity Toolkitの `accounts:signInWithPassword` で取得できます。端末やPCの履歴にトークンを残さないでください。未認証・別プロジェクトは401、未所属・対象外の祖父母は403、共有範囲内は200です。祖父母のPUTは403です。R2の公開URLから直接取得できないことも確認します。
4. 使い捨て家族データで quota/storage または quota/当月のbytesを閾値直前に設定し、上限内は201、超過は413、同一メディアIDの再送は409になることを確認します。並行するアップロードは保存容量と月間容量を同じFirestoreトランザクションで予約します。予約後に異常が起きると保守的に予約を残し、未完了メディアは返しません。試験中に発生した予約残はWorkerを停止し、開発用データだけを対象にR2とFirestoreを照合して整理します。
5. AndroidはGoogle Play開発者サービスのある実機を使います。iOSはXcodeでRunnerのSigning Teamを指定し、対象Bundle IDのPush Notificationsを使える署名プロファイルを用意します。FirebaseのiOSアプリ設定で対応するAPNsキーを登録します。Push Notificationsの署名用entitlementとBackground Modesのremote-notificationを設定済みです。Phase 0のiOS entitlementは開発用です。Firebaseのメソッドスウィズリングは有効のままにします。
6. アプリで通知を許可し、FCMトークン取得後に開発用Firebaseコンソールのテスト送信を実行します。前景はアプリのステータス表示、背景はOSの通知欄で確認します。通知は個人情報を含まない短いダミー文面を使います。トークンをファイルに保存する必要はありません。

## 無料枠と技術課題

| サービス | 無料で使える目安 |
| --- | --- |
| Firebase Spark | 通常のメール・パスワード認証とFCMは無償。Firestoreは1 GiB、読取5万件/日、書込2万件/日、削除2万件/日、外向き転送10 GiB/月（無料枠の対象データベース）。 |
| Workers Free | 10万リクエスト/日、CPU 10 ms/リクエスト、メモリ128 MB。実際のJWT処理、複数のFirestore往復、16 MBの本体処理の負荷計測が必要。 |
| R2 Standard | 10 GB-month、Class A 100万/月、Class B 1,000万/月、外向き転送無料。開発・本番のアカウント合算と超過請求に注意。 |

小規模な検証は無料枠内を想定しています。運用の0円保証には、実測に基づくアカウント全体の容量や操作数の制御が必要です。家族ごとの5 GB制限だけでは合計10 GB-month以内を維持できません。App StoreとGoogle Playの開発者アカウント費用はサーバー利用料と別です。

試験用ファイル上限は16 MBです。JPGはシグネチャ、MP4は非断片化コンテナのムービーヘッダーで時間を確認しています。原本をフォールバック送信する経路はありません。実機でのコーデック・HEIC・回転・音声・EXIFと動画メタデータ、端末圧縮後のMP4互換性、Workers CPUとメモリ、実際のFirestoreトランザクション動作は未検証です。公開前に実体ファイル検証、失敗した予約の回収、認証失効と削除、動画のRange配信を検証・整備します。

- [Firebase料金](https://firebase.google.com/pricing)
- [Firebase IDトークン](https://firebase.google.com/docs/auth/admin/verify-id-tokens)
- [Cloud Firestore REST API](https://firebase.google.com/docs/firestore/use-rest-api)
- [Flutter向けFCM](https://firebase.google.com/docs/cloud-messaging/flutter/get-started)
- [Workers実行制限](https://developers.cloudflare.com/workers/platform/limits/)
- [R2料金](https://developers.cloudflare.com/r2/pricing/)
- [R2有効化](https://developers.cloudflare.com/r2/get-started/)

## Phase 0から先へ進む条件

Androidデバッグビルド、iOS署名なしビルド、両実機の圧縮・FCM、実サービスを通した認証・権限・容量予約・R2送受信を確認します。その後に家族作成・招待、子供プロフィール、タイムライン、投稿と共有範囲に着手します。コメント・いいね・スタンプ・祖父母の端末保存と複数家族所属は後続Phaseで実装し、一般公開前に受け入れ確認します。
