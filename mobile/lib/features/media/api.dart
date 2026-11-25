import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'compression.dart';

class ProbeApi {
  ProbeApi(this.base, this.token);
  final Uri base;
  final Future<String?> Function() token;

  Future<Map<String, String>> _headers() async {
    final idToken = await token();
    if (idToken == null) throw StateError('再ログインしてください。');
    return {'Authorization': 'Bearer $idToken'};
  }

  Future<void> verifyLogin() async {
    final response = await http.get(
      base.resolve('/v0/me'),
      headers: await _headers(),
    );
    _expect(response, 200);
  }

  Future<String> verifyMedia(
    String family,
    String post,
    Compressed compressed,
  ) async {
    final random = Random.secure();
    final bytes = List.generate(16, (_) => random.nextInt(256));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    final hex = bytes
        .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
        .join();
    final id = [
      hex.substring(0, 8),
      hex.substring(8, 12),
      hex.substring(12, 16),
      hex.substring(16, 20),
      hex.substring(20),
    ].join('-');
    final uri = base.replace(
      pathSegments: ['v0', 'families', family, 'posts', post, 'media', id],
    );
    final headers = await _headers();
    final upload = await http.put(
      uri,
      headers: {...headers, 'Content-Type': compressed.mime},
      body: compressed.bytes,
    );
    _expect(upload, 201);
    final download = await http.get(uri, headers: headers);
    _expect(download, 200);
    if (!listEquals(download.bodyBytes, compressed.bytes) ||
        download.headers['content-type'] != compressed.mime) {
      throw StateError('取得したファイルがアップロードしたファイルと一致しません。');
    }
    return id;
  }

  void _expect(http.Response response, int status) {
    if (response.statusCode != status)
      throw StateError('API HTTP ${response.statusCode}');
  }
}
