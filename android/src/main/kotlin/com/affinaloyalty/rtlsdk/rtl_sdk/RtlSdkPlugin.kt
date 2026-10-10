package com.affinaloyalty.rtlsdk.rtl_sdk

import android.app.Activity
import android.content.Context
import android.content.MutableContextWrapper
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import com.affinaloyalty.rtlsdk.RTLSdk
import com.affinaloyalty.rtlsdk.RTLSdkListener
import com.affinaloyalty.rtlsdk.RTLSdkPermissionRequester
import com.affinaloyalty.rtlsdk.location.RTLLocationModule
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.PluginRegistry
import io.flutter.plugin.common.StandardMessageCodec
import io.flutter.plugin.platform.PlatformView
import io.flutter.plugin.platform.PlatformViewFactory
import kotlinx.coroutines.*
import java.util.UUID
import java.lang.ref.WeakReference

/** Flutter glue; all RTL behavior remains in the existing native SDK. */
class RtlSdkPlugin : FlutterPlugin, MethodChannel.MethodCallHandler, ActivityAware,
    PluginRegistry.RequestPermissionsResultListener, RTLSdkListener {
    private var channel: MethodChannel? = null
    private var binding: ActivityPluginBinding? = null
    private var scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var initialized = false
    private var activeView: RtlPlatformView? = null
    private val views = mutableMapOf<Long, WeakReference<RtlPlatformView>>()
    private val tokens = mutableMapOf<String, CompletableDeferred<String?>>()
    private val sdk get() = RTLSdk.getInstance()
    private val permissionRequester = RTLSdkPermissionRequester { _, permissions, requestCode ->
        binding?.activity?.requestPermissions(permissions, requestCode)
    }

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        channel = MethodChannel(binding.binaryMessenger, "com.affinaloyalty.rtl_sdk").also {
            it.setMethodCallHandler(this)
        }
        binding.platformViewRegistry.registerViewFactory("com.affinaloyalty.rtl_sdk/view", RtlViewFactory(this))
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        scope.launch {
            try {
                when (call.method) {
                    "initialize" -> {
                        val activity = binding?.activity ?: return@launch result.error("activity_unavailable", "No host Activity", null)
                        val baseUrl = call.argument<String>("baseUrl")
                        val scheme = call.argument<String>("urlScheme")
                        if (baseUrl.isNullOrBlank() || scheme.isNullOrBlank()) {
                            return@launch result.error("invalid_options", "baseUrl and urlScheme are required", null)
                        }
                        cancelTokens()
                        sdk.initialize(baseUrl, scheme, activity, this@RtlSdkPlugin, call.argument("externalChapterId"))
                        sdk.permissionRequester = permissionRequester
                        RTLLocationModule.install(sdk)
                        initialized = true
                        result.success(null)
                    }
                    "attachView" -> {
                        check(initialized) { "Initialize RTL before mounting its view" }
                        checkNotNull(binding?.activity) { "No host Activity" }
                        check(activeView == null) { "Only one RTL view may be attached" }
                        val id = checkNotNull(call.argument<Number>("viewId")).toLong()
                        val view = checkNotNull(views[id]?.get()) { "The platform view has been disposed" }
                        view.attach(sdk)
                        activeView = view
                        result.success(null)
                    }
                    "disposeView" -> {
                        call.argument<Number>("viewId")?.toLong()?.let { views.remove(it)?.get()?.dispose() }
                        result.success(null)
                    }
                    "presentExperience" -> {
                        if (!initialized) return@launch result.error("not_initialized", "Initialize RTL first", null)
                        val experience = sdk.presentExperience(call.argument("rtlEventId"), call.argument("rtlRedirectUrl"))
                        result.success(mapOf("success" to experience.success, "errorCode" to experience.errorCode))
                    }
                    "handleDeepLink" -> {
                        val uri = call.argument<String>("url")?.let { runCatching { Uri.parse(it) }.getOrNull() }
                        result.success(initialized && uri != null && sdk.handleDeepLink(uri))
                    }
                    "logout" -> { sdk.logout(); cancelTokens(); result.success(null) }
                    "enableLocationFeatures" -> {
                        if (!initialized) return@launch result.error("not_initialized", "Initialize RTL first", null)
                        val activity = binding?.activity ?: return@launch result.error("activity_unavailable", "No host Activity", null)
                        sdk.enableLocationFeatures(activity)
                        result.success(null)
                    }
                    "disableLocationFeatures" -> { sdk.disableLocationFeatures(); result.success(null) }
                    "hasLocationPermission" -> result.success(sdk.hasLocationPermission)
                    else -> result.notImplemented()
                }
            } catch (error: CancellationException) {
                if (channel != null) result.error("request_cancelled", "Request cancelled", null)
            } catch (error: Exception) {
                result.error("${call.method}_failed", error.message, null)
            }
        }
    }

    override suspend fun provideAuthToken(): String? = withContext(Dispatchers.Main.immediate) {
        val currentChannel = channel ?: return@withContext null
        val id = UUID.randomUUID().toString()
        val deferred = CompletableDeferred<String?>()
        tokens[id] = deferred
        currentChannel.invokeMethod("provideAuthToken", mapOf("requestId" to id), object : MethodChannel.Result {
            override fun success(result: Any?) { tokens.remove(id)?.complete(result as? String) }
            override fun error(code: String, message: String?, details: Any?) { tokens.remove(id)?.complete(null) }
            override fun notImplemented() { tokens.remove(id)?.complete(null) }
        })
        try { withTimeoutOrNull(30_000) { deferred.await() } }
        finally { tokens.remove(id) }
    }
    private fun cancelTokens() {
        tokens.values.forEach { it.complete(null) }
        tokens.clear()
    }
    override fun onReady() { scope.launch { channel?.invokeMethod("onReady", null) } }
    override fun onLoadingStateChanged(isLoading: Boolean) {
        scope.launch { channel?.invokeMethod("onLoadingStateChanged", mapOf("isLoading" to isLoading)) }
    }

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        this.binding = binding
        binding.addRequestPermissionsResultListener(this)
        if (initialized) sdk.updateHostActivity(binding.activity)
        activeView?.updateContext(binding.activity)
    }
    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) = onAttachedToActivity(binding)
    private fun detachActivity() {
        binding?.removeRequestPermissionsResultListener(this)
        binding = null
        activeView?.useApplicationContext()
    }
    override fun onDetachedFromActivityForConfigChanges() = detachActivity()
    override fun onDetachedFromActivity() {
        if (initialized) { sdk.logout(); cancelTokens() }
        detachActivity()
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray): Boolean =
        sdk.handlePermissionResult(requestCode, permissions, grantResults)

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel?.invokeMethod("onDetached", null)
        channel?.setMethodCallHandler(null)
        channel = null
        if (initialized) { sdk.logout(); sdk.disableLocationFeatures() }
        if (sdk.permissionRequester === permissionRequester) sdk.permissionRequester = null
        initialized = false
        cancelTokens()
        activeView?.dispose()
        views.clear()
        detachActivity()
        scope.cancel()
    }

    internal fun createView(context: Context, id: Long): RtlPlatformView {
        views.entries.removeAll { it.value.get() == null }
        return RtlPlatformView(MutableContextWrapper(binding?.activity ?: context), id, this).also {
            views[id] = WeakReference(it)
        }
    }
    internal fun releaseView(view: RtlPlatformView) {
        views.remove(view.id)
        if (activeView !== view) return
        sdk.logout()
        cancelTokens()
        activeView = null
    }
}

private class RtlViewFactory(private val plugin: RtlSdkPlugin) : PlatformViewFactory(StandardMessageCodec.INSTANCE) {
    override fun create(context: Context, viewId: Int, args: Any?): PlatformView {
        val id = ((args as? Map<*, *>)?.get("rtlViewId") as? Number)?.toLong() ?: viewId.toLong()
        return plugin.createView(context, id)
    }
}

internal class RtlPlatformView(private val context: MutableContextWrapper, val id: Long,
    private val plugin: RtlSdkPlugin) : PlatformView {
    private val container = FrameLayout(context)
    private var disposed = false
    fun attach(sdk: RTLSdk) {
        check(!disposed) { "The platform view has been disposed" }
        container.addView(sdk.createWebView(context), FrameLayout.LayoutParams(-1, -1))
    }
    override fun getView(): View = container
    fun updateContext(activity: Activity) { context.baseContext = activity }
    fun useApplicationContext() { context.baseContext = context.applicationContext }
    override fun dispose() {
        if (disposed) return
        disposed = true
        plugin.releaseView(this)
        destroyWebViews(container)
        container.removeAllViews()
        useApplicationContext()
    }
    private fun destroyWebViews(view: View) {
        if (view is WebView) { view.stopLoading(); view.destroy() }
        else if (view is ViewGroup) {
            for (i in 0 until view.childCount) destroyWebViews(view.getChildAt(i))
        }
    }
}
