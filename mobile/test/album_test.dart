import 'dart:async';
import 'dart:typed_data';

import 'package:family_share/features/album/album_api.dart';
import 'package:family_share/features/album/album_screen.dart';
import 'package:family_share/features/album/album_widgets.dart';
import 'package:family_share/features/family/family_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _Album extends AlbumApi {
  _Album(String role, {this.gallery = false})
    : super(
        FamilyApi(Uri.parse('https://example.invalid'), () async => null),
        FamilyMembership({
          'id': 'test',
          'name': '家族',
          'role': role,
          'side': 'paternal',
        }),
      );

  final bool gallery;

  @override
  Future<Uint8List> media(String post, String id) =>
      Completer<Uint8List>().future;

  @override
  Future<AlbumRow> get(String endpoint, {Map<String, String>? query}) async =>
      endpoint == 'children'
      ? {'children': []}
      : {
          'posts': gallery
              ? [
                  {
                    'id': '1',
                    'capturedAt': '2022-11-01',
                    'media': [
                      {'id': 'photo', 'type': 'image/jpeg'},
                    ],
                  },
                  {
                    'id': '2',
                    'capturedAt': '2021-07-01',
                    'media': [
                      {'id': 'movie', 'type': 'video/mp4'},
                    ],
                  },
                ]
              : [],
          'next': '',
        };
}

void main() {
  test('age uses completed calendar months, including the end of February', () {
    expect(ageAt('2024-01-31', '2024-02-28'), '0か月');
    expect(ageAt('2024-01-31', '2024-02-29'), '1か月');
    expect(ageAt('2024-01-31', '2024-02-29', includeZeroYears: true), '0歳1か月');
    expect(ageAt('2024-01-31', '2025-02-28'), '1歳1か月');
    expect(ageAt('2024-01-31', '2024-01-01'), '');
  });

  testWidgets('posting is available to parents and absent for grandparents', (
    tester,
  ) async {
    await tester.pumpWidget(MaterialApp(home: AlbumScreen(_Album('parent'))));
    await tester.pumpAndSettle();
    expect(find.text('追加'), findsOneWidget);

    await tester.pumpWidget(const MaterialApp(home: SizedBox()));
    await tester.pumpWidget(
      MaterialApp(home: AlbumScreen(_Album('grandparent'))),
    );
    await tester.pumpAndSettle();
    expect(find.text('追加'), findsNothing);
    expect(find.text('表示できる投稿はまだありません。'), findsOneWidget);
  });

  testWidgets('filtering by year switches the visible month and media', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(home: AlbumScreen(_Album('parent', gallery: true))),
    );
    await tester.pumpAndSettle();
    expect(find.text('11月'), findsOneWidget);
    expect(tester.widget<Text>(find.text('2022年')).style?.color, Colors.white);
    expect(find.byIcon(Icons.play_arrow), findsNothing);
    await tester.tap(find.byType(DropdownButton<int>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('2021年').last);
    await tester.pumpAndSettle();
    expect(find.text('7月'), findsOneWidget);
    expect(find.text('11月'), findsNothing);
    expect(find.byIcon(Icons.play_arrow), findsOneWidget);
  });
}
