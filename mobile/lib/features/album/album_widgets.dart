import 'dart:convert';

import 'package:flutter/material.dart';

import '../family/family_api.dart';

String errorLabel(Object? error) => switch (error) {
  FamilyApiException() => error.message,
  StateError() => error.message.toString(),
  _ => '操作に失敗しました。接続を確認して、もう一度お試しください。',
};

String dateLabel(DateTime date) =>
    '${date.year.toString().padLeft(4, '0')}-'
    '${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}';

String timeLabel(Object? value) {
  final parsed = DateTime.tryParse(value?.toString() ?? '')?.toLocal();
  if (parsed == null) return '';
  return '${dateLabel(parsed)} ${parsed.hour.toString().padLeft(2, '0')}:'
      '${parsed.minute.toString().padLeft(2, '0')}';
}

class ChildAvatar extends StatelessWidget {
  const ChildAvatar(this.encoded, {super.key, this.radius = 20});

  final String? encoded;
  final double radius;

  @override
  Widget build(BuildContext context) {
    final value = encoded;
    MemoryImage? image;
    if (value != null) {
      try {
        image = MemoryImage(base64Decode(value));
      } on FormatException {
        // Keep the default icon when the thumbnail cannot be decoded.
      }
    }
    return CircleAvatar(
      radius: radius,
      foregroundImage: image,
      onForegroundImageError: image == null ? null : (_, _) {},
      child: Icon(Icons.face_outlined, size: radius * 1.15),
    );
  }
}

String ageAt(String birthday, String taken, {bool includeZeroYears = false}) {
  final birth = DateTime.tryParse(birthday);
  final date = DateTime.tryParse(taken);
  if (birth == null || date == null || date.isBefore(birth)) return '';
  var months = (date.year - birth.year) * 12 + date.month - birth.month;
  final endOfMonth = DateTime(date.year, date.month + 1, 0).day;
  if (date.day < (birth.day > endOfMonth ? endOfMonth : birth.day)) months--;
  return months < 12 && !includeZeroYears
      ? '$monthsか月'
      : '${months ~/ 12}歳${months % 12}か月';
}

Future<String?> textDialog(
  BuildContext context,
  String title, {
  required String label,
  String initial = '',
  bool secret = false,
  int maxLength = 60,
}) {
  var text = initial;
  return showDialog<String>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: TextFormField(
        initialValue: initial,
        autofocus: true,
        obscureText: secret,
        decoration: InputDecoration(labelText: label),
        maxLength: maxLength,
        onChanged: (value) => text = value,
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('取り消す'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(context, text),
          child: const Text('続ける'),
        ),
      ],
    ),
  );
}

Future<bool> confirm(
  BuildContext context,
  String title,
  String message,
) async =>
    await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取り消す'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('実行する'),
          ),
        ],
      ),
    ) ??
    false;

void showFailure(BuildContext context, Object error) {
  ScaffoldMessenger.of(context)
      .showSnackBar(SnackBar(content: Text(errorLabel(error))));
}

const scopes = {
  'parents': '両親のみ',
  'all': '全員',
  'paternal': '両親とパパ方家族',
  'maternal': '両親とママ方家族',
};

const reactions = {
  'like': '👍',
  'love': '❤️',
  'cute': '🥰',
  'clap': '👏',
  'smile': '😊',
  'flower': '💮',
  'party': '🎉',
  'heartEyes': '😍',
  'sparkles': '✨',
  'hug': '🤗',
};

String relativeTime(Object? timestamp) {
  final date = DateTime.tryParse(timestamp?.toString() ?? '')?.toLocal();
  if (date == null) return '';
  final elapsed = DateTime.now().difference(date);
  if (elapsed.inMinutes < 1) return 'たった今';
  if (elapsed.inHours < 1) return '${elapsed.inMinutes}分前';
  if (elapsed.inDays < 1) return '${elapsed.inHours}時間前';
  if (elapsed.inDays < 7) return '${elapsed.inDays}日前';
  return '${date.month}月${date.day}日';
}
