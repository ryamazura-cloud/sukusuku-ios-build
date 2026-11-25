import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'auth.dart';

class SignIn extends ConsumerStatefulWidget {
  const SignIn({super.key});
  @override
  ConsumerState<SignIn> createState() => _SignInState();
}

class _SignInState extends ConsumerState<SignIn> {
  final email = TextEditingController();
  final password = TextEditingController();
  bool busy = false;
  String? error;

  @override
  void dispose() {
    email.dispose();
    password.dispose();
    super.dispose();
  }

  Future<void> submit() async {
    if (email.text.trim().isEmpty || password.text.isEmpty) {
      setState(() => error = 'メールアドレスとパスワードを入力してください。');
      return;
    }
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await ref
          .read(authProvider)
          .signInWithEmailAndPassword(
            email: email.text.trim(),
            password: password.text,
          );
    } on FirebaseAuthException catch (exception) {
      if (mounted) setState(() => error = 'ログインに失敗しました（${exception.code}）。');
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('家族共有')),
    body: ListView(
      padding: const EdgeInsets.all(24),
      children: [
        const Text('開発用アカウントでログイン'),
        const SizedBox(height: 16),
        TextField(
          controller: email,
          keyboardType: TextInputType.emailAddress,
          decoration: const InputDecoration(labelText: 'メールアドレス'),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: password,
          obscureText: true,
          decoration: const InputDecoration(labelText: 'パスワード'),
        ),
        const SizedBox(height: 12),
        if (error != null) Text(error!),
        FilledButton(
          onPressed: busy ? null : submit,
          child: const Text('ログイン'),
        ),
      ],
    ),
  );
}
