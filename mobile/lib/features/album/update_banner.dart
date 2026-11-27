import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

enum AlbumUpdate {
  android(
    'android',
    'https://play.google.com/store/apps/details?id=biz.wisemap.family_share',
  ),
  appStore('app-store', 'https://apps.apple.com/app/id6839227117'),
  testFlight('testflight', 'itms-beta://');

  const AlbumUpdate(this.channel, this.store);
  final String channel;
  final String store;

  static AlbumUpdate? get current => switch (defaultTargetPlatform) {
    TargetPlatform.android => android,
    TargetPlatform.iOS =>
      const String.fromEnvironment('APP_DISTRIBUTION') == 'testflight'
          ? testFlight
          : appStore,
    _ => null,
  };

  Future<int> latestBuild(Uri base) async {
    final response = await http
        .get(
          base
              .resolve('/app-update')
              .replace(queryParameters: {'distribution': channel}),
        )
        .timeout(const Duration(seconds: 5));
    if (response.statusCode != 200) throw StateError('Version check failed');
    return (jsonDecode(response.body) as Map<String, dynamic>)['latestBuild']
        as int;
  }

  static Future<int?> installedBuild() =>
      const MethodChannel('biz.wisemap.family_share/app')
          .invokeMethod<int>('buildNumber');

  Future<bool> openStore() async {
    try {
      if (await launchUrl(
        Uri.parse(store),
        mode: LaunchMode.externalApplication,
      ))
        return true;
    } on PlatformException {
      if (this != testFlight) rethrow;
    }
    return this == testFlight &&
        await launchUrl(
          Uri.parse('https://apps.apple.com/app/testflight/id899247664'),
          mode: LaunchMode.externalApplication,
        );
  }
}

class UpdateBanner extends StatelessWidget {
  const UpdateBanner(this.distribution, {super.key, required this.onDismiss});
  final AlbumUpdate distribution;
  final VoidCallback onDismiss;

  Future<void> open(BuildContext context) async {
    try {
      if (await distribution.openStore()) return;
    } catch (_) {}
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('更新先を開けませんでした。ストアアプリから更新してください。')),
      );
    }
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
    child: Material(
      color: const Color(0xFFF0E3D3),
      borderRadius: BorderRadius.circular(16),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 8, 4, 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Padding(
              padding: EdgeInsets.only(top: 8, right: 12),
              child: Icon(
                Icons.system_update_alt_outlined,
                color: Color(0xFF794D39),
              ),
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const SizedBox(height: 6),
                  Text(
                    '新しいバージョンがあります',
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                  TextButton(
                    onPressed: () => open(context),
                    child: const Text('更新する'),
                  ),
                ],
              ),
            ),
            IconButton(
              tooltip: '更新案内を閉じる',
              onPressed: onDismiss,
              icon: const Icon(Icons.close),
            ),
          ],
        ),
      ),
    ),
  );
}
