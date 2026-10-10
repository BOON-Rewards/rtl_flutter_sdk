import XCTest
import Flutter
import UIKit
@testable import rtl_sdk

final class RunnerTests: XCTestCase {
    @MainActor func testPluginIsPublishedForEngineTeardown() throws {
        let controller = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }.first { $0.isKeyWindow }?.rootViewController as? FlutterViewController
        XCTAssertTrue(try XCTUnwrap(controller?.engine).valuePublished(byPlugin: "RtlSdkPlugin") is RtlSdkPlugin)
    }

    @MainActor func testReplacementAttachesBeforeOldContainerIsDestroyed() {
        let (plugin, _) = makePlugin()
        var old: RtlPlatformView? = plugin.createView(frame: .zero, id: 1)
        XCTAssertNil(command(plugin, "attachView", ["viewId": 1]))
        XCTAssertEqual(old?.view().subviews.count, 1)
        XCTAssertNil(command(plugin, "disposeView", ["viewId": 1]))
        XCTAssertEqual(old?.view().subviews.count, 0)
        let replacement = plugin.createView(frame: .zero, id: 2)
        XCTAssertNil(command(plugin, "attachView", ["viewId": 2]))
        old = nil
        XCTAssertEqual(replacement.view().subviews.count, 1)
        let duplicate = plugin.createView(frame: .zero, id: 3)
        XCTAssertEqual((command(plugin, "attachView", ["viewId": 3]) as? FlutterError)?.code, "view_already_attached")
        XCTAssertTrue(duplicate.view().subviews.isEmpty)
        plugin.detach()
    }

    @MainActor func testNativeTimeoutIgnoresLateResponse() async {
        let (plugin, messenger) = makePlugin(timeout: 0.02)
        let requested = expectation(description: "token requested")
        messenger.onRequest = { requested.fulfill() }
        let pending = Task { await plugin.provideAuthToken() }
        await fulfillment(of: [requested], timeout: 1)
        let expired = await pending.value
        XCTAssertNil(expired)
        messenger.reply(0, token: "obsolete")
        await assertFreshToken(plugin, messenger)
        plugin.detach()
    }

    @MainActor func testLogoutAndReinitializationCancelNativeRequests() async {
        for method in ["logout", "initialize"] {
            let (plugin, messenger) = makePlugin()
            let requested = expectation(description: method)
            messenger.onRequest = { requested.fulfill() }
            let pending = Task { await plugin.provideAuthToken() }
            await fulfillment(of: [requested], timeout: 1)
            XCTAssertNil(command(plugin, method, method == "initialize" ? options : [:]))
            let cancelled = await pending.value
            XCTAssertNil(cancelled)
            messenger.reply(0, token: "obsolete")
            await assertFreshToken(plugin, messenger)
            plugin.detach()
        }
    }

    @MainActor func testCallerCancellationAndEngineDetachCancelRequests() async {
        for detach in [false, true] {
            let (plugin, messenger) = makePlugin()
            let requested = expectation(description: "pending")
            messenger.onRequest = { requested.fulfill() }
            let pending = Task { await plugin.provideAuthToken() }
            await fulfillment(of: [requested], timeout: 1)
            if detach { plugin.detach() } else { pending.cancel() }
            let cancelled = await pending.value
            XCTAssertNil(cancelled)
            messenger.reply(0, token: "obsolete")
            if detach {
                let unavailable = await plugin.provideAuthToken()
                XCTAssertNil(unavailable)
                XCTAssertTrue(messenger.calls.contains("onDetached"))
            } else { await assertFreshToken(plugin, messenger); plugin.detach() }
        }
    }

    @MainActor func testEventsUseTheFlutterChannel() {
        let (plugin, messenger) = makePlugin()
        plugin.onReady()
        plugin.onLoadingStateChanged(isLoading: true)
        XCTAssertEqual(messenger.calls, ["onReady", "onLoadingStateChanged"])
        plugin.detach()
    }

    private let options: [String: Any] = ["baseUrl": "https://example.invalid", "urlScheme": "rtl-host"]
    @MainActor private func makePlugin(timeout: TimeInterval = 30) -> (RtlSdkPlugin, RecordingMessenger) {
        let messenger = RecordingMessenger()
        let plugin = RtlSdkPlugin(channel: FlutterMethodChannel(name: "test", binaryMessenger: messenger), tokenTimeout: timeout)
        XCTAssertNil(command(plugin, "initialize", options))
        return (plugin, messenger)
    }
    @MainActor private func command(_ plugin: RtlSdkPlugin, _ method: String, _ arguments: [String: Any] = [:]) -> Any? {
        var response: Any?
        var completed = false
        plugin.handle(FlutterMethodCall(methodName: method, arguments: arguments)) { response = $0; completed = true }
        XCTAssertTrue(completed)
        return response
    }
    @MainActor private func assertFreshToken(_ plugin: RtlSdkPlugin, _ messenger: RecordingMessenger) async {
        let requested = expectation(description: "fresh request")
        messenger.onRequest = { requested.fulfill() }
        let pending = Task { await plugin.provideAuthToken() }
        await fulfillment(of: [requested], timeout: 1)
        messenger.reply(messenger.replies.count - 1, token: "fresh")
        let token = await pending.value
        XCTAssertEqual(token, "fresh")
    }
}

private final class RecordingMessenger: NSObject, FlutterBinaryMessenger {
    var replies: [FlutterBinaryReply] = []
    var calls: [String] = []
    var onRequest: (() -> Void)?
    private let codec = FlutterStandardMethodCodec.sharedInstance()
    func send(onChannel channel: String, message: Data?) { send(onChannel: channel, message: message, binaryReply: nil) }
    func send(onChannel channel: String, message: Data?, binaryReply callback: FlutterBinaryReply?) {
        guard let message else { return }
        let call = codec.decodeMethodCall(message)
        calls.append(call.method)
        if call.method == "provideAuthToken", let callback {
            replies.append(callback)
            onRequest?()
        }
    }
    func reply(_ index: Int, token: String) { replies[index](codec.encodeSuccessEnvelope(token)) }
    func setMessageHandlerOnChannel(_ channel: String, binaryMessageHandler handler: FlutterBinaryMessageHandler?) -> FlutterBinaryMessengerConnection { 1 }
    func cleanUpConnection(_ connection: FlutterBinaryMessengerConnection) {}
}
