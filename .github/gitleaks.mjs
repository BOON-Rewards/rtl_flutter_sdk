// Used by dev-cli before a public push and copied into each SDK for CI.
// Official release: https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Preserve the CI runner workspace; use /tmp for local Unix runs.
const tempRoot =
  process.env.RUNNER_TEMP || (process.platform === "win32" ? os.tmpdir() : "/tmp");

const version = "8.30.1";
// SHA-256 digests from the official release assets. Verify before extraction.
const archives = {
  darwin_arm64:
    "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
  darwin_x64:
    "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709",
  linux_arm64:
    "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080",
  linux_x64: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
};

function run(args, options = {}) {
  const result = spawnSync(args[0], args.slice(1), {
    encoding: "utf8",
    shell: false,
    timeout: 180_000,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${path.basename(args[0])} failed; secret scanning cannot continue.`,
    );
}

function checkFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    // CI checkouts contain Git metadata; only the distribution snapshot is public.
    if (entry.name === ".git") continue;
    const file = path.join(directory, entry.name);
    if (
      entry.isSymbolicLink() ||
      /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|local\.properties|secrets\.properties)$/i.test(
        entry.name,
      ) ||
      /\.(?:pem|key|p12|pfx|jks|keystore|mobileprovision)$/i.test(entry.name) ||
      ["node_modules", "Pods", "build", ".runtime"].includes(entry.name)
    )
      throw new Error(
        `Private/generated file or symlink in public snapshot: ${file}`,
      );
    if (entry.isDirectory()) checkFiles(file);
    else if (!entry.isFile())
      throw new Error(`Unsupported distribution file: ${file}`);
  }
}

export function scan(directory) {
  directory = path.resolve(directory);
  checkFiles(directory);
  const platform = `${process.platform}_${process.arch}`;
  const expectedHash = archives[platform];
  if (!expectedHash)
    throw new Error(`Gitleaks release scanning does not support ${platform}.`);

  const temporary = fs.mkdtempSync(path.join(tempRoot, "sdk-gitleaks-"));
  try {
    const archive = path.join(temporary, "gitleaks.tar.gz");
    const asset = `gitleaks_${version}_${platform}.tar.gz`;
    run([
      "curl",
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      "--tlsv1.2",
      "--connect-timeout",
      "15",
      "--max-time",
      "120",
      "--retry",
      "2",
      `https://github.com/gitleaks/gitleaks/releases/download/v${version}/${asset}`,
      "--output",
      archive,
    ]);
    const actualHash = createHash("sha256")
      .update(fs.readFileSync(archive))
      .digest("hex");
    if (actualHash !== expectedHash)
      throw new Error("Gitleaks archive checksum mismatch; release blocked.");
    run(["tar", "-xzf", archive, "-C", temporary, "gitleaks"]);

    const report = path.join(temporary, "report.json");
    const ignore = path.join(temporary, ".gitleaksignore");
    fs.writeFileSync(ignore, "");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("GITLEAKS_"),
      ),
    );
    const result = spawnSync(
      path.join(temporary, "gitleaks"),
      [
        "dir",
        directory,
        "--config",
        fileURLToPath(new URL("./gitleaks.toml", import.meta.url)),
        "--gitleaks-ignore-path",
        ignore,
        "--ignore-gitleaks-allow",
        "--redact=100",
        "--no-banner",
        "--no-color",
        "--max-decode-depth",
        "5",
        "--max-archive-depth",
        "2",
        "--report-format",
        "json",
        "--report-path",
        report,
        "--exit-code",
        "1",
        "--timeout",
        "120",
      ],
      { cwd: temporary, encoding: "utf8", shell: false, timeout: 150_000, env },
    );
    if (
      result.error ||
      ![0, 1].includes(result.status) ||
      !fs.existsSync(report)
    )
      throw new Error("Gitleaks could not complete; release blocked.");
    const findings = JSON.parse(fs.readFileSync(report, "utf8"));
    // Never print matching source lines or credential values, even on failure.
    for (const finding of findings)
      console.error(`${finding.File}:${finding.StartLine}: ${finding.RuleID}`);
    if (result.status !== 0 || findings.length > 0)
      throw new Error(
        "Gitleaks found potential credentials; remove them before publishing.",
      );
    console.log(`Gitleaks ${version}: no leaks found in ${directory}`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (!process.argv[2] || process.argv.length !== 3)
      throw new Error("Usage: node gitleaks.mjs <SDK snapshot directory>");
    scan(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
