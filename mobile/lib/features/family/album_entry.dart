import 'dart:async';

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../album/album_api.dart';
import '../album/album_screen.dart';
import '../album/album_widgets.dart';
import '../album/settings_screens.dart';
import '../auth/auth.dart';
import 'family_api.dart';
import 'family_screen.dart';
import 'welcome_screen.dart';

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
      if (mounted && family != null) {
        await Navigator.push<void>(
          context,
          MaterialPageRoute(
            builder: (_) => NoticesScreen(AlbumApi(api, family)),
          ),
        );
      }
    } catch (_) {
      // The album entry screen presents any membership error.
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
    final family = auth.currentUser == null ? null : await api.current();
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
    required String albumName,
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
      albumName: albumName,
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

  @override
  Widget build(BuildContext context) => FutureBuilder<EntryState>(
    future: entry,
    builder: (context, snapshot) {
      if (snapshot.connectionState != ConnectionState.done) {
        return const Scaffold(body: Center(child: CircularProgressIndicator()));
      }
      if (snapshot.hasError) {
        return Scaffold(
          appBar: AppBar(title: const Text('すくすく')),
          body: Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(errorLabel(snapshot.error), textAlign: TextAlign.center),
                OutlinedButton(
                  onPressed: () => setState(() => entry = load()),
                  child: const Text('再試行'),
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
        return _AlbumTabs(api: AlbumApi(api, family), base: widget.base);
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
      );
    },
  );
}

class _AlbumTabs extends StatefulWidget {
  const _AlbumTabs({required this.api, required this.base});
  final AlbumApi api;
  final Uri base;

  @override
  State<_AlbumTabs> createState() => _AlbumTabsState();
}

class _AlbumTabsState extends State<_AlbumTabs> {
  int tab = 0;
  bool openedSettings = false;
  String? albumName;

  @override
  Widget build(BuildContext context) => Scaffold(
    body: IndexedStack(
      index: tab,
      children: [
        AlbumScreen(widget.api, active: tab == 0, albumName: albumName),
        if (tab == 1) NoticesScreen(widget.api) else const SizedBox(),
        if (openedSettings)
          FamilyScreen(
            widget.base,
            embedded: true,
            onAlbumRenamed: (name) => setState(() => albumName = name),
          )
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
  required String albumName,
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
  final album = TextEditingController();
  final child = TextEditingController();
  String? relationship;
  DateTime? birth;
  bool busy = false;
  String? error;

  @override
  void dispose() {
    nickname.dispose();
    album.dispose();
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
        albumName: album.text,
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
                  labelText: widget.creating ? 'パパ or ママ' : '立場',
                ),
                items: [
                  for (final role in roles.entries)
                    DropdownMenuItem(value: role.key, child: Text(role.value)),
                ],
                onChanged: busy
                    ? null
                    : (value) => setState(() => relationship = value),
                validator: (value) => value == null ? '立場を選んでください。' : null,
              ),
              const SizedBox(height: 12),
              field('あだ名', nickname),
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
                field('アルバム名', album),
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
