import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'app/config.dart';
import 'app/theme.dart';
import 'features/family/album_entry.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final config = AppConfig.fromBuild();
  final options = config?.firebaseOptions();
  if (config == null || options == null) {
    runApp(const SetupMessage('開発環境のFirebase設定を読み込んでください。'));
    return;
  }
  if (config.environment != 'dev') {
    runApp(const SetupMessage('このビルドは開発環境で利用できます。'));
    return;
  }
  try {
    final app = await Firebase.initializeApp(options: options);
    if (app.options.projectId != options.projectId ||
        app.options.appId != options.appId) {
      runApp(const SetupMessage('端末のFirebase設定とビルド設定が一致しません。'));
      return;
    }
  } on FirebaseException catch (_) {
    runApp(const SetupMessage('Firebaseを初期化できませんでした。'));
    return;
  }
  runApp(ProviderScope(child: FamilyApp(config)));
}

class SetupMessage extends StatelessWidget {
  const SetupMessage(this.message, {super.key});
  final String message;
  @override
  Widget build(BuildContext context) => MaterialApp(
    theme: familyTheme(),
    home: Scaffold(
      body: Center(
        child: Padding(padding: const EdgeInsets.all(24), child: Text(message)),
      ),
    ),
  );
}

final routerProvider = Provider.family<GoRouter, AppConfig>((ref, config) {
  final router = GoRouter(
    routes: [
      GoRoute(path: '/', builder: (_, _) => AlbumEntry(config.api)),
      GoRoute(
        path: '/invite/:code',
        builder: (_, state) => AlbumEntry(
          config.api,
          key: ValueKey(state.pathParameters['code']),
          code: state.pathParameters['code'],
        ),
      ),
    ],
  );
  ref.onDispose(router.dispose);
  return router;
});

class FamilyApp extends ConsumerWidget {
  const FamilyApp(this.config, {super.key});
  final AppConfig config;

  @override
  Widget build(BuildContext context, WidgetRef ref) => MaterialApp.router(
    title: 'すくすく',
    theme: familyTheme(),
    routerConfig: ref.watch(routerProvider(config)),
  );
}
