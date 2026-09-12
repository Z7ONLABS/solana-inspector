import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { OPEN_SOURCE_MODULES, openSourceExports } from "./open-source-contract.mjs";

export const TARBALL_LIMITS = Object.freeze({
  compressedBytes: 8 * 1024 * 1024,
  expandedBytes: 32 * 1024 * 1024,
  memberBytes: 8 * 1024 * 1024,
  members: 256,
});
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const decoder = new TextDecoder("utf-8", { fatal: true });
const ROOT_FILES = new Set([
  "package.json",
  "README.md",
  "LICENSE.txt",
  "THIRD-PARTY-NOTICES.md",
  "BUILD-MANIFEST.json",
]);
const OPEN_SOURCE_FILES = new Set([
  ...[...ROOT_FILES].filter((name) => name !== "LICENSE.txt"),
  "LICENSE", "NOTICE", "docs/protocol-provenance.md",
  ...OPEN_SOURCE_MODULES.map((name) => `src/${name}.ts`),
]);

/** This verifier intentionally supports only our npm-generated regular-file USTAR format. */
function archivePath(name) {
  assert.ok(
    typeof name === "string" && name.length > 0 && name.length <= 240,
    "tar_path_invalid",
  );
  assert.match(name, /^[A-Za-z0-9_.\/-]+$/, "tar_path_invalid");
  assert.ok(
    name.startsWith("package/") && !name.endsWith("/"),
    "tar_path_invalid",
  );
  assert.ok(
    name
      .split("/")
      .every(
        (part) =>
          part &&
          part !== "." &&
          part !== ".." &&
          !part.endsWith(".") &&
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      ),
    "tar_path_invalid",
  );
  return name.slice("package/".length);
}

function field(header, start, length) {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  if (end >= 0)
    assert.ok(
      bytes.subarray(end).every((byte) => byte === 0),
      "tar_field_padding_invalid",
    );
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
}

function octal(header, start, length) {
  // latin1 preserves high bits; Node's ascii decoder masks them and could
  // otherwise accept non-ASCII bytes as seemingly valid octal digits.
  const raw = header.subarray(start, start + length).toString("latin1");
  assert.match(raw, /^[0-7]+[\0 ]*$/, "tar_numeric_field_invalid");
  const value = Number.parseInt(raw, 8);
  assert.ok(Number.isSafeInteger(value), "tar_numeric_field_invalid");
  return value;
}

function canonicalManifest(bytes) {
  assert.ok(bytes.length <= 128 * 1024, "manifest_byte_limit");
  const source = decoder.decode(bytes);
  const parsed = JSON.parse(source);
  // build.mjs emits this exact JSON form. Reject ambiguous duplicate keys rather
  // than accepting JSON.parse's last-key-wins interpretation of an inventory.
  assert.equal(
    source,
    `${JSON.stringify(parsed, null, 2)}\n`,
    "manifest_json_noncanonical",
  );
  return parsed;
}

/** No extraction, filesystem writes, imports or execution of archived code. */
export function verifyTarballBytes(compressed, expectedSha256) {
  assert.ok(
    Buffer.isBuffer(compressed) &&
      compressed.length > 0 &&
      compressed.length <= TARBALL_LIMITS.compressedBytes,
    "tarball_compressed_byte_limit",
  );
  assert.match(
    expectedSha256,
    /^[a-f0-9]{64}$/,
    "tarball_expected_hash_invalid",
  );
  const sha256 = hash(compressed);
  assert.equal(sha256, expectedSha256, "tarball_hash_mismatch");
  const tar = gunzipSync(compressed, {
    maxOutputLength: TARBALL_LIMITS.expandedBytes,
  });
  assert.ok(tar.length >= 1024 && tar.length % 512 === 0, "tar_length_invalid");
  const files = new Map();
  const portableNames = new Set();
  let position = 0;
  let complete = false;
  while (position + 512 <= tar.length) {
    const header = tar.subarray(position, position + 512);
    if (header.every((byte) => byte === 0)) {
      assert.ok(
        tar.length - position >= 1024 &&
          tar.subarray(position).every((byte) => byte === 0),
        "tar_terminator_invalid",
      );
      complete = true;
      break;
    }
    assert.ok(files.size < TARBALL_LIMITS.members, "tar_member_limit");
    const recordedChecksum = octal(header, 148, 8);
    let actualChecksum = 0;
    for (let i = 0; i < 512; i += 1)
      actualChecksum += i >= 148 && i < 156 ? 32 : header[i];
    assert.equal(
      recordedChecksum,
      actualChecksum,
      "tar_header_checksum_mismatch",
    );
    assert.ok(
      header
        .subarray(257, 265)
        .equals(Buffer.from([117, 115, 116, 97, 114, 0, 48, 48])),
      "tar_format_unsupported",
    );
    assert.ok(
      header[156] === 48 || header[156] === 0,
      "tar_member_type_unsupported",
    );
    assert.equal(field(header, 157, 100), "", "tar_link_target_not_allowed");
    const prefix = field(header, 345, 155);
    const name = archivePath(
      `${prefix ? `${prefix}/` : ""}${field(header, 0, 100)}`,
    );
    assert.ok(!portableNames.has(name.toLowerCase()), "tar_duplicate_path");
    portableNames.add(name.toLowerCase());
    const mode = octal(header, 100, 8);
    assert.ok((mode & 0o7000) === 0 && (mode & 0o022) === 0, "tar_unsafe_mode");
    const size = octal(header, 124, 12);
    assert.ok(size <= TARBALL_LIMITS.memberBytes, "tar_member_byte_limit");
    const start = position + 512;
    const end = start + size;
    const next = start + Math.ceil(size / 512) * 512;
    assert.ok(next <= tar.length, "tar_member_truncated");
    assert.ok(
      tar.subarray(end, next).every((byte) => byte === 0),
      "tar_data_padding_invalid",
    );
    files.set(name, tar.subarray(start, end));
    position = next;
  }
  assert.ok(complete, "tar_terminator_missing");
  for (const name of files.keys()) {
    assert.ok(
      ROOT_FILES.has(name) || OPEN_SOURCE_FILES.has(name) ||
        /^dist\/[A-Za-z0-9_/-]+(?:\.js|\.d\.ts)$/.test(name),
      "package_member_not_allowed",
    );
    assert.ok(
      !/(?:^|\/)(?:tests?|node_modules|\.local-data)(?:\/|$)|\.env|\.map$/i.test(
        name,
      ),
      "package_member_not_allowed",
    );
  }
  for (const name of [...ROOT_FILES].filter((item) => item !== "LICENSE.txt"))
    assert.ok(files.has(name), "package_required_file_missing");
  assert.ok(files.has("LICENSE.txt") || files.has("LICENSE"), "package_required_file_missing");
  const inventory = canonicalManifest(files.get("BUILD-MANIFEST.json"));
  assert.equal(inventory.version, 1, "manifest_version_unsupported");
  assert.equal(inventory.publicRelease, false, "unexpected_public_release");
  assert.equal(
    inventory.package,
    "@z7onlabs/solana-inspector",
    "manifest_package_mismatch",
  );
  assert.ok(
    Object.keys(inventory).every((key) =>
      [
        "version",
        "package",
        "packageVersion",
        "files",
        "publicRelease",
        "source",
      ].includes(key),
    ),
    "manifest_unknown_field",
  );
  if (inventory.source !== undefined) {
    const source = inventory.source;
    assert.ok(
      source &&
        Object.keys(source).sort().join(",") === "files,schemaVersion,sha256" &&
        source.schemaVersion === 1,
      "manifest_source_schema_invalid",
    );
    assert.ok(
      Array.isArray(source.files) &&
        source.files.length > 0 &&
        source.files.length <= TARBALL_LIMITS.members,
      "manifest_source_files_invalid",
    );
    const names = new Set();
    for (const entry of source.files) {
      assert.ok(
        entry && Object.keys(entry).sort().join(",") === "file,sha256",
        "manifest_source_entry_invalid",
      );
      const name = archivePath(`package/${entry.file}`);
      assert.ok(
        !/(?:^|\/)(?:node_modules|\.local-data)(?:\/|$)|\.env/i.test(name),
        "manifest_source_path_not_allowed",
      );
      assert.ok(
        !names.has(name.toLowerCase()),
        "manifest_source_duplicate_path",
      );
      names.add(name.toLowerCase());
      assert.match(
        entry.sha256,
        /^[a-f0-9]{64}$/,
        "manifest_source_hash_invalid",
      );
    }
    assert.deepEqual(
      source.files.map(({ file }) => file),
      source.files.map(({ file }) => file).sort(),
      "manifest_source_files_unsorted",
    );
    assert.equal(
      source.sha256,
      hash(JSON.stringify(source.files)),
      "manifest_source_fingerprint_mismatch",
    );
  }
  assert.ok(
    Array.isArray(inventory.files) &&
      inventory.files.length > 0 &&
      inventory.files.length < TARBALL_LIMITS.members,
    "manifest_files_invalid",
  );
  const listed = new Set();
  for (const entry of inventory.files) {
    assert.ok(
      entry && Object.keys(entry).sort().join(",") === "file,sha256",
      "manifest_entry_invalid",
    );
    const name = archivePath(`package/${entry.file}`);
    assert.ok(
      name !== "BUILD-MANIFEST.json" && !listed.has(name.toLowerCase()),
      "manifest_duplicate_path",
    );
    listed.add(name.toLowerCase());
    assert.match(entry.sha256, /^[a-f0-9]{64}$/, "manifest_hash_invalid");
    assert.ok(files.has(name), "manifest_file_missing_from_tarball");
    assert.equal(
      hash(files.get(name)),
      entry.sha256,
      "manifest_file_hash_mismatch",
    );
  }
  assert.equal(files.size, listed.size + 1, "tarball_uninventoried_file");
  const metadata = canonicalManifest(files.get("package.json"));
  assert.equal(metadata.name, inventory.package, "package_name_mismatch");
  assert.equal(
    metadata.version,
    inventory.packageVersion,
    "package_version_mismatch",
  );
  assert.ok(
    ["0.1.0", "0.2.0", "0.3.0", "0.3.1", "0.4.0"].includes(metadata.version),
    "package_version_not_reviewed",
  );
  if (metadata.version !== "0.1.0")
    assert.ok(inventory.source, "manifest_source_required");
  const requiredFiles = metadata.version === "0.4.0" ? OPEN_SOURCE_FILES : ROOT_FILES;
  for (const name of requiredFiles)
    assert.ok(files.has(name), "package_required_file_missing");
  for (const name of files.keys())
    assert.ok(requiredFiles.has(name) || /^dist\/[A-Za-z0-9_/-]+(?:\.js|\.d\.ts)$/.test(name), "package_member_not_allowed");
  if (metadata.version === "0.4.0") {
    for (const name of OPEN_SOURCE_MODULES) {
      const source = inventory.source.files.find((entry) => entry.file === `src/${name}.ts`);
      assert.ok(source, "package_source_not_in_manifest");
      assert.equal(hash(files.get(`src/${name}.ts`)), source.sha256, "package_source_identity_mismatch");
    }
  }
  assert.equal(metadata.private, true, "package_must_remain_private");
  assert.equal(metadata.type, "module", "package_must_be_esm");
  assert.equal(
    metadata.license,
    metadata.version === "0.4.0" ? "Apache-2.0" : "SEE LICENSE IN LICENSE.txt",
    "package_license_mismatch",
  );
  for (const key of [
    "scripts",
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "bundledDependencies",
    "bundleDependencies",
  ])
    assert.equal(
      metadata[key],
      undefined,
      "package_runtime_dependency_or_script",
    );
  assert.deepEqual(
    Object.keys(metadata.bin ?? {}),
    ["z7on-inspect"],
    "package_bin_contract_invalid",
  );
  assert.deepEqual(
    Object.keys(metadata.exports ?? {}).sort(),
    [".", "./node", ...(metadata.version === "0.4.0" ? Object.keys(openSourceExports()) : [])].sort(),
    "package_exports_contract_invalid",
  );
  if (metadata.version === "0.4.0") {
    for (const [name, expected] of Object.entries(openSourceExports())) {
      assert.deepEqual(metadata.exports[name], expected, "package_internal_export_invalid");
      for (const target of Object.values(expected))
        assert.ok(files.has(target.slice(2)), "package_entrypoint_missing");
    }
  }
  for (const name of [".", "./node"])
    assert.deepEqual(
      Object.keys(metadata.exports[name] ?? {}).sort(),
      ["import", "types"],
      "package_exports_contract_invalid",
    );
  for (const [endpoint, extension] of [
    [metadata.bin["z7on-inspect"], ".js"],
    [metadata.exports["."].import, ".js"],
    [metadata.exports["."].types, ".d.ts"],
    [metadata.exports["./node"].import, ".js"],
    [metadata.exports["./node"].types, ".d.ts"],
  ]) {
    assert.ok(
      typeof endpoint === "string" &&
        endpoint.startsWith("./dist/") &&
        endpoint.endsWith(extension),
      "package_entrypoint_invalid",
    );
    assert.ok(
      files.has(archivePath(`package/${endpoint.slice(2)}`)),
      "package_entrypoint_missing",
    );
  }
  const notices = decoder.decode(files.get("THIRD-PARTY-NOTICES.md"));
  assert.ok(
    notices.includes("decimal.js") &&
      notices.includes("SevenLabs") &&
      notices.includes("MIT License") &&
      notices.includes("Permission is hereby granted, free of charge"),
    "required_third_party_notice_missing",
  );
  assert.match(
    decoder.decode(files.get(metadata.version === "0.4.0" ? "LICENSE" : "LICENSE.txt")),
    metadata.version === "0.4.0"
      ? /Apache License[\s\S]*Version 2\.0, January 2004[\s\S]*END OF TERMS AND CONDITIONS/
      : metadata.version === "0.3.1"
      ? /^Z7ON LABS Solana Inspector — Free Internal Use License v1\r?\n/
      : /Evaluation License/,
    metadata.version === "0.4.0"
      ? "apache_license_missing"
      : metadata.version === "0.3.1"
      ? "free_internal_use_license_missing"
      : "evaluation_license_missing",
  );
  return {
    sha256,
    compressedBytes: compressed.length,
    expandedBytes: tar.length,
    files,
    inventory,
    metadata,
  };
}

/** Read one stable regular archive with a bound before allocating/decompressing. */
export function verifyTarballFile(file, expectedSha256) {
  const before = lstatSync(file);
  assert.ok(
    before.isFile() && !before.isSymbolicLink(),
    "tarball_not_regular_file",
  );
  assert.ok(
    before.size > 0 && before.size <= TARBALL_LIMITS.compressedBytes,
    "tarball_compressed_byte_limit",
  );
  const descriptor = openSync(file, "r");
  let confirmation;
  try {
    const opened = fstatSync(descriptor);
    // Some supported Windows libuv versions omit the path stat's device ID.
    // Only that exact case uses a second handle with strict device+inode checks.
    const omittedPathDevice =
      process.platform === "win32" && before.dev === 0 && opened.dev !== 0;
    const sameSnapshot = (left, right) =>
      left.isFile() &&
      right.isFile() &&
      left.ino === right.ino &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs &&
      left.ctimeMs === right.ctimeMs;
    const sameHandle = (left, right) =>
      sameSnapshot(left, right) && left.dev === right.dev;
    const checkPath = () => {
      const current = lstatSync(file);
      assert.ok(
        !current.isSymbolicLink() && sameHandle(before, current),
        "tarball_changed_during_read",
      );
    };
    assert.ok(
      sameSnapshot(before, opened) &&
        (omittedPathDevice || opened.dev === before.dev),
      "tarball_changed_during_read",
    );
    checkPath();
    if (omittedPathDevice) {
      confirmation = openSync(file, "r");
      assert.ok(
        sameHandle(opened, fstatSync(confirmation)),
        "tarball_changed_during_read",
      );
      checkPath();
    }
    const bytes = Buffer.alloc(before.size);
    let read = 0;
    while (read < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        read,
        bytes.length - read,
        read,
      );
      assert.ok(count > 0, "tarball_changed_during_read");
      read += count;
    }
    const after = fstatSync(descriptor);
    assert.ok(
      sameHandle(opened, after) &&
        (confirmation === undefined ||
          sameHandle(opened, fstatSync(confirmation))),
      "tarball_changed_during_read",
    );
    checkPath();
    return verifyTarballBytes(bytes, expectedSha256);
  } finally {
    try {
      if (confirmation !== undefined) closeSync(confirmation);
    } finally {
      closeSync(descriptor);
    }
  }
}
