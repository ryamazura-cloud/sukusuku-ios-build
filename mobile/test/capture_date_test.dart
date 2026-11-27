import 'package:family_share/features/media/compression.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final today = DateTime(2026, 11, 27);

  test('reads camera EXIF and video creation dates', () {
    expect(
      parseCaptureDate('2024:02:29 08:02:10', today: today),
      DateTime(2024, 2, 29),
    );
    expect(
      parseCaptureDate('2025-07-03T01:00:00+09:00', today: today),
      DateTime(2025, 7, 3),
    );
    final local = DateTime.utc(2025, 7, 3, 23).toLocal();
    expect(
      parseCaptureDate('20250703T230000.000Z', today: today),
      DateTime(local.year, local.month, local.day),
    );
  });

  test('falls back when the metadata is absent or invalid', () {
    for (final value in [null, '', '1904-00-00', '2025:02:29', '2026-11-28']) {
      expect(parseCaptureDate(value, today: today), isNull);
    }
  });
}
