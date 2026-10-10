import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rtl_sdk/rtl_sdk.dart';
import 'package:rtl_sdk/src/rtl_platform.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('rtl_sdk_test');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  final sdk = RtlSdk.instance;
  late MethodChannelRtlPlatform platform;
  late List<MethodCall> commands;

  Future<void> initialize({RtlAuthTokenProvider? provider}) async {
    final previous = debugDefaultTargetPlatformOverride;
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    try {
      await sdk.initialize(
        baseUrl: 'https://rewards.example',
        urlScheme: 'host-app',
        externalChapterId: 'chapter',
        authTokenProvider: provider ?? () => 'fresh-jwt',
      );
    } finally {
      debugDefaultTargetPlatformOverride = previous;
    }
  }

  Future<Object?> nativeCall(String name, [Object? arguments]) async {
    final reply = Completer<ByteData?>();
    messenger.handlePlatformMessage(
      channel.name,
      const StandardMethodCodec().encodeMethodCall(MethodCall(name, arguments)),
      reply.complete,
    );
    final data = await reply.future;
    return data == null
        ? null
        : const StandardMethodCodec().decodeEnvelope(data);
  }

  setUp(() {
    commands = [];
    platform = MethodChannelRtlPlatform(channel: channel);
    RtlPlatform.instance = platform;
    messenger.setMockMethodCallHandler(channel, (call) async {
      commands.add(call);
      switch (call.method) {
        case 'presentExperience':
          return {'success': false, 'errorCode': 'authentication_failed'};
        case 'handleDeepLink':
          return false;
        case 'hasLocationPermission':
          return true;
        default:
          return null;
      }
    });
  });
  tearDown(() {
    debugDefaultTargetPlatformOverride = null;
    messenger.setMockMethodCallHandler(channel, null);
    messenger.setMockMethodCallHandler(SystemChannels.platform_views, null);
  });

  test(
    'forwards initialization and named targets; preserves native result codes',
    () async {
      await initialize();
      expect(commands.single.arguments, {
        'baseUrl': 'https://rewards.example',
        'urlScheme': 'host-app',
        'externalChapterId': 'chapter',
      });
      final result = await sdk.presentExperience(
        rtlEventId: 'event',
        rtlRedirectUrl: '/offer',
      );
      expect(commands.last.arguments, {
        'rtlEventId': 'event',
        'rtlRedirectUrl': '/offer',
      });
      expect(result.success, false);
      expect(result.errorCode, 'authentication_failed');
      expect(
        await sdk.handleDeepLink('host-app://rtl-sdk/open?rtlEventId=event'),
        false,
      );
      expect(commands.last.arguments, {
        'url': 'host-app://rtl-sdk/open?rtlEventId=event',
      });
      expect(await sdk.hasLocationPermission(), true);
      await sdk.enableLocationFeatures();
      await sdk.disableLocationFeatures();
      await sdk.logout();
      expect(
        commands.map((c) => c.method),
        containsAllInOrder([
          'initialize',
          'presentExperience',
          'handleDeepLink',
          'hasLocationPermission',
          'enableLocationFeatures',
          'disableLocationFeatures',
          'logout',
        ]),
      );
    },
  );

  test('invalid arguments never cross the native bridge', () async {
    for (final url in [
      '',
      'relative/path',
      'ftp://rewards.example',
      'https://user:secret@rewards.example',
    ]) {
      await expectLater(
        sdk.initialize(
          baseUrl: url,
          urlScheme: 'host-app',
          authTokenProvider: () => null,
        ),
        throwsArgumentError,
      );
    }
    for (final scheme in ['', 'host-app:', 'https', '1host']) {
      await expectLater(
        sdk.initialize(
          baseUrl: 'https://rewards.example',
          urlScheme: scheme,
          authTokenProvider: () => null,
        ),
        throwsArgumentError,
      );
    }
    expect(commands, isEmpty);
  });

  test('native bridge failures remain PlatformExceptions; failed init leaves view unavailable', () async {
    messenger.setMockMethodCallHandler(
      channel,
      (_) async => throw PlatformException(code: 'activity_unavailable'),
    );
    await expectLater(initialize(), throwsA(isA<PlatformException>()));
    expect(platform.isInitialized, false);
    expect(await nativeCall('provideAuthToken'), null);
  });

  test(
    'events reach multiple subscribers independently of token delivery',
    () async {
      final loading1 = <bool>[], loading2 = <bool>[];
      var ready = 0;
      final subscriptions = [
        sdk.ready.listen((_) => ready++),
        sdk.loadingStateChanges.listen(loading1.add),
        sdk.loadingStateChanges.listen(loading2.add),
      ];
      await initialize();
      await nativeCall('onLoadingStateChanged', {'isLoading': true});
      await nativeCall('onReady');
      await nativeCall('onLoadingStateChanged', {'isLoading': false});
      await Future<void>.delayed(Duration.zero);
      expect(ready, 1);
      expect(loading1, [true, false]);
      expect(loading2, loading1);
      for (final subscription in subscriptions) {
        await subscription.cancel();
      }
      expect(await nativeCall('provideAuthToken'), 'fresh-jwt');
    },
  );

  test(
    'fresh token provider supports sync, async, null, and throwing callbacks',
    () async {
      var count = 0;
      await initialize(provider: () => 'token-${++count}');
      expect(await nativeCall('provideAuthToken'), 'token-1');
      expect(await nativeCall('provideAuthToken'), 'token-2');
      await initialize(provider: () async => 'async-jwt');
      expect(await nativeCall('provideAuthToken'), 'async-jwt');
      await initialize(provider: () => null);
      expect(await nativeCall('provideAuthToken'), null);
      await initialize(provider: () => throw StateError('backend failed'));
      expect(await nativeCall('provideAuthToken'), null);
    },
  );

  test(
    'logout and reinitialization ignore an old provider completion',
    () async {
      final old = Completer<String?>();
      await initialize(provider: () => old.future);
      final pending = nativeCall('provideAuthToken');
      await Future<void>.delayed(Duration.zero);
      await sdk.logout();
      expect(await pending, null);
      await initialize(provider: () => 'new-jwt');
      old.complete('old-jwt');
      expect(await pending, null);
      expect(await nativeCall('provideAuthToken'), 'new-jwt');
    },
  );

  test(
    'reinitialization immediately cancels a pending token request',
    () async {
      final provider = Completer<String?>();
      await initialize(provider: () => provider.future);
      final pending = nativeCall('provideAuthToken');
      await Future<void>.delayed(Duration.zero);
      await initialize(provider: () => 'replacement');
      expect(await pending, null);
      provider.complete('obsolete');
      expect(await nativeCall('provideAuthToken'), 'replacement');
    },
  );

  test('engine detach invalidates state and pending tokens', () async {
    final provider = Completer<String?>();
    await initialize(provider: () => provider.future);
    final pending = nativeCall('provideAuthToken');
    await Future<void>.delayed(Duration.zero);
    await nativeCall('onDetached');
    expect(await pending, null);
    provider.complete('late-jwt');
    expect(await pending, null);
    expect(platform.isInitialized, false);
  });

  testWidgets('provider timeout resolves to null and ignores late completion', (
    tester,
  ) async {
    final provider = Completer<String?>();
    await initialize(provider: () => provider.future);
    Object? result = 'pending';
    unawaited(nativeCall('provideAuthToken').then((token) => result = token));
    await tester.pump();
    await tester.pump(const Duration(seconds: 30));
    expect(result, null);
    provider.complete('late-jwt');
    await tester.pump();
    expect(result, null);
  });

  testWidgets(
    'premature mounting fails in Dart, without a platform view call',
    (tester) async {
      await tester.pumpWidget(
        const Directionality(
          textDirection: TextDirection.ltr,
          child: RtlView(),
        ),
      );
      expect(tester.takeException(), isA<StateError>());
      expect(commands, isEmpty);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('keyed replacement waits for release before native attachment', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    final released = Completer<void>();
    var created = 0;
    messenger.setMockMethodCallHandler(
      SystemChannels.platform_views,
      (_) async => null,
    );
    messenger.setMockMethodCallHandler(channel, (call) async {
      commands.add(call);
      if (call.method == 'disposeView') await released.future;
      return null;
    });
    await initialize();
    Widget host(String key) => Directionality(
      textDirection: TextDirection.ltr,
      child: RtlView(key: ValueKey(key), onViewCreated: () => created++),
    );
    await tester.pumpWidget(host('first'));
    await tester.pump();
    expect(created, 1);
    await tester.pumpWidget(host('replacement'));
    await tester.pump();
    expect(tester.takeException(), null);
    expect(created, 1);
    released.complete();
    await tester.pump();
    await tester.pump();
    expect(created, 2);
    expect(commands.map((call) => call.method), [
      'initialize',
      'attachView',
      'disposeView',
      'attachView',
    ]);
    await tester.pumpWidget(const SizedBox());
    await tester.pump();
    await tester.pump();
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('a GlobalKey can move the active view without recreating it', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    messenger.setMockMethodCallHandler(
      SystemChannels.platform_views,
      (_) async => null,
    );
    await initialize();
    final key = GlobalKey();
    Widget host(bool right) => Directionality(
      textDirection: TextDirection.ltr,
      child: Row(
        children: [
          Expanded(child: right ? const SizedBox() : RtlView(key: key)),
          Expanded(child: right ? RtlView(key: key) : const SizedBox()),
        ],
      ),
    );
    await tester.pumpWidget(host(false));
    await tester.pump();
    await tester.pumpWidget(host(true));
    await tester.pump();
    expect(tester.takeException(), null);
    expect(commands.where((call) => call.method == 'attachView').length, 1);
    expect(commands.where((call) => call.method == 'disposeView'), isEmpty);
    await tester.pumpWidget(const SizedBox());
    await tester.pump();
    await tester.pump();
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('two simultaneously mounted views fail in Dart', (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    messenger.setMockMethodCallHandler(
      SystemChannels.platform_views,
      (_) async => null,
    );
    await initialize();
    await tester.pumpWidget(
      const Directionality(
        textDirection: TextDirection.ltr,
        child: Row(
          children: [
            Expanded(child: RtlView()),
            Expanded(child: RtlView()),
          ],
        ),
      ),
    );
    expect(tester.takeException(), isA<StateError>());
    await tester.pumpWidget(const SizedBox());
    await tester.pump();
    await tester.pump();
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets(
    'creation is separate from readiness; disposal permits remounting',
    (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      var created = 0, ready = 0;
      final views = <String>[];
      messenger.setMockMethodCallHandler(SystemChannels.platform_views, (
        call,
      ) async {
        views.add(call.method);
        return null;
      });
      final subscription = sdk.ready.listen((_) => ready++);
      await initialize();
      Widget view() => Directionality(
        textDirection: TextDirection.ltr,
        child: RtlView(onViewCreated: () => created++),
      );
      await tester.pumpWidget(view());
      await tester.pump();
      expect(created, 1);
      expect(ready, 0);
      unawaited(nativeCall('onReady'));
      await tester.pump();
      expect(ready, 1);
      await tester.pumpWidget(const SizedBox());
      await tester.pump();
      await tester.pump();
      await tester.pumpWidget(view());
      await tester.pump();
      expect(created, 2);
      expect(views, containsAllInOrder(['create', 'dispose', 'create']));
      await tester.pumpWidget(const SizedBox());
      await tester.pump();
      await tester.pump();
      unawaited(subscription.cancel());
      debugDefaultTargetPlatformOverride = null;
    },
  );
}
