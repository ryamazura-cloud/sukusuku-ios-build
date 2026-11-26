import 'package:flutter/material.dart';
import 'package:uuid/uuid.dart';

import '../media/compression.dart';
import 'album_api.dart';
import 'album_widgets.dart';

class PostEditor extends StatefulWidget {
  const PostEditor(
    this.api,
    this.children, {
    super.key,
    this.post,
    this.selectedMedia,
  });
  final AlbumApi api;
  final List<AlbumRow> children;
  final AlbumRow? post;
  final Compressed? selectedMedia;

  @override
  State<PostEditor> createState() => _PostEditorState();
}

class _PostEditorState extends State<PostEditor> {
  late final body = TextEditingController(
    text: widget.post?['body'] as String? ?? '',
  );
  late String? scope = widget.post?['scope'] as String?;
  late DateTime? date = widget.post == null
      ? DateUtils.dateOnly(DateTime.now())
      : DateTime.tryParse(widget.post?['capturedAt'] as String? ?? '');
  late final tags = ((widget.post?['childIds'] as List?)?.cast<String>() ?? [])
      .where((id) => widget.children.any((child) => child['id'] == id))
      .toSet();
  late final attachments = [
    if (widget.selectedMedia case final file?)
      (id: const Uuid().v4(), file: file),
  ];
  String? draft;
  int uploaded = 0;
  String? progress;
  String? error;
  bool busy = false;

  @override
  void dispose() {
    body.dispose();
    super.dispose();
  }

  Future<void> submit() async {
    if (busy) return;
    final text = body.text.trim();
    final audience = scope;
    final captured = date;
    if (audience == null || captured == null) {
      setState(() => error = '共有範囲と撮影日を入力してください。');
      return;
    }
    if (widget.post == null && attachments.isEmpty) {
      setState(() => error = '写真または動画を選んでください。');
      return;
    }
    setState(() {
      busy = true;
      error = null;
      progress = '投稿を準備中…';
    });
    try {
      final fields = {
        'body': text,
        'scope': audience,
        'childIds': tags.toList(),
        'capturedAt': dateLabel(captured),
      };
      final existing = widget.post;
      if (existing != null) {
        await widget.api.change('posts/${existing['id']}', 'PUT', fields);
      } else {
        draft ??=
            (await widget.api.change('posts', 'POST', {
                  ...fields,
                  'media': [
                    for (final attachment in attachments)
                      {'id': attachment.id, 'type': attachment.file.mime},
                  ],
                }))['id']
                as String;
        while (uploaded < attachments.length) {
          if (!mounted) return;
          setState(
            () => progress = 'アップロード中 ${uploaded + 1}/${attachments.length}',
          );
          final attachment = attachments[uploaded];
          await widget.api.upload(
            draft!,
            attachment.id,
            attachment.file.bytes,
            attachment.file.mime,
          );
          uploaded++;
        }
        if (mounted) setState(() => progress = '公開中…');
        await widget.api.change('posts/$draft/publish', 'POST');
      }
      if (mounted) {
        setState(() => busy = false);
        Navigator.pop(context, true);
      }
    } catch (failure) {
      if (mounted) {
        setState(() {
          busy = false;
          progress = null;
          error = errorLabel(failure);
        });
      }
    }
  }

  Future<void> discard() async {
    final id = draft;
    if (id == null) return;
    if (!await confirm(context, '投稿を取り消す', 'アップロード済みのメディアも削除されます。')) return;
    if (!mounted) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await widget.api.change('posts/$id', 'DELETE');
      if (mounted) {
        setState(() {
          draft = null;
          uploaded = 0;
          busy = false;
        });
      }
    } catch (failure) {
      if (mounted) {
        setState(() {
          busy = false;
          error = errorLabel(failure);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final locked = busy || draft != null;
    return PopScope(
      canPop: !busy && draft == null,
      child: Scaffold(
        appBar: AppBar(title: Text(widget.post == null ? '新しい投稿' : '投稿を編集')),
        body: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            for (final item in attachments)
              ListTile(
                leading: item.file.mime == 'image/jpeg'
                    ? Image.memory(
                        item.file.bytes,
                        width: 54,
                        height: 54,
                        fit: BoxFit.cover,
                        cacheWidth: 108,
                      )
                    : const Icon(Icons.videocam_outlined),
                title: Text(
                  item.file.mime == 'image/jpeg' ? '選択した写真' : '選択した動画',
                ),
              ),
            TextField(
              controller: body,
              enabled: !locked,
              maxLength: 1200,
              maxLines: 4,
              decoration: const InputDecoration(labelText: '投稿本文（任意）'),
            ),
            DropdownButtonFormField<String>(
              initialValue: scope,
              decoration: const InputDecoration(labelText: '共有範囲（必須）'),
              items: [
                for (final entry in scopes.entries)
                  if (entry.key != 'parents' || scope == 'parents')
                    DropdownMenuItem(
                      value: entry.key,
                      enabled: entry.key != 'parents',
                      child: Text(entry.value),
                    ),
              ],
              onChanged: locked
                  ? null
                  : (value) => setState(() => scope = value),
            ),
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('撮影日（必須）'),
              subtitle: Text(date == null ? '日付を選択' : dateLabel(date!)),
              trailing: const Icon(Icons.calendar_today),
              onTap: locked
                  ? null
                  : () async {
                      final next = await showDatePicker(
                        context: context,
                        initialDate: date ?? DateTime.now(),
                        firstDate: DateTime(1900),
                        lastDate: DateTime.now(),
                      );
                      if (next != null && mounted) setState(() => date = next);
                    },
            ),
            if (widget.children.isNotEmpty) const Text('こども（任意）'),
            if (widget.children.isNotEmpty)
              Wrap(
                spacing: 8,
                children: [
                  for (final child in widget.children)
                    FilterChip(
                      label: Text(child['name'] as String),
                      selected: tags.contains(child['id']),
                      onSelected: locked
                          ? null
                          : (enabled) => setState(() {
                              final id = child['id'] as String;
                              if (enabled) {
                                tags.add(id);
                              } else {
                                tags.remove(id);
                              }
                            }),
                    ),
                ],
              ),
            if (progress case final value?) ...[
              const LinearProgressIndicator(),
              Text(value),
            ],
            if (error case final failure?) Text(failure),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: busy ? null : submit,
              child: Text(
                draft != null
                    ? '再試行'
                    : widget.post == null
                    ? '投稿する'
                    : '変更を保存',
              ),
            ),
            if (draft != null)
              TextButton(
                onPressed: busy ? null : discard,
                child: const Text('投稿を取り消す'),
              ),
          ],
        ),
      ),
    );
  }
}
