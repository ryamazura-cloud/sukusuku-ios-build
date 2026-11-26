import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:share_plus/share_plus.dart';

import '../auth/auth.dart';
import '../album/album_api.dart';
import '../album/album_widgets.dart';
import '../album/settings_screens.dart';

import 'family_api.dart';

class FamilyScreen extends ConsumerStatefulWidget {
  const FamilyScreen(
    this.base, {
    super.key,
    this.embedded = false,
    this.onAlbumRenamed,
  });
  final Uri base;
  final bool embedded;
  final ValueChanged<String>? onAlbumRenamed;

  @override
  ConsumerState<FamilyScreen> createState() => _FamilyScreenState();
}

class _FamilyScreenState extends ConsumerState<FamilyScreen> {
  late Future<FamilyMembership?> membership = api.current();
  InviteRole? target;
  ({String code, DateTime expiresAt})? invitation;
  bool busy = false;
  String? error;

  FamilyApi get api => FamilyApi(
    widget.base,
    () async => await ref.read(authProvider).currentUser?.getIdToken(),
  );

  Future<void> perform(Future<void> Function() action) async {
    if (busy) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await action();
    } on FamilyApiException catch (failure) {
      if (mounted) setState(() => error = failure.message);
    } catch (_) {
      if (mounted) setState(() => error = '操作を完了できませんでした。もう一度お試しください。');
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  void reload() {
    setState(() {
      error = null;
      membership = api.current();
    });
  }

  Widget familyDetails(FamilyMembership family) {
    final album = AlbumApi(api, family);
    final currentInvite = invitation;
    final role = target;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(family.name, style: Theme.of(context).textTheme.headlineSmall),
        Text('あなたの権限：${family.role}'),
        if (family.canInvite)
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: busy
                  ? null
                  : () async {
                      final name = await textDialog(
                        context,
                        'アルバム名を変更',
                        label: 'アルバム名',
                        initial: family.name,
                        maxLength: 60,
                      );
                      if (!mounted ||
                          name == null ||
                          name.trim().isEmpty ||
                          name.trim() == family.name)
                        return;
                      await perform(() async {
                        await album.change('name', 'PUT', {
                          'name': name.trim(),
                        });
                        if (mounted) {
                          widget.onAlbumRenamed?.call(name.trim());
                          reload();
                        }
                      });
                    },
              icon: const Icon(Icons.edit_outlined),
              label: const Text('アルバム名を変更'),
            ),
          ),
        const SizedBox(height: 16),
        OutlinedButton(
          onPressed: busy
              ? null
              : () => Navigator.push<void>(
                  context,
                  MaterialPageRoute(builder: (_) => ChildScreen(album)),
                ),
          child: const Text('子どものプロフィール'),
        ),
        OutlinedButton(
          onPressed: busy
              ? null
              : () async {
                  await Navigator.push<bool>(
                    context,
                    MaterialPageRoute(builder: (_) => MembersScreen(album)),
                  );
                  if (mounted) reload();
                },
          child: const Text('家族メンバー'),
        ),
        if (family.canInvite) ...[
          const SizedBox(height: 32),
          Text('招待リンクを発行', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 12),
          DropdownButtonFormField<InviteRole>(
            initialValue: role,
            decoration: const InputDecoration(labelText: '招待する相手'),
            items: InviteRole.values
                .map(
                  (role) =>
                      DropdownMenuItem(value: role, child: Text(role.label)),
                )
                .toList(),
            onChanged: busy
                ? null
                : (value) => setState(() {
                    target = value;
                    invitation = null;
                  }),
          ),
          const SizedBox(height: 12),
          FilledButton(
            onPressed: busy || role == null
                ? null
                : () => perform(() async {
                    final result = await api.invite(family.id, role);
                    if (mounted) setState(() => invitation = result);
                  }),
            child: const Text('招待リンクを発行'),
          ),
          if (currentInvite != null)
            OutlinedButton.icon(
              onPressed: busy
                  ? null
                  : () => perform(() async {
                      final target = context.findRenderObject() as RenderBox?;
                      await SharePlus.instance.share(
                        ShareParams(
                          text: widget.base
                              .resolve('/invite/${currentInvite.code}')
                              .toString(),
                          sharePositionOrigin: target == null
                              ? null
                              : target.localToGlobal(Offset.zero) & target.size,
                        ),
                      );
                    }),
              icon: const Icon(Icons.share_outlined),
              label: const Text('招待リンクを送る'),
            ),
          if (currentInvite != null) ...[
            const SizedBox(height: 12),
            SelectableText(widget.base.resolve('/invite/').toString()),
            Text(
              '有効期限：${MaterialLocalizations.of(context).formatShortDate(currentInvite.expiresAt)} '
              '${MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(currentInvite.expiresAt))}',
            ),
            const Text('招待する相手にリンクを送ってください。1人が1回だけ使えます。'),
            OutlinedButton(
              onPressed: busy
                  ? null
                  : () => perform(() async {
                      await Clipboard.setData(
                        ClipboardData(
                          text: widget.base.resolve('/invite/').toString(),
                        ),
                      );
                      if (mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(content: Text('招待リンクをコピーしました。')),
                        );
                      }
                    }),
              child: const Text('招待リンクをコピー'),
            ),
          ],
        ],
      ],
    );
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(widget.embedded ? '設定' : 'すくすく'),
      actions: [
        IconButton(
          tooltip: '家族情報を更新',
          onPressed: busy ? null : reload,
          icon: const Icon(Icons.refresh),
        ),
      ],
    ),
    body: ListView(
      padding: const EdgeInsets.all(24),
      children: [
        if (busy) const LinearProgressIndicator(),
        if (error != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Text(
              error!,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          ),
        FutureBuilder(
          future: membership,
          builder: (context, snapshot) {
            if (snapshot.connectionState != ConnectionState.done) {
              return const Center(child: CircularProgressIndicator());
            }
            if (snapshot.hasError) {
              final message = switch (snapshot.error) {
                FamilyApiException(status: 404) =>
                  '開発環境で家族APIが見つかりません（HTTP 404）。',
                FamilyApiException(status: 401) =>
                  'ログインを確認できません。再ログインしてください（HTTP 401）。',
                FamilyApiException(:final status) =>
                  '家族情報を取得できませんでした（HTTP $status）。',
                TimeoutException() => '家族APIへの接続がタイムアウトしました。',
                _ => '家族情報を取得できませんでした。接続を確認してください。',
              };
              return Column(
                children: [
                  Text(message),
                  OutlinedButton(onPressed: reload, child: const Text('再試行')),
                ],
              );
            }
            final family = snapshot.data;
            return family == null
                ? const Text('アルバムに参加していません。')
                : familyDetails(family);
          },
        ),
      ],
    ),
  );
}
