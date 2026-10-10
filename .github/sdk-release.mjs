// Flutter release checks and publication. Exported as .github/sdk-release.mjs.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// Preserve the CI runner workspace; use /tmp for local Unix runs.
const tempRoot =
  process.env.RUNNER_TEMP ||
  (process.platform === "win32" ? os.tmpdir() : "/tmp");

const repositories = {
  ios: "BOON-Rewards/rtl_ios_sdk",
  android: "BOON-Rewards/rtl_android_sdk",
  flutter: "BOON-Rewards/rtl_flutter_sdk",
};
const read = (file) => fs.readFileSync(file, "utf8");
const json = (file) => JSON.parse(read(file));

function run(args, { stream = false, env = {}, input } = {}) {
  const result = spawnSync(args[0], args.slice(1), {
    encoding: "utf8",
    shell: false,
    env: { ...process.env, ...env },
    input,
    maxBuffer: 32 * 1024 * 1024,
    stdio: stream ? "inherit" : ["pipe", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${args[0]} failed: ${result.stderr || result.status}`);
  return (result.stdout || "").trim();
}

function api(route, body) {
  return JSON.parse(
    run(
      [
        "gh",
        "api",
        route,
        ...(body ? ["--method", "POST", "--input", "-"] : []),
      ],
      body ? { input: JSON.stringify(body) } : {},
    ),
  );
}

function optionalApi(route) {
  try {
    return api(route);
  } catch (error) {
    if (/\(HTTP 404\)/.test(error.message)) return null;
    throw error;
  }
}

function metadata() {
  const value = json(".sdk-release.json");
  if (
    value.sdk !== "flutter" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.version) ||
    !/^[a-f0-9]{40}$/.test(value.sourceCommit)
  )
    throw new Error(
      "Invalid SDK release metadata. Prepare the snapshot with dev-cli.",
    );

  const versionMatches = (file, pattern, count = 1) => {
    const matches = [...read(file).matchAll(pattern)];
    if (
      matches.length !== count ||
      matches.some((match) => match[1] !== value.version)
    )
      throw new Error(`Version mismatch in ${file}`);
  };
  versionMatches("pubspec.yaml", /^version: (.+)$/gm);
  versionMatches("ios/rtl_sdk/Package.swift", /exact: "([^"]+)"/g);
  versionMatches("android/build.gradle.kts", /version = "([^"]+)"/g);
  versionMatches(
    "android/build.gradle.kts",
    /com\.affinaloyalty:rtl-sdk-(?:core|location):([^"]+)"/g,
    2,
  );
  return value;
}

function verifyGradleWrapper(directory = process.cwd()) {
  // Verify the official wrapper before executing it with release credentials.
  // Update these pins together when upgrading Gradle.
  const checksums = {
    "gradle/wrapper/gradle-wrapper.jar":
      "7d3a4ac4de1c32b59bc6a4eb8ecb8e612ccd0cf1ae1e99f66902da64df296172",
    gradlew: "fb49f8cb2e5b1d83fba3dcc2c0dd0934c5655cbaf8bd1510ada7cc02692095ca",
    "gradlew.bat":
      "49792578a7942e08b708df3d3902ddbfc49d2203775c0161ef0c24b23fe4aeae",
    // Pins the distribution URL and its SHA-256 as well as wrapper options.
    "gradle/wrapper/gradle-wrapper.properties":
      "05fcb55a155233ee632da57149d1ba3cd39a001701ae00e0c20782fbaf6c378b",
  };
  for (const [file, expected] of Object.entries(checksums)) {
    const actual = createHash("sha256")
      .update(fs.readFileSync(path.join(directory, file)))
      .digest("hex");
    if (actual !== expected)
      throw new Error(`Official Gradle 8.14.3 checksum mismatch: ${file}`);
  }
}

function gradle(tasks, env = {}) {
  verifyGradleWrapper();
  run(["./gradlew", ...tasks, "--no-daemon"], { stream: true, env });
}

function nativeSnapshot(sdk, value, directory) {
  const repo = repositories[sdk];
  const branch = `sdk-release/${value.version}-${value.sourceCommit.slice(0, 12)}`;
  const tag = optionalApi(`repos/${repo}/git/ref/tags/${value.version}`);
  const ref = tag ? value.version : branch;
  run(
    [
      "git",
      "clone",
      "--depth",
      "1",
      "--branch",
      ref,
      `https://github.com/${repo}.git`,
      directory,
    ],
    { stream: true },
  );
  const native = JSON.parse(
    fs.readFileSync(path.join(directory, ".sdk-release.json"), "utf8"),
  );
  if (
    native.sdk !== sdk ||
    native.version !== value.version ||
    native.sourceCommit !== value.sourceCommit
  )
    throw new Error(
      `${sdk} dependency does not match the Flutter source snapshot`,
    );
}

async function withTemporary(prefix, action) {
  const directory = fs.mkdtempSync(path.join(tempRoot, prefix));
  try {
    return await action(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const helpers = { run, gradle, verifyGradleWrapper };

async function check(value) {
  run(["flutter", "pub", "get"], { stream: true });
  run(["flutter", "analyze", "--no-pub"], { stream: true });
  run(["flutter", "test", "--no-pub"], { stream: true });
  await withTemporary("flutter-native-", async (directory) => {
    const ios = path.join(directory, "ios");
    const android = path.join(directory, "android");
    nativeSnapshot("ios", value, ios);
    nativeSnapshot("android", value, android);
    await buildFlutterHost(
      android,
      {
        RTL_IOS_SDK_PATH: ios,
        RTL_ANDROID_SDK_PATH: android,
      },
      helpers,
    );
  });
  run(["git", "diff", "--exit-code", "HEAD"]);
}

async function integration(value) {
  await withTemporary("flutter-native-", async (directory) => {
    const android = path.join(directory, "android");
    nativeSnapshot("android", value, android);
    await checkAndroidIntegration(android, helpers);
  });
}

function tagCommit(repo, version) {
  const ref = optionalApi(`repos/${repo}/git/ref/tags/${version}`);
  if (!ref) return null;
  let object = ref.object;
  for (let depth = 0; depth < 5 && object.type === "tag"; depth++)
    object = api(`repos/${repo}/git/tags/${object.sha}`).object;
  if (object.type !== "commit")
    throw new Error(`Invalid version tag in ${repo}`);
  return object.sha;
}

async function waitForNativeReleases({ version, sourceCommit }) {
  const deadline = Date.now() + 30 * 60 * 1000;
  while (true) {
    const waiting = [];
    for (const sdk of ["ios", "android"]) {
      const repo = repositories[sdk];
      const release = optionalApi(`repos/${repo}/releases/tags/${version}`);
      // Android creates its stable release only after BOTH Maven uploads succeed.
      // A tag alone is not evidence that the dependency is ready to install.
      if (!release || release.draft || release.prerelease) {
        waiting.push(sdk);
        continue;
      }
      const file = api(
        `repos/${repo}/contents/.sdk-release.json?ref=${version}`,
      );
      const native = JSON.parse(
        Buffer.from(file.content, "base64").toString("utf8"),
      );
      if (
        native.sdk !== sdk ||
        native.version !== version ||
        native.sourceCommit !== sourceCommit
      )
        throw new Error(
          `${sdk} ${version} was published from a different source snapshot.`,
        );
    }
    if (!waiting.length) return;
    if (Date.now() >= deadline)
      throw new Error(
        `Native releases are not ready: ${waiting.join(", ")}. Finish them, then rerun this failed job.`,
      );
    console.log(
      `Waiting for ${waiting.join(" and ")} ${version} publication...`,
    );
    await sleep(20000);
  }
}

async function publish(value) {
  const { version } = value;
  const repo = repositories.flutter;
  // PR checks never receive publication credentials. Only the protected default
  // branch can publish, including a manual retry of an already merged version.
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    !["push", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME) ||
    process.env.GITHUB_REPOSITORY !== repo ||
    !process.env.GH_TOKEN
  )
    throw new Error(
      "Publication runs only in the destination GitHub Actions workflow.",
    );
  const event = json(process.env.GITHUB_EVENT_PATH);
  if (
    process.env.GITHUB_REF !== `refs/heads/${event.repository.default_branch}`
  )
    throw new Error("Only the protected default branch may publish.");
  const sha = run(["git", "rev-parse", "HEAD"]);
  if (sha !== process.env.GITHUB_SHA)
    throw new Error("Release checkout differs from the checked commit.");
  run(["git", "diff", "--exit-code", "HEAD"]);

  const existingTag = tagCommit(repo, version);
  if (existingTag && existingTag !== sha)
    throw new Error(
      `Tag ${version} already points to another commit; it will not be moved. Bump the version.`,
    );
  const release = optionalApi(`repos/${repo}/releases/tags/${version}`);
  if (release) {
    if (!existingTag || release.draft || release.prerelease)
      throw new Error(
        "Resolve the existing incomplete release manually before retrying.",
      );
    if (
      !release.assets.some(
        (asset) =>
          asset.name === `rtl-sdk-${version}.tar.gz` &&
          asset.state === "uploaded",
      )
    )
      throw new Error(
        "The existing Flutter release is missing its package archive.",
      );
    console.log(`Already published: ${release.html_url}`);
    return;
  }
  await waitForNativeReleases(value);
  await withTemporary("rtl-wrapper-", async (directory) => {
    const android = path.join(directory, "android");
    // Use the verified wrapper, but resolve both adapters from published artifacts.
    nativeSnapshot("android", value, android);
    await buildFlutterHost(
      android,
      {
        RTL_IOS_SDK_PATH: "",
        RTL_ANDROID_SDK_PATH: "",
      },
      helpers,
    );
  });
  run(["git", "diff", "--exit-code", "HEAD"]);
  if (!existingTag) {
    const tag = api(`repos/${repo}/git/tags`, {
      tag: version,
      message: `SDK ${version}`,
      object: sha,
      type: "commit",
    });
    api(`repos/${repo}/git/refs`, {
      ref: `refs/tags/${version}`,
      sha: tag.sha,
    });
  }
  // Tag and release together: tags created with GITHUB_TOKEN do not start workflows.
  await withTemporary("flutter-package-", async (directory) => {
    const archive = path.join(directory, `rtl-sdk-${version}.tar.gz`);
    run(["git", "archive", "--format=tar.gz", "-o", archive, "HEAD"]);
    run([
      "gh",
      "release",
      "create",
      version,
      "--repo",
      repo,
      "--verify-tag",
      "--generate-notes",
      archive,
    ]);
  });
  console.log(`Published https://github.com/${repo}/releases/tag/${version}`);
}

// Temporary apps exercise the public plugin without shipping a demo app.
function prepareFlutterHost(
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

async function buildFlutterHost(androidSource, env, helpers) {
  const { run, gradle, verifyGradleWrapper } = helpers;
  const original = process.cwd();
  const directory = fs.mkdtempSync(path.join(tempRoot, "rtl-host-"));
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

async function checkAndroidIntegration(
  androidSource,
  { run, verifyGradleWrapper },
) {
  const original = process.cwd();
  const directory = fs.mkdtempSync(path.join(tempRoot, "rtl-android-host-"));
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

try {
  const value = metadata();
  switch (process.argv[2]) {
    case "metadata":
      if (process.env.GITHUB_OUTPUT)
        fs.appendFileSync(
          process.env.GITHUB_OUTPUT,
          `version=${value.version}\n`,
        );
      console.log(`${value.sdk} ${value.version} from ${value.sourceCommit}`);
      break;
    case "check":
      await check(value);
      break;
    case "integration-android":
      await integration(value);
      break;
    case "publish":
      await publish(value);
      break;
    default:
      throw new Error("Use metadata, check, integration-android, or publish.");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
