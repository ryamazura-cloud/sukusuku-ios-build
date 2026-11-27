import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../album/album_api.dart';
import '../album/album_screen.dart';
import '../album/album_widgets.dart';
import '../album/post_screen.dart';
import '../album/update_banner.dart';
import '../album/settings_screens.dart';
import '../auth/auth.dart';
import '../notifications/probe.dart';
import 'family_api.dart';
import 'family_screen.dart';
import 'welcome_screen.dart';

final _noticePostIdPattern = RegExp(r'^[a-z0-9]{10}-[0-9a-f-]{36}$');

String? _noticePostId(RemoteMessage notice) {
  final post = notice.data['post'];
  return post is String && _noticePostIdPattern.hasMatch(post) ? post : null;
}

typedef EntryState = ({FamilyMembership? family, bool? parentInvite});

class AlbumEntry extends ConsumerStatefulWidget {
  const AlbumEntry(this.base, {super.key, this.code});
  final Uri base;
  final String? code;

  @override
  ConsumerState<AlbumEntry> createState() => _AlbumEntryState();
}

class _AlbumEntryState extends ConsumerState<AlbumEntry> {
  late Future<EntryState> entry = load();
  StreamSubscription<RemoteMessage>? notices;
  FamilyMembership? completedFamily;
  bool creating = false;
  bool deleting = false;

  FamilyApi get api => FamilyApi(
    widget.base,
    () async => ref.read(authProvider).currentUser?.getIdToken(),
  );

  @override
  void initState() {
    super.initState();
    notices = FirebaseMessaging.onMessageOpenedApp.listen(openNotice);
    unawaited(
      FirebaseMessaging.instance
          .getInitialMessage()
          .then((notice) {
            if (notice != null) openNotice(notice);
          })
          .catchError((Object _) {}),
    );
  }

  Future<void> openNotice(RemoteMessage notice) async {
    if (notice.data['album'] != 'notices') return;
    try {
      final family = completedFamily ?? (await entry).family;
      if (!mounted || family == null) return;
      final album = AlbumApi(api, family);
      final post = _noticePostId(notice);
      if (post != null) {
        await PostScreen.openFromNotice(context, album, post);
        return;
      }
      await Navigator.push<void>(
        context,
        MaterialPageRoute(builder: (_) => NoticesScreen(album)),
      );
    } catch (failure) {
      if (mounted) showFailure(context, failure);
    }
  }

  @override
  void dispose() {
    unawaited(notices?.cancel());
    super.dispose();
  }

  Future<void> authenticate() async {
    final auth = ref.read(authProvider);
    if (auth.currentUser == null) await auth.signInAnonymously();
  }

  Future<EntryState> load() async {
    final auth = ref.read(authProvider);
    final restored = await auth.authStateChanges().first;
    if (restored != null && !restored.isAnonymous) await auth.signOut();
    if (!mounted) return (family: null, parentInvite: null);
    FamilyMembership? family;
    if (auth.currentUser != null) {
      try {
        family = await api.current();
      } on FamilyApiException catch (error) {
        if (error.reason != 'account deleted') rethrow;
        await auth.signOut();
      } on FirebaseAuthException catch (error) {
        if (![
          'user-not-found',
          'user-disabled',
          'user-token-expired',
          'invalid-user-token',
        ].contains(error.code))
          rethrow;
        await auth.signOut();
      }
    }
    final code = widget.code;
    if (family != null || code == null)
      return (family: family, parentInvite: null);
    if (!RegExp(r'^[a-f0-9]{32}$').hasMatch(code)) {
      throw StateError('招待リンクが無効です。');
    }
    await authenticate();
    if (!mounted) return (family: null, parentInvite: null);
    return (family: null, parentInvite: await api.parentInvite(code));
  }

  Future<FamilyMembership> submit({
    required String relationship,
    required String nickname,
    required String child,
    required DateTime? birth,
  }) async {
    await authenticate();
    if (!mounted) throw StateError('もう一度アプリを開いてください。');
    final code = widget.code;
    if (code != null) {
      return api.join(code, relationship: relationship, nickname: nickname);
    }
    return api.createAlbum(
      albumName: '家族のアルバム',
      relationship: relationship,
      nickname: nickname,
      childName: child,
      birthday: dateLabel(birth!),
    );
  }

  void showFamily(FamilyMembership family) {
    if (!mounted) return;
    setState(() {
      completedFamily = family;
      creating = false;
    });
    if (widget.code != null) {
      // Keep the one-time token out of the active route after joining.
      context.go('/');
    }
  }

  Future<void> finishDeletion() async {
    await ref.read(authProvider).signOut();
    if (!mounted) return;
    setState(() {
      completedFamily = null;
      creating = false;
      entry = Future.value((family: null, parentInvite: null));
    });
    if (widget.code != null) context.go('/');
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('アカウントとデータの削除が完了しました。')));
  }

  void membershipRemoved() {
    if (!mounted) return;
    setState(() {
      completedFamily = null;
      creating = false;
      entry = load();
    });
  }

  Future<void> resumeDeletion() async {
    setState(() => deleting = true);
    try {
      await api.deleteAccount();
      if (mounted) await finishDeletion();
    } catch (error) {
      if (mounted) showFailure(context, error);
    } finally {
      if (mounted) setState(() => deleting = false);
    }
  }

  @override
  Widget build(BuildContext context) => FutureBuilder<EntryState>(
    future: entry,
    builder: (context, snapshot) {
      if (snapshot.connectionState != ConnectionState.done) {
        return const Scaffold(body: Center(child: CircularProgressIndicator()));
      }
      if (snapshot.hasError) {
        final pending =
            snapshot.error is FamilyApiException &&
            (snapshot.error as FamilyApiException).reason ==
                'account retirement in progress';
        return Scaffold(
          appBar: AppBar(title: const Text('すくすく')),
          body: Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(errorLabel(snapshot.error), textAlign: TextAlign.center),
                OutlinedButton(
                  onPressed: pending
                      ? (deleting ? null : resumeDeletion)
                      : () => setState(() => entry = load()),
                  child: Text(pending ? '削除を再開' : '再試行'),
                ),
                if (widget.code != null)
                  TextButton(
                    onPressed: () => context.go('/'),
                    child: const Text('トップへ戻る'),
                  ),
              ],
            ),
          ),
        );
      }
      final value = snapshot.data!;
      final family = completedFamily ?? value.family;
      if (family != null) {
        return _AlbumTabs(
          key: ValueKey(family.id),
          onRemoved: membershipRemoved,
          api: AlbumApi(api, family),
          base: widget.base,
          onDeleted: finishDeletion,
        );
      }
      final parentInvite = value.parentInvite;
      if (parentInvite != null) {
        return _EntryForm(
          creating: false,
          parents: parentInvite,
          submit: submit,
          onSaved: showFamily,
          cancel: () => context.go('/'),
        );
      }
      if (creating) {
        return _EntryForm(
          creating: true,
          parents: true,
          submit: submit,
          onSaved: showFamily,
          cancel: () => setState(() => creating = false),
        );
      }
      return WelcomeScreen(
        onCreateAlbum: () => setState(() => creating = true),
        inviteBase: widget.base,
        onOpenInvite: (code) => context.go('/invite/$code'),
      );
    },
  );
}

class _AlbumTabs extends StatefulWidget {
  const _AlbumTabs({
    super.key,
    required this.onRemoved,
    required this.api,
    required this.base,
    required this.onDeleted,
  });
  final AlbumApi api;
  final Uri base;
  final Future<void> Function() onDeleted;
  final VoidCallback onRemoved;

  @override
  State<_AlbumTabs> createState() => _AlbumTabsState();
}

class _AlbumTabsState extends State<_AlbumTabs> with WidgetsBindingObserver {
  int tab = 0;
  final distribution = AlbumUpdate.current;
  int updateBuild = 0;
  int dismissedBuild = 0;
  bool checkingUpdate = false;
  bool checkingMembership = false;
  bool openedSettings = false;
  StreamSubscription<String>? tokenUpdates;
  StreamSubscription<RemoteMessage>? foregroundNotices;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final messaging = FirebaseMessaging.instance;
    tokenUpdates = messaging.onRegistered.listen(
      (token) => unawaited(syncToken(token)),
    );
    if (defaultTargetPlatform == TargetPlatform.iOS) {
      unawaited(enableForegroundPresentation(messaging));
    } else if (defaultTargetPlatform == TargetPlatform.android) {
      foregroundNotices = FirebaseMessaging.onMessage.listen((notice) {
        if (!mounted || notice.data['album'] != 'notices') return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              notice.notification?.body ??
                  (notice.data['test'] == 'true'
                      ? 'テスト通知です。'
                      : '家族のアルバムに新しいお知らせがあります。'),
            ),
            action: SnackBarAction(
              label: '開く',
              onPressed: () async {
                if (!mounted) return;
                final post = _noticePostId(notice);
                if (post == null) {
                  setState(() => tab = 1);
                  return;
                }
                try {
                  await PostScreen.openFromNotice(context, widget.api, post);
                } catch (failure) {
                  if (mounted) showFailure(context, failure);
                }
              },
            ),
          ),
        );
      });
    }
    unawaited(syncToken());
    unawaited(checkUpdate());
  }

  Future<void> enableForegroundPresentation(FirebaseMessaging messaging) async {
    try {
      await messaging.setForegroundNotificationPresentationOptions(
        alert: true,
        badge: true,
        sound: true,
      );
    } catch (_) {
      // Background notifications remain available.
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(syncToken());
      unawaited(checkUpdate());
      unawaited(checkMembership());
    }
  }

  Future<void> checkUpdate() async {
    final channel = distribution;
    if (channel == null || checkingUpdate) return;
    checkingUpdate = true;
    try {
      final installed = await AlbumUpdate.installedBuild();
      if (installed == null || installed < 1 || !mounted) return;
      final latest = await channel.latestBuild(widget.base);
      if (mounted)
        setState(() => updateBuild = latest > installed ? latest : 0);
    } catch (_) {
      // The album remains available when the update endpoint cannot be reached.
    } finally {
      checkingUpdate = false;
    }
  }

  Future<void> checkMembership() async {
    if (checkingMembership) return;
    checkingMembership = true;
    try {
      final family = await widget.api.api.current();
      if (mounted && family?.id != widget.api.family.id) widget.onRemoved();
    } catch (_) {
      // The album API still enforces permissions for every request.
    } finally {
      checkingMembership = false;
    }
  }

  Future<void> syncToken([String? updatedToken]) async {
    try {
      final token = await NotificationProbe().existingToken(updatedToken);
      if (!mounted || token == null) return;
      await widget.api.change('notification-settings', 'PUT', {'fid': token});
    } catch (_) {
      // Notification settings can be opened to retry registration.
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    unawaited(tokenUpdates?.cancel());
    unawaited(foregroundNotices?.cancel());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: IndexedStack(
      index: tab,
      children: [
        AlbumScreen(
          widget.api,
          active: tab == 0,
          updateBanner:
              distribution != null &&
                  updateBuild > 0 &&
                  updateBuild != dismissedBuild
              ? UpdateBanner(
                  distribution!,
                  onDismiss: () => setState(() => dismissedBuild = updateBuild),
                )
              : null,
        ),
        if (tab == 1) NoticesScreen(widget.api) else const SizedBox(),
        if (openedSettings)
          FamilyScreen(widget.base, embedded: true, onDeleted: widget.onDeleted)
        else
          const SizedBox(),
      ],
    ),
    bottomNavigationBar: NavigationBar(
      selectedIndex: tab,
      onDestinationSelected: (value) => setState(() {
        tab = value;
        if (value == 2) openedSettings = true;
      }),
      destinations: const [
        NavigationDestination(
          icon: Icon(Icons.photo_library_outlined),
          selectedIcon: Icon(Icons.photo_library),
          label: 'アルバム',
        ),
        NavigationDestination(
          icon: Icon(Icons.notifications_none_outlined),
          selectedIcon: Icon(Icons.notifications),
          label: 'お知らせ',
        ),
        NavigationDestination(
          icon: Icon(Icons.settings_outlined),
          selectedIcon: Icon(Icons.settings),
          label: '設定',
        ),
      ],
    ),
  );
}

typedef _SubmitEntry = Future<FamilyMembership> Function({
  required String relationship,
  required String nickname,
  required String child,
  required DateTime? birth,
});

class _EntryForm extends StatefulWidget {
  const _EntryForm({
    required this.creating,
    required this.parents,
    required this.submit,
    required this.onSaved,
    required this.cancel,
  });

  final bool creating;
  final bool parents;
  final _SubmitEntry submit;
  final ValueChanged<FamilyMembership> onSaved;
  final VoidCallback cancel;

  @override
  State<_EntryForm> createState() => _EntryFormState();
}

class _EntryFormState extends State<_EntryForm> {
  final form = GlobalKey<FormState>();
  final nickname = TextEditingController();
  final child = TextEditingController();
  String? relationship;
  DateTime? birth;
  bool busy = false;
  String? error;

  @override
  void dispose() {
    nickname.dispose();
    child.dispose();
    super.dispose();
  }

  Future<void> submit() async {
    if (busy || !form.currentState!.validate()) return;
    if (widget.creating && birth == null) {
      setState(() => error = 'お子さまの生年月日を選んでください。');
      return;
    }
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final family = await widget.submit(
        relationship: relationship!,
        nickname: nickname.text,
        child: child.text,
        birth: birth,
      );
      if (!mounted) return;
      widget.onSaved(family);
    } catch (failure) {
      if (mounted) setState(() => error = errorLabel(failure));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Widget field(String label, TextEditingController controller) => TextFormField(
    controller: controller,
    enabled: !busy,
    maxLength: 60,
    decoration: InputDecoration(labelText: label),
    validator: (value) =>
        value == null || value.trim().isEmpty ? '入力してください。' : null,
  );

  @override
  Widget build(BuildContext context) {
    final roles = widget.parents
        ? const {'father': 'パパ', 'mother': 'ママ'}
        : const {
            'grandfather': 'おじいちゃん',
            'grandmother': 'おばあちゃん',
            'sibling': '兄弟姉妹',
            'other': 'その他',
          };
    return PopScope(
      canPop: !widget.creating,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop && widget.creating && !busy) widget.cancel();
      },
      child: Scaffold(
        appBar: AppBar(
          leading: widget.creating
              ? IconButton(
                  tooltip: '戻る',
                  icon: const BackButtonIcon(),
                  onPressed: busy ? null : widget.cancel,
                )
              : null,
          title: Text(widget.creating ? 'アルバムを追加' : 'アルバムに参加'),
        ),
        body: Form(
          key: form,
          child: ListView(
            padding: const EdgeInsets.all(24),
            children: [
              DropdownButtonFormField<String>(
                initialValue: relationship,
                decoration: InputDecoration(
                  labelText: widget.creating ? 'パパ or ママ' : '間柄',
                ),
                items: [
                  for (final role in roles.entries)
                    DropdownMenuItem(value: role.key, child: Text(role.value)),
                ],
                onChanged: busy
                    ? null
                    : (value) => setState(() => relationship = value),
                validator: (value) => value != null
                    ? null
                    : widget.creating
                    ? 'パパかママを選んでください。'
                    : '間柄を選んでください。',
              ),
              const SizedBox(height: 12),
              field('ニックネーム（後で変更可）', nickname),
              if (widget.creating) ...[
                field('子どもの名前', child),
                OutlinedButton.icon(
                  onPressed: busy
                      ? null
                      : () async {
                          final now = DateTime.now();
                          final date = await showDatePicker(
                            context: context,
                            initialDate: birth ?? now,
                            firstDate: DateTime(1900),
                            lastDate: DateTime(9999, 12, 31),
                          );
                          if (mounted && date != null)
                            setState(() => birth = date);
                        },
                  icon: const Icon(Icons.calendar_today_outlined),
                  label: Text(
                    birth == null ? '子どもの生年月日を選ぶ' : '生年月日 ${dateLabel(birth!)}',
                  ),
                ),
              ],
              if (error case final message?) Text(message),
              if (busy) const LinearProgressIndicator(),
              const SizedBox(height: 16),
              FilledButton(
                onPressed: busy ? null : submit,
                child: Text(widget.creating ? 'アルバムを作成' : '参加する'),
              ),
              if (!widget.creating)
                TextButton(
                  onPressed: busy ? null : widget.cancel,
                  child: const Text('トップへ戻る'),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
