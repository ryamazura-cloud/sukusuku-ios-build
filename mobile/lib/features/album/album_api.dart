import 'dart:typed_data';

import '../family/family_api.dart';

typedef AlbumRow = Map<String, dynamic>;

List<AlbumRow> rows(Object? value) =>
    (value as List<dynamic>? ?? []).cast<AlbumRow>();

class AlbumApi {
  AlbumApi(this.api, this.family);
  final FamilyApi api;
  final FamilyMembership family;
  String get path => 'families/${family.id}';

  Future<AlbumRow> get(String endpoint, {Map<String, String>? query}) =>
      api.request('$path/$endpoint', query: query);

  Future<AlbumRow> change(
    String endpoint,
    String method, [
    Map<String, Object?>? body,
  ]) => api.request('$path/$endpoint', method: method, body: body);

  Future<AlbumRow?> changeChild(
    String id, [
    Map<String, Object?>? fields,
  ]) async {
    final endpoint = fields?.containsKey('avatar') == true
        ? 'children/$id/avatar'
        : 'children/$id';
    try {
      final response = await change(
        endpoint,
        fields == null ? 'DELETE' : 'PUT',
        fields,
      );
      if (response['ok'] != true) {
        throw const FormatException('Missing child update acknowledgement');
      }
      return null;
    } on Exception catch (error, stack) {
      if (error is FamilyApiException &&
          error.status < 500 &&
          error.status != 408) {
        rethrow;
      }
      // A write can commit before the response reaches the app.
      try {
        final confirmed = await get('children');
        final children = confirmed['children'];
        if (children is List) {
          final child = rows(children)
              .where((item) => item['id'] == id)
              .firstOrNull;
          final matches = fields == null
              ? child == null
              : child != null &&
                    fields.entries.every(
                      (entry) => child[entry.key] == entry.value,
                    );
          if (matches) return confirmed;
        }
      } catch (_) {
        // Preserve the original error when the saved state cannot be verified.
      }
      Error.throwWithStackTrace(error, stack);
    }
  }

  Future<Uint8List> media(String post, String id) =>
      api.download('$path/posts/$post/media/$id');

  Future<void> upload(String post, String id, Uint8List bytes, String mime) =>
      api.upload('$path/posts/$post/media/$id', bytes, mime);
}
