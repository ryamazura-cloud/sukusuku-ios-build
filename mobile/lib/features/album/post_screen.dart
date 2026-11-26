import 'package:flutter/material.dart';

import 'album_api.dart';
import 'album_widgets.dart';
import 'media_viewer.dart';
import 'post_editor.dart';

class PostScreen extends StatefulWidget {
  const PostScreen(
    this.api,
    this.id,
    this.children, {
    super.key,
    this.selectedMediaId,
  });
  final AlbumApi api;
  final String id;
  final List<AlbumRow> children;
  final String? selectedMediaId;
  @override
  State<PostScreen> createState() => _PostScreenState();
}

class _PostScreenState extends State<PostScreen> {
  static const _background = Color(0xFFFFFCF6);

  late Future<AlbumRow> postData = widget.api.get(endpoint);
  late Future<AlbumRow> discussionData = loadDiscussion();
  final more = <AlbumRow>[];
  String? page;
  bool busy = false;
  final commentInput = TextEditingController();
  final updatedComments = <String, AlbumRow>{};
  String? selected;

  @override
  void dispose() {
    commentInput.dispose();
    super.dispose();
  }

  bool changed = false;
  String get endpoint => 'posts/${widget.id}';

  Future<AlbumRow> loadDiscussion() => widget.api.get('$endpoint/discussion');

  Future<void> act(
    Future<void> Function() operation, {
    bool reload = true,
  }) async {
    if (busy) return;
    setState(() => busy = true);
    try {
      await operation();
      if (mounted && reload) {
        setState(() {
          discussionData = loadDiscussion();
          more.clear();
          updatedComments.clear();
          page = null;
        });
      }
    } catch (failure) {
      if (mounted) showFailure(context, failure);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> editComment(AlbumRow item) async {
    final value = await textDialog(
      context,
      'コメントを編集',
      label: 'コメント',
      initial: item['body'] as String? ?? '',
      maxLength: 800,
    );
    if (value == null || value.trim().isEmpty || !mounted) return;
    await act(() async {
      await widget.api.change('$endpoint/comments/${item['id']}', 'PUT', {
        'body': value,
      });
    });
  }

  Future<void> sendComment() async {
    final text = commentInput.text.trim();
    if (text.isEmpty) return;
    await act(() async {
      await widget.api.change('$endpoint/comments', 'POST', {'body': text});
      if (mounted) commentInput.clear();
    });
  }

  Future<void> reactToComment(AlbumRow item, String kind, bool enabled) async {
    final id = item['id'] as String;
    await act(() async {
      await widget.api.change('$endpoint/comments/$id/reactions/$kind', 'PUT', {
        'enabled': enabled,
      });
      if (!mounted) return;
      final current = updatedComments[id] ?? item;
      final counts = {...?current['reactions'] as AlbumRow?};
      final own = {...?current['own'] as List?};
      if (enabled ? own.add(kind) : own.remove(kind)) {
        counts[kind] = (counts[kind] as int? ?? 0) + (enabled ? 1 : -1);
      }
      setState(
        () => updatedComments[id] = {
          ...current,
          'reactions': counts,
          'own': own.toList(),
        },
      );
    }, reload: false);
  }

  Future<String?> pickReaction(String title) => showModalBottomSheet<String>(
    context: context,
    useSafeArea: true,
    builder: (context) => SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 16, 12, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(title, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 12),
            GridView.count(
              crossAxisCount: 10,
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              children: [
                for (final entry in reactions.entries)
                  InkWell(
                    borderRadius: BorderRadius.circular(20),
                    onTap: () => Navigator.pop(context, entry.key),
                    child: Center(
                      child: FittedBox(
                        fit: BoxFit.scaleDown,
                        child: Text(
                          entry.value,
                          style: const TextStyle(fontSize: 22),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    ),
  );

  Widget reactionBar({
    required AlbumRow counts,
    required List<dynamic> own,
    required String title,
    required void Function(String kind, bool enabled) onChanged,
    WrapAlignment alignment = WrapAlignment.start,
  }) => Wrap(
    alignment: alignment,
    crossAxisAlignment: WrapCrossAlignment.center,
    spacing: 4,
    children: [
      for (final entry in reactions.entries)
        if ((counts[entry.key] as int? ?? 0) > 0)
          FilterChip(
            visualDensity: VisualDensity.compact,
            showCheckmark: false,
            label: Text('${entry.value} ${counts[entry.key]}'),
            selected: own.contains(entry.key),
            onSelected: busy
                ? null
                : (enabled) => onChanged(entry.key, enabled),
          ),
      IconButton(
        tooltip: title,
        icon: const Icon(Icons.add_reaction_outlined),
        onPressed: busy
            ? null
            : () async {
                final kind = await pickReaction(title);
                if (kind != null && mounted)
                  onChanged(kind, !own.contains(kind));
              },
      ),
    ],
  );

  Widget commentBubble(AlbumRow item, {Widget? menu}) {
    final current = updatedComments[item['id']] ?? item;
    final mine = item['mine'] == true;
    final colors = Theme.of(context).colorScheme;
    final alignment = mine ? WrapAlignment.end : WrapAlignment.start;
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: FractionallySizedBox(
        widthFactor: .86,
        child: Column(
          crossAxisAlignment: mine
              ? CrossAxisAlignment.end
              : CrossAxisAlignment.start,
          children: [
            Wrap(
              alignment: alignment,
              crossAxisAlignment: WrapCrossAlignment.center,
              spacing: 8,
              children: [
                Text(
                  item['name'] as String,
                  style: Theme.of(context).textTheme.labelLarge
                      ?.copyWith(fontWeight: FontWeight.w700),
                ),
                Tooltip(
                  message: timeLabel(item['at']),
                  child: Text(
                    relativeTime(item['at']),
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
                if (menu != null) menu,
              ],
            ),
            const SizedBox(height: 4),
            DecoratedBox(
              decoration: BoxDecoration(
                color: mine
                    ? colors.primaryContainer
                    : colors.surfaceContainerHighest,
                borderRadius: BorderRadius.only(
                  topLeft: Radius.circular(mine ? 18 : 4),
                  topRight: Radius.circular(mine ? 4 : 18),
                  bottomLeft: const Radius.circular(18),
                  bottomRight: const Radius.circular(18),
                ),
              ),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 9,
                ),
                child: Text(
                  item['body'] as String,
                  style: TextStyle(
                    color: mine ? colors.onPrimaryContainer : colors.onSurface,
                  ),
                ),
              ),
            ),
            reactionBar(
              counts: current['reactions'] as AlbumRow? ?? {},
              own: current['own'] as List? ?? [],
              title: 'コメントにリアクション',
              alignment: alignment,
              onChanged: (kind, enabled) =>
                  reactToComment(current, kind, enabled),
            ),
          ],
        ),
      ),
    );
  }

  Widget authorLine(String name, Object? timestamp, {Widget? menu}) => Row(
    children: [
      Expanded(
        child: Text(
          name,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: Theme.of(context).textTheme.titleMedium
              ?.copyWith(fontWeight: FontWeight.w700),
        ),
      ),
      Tooltip(
        message: timeLabel(timestamp),
        child: Text(
          relativeTime(timestamp),
          style: Theme.of(context).textTheme.bodySmall
              ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
        ),
      ),
      if (menu != null) menu,
    ],
  );

  Widget postContent({
    required Widget header,
    required String text,
    Widget? extra,
  }) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          header,
          if (text.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(
              text,
              style: theme.textTheme.bodyLarge?.copyWith(height: 1.45),
            ),
          ],
          if (extra != null) extra,
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: _background,
    appBar: AppBar(
      centerTitle: true,
      toolbarHeight: 68,
      title: FutureBuilder(
        future: postData,
        builder: (context, snapshot) {
          final post = snapshot.data;
          if (post == null) return const Text('投稿');
          final day = DateTime.tryParse(post['capturedAt'] as String? ?? '');
          final title = day == null
              ? '投稿'
              : '${day.year}年${day.month}月${day.day}日';
          return Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(title),
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.lock_outline, size: 14),
                  const SizedBox(width: 5),
                  Flexible(
                    child: Text(
                      scopes[post['scope']] ?? '',
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 13),
                    ),
                  ),
                ],
              ),
            ],
          );
        },
      ),
      leading: BackButton(onPressed: () => Navigator.pop(context, changed)),
    ),
    body: FutureBuilder<AlbumRow>(
      future: discussionData,
      builder: (context, discussionSnapshot) => FutureBuilder<AlbumRow>(
        future: postData,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done &&
              !snapshot.hasData) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return Center(child: Text(errorLabel(snapshot.error)));
          }
          final post = snapshot.data!;
          final discussion = discussionSnapshot.data ?? {};
          final counts = discussion['reactions'] as AlbumRow? ?? {};
          final own = discussion['own'] as List? ?? [];
          final next = page ?? discussion['next'] as String? ?? '';
          final comments =
              {
                for (final item in [...more, ...rows(discussion['comments'])])
                  item['id']: item,
              }.values.toList()..sort((a, b) {
                final order = (a['at'] as String? ?? '').compareTo(
                  b['at'] as String? ?? '',
                );
                return order != 0
                    ? order
                    : (a['id'] as String).compareTo(b['id'] as String);
              });
          final images = rows(post['media']);
          final media =
              images
                  .where(
                    (item) =>
                        item['id'] == (selected ?? widget.selectedMediaId),
                  )
                  .firstOrNull ??
              images.firstOrNull;
          final mediaIndex = images.indexWhere(
            (item) => item['id'] == media?['id'],
          );
          final path = widget.api;
          return ListView(
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 28),
            children: [
              if (media != null)
                ClipRRect(
                  borderRadius: BorderRadius.circular(20),
                  child: SizedBox(
                    height: (MediaQuery.sizeOf(context).width * .96)
                        .clamp(240.0, 530.0)
                        .toDouble(),
                    child: MediaViewer(
                      path,
                      widget.id,
                      media,
                      key: ValueKey(media['id']),
                      inline: true,
                    ),
                  ),
                ),
              if (images.length > 1)
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    IconButton(
                      tooltip: '前のメディア',
                      onPressed: mediaIndex > 0
                          ? () => setState(
                              () => selected =
                                  images[mediaIndex - 1]['id'] as String,
                            )
                          : null,
                      icon: const Icon(Icons.chevron_left),
                    ),
                    Text('${mediaIndex + 1} / ${images.length}'),
                    IconButton(
                      tooltip: '次のメディア',
                      onPressed: mediaIndex + 1 < images.length
                          ? () => setState(
                              () => selected =
                                  images[mediaIndex + 1]['id'] as String,
                            )
                          : null,
                      icon: const Icon(Icons.chevron_right),
                    ),
                  ],
                ),
              const SizedBox(height: 12),
              postContent(
                header: authorLine(post['author'] as String, post['createdAt']),
                text: post['body'] as String,
                extra: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    for (final child in widget.children)
                      if ((post['childIds'] as List).contains(child['id']))
                        Padding(
                          padding: const EdgeInsets.only(top: 8),
                          child: Text(
                            '${child['name']}  ${ageAt(child['birthday'] as String, post['capturedAt'] as String)}',
                          ),
                        ),
                  ],
                ),
              ),
              if (post['mine'] == true || post['canDelete'] == true)
                Wrap(
                  spacing: 8,
                  children: [
                    if (post['mine'] == true)
                      OutlinedButton(
                        onPressed: busy
                            ? null
                            : () async {
                                final saved = await Navigator.push<bool>(
                                  context,
                                  MaterialPageRoute(
                                    builder: (_) => PostEditor(
                                      path,
                                      widget.children,
                                      post: post,
                                    ),
                                  ),
                                );
                                if (saved == true && mounted) {
                                  setState(() {
                                    changed = true;
                                    postData = widget.api.get(endpoint);
                                  });
                                }
                              },
                        child: const Text('編集'),
                      ),
                    if (post['canDelete'] == true)
                      TextButton(
                        onPressed: busy
                            ? null
                            : () async {
                                if (!await confirm(
                                      context,
                                      '投稿を削除',
                                      '写真・動画、コメントも削除されます。',
                                    ) ||
                                    !mounted) {
                                  return;
                                }
                                await act(() async {
                                  await path.change(endpoint, 'DELETE');
                                  if (mounted)
                                    Navigator.pop(this.context, true);
                                }, reload: false);
                              },
                        child: const Text('削除'),
                      ),
                  ],
                ),
              const Divider(),
              if (discussionSnapshot.hasError)
                TextButton(
                  onPressed: () =>
                      setState(() => discussionData = loadDiscussion()),
                  child: const Text('コメントとリアクションを再読み込み'),
                )
              else if (discussionSnapshot.connectionState !=
                  ConnectionState.done)
                const LinearProgressIndicator(),
              if (discussionSnapshot.hasData)
                reactionBar(
                  counts: counts,
                  own: own,
                  title: '投稿にリアクション',
                  onChanged: (kind, enabled) => act(() async {
                    await path.change('$endpoint/reactions/$kind', 'PUT', {
                      'enabled': enabled,
                    });
                  }),
                ),
              for (final item in comments)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: commentBubble(
                    item,
                    menu: item['mine'] == true || path.family.canInvite
                        ? PopupMenuButton<String>(
                            enabled: !busy,
                            onSelected: (value) async {
                              if (value == 'edit') {
                                await editComment(item);
                                return;
                              }
                              if (!await confirm(
                                    context,
                                    'コメントを削除',
                                    'このコメントを削除します。',
                                  ) ||
                                  !mounted) {
                                return;
                              }
                              await act(() async {
                                await path.change(
                                  '$endpoint/comments/${item['id']}',
                                  'DELETE',
                                );
                              });
                            },
                            itemBuilder: (_) => [
                              if (item['mine'] == true)
                                const PopupMenuItem(
                                  value: 'edit',
                                  child: Text('編集'),
                                ),
                              const PopupMenuItem(
                                value: 'delete',
                                child: Text('削除'),
                              ),
                            ],
                          )
                        : null,
                  ),
                ),
              const SizedBox(height: 16),
              TextField(
                controller: commentInput,
                enabled: !busy,
                maxLength: 800,
                minLines: 1,
                maxLines: 4,
                decoration: InputDecoration(
                  labelText: 'コメントを入力',
                  suffixIcon: IconButton(
                    onPressed: busy ? null : sendComment,
                    tooltip: 'コメントを送信',
                    icon: const Icon(Icons.send_outlined),
                  ),
                ),
              ),
              if (next.isNotEmpty)
                OutlinedButton(
                  onPressed: busy
                      ? null
                      : () => act(() async {
                          final result = await path.get(
                            '$endpoint/discussion',
                            query: {'cursor': next},
                          );
                          if (mounted) {
                            setState(() {
                              more.addAll(rows(result['comments']));
                              page = result['next'] as String;
                            });
                          }
                        }, reload: false),
                  child: const Text('以前のコメントを表示'),
                ),
              if (busy) const LinearProgressIndicator(),
            ],
          );
        },
      ),
    ),
  );
}
