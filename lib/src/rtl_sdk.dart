import 'dart:async';

import 'package:flutter/foundation.dart';

import 'rtl_platform.dart';

/// Returns a fresh backend-signed JWT, or null when authentication is unavailable.
typedef RtlAuthTokenProvider = FutureOr<String?> Function();

/// The existing native SDK's presentation result and snake_case error code.
@immutable
class RtlExperienceResult {
  const RtlExperienceResult({required this.success, this.errorCode});
  final bool success;
  final String? errorCode;
}

/// One shared RTL experience, matching the existing native SDK singletons.
class RtlSdk {
  RtlSdk._();
  static final RtlSdk instance = RtlSdk._();
  RtlPlatform get _platform => RtlPlatform.instance;

  /// Subscribe before initializing. This is an event stream, not replayed state.
  Stream<void> get ready => _platform.ready;

  /// Covers initial presentation and native session recovery. Not replayed.
  Stream<bool> get loadingStateChanges => _platform.loadingStateChanges;

  Future<void> initialize({
    required String baseUrl,
    required String urlScheme,
    required RtlAuthTokenProvider authTokenProvider,
    String? externalChapterId,
  }) async {
    final uri = Uri.tryParse(baseUrl);
    if (uri == null ||
        !['http', 'https'].contains(uri.scheme) ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty) {
      throw ArgumentError.value(
        baseUrl,
        'baseUrl',
        'Use a complete HTTP(S) URL',
      );
    }
    if (!RegExp(r'^[a-zA-Z][a-zA-Z0-9+.-]*$').hasMatch(urlScheme) ||
        {
          'http',
          'https',
          'file',
          'javascript',
          'about',
          'data',
          'blob',
          'intent',
          'content',
        }.contains(urlScheme.toLowerCase())) {
      throw ArgumentError.value(
        urlScheme,
        'urlScheme',
        'Use an app URL scheme without a colon',
      );
    }
    if (kIsWeb ||
        ![
          TargetPlatform.iOS,
          TargetPlatform.android,
        ].contains(defaultTargetPlatform)) {
      throw UnsupportedError('RTL supports iOS and Android only');
    }
    await _platform.initialize({
      'baseUrl': baseUrl,
      'urlScheme': urlScheme,
      'externalChapterId': ?externalChapterId,
    }, authTokenProvider);
  }

  Future<RtlExperienceResult> presentExperience({
    String? rtlEventId,
    String? rtlRedirectUrl,
  }) async {
    final result = await _platform.invoke('presentExperience', {
      'rtlEventId': ?rtlEventId,
      'rtlRedirectUrl': ?rtlRedirectUrl,
    }) as Map<Object?, Object?>;
    return RtlExperienceResult(
      success: result['success'] as bool,
      errorCode: result['errorCode'] as String?,
    );
  }

  /// Forward the host's original URL after the native view has been created.
  Future<bool> handleDeepLink(String url) async =>
      await _platform.invoke('handleDeepLink', {'url': url}) as bool;

  /// Completes when native logout is processed, not when server logout finishes.
  Future<void> logout() async {
    await _platform.invoke('logout');
  }

  Future<void> enableLocationFeatures() async {
    await _platform.invoke('enableLocationFeatures');
  }

  Future<void> disableLocationFeatures() async {
    await _platform.invoke('disableLocationFeatures');
  }

  Future<bool> hasLocationPermission() async =>
      await _platform.invoke('hasLocationPermission') as bool;
}
