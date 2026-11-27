import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_image_compress/flutter_image_compress.dart';
import 'package:image_picker/image_picker.dart';
import 'package:video_compress/video_compress.dart';

import 'constraints.dart';

typedef Compressed = ({
  Uint8List bytes,
  String mime,
  int original,
  double? milliseconds,
  DateTime? capturedAt,
});

final _captureDay = RegExp(r'^(\d{4})([-:]?)(\d{2})\2(\d{2})(?=$|[TtZz ])');

DateTime? parseCaptureDate(String? value, {DateTime? today}) {
  final raw = value?.trim() ?? '';
  // UTC creation timestamps from video containers are shown in local time.
  final utc = raw.endsWith('Z') ? DateTime.tryParse(raw) : null;
  final match = _captureDay.firstMatch(raw);
  if (match == null) return null;
  final year = int.parse(match[1]!);
  final month = int.parse(match[3]!);
  final day = int.parse(match[4]!);
  final original = DateTime(year, month, day);
  if (year < 1900 || original.month != month || original.day != day)
    return null;
  final local = utc?.toLocal() ?? original;
  final date = DateTime(local.year, local.month, local.day);
  final now = today ?? DateTime.now();
  return date.isAfter(DateTime(now.year, now.month, now.day)) ? null : date;
}

class Compression {
  Future<Compressed?> pick(bool video) async {
    final picker = ImagePicker();
    final picked = video
        ? await picker.pickVideo(source: ImageSource.gallery)
        : await picker.pickImage(
            source: ImageSource.gallery,
            requestFullMetadata: false,
          );
    return picked == null ? null : compress(picked, video: video);
  }

  Future<Compressed?> capturePhoto() async {
    final picked = await ImagePicker().pickImage(
      source: ImageSource.camera,
      requestFullMetadata: false,
    );
    return picked == null ? null : compress(picked, video: false);
  }

  Future<Compressed?> pickMedia() async {
    final picked = await ImagePicker().pickMedia();
    if (picked == null) return null;
    final extension = picked.path.split('.').last.toLowerCase();
    final video =
        picked.mimeType?.startsWith('video/') == true ||
        {
          'mp4',
          'mov',
          'm4v',
          'webm',
          '3gp',
          '3g2',
          'mkv',
          'avi',
          'mpeg',
          'mpg',
          'ts',
        }.contains(extension);
    return compress(picked, video: video);
  }

  Future<Compressed> compress(XFile picked, {required bool video}) async {
    final original = await picked.length();
    final capturedAt = await _captureDate(picked.path, video);
    if (!video) {
      final bytes = await FlutterImageCompress.compressWithFile(
        picked.path,
        minWidth: 1280,
        minHeight: 1280,
        quality: 76,
        format: CompressFormat.jpeg,
        keepExif: false,
      );
      if (bytes == null) throw StateError('画像を圧縮できませんでした。');
      return (
        bytes: _validBytes(bytes),
        mime: 'image/jpeg',
        original: original,
        milliseconds: null,
        capturedAt: capturedAt,
      );
    }
    final input = await VideoCompress.getMediaInfo(picked.path);
    if (!validVideoDuration(input.duration))
      throw StateError('60秒以下の動画を選んでください。');
    final output = await VideoCompress.compressVideo(
      picked.path,
      quality: VideoQuality.MediumQuality,
      includeAudio: true,
      deleteOrigin: false,
    );
    final file = output?.file;
    if (file == null || file.path == picked.path)
      throw StateError('動画を圧縮できませんでした。');
    try {
      if (!validVideoDuration(output?.duration))
        throw StateError('圧縮後の動画時間を検証できませんでした。');
      if (await file.length() > uploadLimit)
        throw StateError('圧縮後の動画が16MBを超えています。');
      return (
        bytes: _validBytes(await file.readAsBytes()),
        mime: 'video/mp4',
        original: original,
        milliseconds: output?.duration,
        capturedAt: capturedAt,
      );
    } finally {
      await _deleteTemporary(file);
    }
  }

  static const _metadata = MethodChannel('biz.wisemap.family_share/metadata');

  Future<DateTime?> _captureDate(String path, bool video) async {
    try {
      final raw = await _metadata.invokeMethod<String>('captureDate', {
        'path': path,
        'video': video,
      });
      return parseCaptureDate(raw);
    } on PlatformException {
      return null;
    } on MissingPluginException {
      return null;
    }
  }

  Future<void> _deleteTemporary(File file) async {
    if (await file.exists()) await file.delete();
  }

  Uint8List _validBytes(Uint8List bytes) {
    if (bytes.isEmpty || bytes.length > uploadLimit) {
      throw StateError('圧縮後のファイルは1バイト以上、16MB以下にしてください。');
    }
    return bytes;
  }
}
