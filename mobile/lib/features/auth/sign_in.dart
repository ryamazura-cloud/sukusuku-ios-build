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

  Future<void> submit({bool register = false, bool reset = false}) async {
    if (email.text.trim().isEmpty || (!reset && password.text.isEmpty)) {
      setState(() => error = 'メールアドレスとパスワードを入力してください。');
      return;
    }
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final auth = ref.read(authProvider);
      final address = email.text.trim();
      if (reset) {
        await auth.sendPasswordResetEmail(email: address);
        if (mounted) setState(() => error = '再設定メールをリクエストしました。');
      } else if (register) {
        await auth.createUserWithEmailAndPassword(
          email: address,
          password: password.text,
        );
      } else {
        await auth.signInWithEmailAndPassword(
          email: address,
          password: password.text,
        );
      }
    } on FirebaseAuthException catch (exception) {
      if (mounted) setState(() => error = '認証操作に失敗しました（${exception.code}）。');
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
        const Text('メールアドレスでログイン'),
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
        OutlinedButton(
          onPressed: busy ? null : () => submit(register: true),
          child: const Text('アカウントを作成'),
        ),
        TextButton(
          onPressed: busy ? null : () => submit(reset: true),
          child: const Text('パスワードを再設定'),
        ),
      ],
    ),
  );
}
