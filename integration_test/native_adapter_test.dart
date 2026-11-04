import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:rtl_sdk/rtl_sdk.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('native readiness, renewal, replacement, and cancellation', (
    tester,
  ) async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final sdk = RtlSdk.instance;
    var documents = 0;
    var expireDocument = 0;
    var readyCount = 0;
    var tokenRequests = 0;
    final seen = <String>[];
    final handoffs = <Map<String, String>>[];
    final completions = <Map<String, dynamic>>[];
    final loaded = <Uri>[];
    final loading = <bool>[];
    final subscriptions = [
      sdk.ready.listen((_) => readyCount++),
      sdk.loadingStateChanges.listen(loading.add),
    ];
    server.listen((request) async {
      if (request.uri.path == '/state') {
        request.response.headers.contentType = ContentType.json;
        request.response.write(jsonEncode({'expireDocument': expireDocument}));
      } else if (request.uri.path == '/seen') {
        seen.add(request.uri.queryParameters['jwt']!);
        handoffs.add(request.uri.queryParameters);
      } else if (request.uri.path == '/completed') {
        completions.add(
          jsonDecode(request.uri.queryParameters['message']!)
              as Map<String, dynamic>,
        );
      } else if (request.uri.path == '/favicon.ico') {
        request.response.statusCode = HttpStatus.noContent;
      } else {
        loaded.add(request.uri);
        request.response.headers.contentType = ContentType.html;
        request.response.write(experienceHtml(++documents));
      }
      await request.response.close();
    });
    final baseUrl = 'http://localhost:${server.port}';
    Future<void> initialize(RtlAuthTokenProvider provider) => sdk.initialize(
      baseUrl: baseUrl,
      urlScheme: 'rtl-host',
      authTokenProvider: provider,
    );
    Future<void> until(bool Function() condition) async {
      for (var i = 0; i < 200 && !condition(); i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      expect(
        condition(),
        true,
        reason:
            'documents=$documents, ready=$readyCount, seen=$seen, loading=$loading',
      );
    }

    var created = 0;
    Widget host(String key) => MaterialApp(
      home: RtlView(key: ValueKey(key), onViewCreated: () => created++),
    );
    try {
      await initialize(() => 'fixture-${++tokenRequests}');
      await tester.pumpWidget(host('first'));
      await until(() => created == 1);
      expect((await sdk.presentExperience()).success, true);
      await until(() => seen.contains('fixture-1'));
      expect(readyCount, 1);
      expireDocument = documents;
      await until(() => readyCount == 2 && seen.contains('fixture-2'));
      expect(tokenRequests, 2);
      expect(loading, containsAllInOrder([true, false, true, false]));

      // Replace directly, without an empty frame or arbitrary disposal delay.
      await tester.pumpWidget(host('replacement'));
      await until(() => created == 2);
      expect((await sdk.presentExperience()).success, true);
      await until(() => seen.contains('fixture-3'));

      final oldToken = Completer<String?>();
      final requested = Completer<void>();
      await initialize(() {
        requested.complete();
        return oldToken.future;
      });
      final pending = sdk.presentExperience();
      await requested.future;
      await sdk.logout();
      expect((await pending).errorCode, 'request_cancelled');
      oldToken.complete('obsolete');
      await initialize(() => 'fixture-${++tokenRequests}');
      expect((await sdk.presentExperience()).success, true);
      await until(() => seen.contains('fixture-4'));
      expect(seen, isNot(contains('obsolete')));

      for (final url in [
        'unrelated://rtl-callback/open',
        'rtl-host://other/open',
        'rtl-host://rtl-callback/unknown',
        'rtl-host://rtl-callback/open/extra',
        'rtl-host://user@rtl-callback/open',
        'rtl-host://rtl-callback:123/open',
      ]) {
        expect(await sdk.handleDeepLink(url), false, reason: url);
      }
      for (final parameters in <Map<String, String>>[
        {},
        {'rtlEventId': 'event-1'},
        {'rtlRedirectUrl': '$baseUrl/offers'},
        {'rtlEventId': 'event-1', 'rtlRedirectUrl': '$baseUrl/offers'},
        {'rtlEventId': 'event+1', 'rtlRedirectUrl': ' '},
        {'rtlRedirectUrl': '$baseUrl/offers?label=two words&code=a+b'},
      ]) {
        final before = readyCount;
        final url = Uri(
          scheme: 'rtl-host',
          host: 'rtl-callback',
          path: '/open',
          queryParameters: parameters,
        );
        expect(await sdk.handleDeepLink(url.toString()), true);
        await until(() => readyCount == before + 1);
        await until(() => seen.contains('fixture-$tokenRequests'));
        final redirect = parameters['rtlRedirectUrl'];
        final hasRedirect = redirect != null && redirect.trim().isNotEmpty;
        expect(handoffs.last['rtlRedirectUrl'], hasRedirect ? redirect : null);
        expect(
          handoffs.last['rtlEventId'],
          hasRedirect ? null : parameters['rtlEventId'],
        );
      }
      final readyBeforeCallbacks = readyCount;
      for (final path in ['', '/callback']) {
        final count = completions.length;
        final url = Uri(
          scheme: 'rtl-host',
          host: 'rtl-callback',
          path: path,
          queryParameters: {
            'redirectUrl': '$baseUrl/home?result=old&keep=yes&label=two+words',
            'resume': 'message',
            'completionType': 'openBanking',
            'result': 'linked',
            'providerToken': 'opaque+value',
            'error_description': 'user denied',
          },
        );
        expect(await sdk.handleDeepLink(url.toString()), true);
        await until(() => completions.length == count + 1);
        expect(completions.last['completionType'], 'openBanking');
        expect(completions.last['data'], {
          'keep': 'yes',
          'label': 'two words',
          'result': 'linked',
          'providerToken': 'opaque+value',
          'error_description': 'user denied',
        });
        expect(readyCount, readyBeforeCallbacks);
      }
      final loadedBeforeInvalidCallback = loaded.length;
      final invalidCallback = Uri(
        scheme: 'rtl-host',
        host: 'rtl-callback',
        path: '/callback',
        queryParameters: {'redirectUrl': 'https://other.example/home'},
      );
      expect(await sdk.handleDeepLink(invalidCallback.toString()), true);
      await tester.pump(const Duration(milliseconds: 200));
      expect(loaded.length, loadedBeforeInvalidCallback);
      expect(completions.length, 2);

      for (final path in ['', '/callback']) {
        final before = readyCount;
        final url = Uri(
          scheme: 'rtl-host',
          host: 'rtl-callback',
          path: path,
          queryParameters: {
            'redirectUrl': '$baseUrl/home?result=old&keep=yes&label=two+words',
            'result': 'linked',
            'providerToken': 'opaque+value',
            'error_description': 'user denied',
          },
        );
        expect(await sdk.handleDeepLink(url.toString()), true);
        await until(() => readyCount == before + 1);
        expect(loaded.last.path, '/home');
        expect(loaded.last.queryParameters, {
          'keep': 'yes',
          'label': 'two words',
          'result': 'linked',
          'providerToken': 'opaque+value',
          'error_description': 'user denied',
        });
      }

      await initialize(() => throw StateError('backend unavailable'));
      expect((await sdk.presentExperience()).errorCode, 'token_unavailable');
      expect(await sdk.hasLocationPermission(), false);
      await sdk.disableLocationFeatures();
      expect(await sdk.handleDeepLink('unrelated://host/path'), false);
      await tester.pumpWidget(const MaterialApp(home: SizedBox()));
      await tester.pump();
    } finally {
      await sdk.logout();
      for (final subscription in subscriptions) {
        await subscription.cancel();
      }
      await server.close(force: true);
    }
  });
}

// A local, trusted document exercises the real WebView bridge without a backend.
String experienceHtml(int document) =>
    '''<!doctype html><html><body>RTL fixture
<script>
function send(type) {
  const payload = JSON.stringify({type});
  const ios = window.webkit?.messageHandlers?.inappwebview;
  const android = window.inappwebview;
  if (ios) ios.postMessage(payload);
  else if (android) android.postMessage(payload);
  else return false;
  return true;
}
const attach = setInterval(() => {
  if (!send('appReady')) return;
  clearInterval(attach);
  const target = new URLSearchParams(location.hash.slice(1));
  target.set('jwt', target.get('token'));
  fetch('/seen?' + target.toString());
  const poll = setInterval(async () => {
    const state = await (await fetch('/state')).json();
    if (state.expireDocument === $document) {
      clearInterval(poll);
      send('sessionExpired');
    }
  }, 100);
}, 50);
window.addEventListener('message', event => {
  if (event.data?.type === 'logoutRequested') send('userLogout');
  if (event.data?.type === 'overlayCompleted') {
    fetch('/completed?message=' + encodeURIComponent(JSON.stringify(event.data)));
  }
});
</script></body></html>''';
