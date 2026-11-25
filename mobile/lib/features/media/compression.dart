import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_image_compress/flutter_image_compress.dart';
import 'package:image_picker/image_picker.dart';
import 'package:video_compress/video_compress.dart';

import 'constraints.dart';

typedef Compressed = ({
  Uint8List bytes,
  String mime,
  int original,
  double? milliseconds,
});

class Compression {
  Future<Compressed?> pick(bool video) async {
    final picker = ImagePicker();
    final picked = video
        ? await picker.pickVideo(source: ImageSource.gallery)
        : await picker.pickImage(
            source: ImageSource.gallery,
            requestFullMetadata: false,
          );
    if (picked == null) return null;
    final original = await picked.length();
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
      );
    } finally {
      await _deleteTemporary(file);
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
