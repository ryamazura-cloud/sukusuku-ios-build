import 'package:flutter/material.dart';

final _avatarId = RegExp(r'^(person|animal)-(0[1-9]|[1-4][0-9]|50)$');

class MemberAvatar extends StatelessWidget {
  const MemberAvatar(this.id, {super.key, this.size = 32});

  final String? id;
  final double size;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final fallback = Center(
      child: Icon(
        Icons.person_outline,
        size: size * .62,
        color: colors.onSecondaryContainer,
      ),
    );
    final avatar = id;
    return ClipOval(
      child: ColoredBox(
        color: colors.secondaryContainer,
        child: SizedBox.square(
          dimension: size,
          child: avatar != null && _avatarId.hasMatch(avatar)
              ? Image.asset(
                  'assets/avatars/$avatar.jpg',
                  width: size,
                  height: size,
                  fit: BoxFit.cover,
                  excludeFromSemantics: true,
                  errorBuilder: (_, _, _) => fallback,
                )
              : fallback,
        ),
      ),
    );
  }
}

Future<String?> pickMemberAvatar(BuildContext context, String? current) =>
    Navigator.of(
      context,
    ).push<String>(MaterialPageRoute(builder: (_) => _AvatarPicker(current)));

class _AvatarPicker extends StatelessWidget {
  const _AvatarPicker(this.current);

  static const _personLabel = 'ヒト';
  static const _animalLabel = '動物';

  final String? current;

  Widget grid(String type, String label) => GridView.builder(
    key: PageStorageKey(type),
    padding: const EdgeInsets.all(16),
    gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
      maxCrossAxisExtent: 86,
      crossAxisSpacing: 8,
      mainAxisSpacing: 8,
    ),
    itemCount: 50,
    itemBuilder: (context, index) {
      final number = (index + 1).toString().padLeft(2, '0');
      final id = '$type-$number';
      final selected = current == id;
      return Semantics(
        label: '$label ${index + 1}',
        selected: selected,
        button: true,
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: () => Navigator.pop(context, id),
          child: DecoratedBox(
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: selected
                  ? Border.all(
                      color: Theme.of(context).colorScheme.primary,
                      width: 2,
                    )
                  : null,
            ),
            child: Center(child: MemberAvatar(id, size: 52)),
          ),
        ),
      );
    },
  );

  @override
  Widget build(BuildContext context) => DefaultTabController(
    length: 2,
    initialIndex: current?.startsWith('animal-') == true ? 1 : 0,
    child: Scaffold(
      appBar: AppBar(
        title: const Text('アイコンを選ぶ'),
        bottom: const TabBar(
          labelColor: Colors.white,
          unselectedLabelColor: Color(0xFFFFF4E8),
          indicatorColor: Colors.white,
          tabs: [
            Tab(text: _personLabel),
            Tab(text: _animalLabel),
          ],
        ),
      ),
      body: TabBarView(
        children: [grid('person', _personLabel), grid('animal', _animalLabel)],
      ),
    ),
  );
}
