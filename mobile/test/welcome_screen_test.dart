import 'package:family_share/features/family/welcome_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('welcome offers both paths and explains how to open an invite', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(360, 800);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    var created = 0;
    await tester.pumpWidget(
      MaterialApp(home: WelcomeScreen(onCreateAlbum: () => created++)),
    );
    await tester.pumpAndSettle();
    expect(find.text('すくすく'), findsOneWidget);
    expect(find.byType(Image), findsNWidgets(2));

    await tester.tap(find.text('アルバムを作る'));
    expect(created, 1);
    await tester.tap(find.text('招待リンクから参加'));
    await tester.pumpAndSettle();
    expect(find.textContaining('招待リンクをもう一度開いてください'), findsOneWidget);
    expect(find.byType(TextFormField), findsNothing);
    await tester.tap(find.text('閉じる'));
    await tester.pumpAndSettle();
    expect(created, 1);
    expect(find.byType(AlertDialog), findsNothing);

    tester.view.physicalSize = const Size(320, 480);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    final invite = find.text('招待リンクから参加');
    await tester.ensureVisible(invite);
    await tester.pumpAndSettle();
    await tester.tap(invite);
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsOneWidget);
    await tester.tap(find.text('閉じる'));
    await tester.pumpAndSettle();

    for (final label in ['プライバシーポリシー', '利用規約']) {
      final link = find.widgetWithText(TextButton, label);
      await tester.ensureVisible(link);
      await tester.pumpAndSettle();
      expect(link.hitTestable(), findsOneWidget);
    }
  });
}
