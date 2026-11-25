import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

class NotificationProbe {
  Stream<RemoteMessage> get foreground => FirebaseMessaging.onMessage;
  Future<String> token() async {
    final messaging = FirebaseMessaging.instance;
    final settings = await messaging.requestPermission();
    if (settings.authorizationStatus == AuthorizationStatus.denied) {
      throw StateError('端末の通知が許可されていません。');
    }
    if (defaultTargetPlatform == TargetPlatform.iOS &&
        await messaging.getAPNSToken() == null) {
      throw StateError('APNsトークンが未取得です。設定を確認して再試行してください。');
    }
    final token = await messaging.getToken();
    if (token == null) throw StateError('FCMトークンを取得できませんでした。');
    return token;
  }
}
