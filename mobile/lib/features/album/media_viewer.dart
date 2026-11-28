import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'album_api.dart';
import 'album_widgets.dart';

class MediaViewer extends StatefulWidget {
  const MediaViewer(
    this.api,
    this.post,
    this.media, {
    super.key,
    this.inline = false,
  });
  final AlbumApi api;
  final String post;
  final AlbumRow media;
  final bool inline;

  @override
  State<MediaViewer> createState() => _MediaViewerState();
}

class _MediaViewerState extends State<MediaViewer> {
  static const playback = MethodChannel('biz.wisemap.family_share/video');
  File? videoFile;
  bool playing = false;
  Uint8List? preview;
  String? error;
  bool saving = false;
  bool get video => widget.media['type'] == 'video/mp4';

  Future<Uint8List> download() =>
      widget.api.media(widget.post, widget.media['id'] as String);

  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load() async {
    try {
      final data = video
          ? await download()
          : await widget.api.photo(widget.post, widget.media['id'] as String);
      if (!mounted) return;
      if (!video) {
        setState(() => preview = data);
        return;
      }
      final cache = await playback.invokeMethod<String>('temporaryDirectory');
      if (cache == null) throw StateError('動画用の一時領域を取得できませんでした。');
      final dir = await Directory(cache).createTemp('sukusuku-video-');
      if (!mounted) {
        await dir.delete(recursive: true);
        return;
      }
      try {
        final file = await File('${dir.path}/video.mp4').writeAsBytes(data);
        if (!mounted) {
          await dir.delete(recursive: true);
          return;
        }
        setState(() => videoFile = file);
      } catch (_) {
        await dir.delete(recursive: true);
        rethrow;
      }
    } catch (failure) {
      if (mounted) setState(() => error = errorLabel(failure));
    }
  }

  Future<void> save() async {
    setState(() => saving = true);
    try {
      final data = await download();
      if (!mounted) return;
      final saved = await playback.invokeMethod<bool>('save', {
        'bytes': data,
        'video': video,
      });
      if (mounted && saved == true) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(video ? '動画を保存しました。' : '写真を保存しました。')),
        );
      }
    } on PlatformException catch (failure) {
      if (!mounted) return;
      final message = failure.code == 'save_permission'
          ? '端末の設定ですくすくに写真の追加を許可してください。'
          : '端末に保存できませんでした。空き容量を確認して再試行してください。';
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(message)));
    } catch (failure) {
      if (mounted) showFailure(context, failure);
    } finally {
      if (mounted) setState(() => saving = false);
    }
  }

  Future<void> play(File file) async {
    setState(() => playing = true);
    try {
      await playback.invokeMethod<void>('open', file.path);
    } on PlatformException {
      if (mounted) showFailure(context, StateError('動画を再生できませんでした。'));
    } finally {
      if (mounted) {
        setState(() => playing = false);
      } else {
        await deleteVideo(file);
      }
    }
  }

  Future<void> deleteVideo(File file) async {
    try {
      if (await file.parent.exists()) await file.parent.delete(recursive: true);
    } on FileSystemException {
      // The OS may already have cleared the cache directory.
    }
  }

  @override
  void dispose() {
    final file = videoFile;
    if (file != null && !playing) unawaited(deleteVideo(file));
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final file = videoFile;
    final content = Center(
      child: switch ((preview, file, error)) {
        (_, _, final String failure) => Text(failure),
        (final Uint8List image, _, _) => InteractiveViewer(
          minScale: 1,
          maxScale: 5,
          child: Image.memory(image, fit: BoxFit.contain),
        ),
        (_, final File movie, _) => FilledButton.icon(
          onPressed: playing ? null : () => play(movie),
          icon: const Icon(Icons.play_arrow),
          label: const Text('動画を再生'),
        ),
        _ => const CircularProgressIndicator(),
      },
    );
    final saveButton = IconButton(
      onPressed: saving || error != null ? null : save,
      tooltip: '端末に保存',
      icon: saving
          ? const SizedBox.square(
              dimension: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : const Icon(Icons.file_download_outlined),
    );
    if (widget.inline) {
      return Stack(
        fit: StackFit.expand,
        children: [
          content,
          Align(
            alignment: Alignment.topRight,
            child: Material(
              color: Theme.of(context).colorScheme.surfaceContainer,
              shape: const CircleBorder(),
              child: saveButton,
            ),
          ),
        ],
      );
    }
    return Scaffold(
      appBar: AppBar(title: Text(video ? '動画' : '写真'), actions: [saveButton]),
      body: content,
    );
  }
}
