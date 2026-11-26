import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:video_compress/video_compress.dart';

import 'album_api.dart';
import 'album_widgets.dart';
import '../media/compression.dart';
import 'post_editor.dart';
import 'post_screen.dart';

class AlbumScreen extends StatefulWidget {
  const AlbumScreen(this.api, {super.key, this.active = true, this.albumName});
  final AlbumApi api;
  final bool active;
  final String? albumName;

  @override
  State<AlbumScreen> createState() => _AlbumScreenState();
}

class _AlbumScreenState extends State<AlbumScreen> {
  late Future<(List<AlbumRow>, AlbumRow)> album = load();
  String? child;
  int? year;
  final more = <AlbumRow>[];
  String? page;
  bool busy = false;

  @override
  void didUpdateWidget(covariant AlbumScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.active && !oldWidget.active) reload();
  }

  Future<(List<AlbumRow>, AlbumRow)> load() async {
    final result = await Future.wait([
      widget.api.get('children'),
      widget.api.get('posts', query: {'child': ?child}),
    ]);
    final children = rows(result[0]['children']);
    if (child != null && !children.any((item) => item['id'] == child)) {
      child = null;
      return (children, await widget.api.get('posts'));
    }
    return (children, result[1]);
  }

  void reload() => setState(() {
    more.clear();
    page = null;
    album = load();
  });

  DateTime? captured(AlbumRow post) =>
      DateTime.tryParse(post['capturedAt'] as String? ?? '') ??
      DateTime.tryParse(post['createdAt'] as String? ?? '')?.toLocal();

  Future<void> loadMore(String next) async {
    setState(() => busy = true);
    try {
      final result = await widget.api.get(
        'posts',
        query: {'cursor': next, 'child': ?child},
      );
      if (!mounted) return;
      setState(() {
        more.addAll(rows(result['posts']));
        page = result['next'] as String;
      });
    } catch (failure) {
      if (mounted) showFailure(context, failure);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> addPost(List<AlbumRow> children) async {
    if (busy) return;
    setState(() => busy = true);
    Compressed? selected;
    try {
      selected = await Compression().pickMedia();
    } catch (failure) {
      if (mounted) showFailure(context, failure);
    } finally {
      if (mounted) setState(() => busy = false);
    }
    if (selected == null || !mounted) return;
    final posted = await Navigator.push<bool>(
      context,
      MaterialPageRoute(
        builder: (_) =>
            PostEditor(widget.api, children, selectedMedia: selected),
      ),
    );
    if (posted == true && mounted) {
      year = null;
      reload();
    }
  }

  Future<void> openPost(
    String id,
    List<AlbumRow> children,
    AlbumRow selected,
  ) async {
    final changed = await Navigator.push<bool>(
      context,
      MaterialPageRoute(
        builder: (_) => PostScreen(
          widget.api,
          id,
          children,
          selectedMediaId: selected['id'] as String,
        ),
      ),
    );
    if (changed == true && mounted) reload();
  }

  @override
  Widget build(BuildContext context) => FutureBuilder(
    future: album,
    builder: (context, snapshot) {
      if (snapshot.connectionState != ConnectionState.done) {
        return const Scaffold(body: Center(child: CircularProgressIndicator()));
      }
      if (snapshot.hasError) {
        return Scaffold(
          appBar: AppBar(
            title: Text(widget.albumName ?? widget.api.family.name),
          ),
          body: Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(errorLabel(snapshot.error)),
                TextButton(onPressed: reload, child: const Text('再試行')),
              ],
            ),
          ),
        );
      }

      final (children, feed) = snapshot.data!;
      final posts = [...rows(feed['posts']), ...more];
      final next = page ?? feed['next'] as String;
      final years = <int>{
        DateTime.now().year,
        if (year case final selected?) selected,
        for (final post in posts)
          if (captured(post) case final date?) date.year,
      }.toList()..sort((a, b) => b.compareTo(a));
      final visibleYear =
          year ??
          (posts.isEmpty
              ? DateTime.now().year
              : years.firstWhere(
                  (candidate) =>
                      posts.any((post) => captured(post)?.year == candidate),
                  orElse: () => DateTime.now().year,
                ));
      final months = <int, List<({AlbumRow post, AlbumRow item})>>{};
      final dated = [
        for (final post in posts)
          if (captured(post) case final date?) (post: post, date: date),
      ]..sort((a, b) => b.date.compareTo(a.date));
      for (final entry in dated) {
        if (entry.date.year != visibleYear) continue;
        final group = months.putIfAbsent(entry.date.month, () => []);
        for (final item in rows(entry.post['media'])) {
          group.add((post: entry.post, item: item));
        }
      }
      return Scaffold(
        appBar: AppBar(
          title: DropdownButtonHideUnderline(
            child: DropdownButton<int>(
              value: visibleYear,
              style: Theme.of(context).textTheme.titleLarge,
              iconEnabledColor: Colors.white,
              selectedItemBuilder: (_) => [
                for (final value in years)
                  Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      '$value年',
                      style: const TextStyle(color: Colors.white),
                    ),
                  ),
              ],
              items: [
                for (final value in years)
                  DropdownMenuItem(value: value, child: Text('$value年')),
              ],
              onChanged: (value) => setState(() => year = value),
            ),
          ),
          actions: [
            IconButton(
              tooltip: 'アルバムを更新',
              onPressed: busy ? null : reload,
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
        floatingActionButton: widget.api.family.canPost
            ? FloatingActionButton.extended(
                onPressed: busy ? null : () => addPost(children),
                icon: const Icon(Icons.add),
                label: const Text('追加'),
              )
            : null,
        body: CustomScrollView(
          slivers: [
            if (children.isNotEmpty)
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                sliver: SliverToBoxAdapter(
                  child: Wrap(
                    spacing: 8,
                    children: [
                      ChoiceChip(
                        selectedColor: const Color(0xFFF0E3D3),
                        label: const Text('すべて'),
                        selected: child == null,
                        onSelected: busy
                            ? null
                            : (_) {
                                child = null;
                                reload();
                              },
                      ),
                      for (final item in children)
                        ChoiceChip(
                          selectedColor: const Color(0xFFF0E3D3),
                          showCheckmark: false,
                          avatar: ChildAvatar(
                            item['avatar'] as String?,
                            radius: 12,
                          ),
                          label: Column(
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                item['name'] as String,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                              Text(switch (ageAt(
                                item['birthday'] as String,
                                dateLabel(DateTime.now()),
                                includeZeroYears: true,
                              )) {
                                '' => '誕生予定',
                                final age => age,
                              }, style: Theme.of(context).textTheme.labelSmall),
                            ],
                          ),
                          selected: child == item['id'],
                          onSelected: busy
                              ? null
                              : (_) {
                                  child = item['id'] as String;
                                  reload();
                                },
                        ),
                    ],
                  ),
                ),
              ),
            if (months.isEmpty && next.isEmpty)
              const SliverFillRemaining(
                hasScrollBody: false,
                child: Center(child: Text('表示できる投稿はまだありません。')),
              ),
            for (final month in months.entries) ...[
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
                sliver: SliverToBoxAdapter(
                  child: Text(
                    '${month.key}月',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                ),
              ),
              SliverPadding(
                padding: const EdgeInsets.symmetric(horizontal: 12),
                sliver: SliverGrid.builder(
                  gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                    maxCrossAxisExtent: 150,
                    crossAxisSpacing: 5,
                    mainAxisSpacing: 5,
                  ),
                  itemCount: month.value.length,
                  itemBuilder: (context, index) {
                    final entry = month.value[index];
                    final id = entry.post['id'] as String;
                    return _MediaTile(
                      key: ValueKey((id, entry.item['id'])),
                      api: widget.api,
                      postId: id,
                      item: entry.item,
                      details: () => openPost(id, children, entry.item),
                    );
                  },
                ),
              ),
            ],
            if (next.isNotEmpty)
              SliverPadding(
                padding: const EdgeInsets.all(16),
                sliver: SliverToBoxAdapter(
                  child: OutlinedButton(
                    onPressed: busy
                        ? null
                        : () {
                            year = visibleYear;
                            loadMore(next);
                          },
                    child: const Text('さらに読み込む'),
                  ),
                ),
              ),
            if (busy)
              const SliverToBoxAdapter(child: LinearProgressIndicator()),
            const SliverToBoxAdapter(child: SizedBox(height: 80)),
          ],
        ),
      );
    },
  );
}

class _MediaTile extends StatefulWidget {
  const _MediaTile({
    super.key,
    required this.api,
    required this.postId,
    required this.item,
    required this.details,
  });
  final AlbumApi api;
  final String postId;
  final AlbumRow item;
  final VoidCallback details;

  @override
  State<_MediaTile> createState() => _MediaTileState();
}

class _MediaTileState extends State<_MediaTile> {
  bool get video => widget.item['type'] == 'video/mp4';
  late final Future<Uint8List?> thumbnail = load();

  Future<Uint8List?> load() async {
    final data = await widget.api.media(
      widget.postId,
      widget.item['id'] as String,
    );
    if (!video || !mounted) return video ? null : data;
    final temp = await Directory.systemTemp.createTemp('sukusuku-thumb-');
    try {
      final file = await File('${temp.path}/thumb.mp4').writeAsBytes(data);
      return await VideoCompress.getByteThumbnail(file.path, quality: 45);
    } finally {
      await temp.delete(recursive: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return ClipRRect(
      borderRadius: BorderRadius.circular(10),
      child: Stack(
        fit: StackFit.expand,
        children: [
          FutureBuilder<Uint8List?>(
            future: thumbnail,
            builder: (context, snapshot) {
              final bytes = snapshot.data;
              return bytes == null
                  ? ColoredBox(
                      color: colors.surfaceContainerHighest,
                      child: Icon(
                        video ? Icons.videocam_outlined : Icons.photo_outlined,
                        color: colors.onSurfaceVariant,
                      ),
                    )
                  : Image.memory(
                      bytes,
                      fit: BoxFit.cover,
                      cacheWidth: (150 * MediaQuery.devicePixelRatioOf(context))
                          .round(),
                      excludeFromSemantics: true,
                    );
            },
          ),
          if (video)
            const Center(
              child: CircleAvatar(
                backgroundColor: Colors.black54,
                child: Icon(Icons.play_arrow, color: Colors.white),
              ),
            ),
          Material(
            color: Colors.transparent,
            child: InkWell(
              onTap: widget.details,
              child: Semantics(label: video ? '動画を開く' : '写真を開く'),
            ),
          ),
        ],
      ),
    );
  }
}
