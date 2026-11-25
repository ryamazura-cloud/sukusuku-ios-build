import 'package:flutter/material.dart';

ThemeData familyTheme() {
  return ThemeData(
    colorScheme: ColorScheme.fromSeed(
      seedColor: const Color(0xFFBA584C),
      surface: const Color(0xFFFFF8EF),
    ),
    scaffoldBackgroundColor: const Color(0xFFFFF8EF),
    inputDecorationTheme: const InputDecorationTheme(
      border: OutlineInputBorder(),
    ),
  );
}
