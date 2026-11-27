import 'dart:async';

import '../family/family_api.dart';
import 'album_api.dart';

class ForegroundUsage {
  ForegroundUsage(this.api, this.onRemoved);
  final AlbumApi api;
  final void Function() onRemoved;
  final _clock = Stopwatch();
  Timer? _timer;
  Future<void> _pending = Future.value();
  int _startedAt = 0;

  void resume() {
    if (_timer != null) return;
    _startInterval();
    _timer = Timer.periodic(const Duration(minutes: 1), (_) => _report());
  }

  void pause() {
    _timer?.cancel();
    _timer = null;
    if (_clock.isRunning) _report(restart: false);
  }

  void _startInterval() {
    _startedAt = DateTime.now().millisecondsSinceEpoch;
    _clock
      ..reset()
      ..start();
  }

  void _report({bool restart = true}) {
    _clock.stop();
    final duration = _clock.elapsedMilliseconds;
    final end = _startedAt + duration;
    final start = end - (duration > 75000 ? 75000 : duration);
    if (restart) _startInterval();
    if (start == end) return;
    _pending = _pending.then((_) async {
      try {
        await api.change('usage', 'PUT', {'start': start, 'end': end});
      } on FamilyApiException catch (error) {
        if (error.reason == 'family membership required') onRemoved();
      } catch (_) {
        // A tracking request should never block browsing.
      }
    });
  }
}
