import 'dart:convert';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_image_compress/flutter_image_compress.dart';
import 'package:image_picker/image_picker.dart';
import 'package:flutter/material.dart';
import 'package:uuid/uuid.dart';

import '../family/family_api.dart';
import '../notifications/probe.dart';
import 'album_api.dart';
import 'album_widgets.dart';
import 'post_screen.dart';

class AccountScreen extends StatefulWidget {
  const AccountScreen(this.api, this.user, {super.key});
  final FamilyApi api;
  final User user;
  @override
  State<AccountScreen> createState() => _AccountScreenState();
}

class _AccountScreenState extends State<AccountScreen> {
  late Future<AlbumRow> profile = widget.api.request('profile');
  bool busy = false;

  Future<void> run(Future<void> Function() task) async {
    setState(() => busy = true);
    try {
      await task();
    } on FirebaseAuthException catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('認証を完了できませんでした（${error.code}）。')),
        );
      }
    } catch (failure) {
      if (mounted) showFailure(context, failure);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> retire() async {
    if (!await confirm(
          context,
          'アカウントを削除',
          '本人の投稿・写真・動画・コメントを削除します。管理者が1人の場合は、先にパートナーを招待してください。',
        ) ||
        !mounted) {
      return;
    }
    final password = await textDialog(
      context,
      '本人確認',
      label: 'パスワード',
      secret: true,
      maxLength: 200,
    );
    final email = widget.user.email;
    if (password == null || email == null || !mounted) return;
    await run(() async {
      final user = widget.user;
      await user.reauthenticateWithCredential(
        EmailAuthProvider.credential(email: email, password: password),
      );
      await user.getIdToken(true);
      await widget.api.request('account', method: 'DELETE');
      await user.delete();
      if (mounted) Navigator.pop(context);
    });
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('アカウント設定')),
    body: ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Text(widget.user.email ?? ''),
        FutureBuilder(
          future: profile,
          builder: (context, snapshot) {
            if (snapshot.connectionState != ConnectionState.done) {
              return const LinearProgressIndicator();
            }
            if (snapshot.hasError) return Text(errorLabel(snapshot.error));
            final name = snapshot.data?['name'] as String? ?? '';
            return ListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('表示名'),
              subtitle: Text(name.isEmpty ? '未設定' : name),
              onTap: busy
                  ? null
                  : () async {
                      final value = await textDialog(
                        context,
                        '表示名を編集',
                        label: '表示名',
                        initial: name,
                      );
                      if (value == null || value.trim().isEmpty || !mounted) {
                        return;
                      }
                      await run(() async {
                        final saved = await widget.api.request(
                          'profile',
                          method: 'PUT',
                          body: {'name': value},
                        );
                        if (mounted) {
                          setState(() => profile = Future.value(saved));
                        }
                      });
                    },
            );
          },
        ),
        TextButton(
          onPressed: busy ? null : retire,
          child: const Text('アカウントを削除'),
        ),
        if (busy) const LinearProgressIndicator(),
      ],
    ),
  );
}

class ChildScreen extends StatefulWidget {
  const ChildScreen(this.api, {super.key});
  final AlbumApi api;
  @override
  State<ChildScreen> createState() => _ChildScreenState();
}

class _ChildScreenState extends State<ChildScreen> {
  late Future<AlbumRow> data = widget.api.get('children');
  bool busy = false;

  Future<void> change(String id, [Map<String, Object?>? fields]) async {
    setState(() => busy = true);
    try {
      final previous = await data;
      final confirmed = await widget.api.changeChild(id, fields);
      if (!mounted) return;
      if (confirmed != null) {
        setState(() => data = Future.value(confirmed));
        return;
      }
      final children = rows(previous['children']).toList();
      final index = children.indexWhere((item) => item['id'] == id);
      if (fields == null) {
        if (index >= 0) children.removeAt(index);
      } else if (index < 0) {
        children.add({'id': id, ...fields});
      } else {
        children[index] = {...children[index], ...fields};
      }
      setState(() => data = Future.value({...previous, 'children': children}));
    } catch (failure) {
      if (mounted) showFailure(context, failure);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> editAvatar(AlbumRow child) async {
    final id = child['id'] as String;
    setState(() => busy = true);
    try {
      final picked = await ImagePicker().pickImage(
        source: ImageSource.gallery,
        maxWidth: 128,
        maxHeight: 128,
        requestFullMetadata: false,
      );
      if (picked == null || !mounted) return;
      final bytes = await FlutterImageCompress.compressWithFile(
        picked.path,
        minWidth: 96,
        minHeight: 96,
        quality: 68,
        format: CompressFormat.jpeg,
        keepExif: false,
      );
      if (!mounted) return;
      if (bytes == null || bytes.isEmpty || bytes.length > 10500) {
        throw StateError('アイコン用の画像に変換できませんでした。別の画像を選んでください。');
      }
      await change(id, {'avatar': base64Encode(bytes)});
    } catch (failure) {
      if (mounted) showFailure(context, failure);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> edit([AlbumRow? child]) async {
    final name = await textDialog(
      context,
      child == null ? '子どもを登録' : '子ども情報を編集',
      label: '名前・ニックネーム',
      initial: child?['name'] as String? ?? '',
    );
    if (name == null || name.trim().isEmpty || !mounted) return;
    final birthday = await showDatePicker(
      context: context,
      helpText: '生年月日を選択',
      initialDate:
          DateTime.tryParse(child?['birthday'] as String? ?? '') ??
          DateTime.now(),
      firstDate: DateTime(1900),
      lastDate: DateTime(9999, 12, 31),
    );
    if (birthday == null || !mounted) return;
    final id = child?['id'] as String? ?? const Uuid().v4();
    await change(id, {'name': name.trim(), 'birthday': dateLabel(birthday)});
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('子どものプロフィール')),
    body: FutureBuilder(
      future: data,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snapshot.hasError) {
          return Center(child: Text(errorLabel(snapshot.error)));
        }
        final children = rows(snapshot.data?['children']);
        return ListView(
          padding: const EdgeInsets.all(20),
          children: [
            if (widget.api.family.canPost)
              FilledButton(
                onPressed: busy ? null : () => edit(),
                child: const Text('子どもを登録'),
              ),
            if (children.isEmpty)
              const Padding(
                padding: EdgeInsets.all(12),
                child: Text('子どもはまだ登録されていません。'),
              ),
            for (final item in children)
              ListTile(
                title: Text(item['name'] as String),
                subtitle: Text(item['birthday'] as String),
                leading: ChildAvatar(item['avatar'] as String?),
                trailing: widget.api.family.canPost
                    ? PopupMenuButton<String>(
                        enabled: !busy,
                        itemBuilder: (_) => [
                          const PopupMenuItem(
                            value: 'edit',
                            child: Text('名前・生年月日を編集'),
                          ),
                          const PopupMenuItem(
                            value: 'avatar',
                            child: Text('アイコンを設定'),
                          ),
                          if (item['avatar'] != null)
                            const PopupMenuItem(
                              value: 'clearAvatar',
                              child: Text('アイコンを解除'),
                            ),
                          const PopupMenuItem(
                            value: 'delete',
                            child: Text('プロフィールを削除'),
                          ),
                        ],
                        onSelected: (value) async {
                          if (value == 'edit') {
                            await edit(item);
                            return;
                          }
                          if (value == 'avatar') {
                            await editAvatar(item);
                            return;
                          }
                          if (value == 'clearAvatar') {
                            await change(item['id'] as String, {
                              'avatar': null,
                            });
                            return;
                          }
                          if (await confirm(
                                context,
                                'プロフィールを削除',
                                '子どものプロフィールを削除します。投稿は残ります。',
                              ) &&
                              mounted) {
                            await change(item['id'] as String);
                          }
                        },
                      )
                    : null,
              ),
            if (busy) const LinearProgressIndicator(),
          ],
        );
      },
    ),
  );
}

class MembersScreen extends StatefulWidget {
  const MembersScreen(this.api, {super.key});
  final AlbumApi api;
  @override
  State<MembersScreen> createState() => _MembersScreenState();
}

class _MembersScreenState extends State<MembersScreen> {
  late var data = widget.api.get('members');
  bool busy = false;

  Future<void> correctRole(AlbumRow member, InviteRole role) async {
    final name = member['name'] as String;
    final who = name.isEmpty ? 'このメンバー' : name;
    if (!await confirm(context, '続柄を修正', '$whoの続柄を「${role.label}」に変更します。') ||
        !mounted) {
      return;
    }
    setState(() => busy = true);
    try {
      await widget.api.change('members/${member['id']}/grandparent', 'PUT', {
        'side': role.name,
      });
      if (mounted) setState(() => data = widget.api.get('members'));
    } catch (failure) {
      if (mounted) showFailure(context, failure);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('家族メンバー')),
    body: FutureBuilder<AlbumRow>(
      future: data,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snapshot.hasError) {
          return Center(child: Text(errorLabel(snapshot.error)));
        }
        return ListView(
          padding: const EdgeInsets.all(20),
          children: [
            for (final item in rows(snapshot.data?['members']))
              ListTile(
                title: Text(
                  (item['name'] as String).isEmpty
                      ? '表示名が未設定'
                      : item['name'] as String,
                ),
                subtitle: Text(
                  relationshipNames[item['relationship']] ??
                      switch ((item['role'], item['side'])) {
                        ('admin', _) => '管理者',
                        ('parent', _) => '親',
                        ('grandparent', 'paternal') => '父方の祖父母',
                        _ => '母方の祖父母',
                      },
                ),
                trailing:
                    widget.api.family.canInvite && item['role'] == 'grandparent'
                    ? PopupMenuButton<InviteRole>(
                        enabled: !busy,
                        tooltip: '家族の区分',
                        onSelected: (role) => correctRole(item, role),
                        itemBuilder: (_) => [
                          for (final role in [
                            InviteRole.paternal,
                            InviteRole.maternal,
                          ])
                            if (item['side'] != role.name)
                              PopupMenuItem(
                                value: role,
                                child: Text('${role.label}に修正'),
                              ),
                        ],
                      )
                    : null,
              ),
            if (busy) const LinearProgressIndicator(),
          ],
        );
      },
    ),
  );
}

const _notificationNames = {
  'post': '新しい投稿',
  'comment': 'コメント',
  'reaction': 'いいね・スタンプ',
  'join': 'アルバムへの参加',
};

String _noticeTitle(AlbumRow notice) {
  final actor = notice['actor'] as String?;
  if (actor == null || actor.isEmpty)
    return _notificationNames[notice['kind']] ?? 'お知らせ';
  return switch (notice['kind']) {
    'post' => '$actorさんが写真・動画を投稿しました',
    'comment' => '$actorさんがコメントしました',
    'reaction' => '$actorさんが投稿にリアクションしました',
    'commentReaction' => '$actorさんがコメントにリアクションしました',
    'join' => '$actorさんがアルバムに参加しました',
    _ => 'お知らせ',
  };
}

IconData _noticeIcon(Object? kind) => switch (kind) {
  'post' => Icons.photo_outlined,
  'comment' => Icons.mode_comment_outlined,
  'reaction' || 'commentReaction' => Icons.favorite_border,
  'join' => Icons.person_add_alt_1_outlined,
  _ => Icons.notifications_none_outlined,
};

class NoticesScreen extends StatefulWidget {
  const NoticesScreen(this.api, {super.key});
  final AlbumApi api;
  @override
  State<NoticesScreen> createState() => _NoticesScreenState();
}

class _NoticesScreenState extends State<NoticesScreen> {
  late Future<AlbumRow> data = widget.api.get('notifications');
  final more = <AlbumRow>[];
  String? page;
  bool busy = false;
  void reload() => setState(() {
    data = widget.api.get('notifications');
    more.clear();
    page = null;
  });

  Future<void> settings() async {
    try {
      final current = await widget.api.get('notification-settings');
      var push = current['enabled'] == true;
      final preferences = (current['preferences'] as List)
          .cast<String>()
          .toSet();
      if (!mounted) return;
      final changed = await showDialog<bool>(
        context: context,
        builder: (context) => StatefulBuilder(
          builder: (context, update) => AlertDialog(
            title: const Text('通知設定'),
            content: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  SwitchListTile(
                    title: const Text('端末に通知する'),
                    value: push,
                    onChanged: (value) => update(() => push = value),
                  ),
                  for (final entry in _notificationNames.entries)
                    CheckboxListTile(
                      title: Text(entry.value),
                      value: preferences.contains(entry.key),
                      onChanged: (value) => update(() {
                        if (value == true) {
                          preferences.add(entry.key);
                        } else {
                          preferences.remove(entry.key);
                        }
                      }),
                    ),
                ],
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context),
                child: const Text('取り消す'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(context, true),
                child: const Text('保存'),
              ),
            ],
          ),
        ),
      );
      if (changed != true || !mounted) return;
      final token = push ? await NotificationProbe().token() : '';
      await widget.api.change('notification-settings', 'PUT', {
        'token': token,
        'preferences': preferences.toList(),
      });
      if (mounted) reload();
    } catch (failure) {
      if (mounted) showFailure(context, failure);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('お知らせ'),
      actions: [
        IconButton(
          onPressed: busy ? null : reload,
          tooltip: '更新',
          icon: const Icon(Icons.refresh),
        ),
        IconButton(
          onPressed: busy ? null : settings,
          tooltip: '通知設定',
          icon: const Icon(Icons.settings),
        ),
      ],
    ),
    body: FutureBuilder(
      future: data,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snapshot.hasError) {
          return Center(child: Text(errorLabel(snapshot.error)));
        }
        final notices = [...rows(snapshot.data?['notices']), ...more];
        final next = page ?? snapshot.data?['next'] as String;
        return ListView(
          padding: const EdgeInsets.all(20),
          children: [
            if (notices.isEmpty && next.isEmpty) const Text('お知らせはまだありません。'),
            for (final notice in notices)
              ListTile(
                leading: CircleAvatar(
                  backgroundColor: Theme.of(context)
                      .colorScheme
                      .secondaryContainer,
                  child: Icon(
                    _noticeIcon(notice['kind']),
                    color: Theme.of(context).colorScheme.onSecondaryContainer,
                  ),
                ),
                title: Text(_noticeTitle(notice)),
                subtitle: Text(relativeTime(notice['at'])),
                trailing: notice['post'] is String
                    ? const Icon(Icons.chevron_right)
                    : null,
                onTap: notice['post'] is! String
                    ? null
                    : () async {
                        try {
                          final children = rows(
                            (await widget.api.get('children'))['children'],
                          );
                          if (!mounted) return;
                          await Navigator.push<bool>(
                            this.context,
                            MaterialPageRoute(
                              builder: (_) => PostScreen(
                                widget.api,
                                notice['post'] as String,
                                children,
                              ),
                            ),
                          );
                          if (mounted) reload();
                        } catch (failure) {
                          if (mounted) showFailure(this.context, failure);
                        }
                      },
              ),
            if (next.isNotEmpty)
              OutlinedButton(
                onPressed: busy
                    ? null
                    : () async {
                        setState(() => busy = true);
                        try {
                          final result = await widget.api.get(
                            'notifications',
                            query: {'cursor': next},
                          );
                          if (mounted) {
                            setState(() {
                              more.addAll(rows(result['notices']));
                              page = result['next'] as String;
                            });
                          }
                        } catch (failure) {
                          if (mounted) showFailure(this.context, failure);
                        } finally {
                          if (mounted) setState(() => busy = false);
                        }
                      },
                child: const Text('お知らせをさらに表示'),
              ),
          ],
        );
      },
    ),
  );
}
