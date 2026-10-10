// Flutter-only verification host. Copied beside sdk-release.mjs in the distribution.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Preserve the CI runner workspace; use /tmp for local Unix runs.
const tempRoot =
  process.env.RUNNER_TEMP || (process.platform === "win32" ? os.tmpdir() : "/tmp");

export function prepareFlutterHost(
  directory,
  androidSource,
  { run, packageRoot = process.cwd(), platforms = ["ios", "android"] },
) {
  run(
    [
      "flutter",
      "create",
      `--platforms=${platforms.join(",")}`,
      "--project-name=rtl_host",
      "--org=com.affinaloyalty",
      "--no-pub",
      directory,
    ],
    { stream: true },
  );
  const write = (file, value) =>
    fs.writeFileSync(path.join(directory, file), value);
  const copy = (source, target) => {
    fs.mkdirSync(path.dirname(path.join(directory, target)), {
      recursive: true,
    });
    fs.copyFileSync(
      path.join(packageRoot, source),
      path.join(directory, target),
    );
  };
  write(
    "pubspec.yaml",
    JSON.stringify(
      {
        name: "rtl_host",
        publish_to: "none",
        version: "1.0.0+1",
        environment: { sdk: ">=3.13.0 <4.0.0", flutter: ">=3.47.0" },
        dependencies: {
          flutter: { sdk: "flutter" },
          rtl_sdk: { path: packageRoot },
        },
        dev_dependencies: {
          flutter_test: { sdk: "flutter" },
          integration_test: { sdk: "flutter" },
        },
        flutter: {
          config: { "enable-swift-package-manager": true },
          "uses-material-design": true,
        },
      },
      null,
      2,
    ),
  );
  write(
    "lib/main.dart",
    `import 'package:flutter/material.dart';
import 'package:rtl_sdk/rtl_sdk.dart';
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await RtlSdk.instance.initialize(baseUrl: 'https://example.invalid', urlScheme: 'rtl-host', authTokenProvider: () => null);
  runApp(const MaterialApp(home: RtlView()));
}
`,
  );
  fs.rmSync(path.join(directory, "test"), { recursive: true, force: true });
  write(
    "analysis_options.yaml",
    "analyzer:\n  exclude: [build/**, android/**, ios/**]\n",
  );
  copy(
    "integration_test/native_adapter_test.dart",
    "integration_test/native_adapter_test.dart",
  );
  write(
    "android/settings.gradle.kts",
    `pluginManagement {
  val properties = java.util.Properties()
  file("local.properties").inputStream().use { properties.load(it) }
  val flutterSdkPath = requireNotNull(properties.getProperty("flutter.sdk"))
  includeBuild("$flutterSdkPath/packages/flutter_tools/gradle")
  repositories { google(); mavenCentral(); gradlePluginPortal() }
}
plugins {
  id("dev.flutter.flutter-plugin-loader") version "1.0.0"
  id("com.android.application") version "8.13.2" apply false
  id("com.android.library") version "8.13.2" apply false
  id("org.jetbrains.kotlin.android") version "2.2.20" apply false
}
include(":app")
val nativeSdkPath = System.getenv("RTL_ANDROID_SDK_PATH")
if (!nativeSdkPath.isNullOrBlank()) {
  include(":core", ":hyperlocal-offers")
  project(":core").projectDir = file("$nativeSdkPath/core")
  project(":hyperlocal-offers").projectDir = file("$nativeSdkPath/hyperlocal-offers")
}
`,
  );
  write(
    "android/build.gradle.kts",
    `allprojects {
  repositories {
    google(); mavenCentral()
    maven {
      url = uri("https://maven.pkg.github.com/BOON-Rewards/rtl_android_sdk")
      content { includeGroup("com.affinaloyalty") }
      credentials {
        username = System.getenv("GITHUB_USERNAME")
        password = System.getenv("GITHUB_TOKEN")
      }
    }
  }
}
val output = rootProject.layout.projectDirectory.dir("../build")
rootProject.layout.buildDirectory.value(output)
subprojects {
  layout.buildDirectory.value(output.dir(name))
  evaluationDependsOn(":app")
}
tasks.register<Delete>("clean") { delete(rootProject.layout.buildDirectory) }
`,
  );
  write(
    "android/app/build.gradle.kts",
    `plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
  id("dev.flutter.flutter-gradle-plugin")
}
android {
  namespace = "com.affinaloyalty.rtl_host"
  compileSdk = 36
  ndkVersion = flutter.ndkVersion
  compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
  defaultConfig { applicationId = "com.affinaloyalty.rtl_host"; minSdk = 24; targetSdk = 36; versionCode = 1; versionName = "1.0" }
}
kotlin { compilerOptions { jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17 } }
flutter { source = "../.." }
`,
  );
  write(
    "android/gradle.properties",
    "org.gradle.jvmargs=-Xmx4G\nandroid.useAndroidX=true\nandroid.builtInKotlin=false\nandroid.newDsl=false\n",
  );
  // Local HTTP is restricted to this temporary test host, never the SDK manifest.
  write(
    "android/app/src/main/AndroidManifest.xml",
    `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.INTERNET" />
  <application android:label="RTL host" android:name="\${applicationName}" android:usesCleartextTraffic="true">
    <activity android:name=".MainActivity" android:exported="true" android:theme="@style/LaunchTheme"
      android:configChanges="orientation|keyboardHidden|keyboard|screenSize|smallestScreenSize|locale|layoutDirection|fontScale|screenLayout|density|uiMode"
      android:hardwareAccelerated="true" android:windowSoftInputMode="adjustResize">
      <meta-data android:name="io.flutter.embedding.android.NormalTheme" android:resource="@style/NormalTheme" />
      <intent-filter><action android:name="android.intent.action.MAIN" /><category android:name="android.intent.category.LAUNCHER" /></intent-filter>
    </activity>
    <meta-data android:name="flutterEmbedding" android:value="2" />
  </application>
</manifest>
`,
  );
  for (const file of [
    "gradlew",
    "gradlew.bat",
    "gradle/wrapper/gradle-wrapper.jar",
    "gradle/wrapper/gradle-wrapper.properties",
  ]) {
    fs.copyFileSync(
      path.join(androidSource, file),
      path.join(directory, "android", file),
    );
  }
  fs.chmodSync(path.join(directory, "android/gradlew"), 0o755);
  if (platforms.includes("ios")) {
    const patch = (file, pattern, replacement) => {
      const text = fs.readFileSync(path.join(directory, file), "utf8");
      if (!pattern.test(text))
        throw new Error(`Flutter host template changed: ${file}`);
      write(file, text.replace(pattern, replacement));
    };
    patch(
      "ios/Runner.xcodeproj/project.pbxproj",
      /IPHONEOS_DEPLOYMENT_TARGET = [^;]+;/g,
      "IPHONEOS_DEPLOYMENT_TARGET = 15.0;",
    );
    const project = path.join(
      directory,
      "ios/Runner.xcodeproj/project.pbxproj",
    );
    fs.writeFileSync(
      project,
      fs
        .readFileSync(project, "utf8")
        .replace(/^\s*DEVELOPMENT_TEAM = [^;]+;\n/gm, ""),
    );
    patch(
      "ios/Flutter/AppFrameworkInfo.plist",
      /<\/dict>\s*<\/plist>\s*$/,
      "<key>MinimumOSVersion</key><string>15.0</string>\n</dict></plist>\n",
    );
    patch(
      "ios/Runner/Info.plist",
      /<\/dict>\s*<\/plist>\s*$/,
      "<key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict>\n</dict></plist>\n",
    );
    copy(
      "test/native/RtlSdkPluginTests.swift",
      "ios/RunnerTests/RunnerTests.swift",
    );
  }
}

export async function buildFlutterHost(androidSource, env, helpers) {
  const { run, gradle, verifyGradleWrapper } = helpers;
  const original = process.cwd();
  const directory = fs.mkdtempSync(
    path.join(tempRoot, "rtl-host-"),
  );
  try {
    prepareFlutterHost(directory, androidSource, {
      run,
      packageRoot: original,
    });
    verifyGradleWrapper(path.join(directory, "android"));
    process.chdir(directory);
    run(["flutter", "pub", "get"], { stream: true });
    run(["flutter", "analyze", "--no-pub"], { stream: true });
    run(["flutter", "build", "apk", "--debug", "--no-pub"], {
      stream: true,
      env,
    });
    process.chdir("android");
    gradle([":rtl_sdk:testDebugUnitTest"], env);
    process.chdir("..");
    run(
      [
        "flutter",
        "build",
        "ios",
        "--simulator",
        "--debug",
        "--no-codesign",
        "--no-pub",
      ],
      { stream: true, env },
    );
    const devices = JSON.parse(
      run(["xcrun", "simctl", "list", "devices", "available", "-j"]),
    );
    const iphones = Object.entries(devices.devices)
      .filter(([runtime]) => runtime.includes("iOS"))
      .flatMap(([, list]) => list)
      .filter((device) => device.name.startsWith("iPhone"));
    const iphone =
      iphones.find((device) => device.state === "Booted") ?? iphones[0];
    if (!iphone) throw new Error("Flutter checks require an iPhone Simulator");
    if (iphone.state !== "Booted")
      run(["xcrun", "simctl", "boot", iphone.udid]);
    run(["xcrun", "simctl", "bootstatus", iphone.udid, "-b"], { stream: true });
    process.chdir("ios");
    run(
      [
        "xcodebuild",
        "test",
        "-workspace",
        "Runner.xcworkspace",
        "-scheme",
        "Runner",
        "-destination",
        `platform=iOS Simulator,id=${iphone.udid}`,
        "CODE_SIGNING_ALLOWED=NO",
      ],
      { stream: true, env },
    );
    process.chdir("..");
    run(
      [
        "flutter",
        "test",
        "integration_test/native_adapter_test.dart",
        "-d",
        iphone.udid,
        "--no-pub",
      ],
      { stream: true, env },
    );
  } finally {
    process.chdir(original);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export async function checkAndroidIntegration(
  androidSource,
  { run, verifyGradleWrapper },
) {
  const original = process.cwd();
  const directory = fs.mkdtempSync(
    path.join(tempRoot, "rtl-android-host-"),
  );
  try {
    prepareFlutterHost(directory, androidSource, {
      run,
      packageRoot: original,
      platforms: ["android"],
    });
    verifyGradleWrapper(path.join(directory, "android"));
    process.chdir(directory);
    run(["flutter", "pub", "get"], { stream: true });
    run(
      [
        "flutter",
        "test",
        "integration_test/native_adapter_test.dart",
        "-d",
        process.env.ANDROID_SERIAL || "emulator-5554",
        "--no-pub",
      ],
      {
        stream: true,
        env: { RTL_ANDROID_SDK_PATH: androidSource },
      },
    );
  } finally {
    process.chdir(original);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
