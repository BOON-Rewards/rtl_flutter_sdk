// Copied into each public SDK repository by dev-cli. Runs without npm dependencies.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// Preserve the CI runner workspace; use /tmp for local Unix runs.
const tempRoot =
  process.env.RUNNER_TEMP || (process.platform === "win32" ? os.tmpdir() : "/tmp");

const repositories = {
  ios: "BOON-Rewards/rtl_ios_sdk",
  android: "BOON-Rewards/rtl_android_sdk",
  "react-native": "BOON-Rewards/rtl_rn_sdk",
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
    !Object.hasOwn(repositories, value.sdk) ||
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
  if (value.sdk === "ios") {
    versionMatches("RTLSdk.podspec", /s\.version\s*=\s*"([^"]+)"/g);
  } else if (value.sdk === "android") {
    for (const module of ["core", "hyperlocal-offers"])
      versionMatches(`${module}/build.gradle.kts`, /version = "([^"]+)"/g);
  } else if (value.sdk === "flutter") {
    versionMatches("pubspec.yaml", /^version: (.+)$/gm);
    versionMatches("ios/rtl_sdk/Package.swift", /exact: "([^"]+)"/g);
    versionMatches("android/build.gradle.kts", /version = "([^"]+)"/g);
    versionMatches(
      "android/build.gradle.kts",
      /com\.affinaloyalty:rtl-sdk-(?:core|location):([^"]+)"/g,
      2,
    );
  } else {
    const lock = json("package-lock.json");
    if (
      [
        json("package.json").version,
        lock.version,
        lock.packages[""].version,
      ].some((version) => version !== value.version)
    )
      throw new Error("React Native package and lockfile versions must match.");
    versionMatches(
      "react-native-rtl-sdk.podspec",
      /s\.dependency "RTLSdk", "([^"]+)"/g,
    );
    versionMatches(
      "android/build.gradle",
      /com\.affinaloyalty:rtl-sdk-(?:core|location):([^']+)'/g,
      2,
    );
  }
  return value;
}

function iosCheck() {
  const xcodes = fs
    .readdirSync("/Applications")
    .filter((name) => /^Xcode_26(?:\.\d+)*\.app$/.test(name))
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  if (!xcodes.length) throw new Error("This runner needs stable Xcode 26.");
  const env = {
    DEVELOPER_DIR: `/Applications/${xcodes[0]}/Contents/Developer`,
  };
  const devices = JSON.parse(
    run(["xcrun", "simctl", "list", "devices", "available", "-j"], { env }),
  );
  const iphone = Object.entries(devices.devices)
    .filter(([runtime]) => runtime.includes("iOS-26"))
    .flatMap(([, list]) => list)
    .find((device) => device.name.startsWith("iPhone"));
  if (!iphone) throw new Error("This runner needs an iOS 26 iPhone Simulator.");
  run(
    [
      "xcodebuild",
      "-scheme",
      "RTLSdk",
      "-destination",
      `platform=iOS Simulator,id=${iphone.udid}`,
      "-derivedDataPath",
      path.join(tempRoot, "sdk-derived-data"),
      "CODE_SIGNING_ALLOWED=NO",
      "test",
    ],
    { stream: true, env },
  );
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

function npmInstall() {
  run(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    stream: true,
  });
}

function pack() {
  const directory = fs.mkdtempSync(
    path.join(tempRoot, "sdk-package-"),
  );
  const result = JSON.parse(
    run([
      "npm",
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      directory,
    ]),
  );
  if (
    result.length !== 1 ||
    path.basename(result[0].filename) !== result[0].filename
  )
    throw new Error("Unexpected npm package output.");
  const file = path.join(directory, result[0].filename);
  if (!fs.existsSync(file)) throw new Error("Missing npm package archive.");
  return file;
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

async function flutterBuild(androidSource, env = {}) {
  const { buildFlutterHost } = await import("./flutter-release.mjs");
  await buildFlutterHost(androidSource, env, {
    run,
    gradle,
    verifyGradleWrapper,
  });
}

async function flutterCheck(value) {
  run(["flutter", "pub", "get"], { stream: true });
  run(["flutter", "analyze", "--no-pub"], { stream: true });
  run(["flutter", "test", "--no-pub"], { stream: true });
  const directory = fs.mkdtempSync(
    path.join(tempRoot, "flutter-native-"),
  );
  try {
    nativeSnapshot("ios", value, path.join(directory, "ios"));
    nativeSnapshot("android", value, path.join(directory, "android"));
    await flutterBuild(path.join(directory, "android"), {
      RTL_IOS_SDK_PATH: path.join(directory, "ios"),
      RTL_ANDROID_SDK_PATH: path.join(directory, "android"),
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function check(value) {
  const { sdk } = value;
  if (sdk === "ios") iosCheck();
  else if (sdk === "android")
    gradle([
      ":core:testReleaseUnitTest",
      ":core:assembleRelease",
      ":hyperlocal-offers:assembleRelease",
    ]);
  else if (sdk === "flutter") await flutterCheck(value);
  else {
    npmInstall();
    run(["npm", "run", "typecheck"], { stream: true });
    run(
      [
        "npm",
        "install",
        "--no-save",
        "--package-lock=false",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "react-native@0.86.3",
      ],
      { stream: true },
    );
    run(["npm", "run", "typecheck"], { stream: true });
    npmInstall();
    pack();
  }
  run(["git", "diff", "--exit-code", "HEAD"]);
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
  const { sdk, version } = value;
  const repo = repositories[sdk];
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
      sdk === "react-native" &&
      !release.assets.some(
        (asset) =>
          asset.name === `react-native-rtl-sdk-${version}.tgz` &&
          asset.state === "uploaded",
      )
    )
      throw new Error(
        "The existing React Native release is missing its package archive.",
      );
    if (
      sdk === "flutter" &&
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
  if (sdk === "android" && existingTag)
    throw new Error(
      "Android has a tag without a completed release. Maven uploads may be partial. Inspect both packages; finish the original publication and create its release after verification, or use a new version. No artifacts were overwritten.",
    );

  const assets = [];
  if (sdk === "react-native") {
    await waitForNativeReleases(value);
    npmInstall();
    assets.push(pack());
    run(["git", "diff", "--exit-code", "HEAD"]);
  }
  if (sdk === "flutter") {
    await waitForNativeReleases(value);
    const native = fs.mkdtempSync(
      path.join(tempRoot, "rtl-wrapper-"),
    );
    try {
      // Fetch the checked native release only for its verified Gradle wrapper.
      // The generated host still resolves both adapters from published dependencies.
      nativeSnapshot("android", value, path.join(native, "android"));
      await flutterBuild(path.join(native, "android"), {
        RTL_IOS_SDK_PATH: "",
        RTL_ANDROID_SDK_PATH: "",
      });
    } finally {
      fs.rmSync(native, { recursive: true, force: true });
    }
    run(["git", "diff", "--exit-code", "HEAD"]);
    const directory = fs.mkdtempSync(
      path.join(tempRoot, "flutter-package-"),
    );
    const archive = path.join(directory, `rtl-sdk-${version}.tar.gz`);
    run(["git", "archive", "--format=tar.gz", "-o", archive, "HEAD"]);
    assets.push(archive);
  }
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
  // Tagging and publication deliberately stay in the same workflow: tags made
  // with GITHUB_TOKEN do not start another tag-triggered Actions workflow.
  if (sdk === "android")
    gradle(
      [
        ":core:publishReleasePublicationToGitHubPackagesRepository",
        ":hyperlocal-offers:publishReleasePublicationToGitHubPackagesRepository",
      ],
      {
        GITHUB_USERNAME: process.env.GITHUB_ACTOR,
        GITHUB_TOKEN: process.env.GH_TOKEN,
      },
    );
  run([
    "gh",
    "release",
    "create",
    version,
    "--repo",
    repo,
    "--verify-tag",
    "--generate-notes",
    ...assets,
  ]);
  console.log(`Published https://github.com/${repo}/releases/tag/${version}`);
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
    case "integration-android": {
      if (value.sdk !== "flutter")
        throw new Error("Android integration requires the Flutter SDK");
      const directory = fs.mkdtempSync(
        path.join(tempRoot, "flutter-native-"),
      );
      try {
        const androidSource = path.join(directory, "android");
        nativeSnapshot("android", value, androidSource);
        const { checkAndroidIntegration } = await import(
          "./flutter-release.mjs"
        );
        await checkAndroidIntegration(androidSource, {
          run,
          verifyGradleWrapper,
        });
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
      break;
    }
    case "publish":
      await publish(value);
      break;
    default:
      throw new Error(
        "Use metadata, check, integration-android (Flutter), or publish.",
      );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
