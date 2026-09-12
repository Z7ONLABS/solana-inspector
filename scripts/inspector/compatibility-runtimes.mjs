/** Preparation only: downloads pinned official Node runtimes, never blockchain data. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const RUNTIME_VERSIONS = ["22.12.0", "22.23.2", "24.0.0", "24.21.0"];
// Official /download/release/v<VERSION>/SHASUMS256.txt, reviewed 2026-09-11.
export const RUNTIME_HASHES = {
  "22.12.0": {
    win32: "2b8f2256382f97ad51e29ff71f702961af466c4616393f767455501e6aece9b8",
    linux: "22982235e1b71fa8850f82edd09cdae7e3f32df1764a9ec298c72d25ef2c164f",
  },
  "22.23.2": {
    win32: "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97",
    linux: "d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307",
  },
  "24.0.0": {
    win32: "3d0fff80c87bb9a8d7f49f2f27832aa34a1477d137af46f5b14df5498be81304",
    linux: "59b8af617dccd7f9f68cc8451b2aee1e86d6bd5cb92cd51dd6216a31b707efd7",
  },
  "24.21.0": {
    win32: "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541",
    linux: "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6",
  },
};
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const destination = path.join(root, ".local-data/inspector/runtimes");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function runtimeSpec(
  version,
  platform = process.platform,
  arch = process.arch,
) {
  assert.equal(
    arch,
    "x64",
    "Only Windows/Linux x64 is in this compatibility matrix.",
  );
  assert.ok(RUNTIME_VERSIONS.includes(version), "Unreviewed Node version");
  assert.ok(platform === "win32" || platform === "linux", "Unsupported host");
  const stem = `node-v${version}-${platform === "win32" ? "win" : "linux"}-x64`;
  const archive = `${stem}.${platform === "win32" ? "zip" : "tar.xz"}`;
  return {
    version,
    stem,
    archive,
    platform,
    sha256: RUNTIME_HASHES[version][platform],
    url: `https://nodejs.org/download/release/v${version}/${archive}`,
    checksumsUrl: `https://nodejs.org/download/release/v${version}/SHASUMS256.txt`,
  };
}

async function download(url, maximum) {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
  assert.ok(response.ok && response.body, "Official runtime download failed");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    assert.ok(bytes <= maximum, "Runtime download exceeded its byte limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function prepareRuntime(version) {
  const spec = runtimeSpec(version);
  fs.mkdirSync(destination, { recursive: true });
  assert.equal(
    fs.realpathSync(destination).toLowerCase(),
    destination.toLowerCase(),
    "Runtime destination must not be a symlink",
  );
  const directory = path.join(destination, spec.stem);
  const executable = path.join(
    directory,
    process.platform === "win32" ? "node.exe" : "bin/node",
  );
  const record = path.join(destination, `${spec.stem}.json`);
  if (fs.existsSync(directory)) {
    const proof = JSON.parse(fs.readFileSync(record));
    assert.equal(proof.archiveSha256, spec.sha256);
    assert.equal(sha(fs.readFileSync(executable)), proof.executableSha256);
    assert.equal(
      execFileSync(executable, ["--version"], { encoding: "utf8" }).trim(),
      `v${version}`,
    );
    return executable;
  }
  const sums = (await download(spec.checksumsUrl, 128 * 1024)).toString("utf8");
  assert.ok(
    sums
      .split(/\r?\n/)
      .some((line) => line === `${spec.sha256}  ${spec.archive}`),
    "Pinned runtime hash differs from official checksums",
  );
  const bytes = await download(spec.url, 100 * 1024 * 1024);
  assert.equal(
    sha(bytes),
    spec.sha256,
    "Official runtime archive hash mismatch",
  );
  const archive = path.join(destination, spec.archive);
  if (fs.existsSync(archive))
    assert.equal(sha(fs.readFileSync(archive)), spec.sha256);
  else fs.writeFileSync(archive, bytes, { flag: "wx" });
  // The verified official archive is extracted only into a newly owned directory.
  // Keep incomplete evidence on failure; do not repair or delete earlier runtimes.
  const staging = fs.mkdtempSync(path.join(destination, ".extract-"));
  const members = execFileSync("tar", ["-tf", archive], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  for (const name of members.trim().split(/\r?\n/)) {
    assert.ok(
      name.startsWith(`${spec.stem}/`),
      "Unexpected runtime archive root",
    );
    assert.ok(
      !name.split("/").some((part) => part === ".." || part.includes("\\")),
      "Unsafe runtime archive member",
    );
  }
  execFileSync("tar", ["-xf", archive, "-C", staging], { timeout: 120_000 });
  fs.renameSync(path.join(staging, spec.stem), directory);
  fs.rmdirSync(staging);
  assert.equal(
    execFileSync(executable, ["--version"], { encoding: "utf8" }).trim(),
    `v${version}`,
  );
  fs.writeFileSync(
    record,
    `${JSON.stringify({ ...spec, archiveSha256: spec.sha256, executableSha256: sha(fs.readFileSync(executable)), executable }, null, 2)}\n`,
    { flag: "wx" },
  );
  return executable;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    assert.ok(
      args.length === 0 || (args.length === 2 && args[0] === "--version"),
      "Use compatibility-runtimes.mjs [--version VERSION]",
    );
    const versions = args.length ? [args[1]] : RUNTIME_VERSIONS;
    const executables = [];
    for (const version of versions) {
      process.stderr.write(
        `Preparing official Node ${version}; no global installation.\n`,
      );
      executables.push(await prepareRuntime(version));
    }
    process.stdout.write(
      `${JSON.stringify({ platform: process.platform, arch: process.arch, executables }, null, 2)}\n`,
    );
  } catch (error) {
    process.stderr.write(`Runtime preparation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
