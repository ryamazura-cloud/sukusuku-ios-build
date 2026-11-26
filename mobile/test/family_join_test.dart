import 'dart:convert';

import 'package:family_share/features/family/family_api.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  const membership = {
    'family': {
      'id': 'test-family',
      'name': 'テスト家族',
      'role': 'grandparent',
      'side': 'maternal',
    },
  };

  for (final status in [200, 409, 503]) {
    test(
      'recovers a saved membership after an unclear join response ($status)',
      () async {
        final requests = <String>[];
        final result = await http.runWithClient(
          () => FamilyApi(
            Uri.https('example.invalid'),
            () async => 'test-token',
          ).join('code'),
          () => MockClient((request) async {
            requests.add(request.method);
            return request.method == 'POST'
                ? http.Response('{"unexpected":true}', status)
                : http.Response.bytes(utf8.encode(jsonEncode(membership)), 200);
          }),
        );
        expect(result.role, '母方の祖父母');
        expect(result.canPost, isFalse);
        expect(requests, ['POST', 'GET']);
      },
    );
  }

  test(
    'an invalid invitation keeps its error without checking membership',
    () async {
      final requests = <String>[];
      await expectLater(
        http.runWithClient(
          () => FamilyApi(
            Uri.https('example.invalid'),
            () async => 'test-token',
          ).join('code'),
          () => MockClient((request) async {
            requests.add(request.method);
            return http.Response('{"error":"invalid invite code"}', 400);
          }),
        ),
        throwsA(
          isA<FamilyApiException>().having((e) => e.status, 'status', 400),
        ),
      );
      expect(requests, ['POST']);
    },
  );

  test('an unconfirmed join keeps the original error', () async {
    await expectLater(
      http.runWithClient(
        () => FamilyApi(
          Uri.https('example.invalid'),
          () async => 'test-token',
        ).join('code'),
        () => MockClient(
          (request) async => request.method == 'POST'
              ? http.Response('{"error":"service unavailable"}', 503)
              : http.Response('{"family":null}', 200),
        ),
      ),
      throwsA(isA<FamilyApiException>().having((e) => e.status, 'status', 503)),
    );
  });

  test('recovers an album saved before an unclear create response', () async {
    final paths = <String>[];
    final album = await http.runWithClient(
      () => FamilyApi(Uri.https('example.invalid'), () async => 'token')
          .createAlbum(
            albumName: 'Our album',
            relationship: 'mother',
            nickname: 'Mama',
            childName: 'Baby',
            birthday: '2026-11-26',
          ),
      () => MockClient((request) async {
        paths.add(request.url.path);
        if (request.method == 'POST') {
          expect(jsonDecode(request.body)['relationship'], 'mother');
          return http.Response('', 201);
        }
        return http.Response(
          '{"family":{"id":"created","name":"Our album","role":"admin","relationship":"mother"}}',
          200,
        );
      }),
    );
    expect(album.id, 'created');
    expect(album.canInvite, isTrue);
    expect(paths, ['/v1/families', '/v1/families/current']);
  });
}
