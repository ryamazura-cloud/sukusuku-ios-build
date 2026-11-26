import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

class NotificationProbe {
  Stream<RemoteMessage> get foreground => FirebaseMessaging.onMessage;
  Future<String> token() async {
    final settings = await FirebaseMessaging.instance.requestPermission();
    return _token(settings);
  }

  Future<String?> existingToken() async {
    final settings = await FirebaseMessaging.instance.getNotificationSettings();
    if (settings.authorizationStatus != AuthorizationStatus.authorized &&
        settings.authorizationStatus != AuthorizationStatus.provisional) {
      return null;
    }
    return _token(settings);
  }

  Future<String> _token(NotificationSettings settings) async {
    final messaging = FirebaseMessaging.instance;
    if (settings.authorizationStatus == AuthorizationStatus.denied) {
      throw StateError('端末の通知が許可されていません。');
    }
    if (defaultTargetPlatform == TargetPlatform.iOS) {
      String? apns;
      for (var attempt = 0; attempt < 20; attempt++) {
        apns = await messaging.getAPNSToken();
        if (apns != null) break;
        await Future<void>.delayed(const Duration(milliseconds: 350));
      }
      if (apns == null) {
        throw StateError('iPhoneの通知登録が完了していません。しばらく待って再試行してください。');
      }
    }
    final token = await messaging.getToken();
    if (token == null) throw StateError('FCMトークンを取得できませんでした。');
    return token;
  }
}
