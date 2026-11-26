import 'package:flutter/material.dart';

ThemeData familyTheme() {
  return ThemeData(
    colorScheme: ColorScheme.fromSeed(
      seedColor: const Color(0xFF94744E),
      surface: const Color(0xFFFFF8EF),
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: Color(0xFF794D39),
      foregroundColor: Color(0xFFFFF8EF),
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
    ),
    scaffoldBackgroundColor: const Color(0xFFFFF8EF),
    inputDecorationTheme: const InputDecorationTheme(
      border: OutlineInputBorder(),
    ),
  );
}
