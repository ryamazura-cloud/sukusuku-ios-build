import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../auth/auth.dart';
import '../notifications/probe.dart';
import 'api.dart';
import 'compression.dart';

class ProbeScreen extends ConsumerStatefulWidget {
  const ProbeScreen(this.api, {super.key});
  final Uri api;

  @override
  ConsumerState<ProbeScreen> createState() => _ProbeScreenState();
}

class _ProbeScreenState extends ConsumerState<ProbeScreen> {
  final family = TextEditingController(text: 'phase0');
  final post = TextEditingController(text: 'family');
  final probe = NotificationProbe();
  late final StreamSubscription<Object?> messages;
  bool busy = false;
  String status = '';
  String? token;

  @override
  void initState() {
    super.initState();
    messages = probe.foreground.listen((_) {
      if (mounted) setState(() => status = 'FCM通知を前景で受信しました。');
    });
  }

  @override
  void dispose() {
    unawaited(messages.cancel());
    family.dispose();
    post.dispose();
    super.dispose();
  }

  ProbeApi get api => ProbeApi(
    widget.api,
    () async => await ref.read(authProvider).currentUser?.getIdToken(),
  );

  Future<void> run(Future<String> Function() operation) async {
    setState(() {
      busy = true;
      status = '';
    });
    try {
      final result = await operation();
      if (mounted) setState(() => status = result);
    } on StateError catch (error) {
      if (mounted) setState(() => status = error.message.toString());
    } on PlatformException catch (error) {
      if (mounted) setState(() => status = '端末処理に失敗しました（${error.code}）。');
    } catch (_) {
      if (mounted) setState(() => status = '検証に失敗しました。接続や設定を確認してください。');
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<String> media(bool video) async {
    final group = family.text.trim();
    final fixture = post.text.trim();
    final compressed = await Compression().pick(video);
    if (compressed == null || !mounted) return '選択を取り消しました。';
    final id = await api.verifyMedia(group, fixture, compressed);
    final seconds = compressed.milliseconds == null
        ? ''
        : ' / ${(compressed.milliseconds! / 1000).toStringAsFixed(2)}秒';
    return '${compressed.original} → ${compressed.bytes.length} バイト$seconds\n'
        '取得データが一致しました。\nメディアID $id';
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('Phase 0 技術検証'),
      actions: [
        IconButton(
          tooltip: 'ログアウト',
          icon: const Icon(Icons.logout),
          onPressed: busy
              ? null
              : () => run(() async {
                  await ref.read(authProvider).signOut();
                  return '';
                }),
        ),
      ],
    ),
    body: ListView(
      padding: const EdgeInsets.all(24),
      children: [
        const Text('撮影した家族の写真や動画を使わず、合成素材を選んでください。'),
        const SizedBox(height: 16),
        TextField(
          controller: family,
          decoration: const InputDecoration(labelText: '試験用家族ID'),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: post,
          decoration: const InputDecoration(labelText: '試験用投稿ID'),
        ),
        const SizedBox(height: 12),
        OutlinedButton(
          onPressed: busy
              ? null
              : () => run(() async {
                  await api.verifyLogin();
                  return 'WorkersでFirebase IDトークンを確認しました。';
                }),
          child: const Text('認証を確認'),
        ),
        FilledButton(
          onPressed: busy ? null : () => run(() => media(false)),
          child: const Text('画像を圧縮して送受信'),
        ),
        FilledButton(
          onPressed: busy ? null : () => run(() => media(true)),
          child: const Text('動画を圧縮して送受信'),
        ),
        OutlinedButton(
          onPressed: busy
              ? null
              : () => run(() async {
                  final received = await probe.token();
                  if (mounted) setState(() => token = received);
                  return 'FCMトークンを取得しました。';
                }),
          child: const Text('通知の設定を確認'),
        ),
        if (token != null)
          OutlinedButton(
            onPressed: busy
                ? null
                : () => run(() async {
                    await Clipboard.setData(ClipboardData(text: token!));
                    return '通知テスト用トークンをコピーしました。';
                  }),
            child: const Text('FCMトークンをコピー'),
          ),
        if (busy) const LinearProgressIndicator(),
        SelectableText(status),
      ],
    ),
  );
}
