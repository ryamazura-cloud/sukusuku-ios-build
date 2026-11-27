import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

enum LegalDocument {
  privacyPolicy('プライバシーポリシー', '/privacy-policy/'),
  terms('利用規約', '/terms/');

  const LegalDocument(this.label, this.path);

  final String label;
  final String path;

  Future<void> open(BuildContext context) async {
    final url = Uri.https('sukusuku.wisemap.biz', path);
    try {
      if (await launchUrl(url, mode: LaunchMode.externalApplication)) return;
    } on PlatformException {
      // Show the same message when the browser cannot be started.
    }
    if (!context.mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text('$labelを開けませんでした。')));
  }
}
