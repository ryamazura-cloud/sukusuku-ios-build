import 'package:family_share/app/theme.dart';
import 'package:family_share/features/album/album_api.dart';
import 'package:family_share/features/album/album_widgets.dart';
import 'package:family_share/features/album/post_editor.dart';
import 'package:family_share/features/album/post_screen.dart';
import 'package:family_share/features/family/family_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _PostApi extends AlbumApi {
  _PostApi()
    : super(
        FamilyApi(Uri.https('example.invalid'), () async => null),
        FamilyMembership({'id': 'family', 'name': '家族', 'role': 'parent'}),
      );

  @override
  Future<AlbumRow> get(String endpoint, {Map<String, String>? query}) async =>
      endpoint.endsWith('/discussion')
      ? {
          'comments': [
            {
              'id': 'comment',
              'name': 'ばあば',
              'body': 'かわいいね',
              'at': '2026-10-12T03:00:00Z',
            },
          ],
          'reactions': <String, dynamic>{},
          'own': <String>[],
          'next': '',
        }
      : {
          'capturedAt': '2026-10-11',
          'createdAt': '2026-10-12T00:00:00Z',
          'scope': 'all',
          'author': 'ママ',
          'body': '今日のひとこま',
          'media': <dynamic>[],
          'childIds': <dynamic>[],
        };
}

void main() {
  testWidgets('new posts start with today and edits keep their saved date', (
    tester,
  ) async {
    final today = dateLabel(DateTime.now());
    await tester.pumpWidget(MaterialApp(home: PostEditor(_PostApi(), [])));
    expect(find.text(today), findsOneWidget);

    await tester.pumpWidget(
      MaterialApp(
        home: PostEditor(
          _PostApi(),
          [],
          key: const ValueKey('edit'),
          post: {'capturedAt': '2025-01-23'},
        ),
      ),
    );
    expect(find.text('2025-01-23'), findsOneWidget);
  });

  testWidgets(
    'detail shows centered date and scope, with author before each entry',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: familyTheme(),
          home: PostScreen(_PostApi(), 'post', []),
        ),
      );
      await tester.pumpAndSettle();
      final bar = tester.widget<AppBar>(find.byType(AppBar));
      expect(bar.centerTitle, isTrue);
      expect(
        tester.widget<Scaffold>(find.byType(Scaffold)).backgroundColor,
        const Color(0xFFFFFCF6),
      );
      expect(find.byType(Card), findsNothing);
      expect(
        Theme.of(tester.element(find.byType(AppBar)))
            .appBarTheme
            .backgroundColor,
        const Color(0xFF794D39),
      );
      expect(
        find.descendant(
          of: find.byType(AppBar),
          matching: find.text('2026年10月11日'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(of: find.byType(AppBar), matching: find.text('家族全員')),
        findsOneWidget,
      );
      expect(
        tester.getTopLeft(find.text('ママ')).dy,
        lessThan(tester.getTopLeft(find.text('今日のひとこま')).dy),
      );
      expect(
        tester.getTopLeft(find.text('ばあば')).dy,
        lessThan(tester.getTopLeft(find.text('かわいいね')).dy),
      );
      expect(find.text('コメントを入力'), findsOneWidget);
      expect(find.text('コメント'), findsNothing);
      expect(find.text('写真 1'), findsNothing);
      for (final title in ['投稿にリアクション', 'コメントにリアクション']) {
        final button = find.byTooltip(title);
        await tester.ensureVisible(button);
        await tester.tap(button);
        await tester.pumpAndSettle();
        final grid = tester.widget<GridView>(find.byType(GridView));
        final columns =
            grid.gridDelegate as SliverGridDelegateWithFixedCrossAxisCount;
        expect(columns.crossAxisCount, 10);
        expect(grid.childrenDelegate.estimatedChildCount, 10);
        Navigator.of(tester.element(find.byType(GridView))).pop();
        await tester.pumpAndSettle();
      }
    },
  );
}
