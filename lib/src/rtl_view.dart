import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import 'rtl_platform.dart';
import 'rtl_sdk.dart';

/// Embeds the existing native RTL view. Mount only after initialization completes.
class RtlView extends StatefulWidget {
  const RtlView({
    super.key,
    this.onViewCreated,
    this.gestureRecognizers = const <Factory<OneSequenceGestureRecognizer>>{},
  });

  /// Native RTL view attachment, distinct from [RtlSdk.ready] and web readiness.
  final VoidCallback? onViewCreated;
  final Set<Factory<OneSequenceGestureRecognizer>> gestureRecognizers;

  @override
  State<RtlView> createState() => _RtlViewState();
}

class _RtlViewState extends State<RtlView> {
  static _RtlViewState? _active;
  static Future<void>? _pendingDisposal;
  static int _nextViewId = 0;
  final _viewId = _nextViewId++;
  bool _canCreate = false;
  static const _viewType = 'com.affinaloyalty.rtl_sdk/view';

  @override
  void initState() {
    super.initState();
    if (!RtlPlatform.instance.isInitialized) {
      throw StateError(
        'Await RtlSdk.instance.initialize before mounting RtlView',
      );
    }
    _claim();
    // Finalize the outgoing widget and release its RTL view before attaching
    // a replacement. Flutter may retain its platform container for another frame.
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      await _pendingDisposal;
      if (mounted && identical(_active, this)) {
        setState(() => _canCreate = true);
      }
    });
  }

  void _claim() {
    if (_active != null && !identical(_active, this)) {
      throw StateError('Only one RtlView can be mounted at a time');
    }
    _active = this;
  }

  Future<void> _onCreated(int id) async {
    try {
      await _pendingDisposal;
      if (!mounted || !identical(_active, this)) return;
      await RtlPlatform.instance.invoke('attachView', {'viewId': _viewId});
      if (mounted && identical(_active, this)) widget.onViewCreated?.call();
    } catch (error, stack) {
      _report(error, stack);
    }
  }

  static void _report(Object error, StackTrace stack) {
    FlutterError.reportError(
      FlutterErrorDetails(
        exception: error,
        stack: stack,
        library: 'rtl_sdk',
        context: ErrorDescription('while attaching or releasing an RTL view'),
      ),
    );
  }

  @override
  void deactivate() {
    if (identical(_active, this)) _active = null;
    super.deactivate();
  }

  @override
  void activate() {
    super.activate();
    _claim();
  }

  @override
  void dispose() {
    if (identical(_active, this)) _active = null;
    if (_canCreate) {
      final disposal = RtlPlatform.instance
          .invoke('disposeView', {'viewId': _viewId})
          .then<void>((_) {})
          .catchError(_report);
      _pendingDisposal = disposal;
      disposal.whenComplete(() {
        if (identical(_pendingDisposal, disposal)) _pendingDisposal = null;
      });
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!RtlPlatform.instance.isInitialized) {
      throw StateError('RtlView requires an initialized RTL SDK');
    }
    if (!_canCreate) return const SizedBox.expand();
    if (!kIsWeb && defaultTargetPlatform == TargetPlatform.iOS) {
      return UiKitView(
        viewType: _viewType,
        creationParams: {'rtlViewId': _viewId},
        creationParamsCodec: const StandardMessageCodec(),
        onPlatformViewCreated: _onCreated,
        gestureRecognizers: widget.gestureRecognizers,
      );
    }
    if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) {
      return PlatformViewLink(
        viewType: _viewType,
        surfaceFactory: (context, controller) => AndroidViewSurface(
          controller: controller as AndroidViewController,
          gestureRecognizers: widget.gestureRecognizers,
          hitTestBehavior: PlatformViewHitTestBehavior.opaque,
        ),
        onCreatePlatformView: (params) {
          final controller = PlatformViewsService.initSurfaceAndroidView(
            id: params.id,
            viewType: _viewType,
            layoutDirection: Directionality.of(context),
            creationParams: {'rtlViewId': _viewId},
            creationParamsCodec: const StandardMessageCodec(),
            onFocus: () => params.onFocusChanged(true),
          );
          controller.addOnPlatformViewCreatedListener(
            params.onPlatformViewCreated,
          );
          controller.addOnPlatformViewCreatedListener(_onCreated);
          controller.create();
          return controller;
        },
      );
    }
    throw UnsupportedError('RtlView supports iOS and Android only');
  }
}
