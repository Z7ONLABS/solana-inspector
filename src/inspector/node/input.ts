import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import Decimal from "decimal.js";

export const INSPECTOR_VERSION = "0.4.0";
export const INPUT_VERSION = "solana-inspector-input-v1";
export const LIMITS = Object.freeze({
  inputBytes: 32 * 1024 * 1024,
  transactions: 1_000,
  executionMs: 30_000,
  depth: 64,
  nodes: 2_000_000,
  outputBytes: 128 * 1024 * 1024,
});

export class InspectorInputError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "InspectorInputError";
  }
}

export const hashBytes = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

/** Canonical object keys; arrays retain their supplied order, never economic order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined)
    throw new InspectorInputError("unserializable_value");
  return result;
}

/** Bounded JSON reader rejects duplicate keys and unsafe numeric literals before normalization. */
export function parseEvidenceJson(text: string): unknown {
  let at = 0;
  let nodes = 0;
  const fail = (code = "invalid_json"): never => {
    throw new InspectorInputError(code);
  };
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(text[at] ?? "x")) at++;
  };
  const string = (): string => {
    const start = at++;
    let closed = false;
    while (at < text.length) {
      const char = text[at++];
      if (char === "\\") {
        at++;
        continue;
      }
      if (char === '"') {
        closed = true;
        break;
      }
    }
    if (!closed) fail();
    try {
      return JSON.parse(text.slice(start, at)) as string;
    } catch {
      return fail();
    }
  };
  const numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const value = (depth: number): unknown => {
    if (++nodes > LIMITS.nodes || depth > LIMITS.depth)
      fail("json_structure_limit");
    whitespace();
    const char = text[at];
    if (char === '"') return string();
    if (char === "{") {
      at++;
      const record: Record<string, unknown> = Object.create(null);
      whitespace();
      if (text[at] === "}") {
        at++;
        return record;
      }
      while (at < text.length) {
        whitespace();
        if (text[at] !== '"') fail();
        const key = string();
        if (Object.hasOwn(record, key)) fail("duplicate_json_key");
        if (["__proto__", "prototype", "constructor"].includes(key))
          fail("unsafe_json_key");
        whitespace();
        if (text[at++] !== ":") fail();
        record[key] = value(depth + 1);
        whitespace();
        if (text[at] === "}") {
          at++;
          return record;
        }
        if (text[at++] !== ",") fail();
      }
      return fail();
    }
    if (char === "[") {
      at++;
      const list: unknown[] = [];
      whitespace();
      if (text[at] === "]") {
        at++;
        return list;
      }
      while (at < text.length) {
        list.push(value(depth + 1));
        whitespace();
        if (text[at] === "]") {
          at++;
          return list;
        }
        if (text[at++] !== ",") fail();
      }
      return fail();
    }
    for (const [word, result] of [
      ["null", null],
      ["true", true],
      ["false", false],
    ] as const) {
      if (text.startsWith(word, at)) {
        at += word.length;
        return result;
      }
    }
    numberPattern.lastIndex = at;
    const match = numberPattern.exec(text);
    if (!match) return fail();
    const token = match[0];
    at += token.length;
    if (token.length > 128) fail("unsafe_json_number");
    const parsed = Number(token);
    if (
      !Number.isFinite(parsed) ||
      Math.abs(parsed) > Number.MAX_SAFE_INTEGER ||
      (Number.isInteger(parsed) && !new Decimal(token).equals(String(parsed)))
    ) {
      fail("unsafe_json_number");
    }
    return parsed;
  };
  const result = value(0);
  whitespace();
  if (at !== text.length) fail();
  return result;
}

export async function readInputBytes(
  file: string,
  maximumBytes: number = LIMITS.inputBytes,
): Promise<Buffer> {
  const initial = await lstat(file);
  if (!initial.isFile() || initial.isSymbolicLink())
    throw new InspectorInputError("input_not_regular_file");
  if (initial.size > maximumBytes)
    throw new InspectorInputError("input_byte_limit");
  const handle = await open(file, "r");
  let confirmation: FileHandle | undefined;
  try {
    const before = await handle.stat();
    // Older supported Windows libuv path-stat calls can omit st_dev (zero),
    // although fstat supplies it. Compensate with two contemporaneous handles;
    // never ignore a known device mismatch or relax inode/content checks.
    const omittedPathDevice =
      process.platform === "win32" && initial.dev === 0 && before.dev !== 0;
    const sameSnapshot = (left: Stats, right: Stats) =>
      left.isFile() &&
      right.isFile() &&
      left.ino === right.ino &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs &&
      left.ctimeMs === right.ctimeMs;
    const sameHandle = (left: Stats, right: Stats) =>
      sameSnapshot(left, right) && left.dev === right.dev;
    const checkPath = async () => {
      const current = await lstat(file);
      if (current.isSymbolicLink() || !sameHandle(initial, current))
        throw new InspectorInputError("input_changed");
    };
    if (
      before.size > maximumBytes ||
      !sameSnapshot(initial, before) ||
      (!omittedPathDevice && before.dev !== initial.dev)
    ) {
      throw new InspectorInputError("input_changed");
    }
    await checkPath();
    if (omittedPathDevice) {
      confirmation = await open(file, "r");
      if (!sameHandle(before, await confirmation.stat()))
        throw new InspectorInputError("input_changed");
      await checkPath();
    }
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const chunk = await handle.read(
        bytes,
        count,
        bytes.length - count,
        count,
      );
      if (!chunk.bytesRead) break;
      count += chunk.bytesRead;
    }
    const after = await handle.stat();
    if (
      count !== before.size ||
      !sameHandle(before, after) ||
      (confirmation && !sameHandle(before, await confirmation.stat()))
    ) {
      throw new InspectorInputError("input_changed");
    }
    await checkPath();
    return bytes.subarray(0, count);
  } finally {
    try {
      if (confirmation) await confirmation.close();
    } finally {
      await handle.close();
    }
  }
}

function decode(bytes: Buffer): unknown {
  try {
    return parseEvidenceJson(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch (error) {
    if (error instanceof InspectorInputError) throw error;
    throw new InspectorInputError("input_not_utf8_json");
  }
}

export type InspectorManifest = {
  version: typeof INPUT_VERSION;
  inspectorVersion: string;
  walletAddress: string;
  input: { file: "input.json"; sha256: string; bytes: number };
  transactions: Array<{ payloadSha256: string }>;
  provenance: "user-supplied-not-chain-authenticated";
  artifacts?: Record<"report.json" | "report.html", string>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export async function loadInspectorInput(file: string, walletAddress: string) {
  let bytes = await readInputBytes(file);
  let decoded = decode(bytes);
  let prior: InspectorManifest | undefined;
  if (
    decoded &&
    typeof decoded === "object" &&
    !Array.isArray(decoded) &&
    (decoded as Record<string, unknown>).version === INPUT_VERSION
  ) {
    prior = decoded as InspectorManifest;
    if (
      prior.walletAddress !== walletAddress ||
      prior.inspectorVersion !== INSPECTOR_VERSION ||
      prior.input?.file !== "input.json" ||
      !/^[a-f0-9]{64}$/.test(prior.input.sha256) ||
      !Number.isSafeInteger(prior.input.bytes) ||
      !Array.isArray(prior.transactions) ||
      prior.transactions.length > LIMITS.transactions ||
      prior.provenance !== "user-supplied-not-chain-authenticated"
    ) {
      throw new InspectorInputError("manifest_incompatible");
    }
    const evidencePath = path.join(path.dirname(file), "input.json");
    if (path.resolve(evidencePath) === path.resolve(file))
      throw new InspectorInputError("manifest_recursive");
    bytes = await readInputBytes(evidencePath);
    if (
      hashBytes(bytes) !== prior.input.sha256 ||
      bytes.length !== prior.input.bytes
    ) {
      throw new InspectorInputError("manifest_hash_mismatch");
    }
    if (prior.artifacts !== undefined) {
      if (
        !isRecord(prior.artifacts) ||
        Object.keys(prior.artifacts).sort().join(",") !==
          "report.html,report.json" ||
        Object.values(prior.artifacts).some(
          (hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash),
        )
      ) {
        throw new InspectorInputError("manifest_artifacts_incompatible");
      }
      let artifactBytes = bytes.length;
      for (const name of ["report.json", "report.html"] as const) {
        let artifact: Buffer;
        try {
          artifact = await readInputBytes(
            path.join(path.dirname(file), name),
            LIMITS.outputBytes - artifactBytes,
          );
        } catch {
          throw new InspectorInputError("manifest_artifact_unavailable");
        }
        artifactBytes += artifact.length;
        if (hashBytes(artifact) !== prior.artifacts[name])
          throw new InspectorInputError("manifest_artifact_hash_mismatch");
      }
    }
    decoded = decode(bytes);
  }
  const rawEntries = Array.isArray(decoded) ? decoded : [decoded];
  if (!rawEntries.length || rawEntries.length > LIMITS.transactions)
    throw new InspectorInputError("transaction_count_limit");
  const transactions = rawEntries.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new InspectorInputError("transaction_envelope_invalid");
    const record = entry as Record<string, unknown>;
    if (Object.hasOwn(record, "error"))
      throw new InspectorInputError("rpc_error_response");
    const raw = Object.hasOwn(record, "result") ? record.result : record;
    if (raw === null) throw new InspectorInputError("transaction_not_found");
    if (
      !isRecord(raw) ||
      !isRecord(raw.transaction) ||
      !isRecord(raw.meta) ||
      !Array.isArray(raw.transaction.signatures) ||
      !isRecord(raw.transaction.message) ||
      !Array.isArray(raw.transaction.message.accountKeys) ||
      !Array.isArray(raw.transaction.message.instructions)
    ) {
      throw new InspectorInputError("transaction_envelope_invalid");
    }
    return { raw, payloadSha256: hashBytes(canonicalJson(raw)) };
  });
  if (
    prior &&
    (prior.transactions.length !== transactions.length ||
      transactions.some(
        (tx, index) =>
          tx.payloadSha256 !== prior!.transactions[index]?.payloadSha256,
      ))
  )
    throw new InspectorInputError("manifest_transaction_hash_mismatch");
  const inputSha256 = hashBytes(bytes);
  const manifest: InspectorManifest = {
    version: INPUT_VERSION,
    inspectorVersion: INSPECTOR_VERSION,
    walletAddress,
    input: { file: "input.json", sha256: inputSha256, bytes: bytes.length },
    transactions: transactions.map(({ payloadSha256 }) => ({ payloadSha256 })),
    provenance: "user-supplied-not-chain-authenticated",
  };
  return {
    bytes,
    manifest,
    evidence: { walletAddress, transactions, inputSha256 },
  };
}
