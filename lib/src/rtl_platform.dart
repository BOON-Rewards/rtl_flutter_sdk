import 'dart:async';

import 'package:flutter/services.dart';

/// Internal seam for channel tests; not exported by the public library.
abstract class RtlPlatform {
  static RtlPlatform instance = MethodChannelRtlPlatform();

  bool get isInitialized;
  Stream<void> get ready;
  Stream<bool> get loadingStateChanges;
  Future<void> initialize(
    Map<String, Object?> options,
    FutureOr<String?> Function() provider,
  );
  Future<Object?> invoke(String method, [Object? arguments]);
}

class MethodChannelRtlPlatform implements RtlPlatform {
  MethodChannelRtlPlatform({MethodChannel? channel})
    : _channel = channel ?? const MethodChannel('com.affinaloyalty.rtl_sdk') {
    _channel.setMethodCallHandler(_handleNativeCall);
  }

  final MethodChannel _channel;
  final _ready = StreamController<void>.broadcast();
  final _loading = StreamController<bool>.broadcast();
  FutureOr<String?> Function()? _provider;
  int _generation = 0;
  final _pendingTokens = <Completer<String?>>{};
  bool _initialized = false;

  @override
  bool get isInitialized => _initialized;
  @override
  Stream<void> get ready => _ready.stream;
  @override
  Stream<bool> get loadingStateChanges => _loading.stream;

  Future<Object?> _handleNativeCall(MethodCall call) async {
    switch (call.method) {
      case 'provideAuthToken':
        final generation = _generation;
        final provider = _provider;
        if (!_initialized || provider == null) return null;
        final cancelled = Completer<String?>();
        _pendingTokens.add(cancelled);
        try {
          // Future.sync may return a covariant Future<String>; wrap it to keep
          // the timeout callback nullable even for an async non-null provider.
          Future<String?> request() async => await provider();
          final token = await Future.any<String?>([request(), cancelled.future])
              .timeout(const Duration(seconds: 30), onTimeout: () => null);
          return generation == _generation ? token : null;
        } catch (_) {
          return null;
        } finally {
          _pendingTokens.remove(cancelled);
        }
      case 'onReady':
        _ready.add(null);
        return null;
      case 'onLoadingStateChanged':
        final arguments = call.arguments as Map<Object?, Object?>;
        _loading.add(arguments['isLoading'] as bool);
        return null;
      case 'onDetached':
        _cancelTokens();
        _provider = null;
        _initialized = false;
        return null;
      default:
        throw MissingPluginException('Unknown RTL callback: ${call.method}');
    }
  }

  @override
  Future<void> initialize(
    Map<String, Object?> options,
    FutureOr<String?> Function() provider,
  ) async {
    _cancelTokens();
    final generation = _generation;
    _initialized = false;
    _provider = provider;
    try {
      await _channel.invokeMethod<void>('initialize', options);
      if (generation == _generation) _initialized = true;
    } catch (_) {
      if (generation == _generation) _provider = null;
      rethrow;
    }
  }

  void _cancelTokens() {
    _generation++;
    for (final cancelled in _pendingTokens) {
      cancelled.complete(null);
    }
    _pendingTokens.clear();
  }

  @override
  Future<Object?> invoke(String method, [Object? arguments]) {
    if (method == 'logout') _cancelTokens();
    return _channel.invokeMethod<Object?>(method, arguments);
  }
}
