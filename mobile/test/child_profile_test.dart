import 'dart:convert';

import 'package:family_share/features/album/album_api.dart';
import 'package:family_share/features/family/family_api.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

final album = AlbumApi(
  FamilyApi(Uri.https('example.invalid'), () async => 'test-token'),
  FamilyMembership({'id': 'family', 'name': 'Family', 'role': 'admin'}),
);

void main() {
  for (final (endpoint, update, response) in [
    (
      'child',
      {'name': 'Updated', 'birthday': '2026-12-01'},
      http.Response('', 200),
    ),
    (
      'child/avatar',
      {'avatar': 'image'},
      http.Response('{"error":"service unavailable"}', 503),
    ),
    ('child/avatar', {'avatar': null}, http.Response('[]', 200)),
  ]) {
    test(
      'confirms saved child fields after an unclear response ($update)',
      () async {
        final child = {
          'id': 'child',
          'name': 'Previous',
          'birthday': '2025-12-01',
          ...update,
        };
        if (update.containsKey('avatar') && update['avatar'] == null) {
          child.remove('avatar');
        }
        final saved = {
          'children': [child],
        };
        final requests = <String>[];
        final result = await http.runWithClient(
          () => album.changeChild('child', update),
          () => MockClient((request) async {
            requests.add('${request.method} ${request.url.path}');
            if (request.method == 'PUT') {
              expect(jsonDecode(request.body), update);
              return response;
            }
            return http.Response(jsonEncode(saved), 200);
          }),
        );
        expect(result, saved);
        expect(requests, [
          'PUT /v1/families/family/children/$endpoint',
          'GET /v1/families/family/children',
        ]);
      },
    );
  }

  for (final status in [403, 503]) {
    test(
      'keeps the original error when the update is unconfirmed ($status)',
      () async {
        final requests = <String>[];
        await expectLater(
          http.runWithClient(
            () => album.changeChild('child', {'avatar': 'new'}),
            () => MockClient((request) async {
              requests.add(request.method);
              return request.method == 'PUT'
                  ? http.Response('{"error":"write failed"}', status)
                  : http.Response(
                      '{"children":[{"id":"child","avatar":"old"}]}',
                      200,
                    );
            }),
          ),
          throwsA(
            isA<FamilyApiException>().having((e) => e.status, 'status', status),
          ),
        );
        expect(requests, status == 403 ? ['PUT'] : ['PUT', 'GET']);
      },
    );
  }
}
