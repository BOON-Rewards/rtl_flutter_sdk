package com.affinaloyalty.rtlsdk.rtl_sdk

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import com.affinaloyalty.rtlsdk.RTLLocationExtension
import com.affinaloyalty.rtlsdk.RTLSdk
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.mockito.Mockito.*
import java.lang.ref.WeakReference

@OptIn(ExperimentalCoroutinesApi::class)
class RtlSdkPluginTest {
    private val sdk = RTLSdk.getInstance()
    private lateinit var plugin: RtlSdkPlugin
    private val dispatcher = UnconfinedTestDispatcher()

    @Before fun setUp() {
        Dispatchers.setMain(dispatcher)
        plugin = RtlSdkPlugin()
    }

    @After fun tearDown() {
        sdk.locationExtension = null
        Dispatchers.resetMain()
    }

    @Test fun `activity recreation replaces the host and re-registers permission handling`() {
        val old = activityBinding()
        plugin.onAttachedToActivity(old)
        // Simulate an already initialized engine; no WebView or network is needed.
        RtlSdkPlugin::class.java.getDeclaredField("initialized").apply {
            isAccessible = true
            setBoolean(plugin, true)
        }
        plugin.onDetachedFromActivityForConfigChanges()
        verify(old).removeRequestPermissionsResultListener(plugin)
        val replacement = activityBinding()
        plugin.onReattachedToActivityForConfigChanges(replacement)
        verify(replacement).addRequestPermissionsResultListener(plugin)
        val field = RTLSdk::class.java.getDeclaredField("currentActivityRef").apply { isAccessible = true }
        assertSame(replacement.activity, (field.get(sdk) as WeakReference<*>).get())
        field.set(sdk, null)
    }

    @Test fun `permission denial is forwarded unchanged and unrelated requests remain unhandled`() {
        val location = mock(RTLLocationExtension::class.java)
        sdk.locationExtension = location
        val permissions = arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
        val denied = intArrayOf(PackageManager.PERMISSION_DENIED)
        `when`(location.handlePermissionResult(7, permissions, denied)).thenReturn(true)
        assertTrue(plugin.onRequestPermissionsResult(7, permissions, denied))
        verify(location).handlePermissionResult(7, permissions, denied)
        assertFalse(plugin.onRequestPermissionsResult(999, permissions, denied))
        val result = RecordingResult()
        plugin.onMethodCall(MethodCall("hasLocationPermission", null), result)
        assertEquals(false, result.value)
    }

    @Test fun `initialization without a host activity returns a bridge error`() {
        val result = RecordingResult()
        plugin.onMethodCall(MethodCall("initialize", mapOf("baseUrl" to "https://example.com", "urlScheme" to "app")), result)
        assertEquals("activity_unavailable", result.errorCode)
    }

    @Test fun `native token timeout ignores late replies and accepts a fresh request`() = runTest(dispatcher) {
        val replies = tokenChannel()
        val pending = async { plugin.provideAuthToken() }
        advanceTimeBy(30_000)
        runCurrent()
        assertNull(pending.await())
        replies.single().success("obsolete")
        val fresh = async { plugin.provideAuthToken() }
        replies.last().success("fresh")
        assertEquals("fresh", fresh.await())
    }

    @Test fun `logout cancels pending native tokens and ignores old callbacks`() = runTest(dispatcher) {
        val replies = tokenChannel()
        val pending = async { plugin.provideAuthToken() }
        val result = RecordingResult()
        plugin.onMethodCall(MethodCall("logout", null), result)
        assertNull(result.errorCode)
        assertNull(pending.await())
        replies.single().success("obsolete")
        val fresh = async { plugin.provideAuthToken() }
        replies.last().success("fresh")
        assertEquals("fresh", fresh.await())
    }

    @Test fun `engine detach cancels tokens and prevents new requests`() = runTest(dispatcher) {
        val replies = tokenChannel()
        val pending = async { plugin.provideAuthToken() }
        plugin.onDetachedFromEngine(mock(io.flutter.embedding.engine.plugins.FlutterPlugin.FlutterPluginBinding::class.java))
        assertNull(pending.await())
        replies.single().success("obsolete")
        assertNull(plugin.provideAuthToken())
        assertEquals(1, replies.size)
    }

    @Test fun `caller cancellation removes the native request`() = runTest(dispatcher) {
        val replies = tokenChannel()
        val pending = async { plugin.provideAuthToken() }
        pending.cancel()
        pending.join()
        replies.single().success("obsolete")
        val fresh = async { plugin.provideAuthToken() }
        replies.last().success("fresh")
        assertEquals("fresh", fresh.await())
    }

    private fun tokenChannel(): MutableList<MethodChannel.Result> {
        val channel = mock(MethodChannel::class.java)
        val replies = mutableListOf<MethodChannel.Result>()
        doAnswer { invocation ->
            replies.add(invocation.getArgument(2))
            null
        }.`when`(channel).invokeMethod(eq("provideAuthToken"), any(), any(MethodChannel.Result::class.java))
        RtlSdkPlugin::class.java.getDeclaredField("channel").apply { isAccessible = true; set(plugin, channel) }
        return replies
    }

    private fun activityBinding(): ActivityPluginBinding = mock(ActivityPluginBinding::class.java).also {
        `when`(it.activity).thenReturn(mock(Activity::class.java))
    }

    private class RecordingResult : MethodChannel.Result {
        var value: Any? = null
        var errorCode: String? = null
        override fun success(result: Any?) { value = result }
        override fun error(code: String, message: String?, details: Any?) { errorCode = code }
        override fun notImplemented() { error("Unexpected method") }
    }
}
