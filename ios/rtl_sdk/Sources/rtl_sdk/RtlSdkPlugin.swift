import Flutter
import Foundation
import RTLSdk
import UIKit

/// Flutter glue; RTL behavior remains in the existing native RTLSdk.
public final class RtlSdkPlugin: NSObject, FlutterPlugin, RTLSdkDelegate {
    private let channel: FlutterMethodChannel
    private var attached = true
    private var initialized = false
    private weak var activeView: RtlPlatformView?
    private var activeViewId: Int64?
    private let views = NSMapTable<NSNumber, RtlPlatformView>.strongToWeakObjects()
    private var presentations: [UUID: Task<Void, Never>] = [:]
    private struct TokenRequest {
        let continuation: CheckedContinuation<String?, Never>
        let timeout: DispatchWorkItem
    }
    private var tokens: [UUID: TokenRequest] = [:]

    private let tokenTimeout: TimeInterval
    init(channel: FlutterMethodChannel, tokenTimeout: TimeInterval = 30) {
        self.channel = channel
        self.tokenTimeout = tokenTimeout
    }

    public static func register(with registrar: FlutterPluginRegistrar) {
        let channel = FlutterMethodChannel(name: "com.affinaloyalty.rtl_sdk", binaryMessenger: registrar.messenger())
        let plugin = RtlSdkPlugin(channel: channel)
        // Flutter delivers detachFromEngine only to a published plugin instance.
        registrar.publish(plugin)
        registrar.addMethodCallDelegate(plugin, channel: channel)
        registrar.register(RtlViewFactory(plugin: plugin), withId: "com.affinaloyalty.rtl_sdk/view")
    }

    public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        dispatchPrecondition(condition: .onQueue(.main))
        let options = call.arguments as? [String: Any] ?? [:]
        switch call.method {
        case "initialize":
            guard let value = options["baseUrl"] as? String, let url = URL(string: value),
                  ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil,
                  let scheme = options["urlScheme"] as? String, !scheme.isEmpty else {
                result(FlutterError(code: "invalid_options", message: "baseUrl and urlScheme are required", details: nil))
                return
            }
            cancelTokens()
            RTLSdk.shared.initialize(baseURL: url, urlScheme: scheme, delegate: self,
                                     externalChapterId: options["externalChapterId"] as? String)
            initialized = true
            result(nil)
        case "attachView":
            guard attached, initialized else {
                result(FlutterError(code: "not_initialized", message: "Initialize RTL first", details: nil)); return
            }
            guard let id = options["viewId"] as? NSNumber,
                  let view = views.object(forKey: id) else {
                result(FlutterError(code: "view_unavailable", message: "The platform view has been disposed", details: nil)); return
            }
            guard activeViewId == nil else {
                result(FlutterError(code: "view_already_attached", message: "Only one RTL view may be attached", details: nil)); return
            }
            view.attach(RTLSdk.shared.createWebView())
            activeView = view
            activeViewId = id.int64Value
            result(nil)
        case "disposeView":
            if let id = options["viewId"] as? NSNumber { releaseView(id.int64Value) }
            result(nil)
        case "presentExperience":
            guard initialized else {
                result(FlutterError(code: "not_initialized", message: "Initialize RTL first", details: nil))
                return
            }
            let id = UUID()
            presentations[id] = Task { @MainActor [weak self] in
                let experience = await RTLSdk.shared.presentExperience(
                    rtlEventId: options["rtlEventId"] as? String,
                    rtlRedirectUrl: options["rtlRedirectUrl"] as? String)
                guard let self else { return }
                self.presentations.removeValue(forKey: id)
                if self.attached {
                    result(["success": experience.success, "errorCode": experience.errorCode as Any? ?? NSNull()])
                }
            }
        case "handleDeepLink":
            guard let value = options["url"] as? String, let url = URL(string: value) else {
                result(false); return
            }
            result(initialized && RTLSdk.shared.handleDeepLink(url))
        case "logout":
            RTLSdk.shared.logout()
            cancelTokens()
            result(nil)
        case "enableLocationFeatures":
            guard initialized else {
                result(FlutterError(code: "not_initialized", message: "Initialize RTL first", details: nil)); return
            }
            RTLSdk.shared.enableLocationFeatures()
            result(nil)
        case "disableLocationFeatures":
            RTLSdk.shared.disableLocationFeatures()
            result(nil)
        case "hasLocationPermission": result(RTLSdk.shared.hasLocationPermission)
        default: result(FlutterMethodNotImplemented)
        }
    }

    public func detachFromEngine(for registrar: FlutterPluginRegistrar) {
        detach()
    }

    func detach() {
        dispatchPrecondition(condition: .onQueue(.main))
        channel.invokeMethod("onDetached", arguments: nil)
        if let id = activeViewId { releaseView(id) }
        views.removeAllObjects()
        attached = false
        initialized = false
        RTLSdk.shared.logout()
        RTLSdk.shared.disableLocationFeatures()
        cancelTokens()
        presentations.values.forEach { $0.cancel() }
        presentations.removeAll()
        channel.setMethodCallHandler(nil)
    }

    public func provideAuthToken() async -> String? {
        await requestToken()
    }

    @MainActor private func requestToken() async -> String? {
        let id = UUID()
        return await withTaskCancellationHandler {
            guard attached, initialized, !Task.isCancelled else { return nil }
            return await withCheckedContinuation { continuation in
                let timeout = DispatchWorkItem { [weak self] in self?.resolveToken(id, token: nil) }
                tokens[id] = TokenRequest(continuation: continuation, timeout: timeout)
                DispatchQueue.main.asyncAfter(deadline: .now() + tokenTimeout, execute: timeout)
                channel.invokeMethod("provideAuthToken", arguments: ["requestId": id.uuidString]) { [weak self] value in
                    self?.resolveToken(id, token: value as? String)
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.resolveToken(id, token: nil) }
        }
    }

    private func resolveToken(_ id: UUID, token: String?) {
        guard let request = tokens.removeValue(forKey: id) else { return }
        request.timeout.cancel()
        request.continuation.resume(returning: token)
    }

    private func cancelTokens() {
        for id in Array(tokens.keys) { resolveToken(id, token: nil) }
    }

    public func onReady() { emit("onReady", arguments: nil) }
    public func onLoadingStateChanged(isLoading: Bool) {
        emit("onLoadingStateChanged", arguments: ["isLoading": isLoading])
    }
    private func emit(_ method: String, arguments: Any?) {
        if Thread.isMainThread {
            if attached { channel.invokeMethod(method, arguments: arguments) }
        } else {
            DispatchQueue.main.async { [weak self] in self?.emit(method, arguments: arguments) }
        }
    }

    func createView(frame: CGRect, id: Int64) -> RtlPlatformView {
        let view = RtlPlatformView(frame: frame, id: id, plugin: self)
        views.setObject(view, forKey: NSNumber(value: id))
        return view
    }

    fileprivate func releaseView(_ id: Int64) {
        if activeViewId == id {
            RTLSdk.shared.logout()
            cancelTokens()
            activeView?.detach()
            activeView = nil
            activeViewId = nil
        }
        views.removeObject(forKey: NSNumber(value: id))
    }
}

private final class RtlViewFactory: NSObject, FlutterPlatformViewFactory {
    private let plugin: RtlSdkPlugin
    init(plugin: RtlSdkPlugin) { self.plugin = plugin }
    func createArgsCodec() -> FlutterMessageCodec & NSObjectProtocol { FlutterStandardMessageCodec.sharedInstance() }
    func create(withFrame frame: CGRect, viewIdentifier viewId: Int64, arguments args: Any?) -> FlutterPlatformView {
        let id = (args as? [String: Any])?["rtlViewId"] as? NSNumber
        return plugin.createView(frame: frame, id: id?.int64Value ?? viewId)
    }
}

final class RtlPlatformView: NSObject, FlutterPlatformView {
    private weak var plugin: RtlSdkPlugin?
    private let id: Int64
    private let container: UIView
    init(frame: CGRect, id: Int64, plugin: RtlSdkPlugin) {
        self.plugin = plugin
        self.id = id
        container = UIView(frame: frame)
    }
    func attach(_ view: UIView) {
        view.frame = container.bounds
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.addSubview(view)
    }
    func detach() { container.subviews.forEach { $0.removeFromSuperview() } }
    func view() -> UIView { container }
    deinit {
        let plugin = plugin
        let id = id
        if Thread.isMainThread { plugin?.releaseView(id) }
        else { DispatchQueue.main.async { plugin?.releaseView(id) } }
    }
}
