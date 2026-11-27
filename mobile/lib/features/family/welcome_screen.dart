import 'package:flutter/material.dart';

import 'legal_document.dart';

class WelcomeScreen extends StatelessWidget {
  const WelcomeScreen({
    required this.onCreateAlbum,
    required this.inviteBase,
    required this.onOpenInvite,
    super.key,
  });

  final VoidCallback onCreateAlbum;
  final Uri inviteBase;
  final ValueChanged<String> onOpenInvite;
  static const _ivory = Color(0xFFFFFCF6);
  static const _brown = Color(0xFF794D39);
  static const _ink = Color(0xFF38291F);

  String? _inviteCode(String? input) {
    final uri = Uri.tryParse(input?.trim() ?? '');
    if (uri == null ||
        uri.scheme != inviteBase.scheme ||
        uri.host != inviteBase.host ||
        uri.port != inviteBase.port ||
        uri.userInfo.isNotEmpty) {
      return null;
    }
    return RegExp(r'^/invite/([a-f0-9]{32})$').firstMatch(uri.path)?.group(1);
  }

  Future<void> _showInviteInstructions(BuildContext context) async {
    final code = await showDialog<String>(
      context: context,
      builder: (context) {
        final form = GlobalKey<FormState>();
        String? enteredCode;
        void submit() {
          if (form.currentState!.validate()) {
            Navigator.pop(context, enteredCode);
          }
        }

        return AlertDialog(
          title: const Text('招待リンクから参加'),
          content: Form(
            key: form,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text('家族から届いた招待リンクをコピーして、ここに貼り付けてください。'),
                const SizedBox(height: 12),
                TextFormField(
                  decoration: const InputDecoration(labelText: '招待リンク'),
                  keyboardType: TextInputType.url,
                  autocorrect: false,
                  enableSuggestions: false,
                  textInputAction: TextInputAction.go,
                  onFieldSubmitted: (_) => submit(),
                  validator: (value) {
                    enteredCode = _inviteCode(value);
                    return enteredCode == null ? 'すくすくの招待リンクを入力してください。' : null;
                  },
                ),
              ],
            ),
          ),
          scrollable: true,
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('閉じる'),
            ),
            FilledButton(onPressed: submit, child: const Text('続ける')),
          ],
        );
      },
    );
    if (context.mounted && code != null) onOpenInvite(code);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: _ivory,
    body: SafeArea(
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 440),
          child: CustomScrollView(
            slivers: [
              SliverFillRemaining(
                hasScrollBody: false,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(24, 24, 24, 20),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Center(
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(15),
                          child: Image.asset(
                            'assets/welcome/app-icon.png',
                            width: 56,
                            height: 56,
                            excludeFromSemantics: true,
                          ),
                        ),
                      ),
                      const SizedBox(height: 7),
                      const Text(
                        'すくすく',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          color: _ink,
                          fontSize: 23,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const Spacer(flex: 2),
                      const SizedBox(height: 16),
                      Center(
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 344),
                          child: AspectRatio(
                            aspectRatio: 304 / 259,
                            child: ClipRRect(
                              borderRadius: BorderRadius.circular(20),
                              child: Image.asset(
                                'assets/welcome/family-collage.jpg',
                                fit: BoxFit.cover,
                                excludeFromSemantics: true,
                              ),
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(height: 16),
                      const Text(
                        '小さな毎日を、\n家族のアルバムに。',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          color: _ink,
                          fontSize: 24,
                          height: 1.42,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 8),
                      const Text(
                        '写真や動画をまとめて残し、\n招待した家族と思い出を共有。',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          color: Color(0xFF615345),
                          fontSize: 14,
                          height: 1.6,
                        ),
                      ),
                      const Spacer(flex: 3),
                      const SizedBox(height: 16),
                      FilledButton(
                        style: FilledButton.styleFrom(
                          backgroundColor: _brown,
                          foregroundColor: Colors.white,
                          minimumSize: const Size.fromHeight(48),
                        ),
                        onPressed: onCreateAlbum,
                        child: const Text('アルバムを作る'),
                      ),
                      const SizedBox(height: 8),
                      OutlinedButton(
                        style: OutlinedButton.styleFrom(
                          foregroundColor: _brown,
                          side: const BorderSide(color: Color(0xFFB7A18D)),
                          minimumSize: const Size.fromHeight(48),
                        ),
                        onPressed: () => _showInviteInstructions(context),
                        child: const Text('招待リンクから参加'),
                      ),
                      const SizedBox(height: 4),
                      Wrap(
                        alignment: WrapAlignment.center,
                        spacing: 8,
                        children: [
                          for (final document in LegalDocument.values)
                            TextButton(
                              style: TextButton.styleFrom(
                                foregroundColor: _brown,
                              ),
                              onPressed: () => document.open(context),
                              child: Text(
                                document.label,
                                style: const TextStyle(
                                  decoration: TextDecoration.underline,
                                ),
                              ),
                            ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}
