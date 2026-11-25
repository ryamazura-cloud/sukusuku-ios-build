import 'package:family_share/features/media/constraints.dart';
import 'package:family_share/main.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('unconfigured app presents setup guidance', (tester) async {
    await tester.pumpWidget(const SetupMessage('開発環境のFirebase設定を読み込んでください。'));
    expect(find.text('開発環境のFirebase設定を読み込んでください。'), findsOneWidget);
  });

  test('video duration boundary', () {
    expect(validVideoDuration(60000), isTrue);
    expect(validVideoDuration(60000.1), isFalse);
    expect(validVideoDuration(0), isFalse);
    expect(validVideoDuration(double.nan), isFalse);
    expect(validVideoDuration(null), isFalse);
  });
}
