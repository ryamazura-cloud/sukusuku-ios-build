import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

const relationshipNames = {
  'father': 'パパ',
  'mother': 'ママ',
  'grandfather': 'おじいちゃん',
  'grandmother': 'おばあちゃん',
  'sibling': '兄弟姉妹',
  'other': 'その他',
};

class FamilyMembership {
  FamilyMembership(Map<String, dynamic> json)
    : id = json['id'] as String,
      name = json['name'] as String,
      role = switch ((json['role'], json['side'])) {
        ('admin', _) => '管理者',
        ('parent', _) => '管理者',
        ('grandparent', 'paternal') => '父方の祖父母',
        ('grandparent', 'maternal') => '母方の祖父母',
        _ => throw const FormatException('Unknown family role'),
      },
      relationship = relationshipNames[json['relationship']],
      canInvite = json['role'] == 'admin' || json['role'] == 'parent',
      canPost = json['role'] != 'grandparent';

  final String id;
  final String name;
  final String role;
  final String? relationship;
  final bool canInvite;
  final bool canPost;
}

enum InviteRole {
  parent('パートナー'),
  paternal('パパ方家族'),
  maternal('ママ方家族');

  const InviteRole(this.label);
  final String label;
}

class FamilyApi {
  FamilyApi(this.base, this.token);
  final Uri base;
  final Future<String?> Function() token;

  Future<FamilyMembership?> current() async {
    final response = await _request('families/current');
    final family = response['family'];
    return family == null
        ? null
        : FamilyMembership(family as Map<String, dynamic>);
  }

  Future<FamilyMembership> create(String name) async {
    final response = await _request('families', body: {'name': name});
    return FamilyMembership(response['family'] as Map<String, dynamic>);
  }

  Future<FamilyMembership> createAlbum({
    required String albumName,
    required String relationship,
    required String nickname,
    required String childName,
    required String birthday,
  }) async {
    return _writeMembership('families', {
      'name': albumName,
      'relationship': relationship,
      'nickname': nickname,
      'childName': childName,
      'birthday': birthday,
    });
  }

  Future<bool> parentInvite(String code) async {
    final response = await _request(
      'families/invite-details',
      body: {'code': code},
    );
    return response['type'] == 'parent';
  }

  Future<FamilyMembership> join(
    String code, {
    String? relationship,
    String? nickname,
  }) => _writeMembership('families/join', {
    'code': code,
    'relationship': ?relationship,
    'nickname': ?nickname,
  });

  Future<FamilyMembership> _writeMembership(
    String path,
    Map<String, String> fields,
  ) async {
    try {
      final response = await _request(path, body: fields);
      return FamilyMembership(response['family'] as Map<String, dynamic>);
    } catch (error, stack) {
      if (error is FamilyApiException &&
          error.status < 500 &&
          error.status != 409) {
        rethrow;
      }
      // The membership may have been saved before the response was interrupted.
      FamilyMembership? confirmed;
      try {
        confirmed = await current();
      } catch (_) {
        // Preserve the original error if the membership check also fails.
      }
      if (confirmed != null) return confirmed;
      Error.throwWithStackTrace(error, stack);
    }
  }

  Future<({String code, DateTime expiresAt})> invite(
    String familyId,
    InviteRole role,
  ) async {
    final response = await _request(
      'families/$familyId/invites',
      body: {'role': role.name},
    );
    return (
      code: response['code'] as String,
      expiresAt: DateTime.parse(response['expiresAt'] as String).toLocal(),
    );
  }

  Future<Map<String, dynamic>> _request(
    String path, {
    Map<String, String>? body,
  }) => request(path, method: body == null ? 'GET' : 'POST', body: body);

  Future<Map<String, dynamic>> request(
    String path, {
    String method = 'GET',
    Map<String, Object?>? body,
    Map<String, String>? query,
  }) async {
    final response = await _send(
      path,
      method,
      query: query,
      bytes: body == null ? null : utf8.encode(jsonEncode(body)),
      contentType: 'application/json',
    );
    final decoded = jsonDecode(utf8.decode(response.bodyBytes));
    if (decoded is! Map<String, dynamic>) {
      throw const FormatException('Expected an API response object');
    }
    return decoded;
  }

  Future<void> deleteAccount({bool closesAlbum = false}) async {
    while (true) {
      final result = await request(
        'account',
        method: 'DELETE',
        body: {'closeAlbum': closesAlbum},
      );
      if (result['ok'] == true) return;
      if (result['pending'] != true) {
        throw const FormatException('Missing account deletion acknowledgement');
      }
      await Future<void>.delayed(const Duration(milliseconds: 250));
    }
  }

  Future<void> upload(String path, Uint8List bytes, String mime) async {
    await _send(path, 'PUT', bytes: bytes, contentType: mime);
  }

  Future<Uint8List> download(String path) async =>
      (await _send(path, 'GET')).bodyBytes;

  Future<http.Response> _send(
    String path,
    String method, {
    Map<String, String>? query,
    List<int>? bytes,
    String? contentType,
  }) async {
    final idToken = await token();
    if (idToken == null) throw const FamilyApiException(401);
    final uri = base.resolve('/v1/$path').replace(queryParameters: query);
    final request = http.Request(method, uri);
    request.headers['Authorization'] = 'Bearer $idToken';
    if (bytes != null) {
      request.headers['Content-Type'] = contentType!;
      request.bodyBytes = bytes;
    }
    final client = http.Client();
    try {
      final response = await client
          .send(request)
          .then(http.Response.fromStream)
          .timeout(const Duration(seconds: 55));
      if (response.statusCode < 200 || response.statusCode >= 300) {
        String? reason;
        try {
          reason = (jsonDecode(response.body)['error'] as String?);
        } catch (_) {}
        throw FamilyApiException(response.statusCode, reason);
      }
      return response;
    } finally {
      client.close();
    }
  }
}

class FamilyApiException implements Exception {
  const FamilyApiException(this.status, [this.reason]);
  final int status;
  final String? reason;

  String get message => switch ((status, reason)) {
    (400, 'relationship does not match invitation') => '招待内容に合う間柄を選んでください。',
    (409, 'cannot remove yourself') => 'ご自身の退出はアカウントとデータの削除から行ってください。',
    (409, 'notification device not registered') => '先に端末への通知をオンにして保存してください。',
    (429, 'notification test rate limited') => 'テスト通知は30秒後にもう一度送れます。',
    (503, 'notification delivery THIRD_PARTY_AUTH_ERROR') =>
      'iPhoneへの通知の認証に失敗しました。FirebaseのAPNs設定をご確認ください。',
    (503, 'notification delivery PERMISSION_DENIED') =>
      '通知サーバーの送信権限を確認してください（PERMISSION_DENIED）。',
    (503, 'notification delivery SENDER_ID_MISMATCH') =>
      '端末と通知サーバーのFirebaseプロジェクトが一致していません。',
    (503, 'notification delivery UNREGISTERED') =>
      '端末の登録情報が無効です。通知をオンにして保存し直してください。',
    (503, final reason?) when reason.startsWith('notification delivery ') =>
      'テスト通知を送信できませんでした（${reason.split(' ').last}）。',
    (409, 'confirm album closure') =>
      '管理者の状況が変わりました。もう一度削除ボタンを押し、削除される内容を確認してください。',
    (503, 'Firebase account deletion unavailable') =>
      '認証データの削除を完了できませんでした。少し時間をおいて再試行してください。',
    (409, 'another administrator required') ||
    (
      409,
      'transfer administrator before retirement',
    ) => '退会前に、パートナーを招待して別の管理者を登録してください。',
    (409, 'upload is being processed') => '前回のアップロードを処理中です。少し待って再試行してください。',
    (409, 'upload in progress; retry deletion later') =>
      'アップロードの終了後に、もう一度削除してください。',
    (403, 'account retirement in progress') => 'アカウントとデータの削除が途中です。',
    (413, _) => 'ファイルが大きすぎるか、家族の容量上限に達しています。',
    (422, _) => '対応している写真、または60秒以下の動画を選んでください。',
    (400, _) => '入力内容を確認してください。',
    (401, _) => 'ログアウトして、もう一度ログインしてください。',
    (403, _) => 'この操作を行う権限がありません。',
    (404, 'post not found') => 'この投稿は閲覧できません。アルバムを更新してください。',
    (404, 'media not found') => 'この写真・動画を取得できませんでした。',
    (404, _) => '招待コードが無効か、すでに使われています。',
    (503, 'Firestore request failed') =>
      'データの取得・更新に失敗しました（Firestore / HTTP 503）。',
    (503, _) => 'サービスに接続できませんでした（HTTP 503）。',
    (409, _) => 'すでに家族に所属しているか、参加先の定員に達しています。',
    _ => '家族情報を取得・更新できませんでした。',
  };
}
