# 家族向け写真・動画共有 | Phase 0

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

Phase 0の試験用APIは開発環境に限定し、Firestoreで明示的に用意した試験投稿だけを処理します。対象素材は合成メディアです。一般公開用のルート、招待・タイムライン・リアクションの実装はPhase 0の接続と実機検証が済んでから着手します。
