import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

class NotificationProbe {
  static Future<String>? _registration;

  Stream<RemoteMessage> get foreground => FirebaseMessaging.onMessage;
  Future<String> token() async {
    return _registrationRequest(() async {
      final settings = await FirebaseMessaging.instance.requestPermission();
      return _token(settings);
    });
  }

  Future<String?> existingToken([String? refreshedToken]) =>
      _registrationRequest(() async {
        final settings = await FirebaseMessaging.instance
            .getNotificationSettings();
        if (settings.authorizationStatus != AuthorizationStatus.authorized &&
            settings.authorizationStatus != AuthorizationStatus.provisional) {
          return null;
        }
        return refreshedToken ?? await _token(settings);
      });

  Future<T> _registrationRequest<T>(Future<T> Function() request) async {
    try {
      return await request();
    } on FirebaseException catch (error) {
      throw StateError('端末を通知サービスに登録できませんでした（${error.code}）。');
    } on PlatformException catch (error) {
      throw StateError('端末の通知設定を確認できませんでした（${error.code}）。');
    }
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
    final task = _registration ??= _register(messaging);
    try {
      return await task;
    } finally {
      if (identical(_registration, task)) _registration = null;
    }
  }

  Future<String> _register(FirebaseMessaging messaging) async {
    final id = Completer<String>();
    final subscription = messaging.onRegistered.listen(
      (fid) {
        if (!id.isCompleted) id.complete(fid);
      },
      onError: (Object error, StackTrace stackTrace) {
        if (!id.isCompleted) id.completeError(error, stackTrace);
      },
    );
    try {
      await Future.wait<void>([
        id.future,
        messaging.register(),
      ], eagerError: true).timeout(const Duration(seconds: 12));
      return await id.future;
    } on TimeoutException {
      throw StateError('端末の通知登録がタイムアウトしました。少し待って再試行してください。');
    } finally {
      await subscription.cancel();
    }
  }
}
