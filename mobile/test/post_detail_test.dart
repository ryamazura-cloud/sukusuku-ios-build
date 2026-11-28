import 'dart:async';

import 'package:family_share/app/theme.dart';
import 'package:family_share/features/album/album_api.dart';
import 'package:family_share/features/album/album_widgets.dart';
import 'package:family_share/features/album/media_viewer.dart';
import 'package:family_share/features/album/post_editor.dart';
import 'package:family_share/features/album/post_screen.dart';
import 'package:family_share/features/family/family_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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

class _SavePhotoApi extends _PostApi {
  final Uint8List bytes = Uint8List.fromList([1, 2, 3]);

  @override
  Future<Uint8List> photo(String post, String id) =>
      Completer<Uint8List>().future;

  @override
  Future<Uint8List> media(String post, String id) async => bytes;
}

void main() {
  testWidgets('download button saves the photo through the platform channel', (
    tester,
  ) async {
    final api = _SavePhotoApi();
    const channel = MethodChannel('biz.wisemap.family_share/video');
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    MethodCall? saved;
    messenger.setMockMethodCallHandler(channel, (call) async {
      saved = call;
      return true;
    });
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));

    await tester.pumpWidget(
      MaterialApp(
        home: MediaViewer(api, 'post', {'id': 'photo', 'type': 'image/jpeg'}),
      ),
    );
    expect(find.byIcon(Icons.file_download_outlined), findsOneWidget);
    await tester.tap(find.byTooltip('端末に保存'));
    await tester.pump();
    expect(saved?.method, 'save');
    expect(saved?.arguments, {'bytes': api.bytes, 'video': false});
    expect(find.text('写真を保存しました。'), findsOneWidget);
  });

  testWidgets('opens the post identified by a notification', (tester) async {
    const postId = '0000000000-9b520f34-b260-48b1-97d8-343d40e44b09';
    final api = _PostApi();
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () => PostScreen.openFromNotice(context, api, postId),
              child: const Text('開く'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('開く'));
    await tester.pumpAndSettle();
    expect(tester.widget<PostScreen>(find.byType(PostScreen)).id, postId);
    expect(find.text('今日のひとこま'), findsOneWidget);
  });

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
        find.descendant(of: find.byType(AppBar), matching: find.text('全員')),
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
