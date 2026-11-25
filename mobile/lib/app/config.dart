import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';

class AppConfig {
  const AppConfig(this.environment, this.api, this.project);
  final String environment;
  final Uri api;
  final String project;

  static AppConfig? fromBuild() {
    const environment = String.fromEnvironment('APP_ENV');
    const project = String.fromEnvironment('FIREBASE_PROJECT_ID');
    final api = Uri.tryParse(const String.fromEnvironment('API_BASE_URL'));
    if ((environment != 'dev' && environment != 'prod') ||
        project.isEmpty ||
        project.contains('REPLACE') ||
        api == null ||
        api.scheme != 'https' ||
        api.host.isEmpty ||
        api.host.contains('replace') ||
        api.userInfo.isNotEmpty ||
        api.hasQuery ||
        api.hasFragment ||
        (api.path.isNotEmpty && api.path != '/')) {
      return null;
    }
    return AppConfig(environment, api, project);
  }

  FirebaseOptions? firebaseOptions() {
    const sender = String.fromEnvironment('FIREBASE_MESSAGING_SENDER_ID');
    final ios = defaultTargetPlatform == TargetPlatform.iOS;
    final appId = ios
        ? const String.fromEnvironment('FIREBASE_IOS_APP_ID')
        : const String.fromEnvironment('FIREBASE_ANDROID_APP_ID');
    final key = ios
        ? const String.fromEnvironment('FIREBASE_IOS_API_KEY')
        : const String.fromEnvironment('FIREBASE_ANDROID_API_KEY');
    if ([
      key,
      sender,
      appId,
    ].any((value) => value.isEmpty || value.contains('REPLACE'))) {
      return null;
    }
    return FirebaseOptions(
      apiKey: key,
      appId: appId,
      messagingSenderId: sender,
      projectId: project,
      iosBundleId: ios ? 'biz.wisemap.familyShare' : null,
    );
  }
}
