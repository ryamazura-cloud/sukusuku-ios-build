import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'app/config.dart';
import 'app/theme.dart';
import 'features/auth/auth.dart';
import 'features/auth/sign_in.dart';
import 'features/media/probe_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final config = AppConfig.fromBuild();
  final options = config?.firebaseOptions();
  if (config == null || options == null) {
    runApp(const SetupMessage('開発環境のFirebase設定を読み込んでください。'));
    return;
  }
  if (config.environment != 'dev') {
    runApp(const SetupMessage('Phase 0の検証画面は開発環境で利用できます。'));
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
  final changed = ValueNotifier(0);
  ref.listen(userProvider, (_, _) => changed.value++);
  final router = GoRouter(
    initialLocation: '/',
    refreshListenable: changed,
    redirect: (_, state) {
      final user = ref.read(userProvider);
      if (user.isLoading || user.hasError)
        return state.uri.path == '/' ? null : '/';
      final destination = user.value == null ? '/login' : '/probe';
      return state.uri.path == destination ? null : destination;
    },
    routes: [
      GoRoute(
        path: '/',
        builder: (_, _) => Scaffold(
          body: Center(
            child: Consumer(
              builder: (_, ref, _) {
                final user = ref.watch(userProvider);
                return user.hasError
                    ? FilledButton(
                        onPressed: () => ref.invalidate(userProvider),
                        child: const Text('認証接続を再試行'),
                      )
                    : const CircularProgressIndicator();
              },
            ),
          ),
        ),
      ),
      GoRoute(path: '/login', builder: (_, _) => const SignIn()),
      GoRoute(path: '/probe', builder: (_, _) => ProbeScreen(config.api)),
    ],
  );
  ref.onDispose(() {
    router.dispose();
    changed.dispose();
  });
  return router;
});

class FamilyApp extends ConsumerWidget {
  const FamilyApp(this.config, {super.key});
  final AppConfig config;

  @override
  Widget build(BuildContext context, WidgetRef ref) => MaterialApp.router(
    title: '家族共有',
    theme: familyTheme(),
    routerConfig: ref.watch(routerProvider(config)),
  );
}
