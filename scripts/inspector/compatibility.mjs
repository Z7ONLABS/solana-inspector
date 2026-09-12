/** Installed-package compatibility proof using only synthetic data; no provider or DB access. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyTarballFile } from "./tarball.mjs";
import { RUNTIME_VERSIONS, runtimeSpec } from "./compatibility-runtimes.mjs";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "../..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file));
const writeJson = (file, value) =>
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
const WALLET = "11111111111111111111111111111112";
const SPONSOR = "11111111111111111111111111111113";
const RECIPIENT = "11111111111111111111111111111114";
const BUNDLE = ["input.json", "manifest.json", "report.json", "report.html"];

/** A new public candidate must be bound to a separately reviewed fingerprint. */
export function assertReviewedCandidate(candidate, expectedSha) {
  assert.ok(
    ["0.3.0", "0.3.1", "0.4.0"].includes(candidate.version),
    "Unreviewed inspector candidate version",
  );
  assert.match(candidate.sha256, /^[a-f0-9]{64}$/);
  if (candidate.version === "0.3.1" || candidate.version === "0.4.0")
    assert.ok(
      expectedSha,
      `${candidate.version} requires --expected-sha from the reviewed candidate`,
    );
  if (expectedSha !== undefined) {
    assert.match(expectedSha, /^[a-f0-9]{64}$/);
    assert.equal(
      candidate.sha256,
      expectedSha,
      "Candidate is not the approved tarball",
    );
  }
}

/** Clearly synthetic test evidence, never a customer example or coverage claim. */
export function compatibilityTransaction(
  signature = "synthetic-compatibility-only",
  amount = 100,
) {
  return {
    slot: 42,
    version: "legacy",
    blockTime: 1700000000,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [
          { pubkey: SPONSOR, signer: true, writable: true },
          { pubkey: WALLET, signer: true, writable: true },
          { pubkey: RECIPIENT, signer: false, writable: true },
        ],
        instructions: [
          {
            program: "system",
            programId: "11111111111111111111111111111111",
            parsed: {
              type: "transfer",
              info: {
                source: WALLET,
                destination: RECIPIENT,
                lamports: amount,
              },
            },
          },
        ],
      },
    },
    meta: {
      fee: 5,
      err: null,
      preBalances: [1000, 1000, 0],
      postBalances: [995, 1000 - amount, amount],
      preTokenBalances: [],
      postTokenBalances: [],
      innerInstructions: [],
      logMessages: [],
    },
  };
}

export function minimalEnvironment({
  home,
  cache,
  temporary,
  guard,
  nodeExecutable,
}) {
  const nodeDirectory = path.dirname(nodeExecutable);
  /** @type {NodeJS.ProcessEnv} */
  const environment = {
    NODE_ENV: "test",
    HOME: home,
    USERPROFILE: home,
    TMP: temporary,
    TEMP: temporary,
    TMPDIR: temporary,
    PATH: [nodeDirectory, "/usr/bin", "/bin"].join(path.delimiter),
    NODE_OPTIONS: `--import ${pathToFileURL(guard).href}`,
    NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_USERCONFIG: path.join(home, "user.npmrc"),
    NPM_CONFIG_GLOBALCONFIG: path.join(home, "global.npmrc"),
    NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_PROGRESS: "false",
  };
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot;
    assert.ok(
      systemRoot,
      "SystemRoot is required for installed Windows command shims",
    );
    environment.SystemRoot = systemRoot;
    environment.ComSpec = path.join(systemRoot, "System32/cmd.exe");
    environment.PATHEXT = ".COM;.EXE;.BAT;.CMD";
    environment.PATH = [
      nodeDirectory,
      path.join(systemRoot, "System32"),
      systemRoot,
    ].join(path.delimiter);
    environment.APPDATA = home;
    environment.LOCALAPPDATA = home;
  }
  return environment;
}

export function compatibilityGuard(attempts) {
  return `import fs from 'node:fs';import net from 'node:net';import tls from 'node:tls';import http from 'node:http';import https from 'node:https';import http2 from 'node:http2';import dns from 'node:dns';import dgram from 'node:dgram';import {syncBuiltinESMExports} from 'node:module';
const blocked=()=>{fs.appendFileSync(${JSON.stringify(attempts)},'blocked\\n');process.stderr.write('UNEXPECTED_NETWORK_OR_DATABASE_CONNECTION\\n');process.exit(91)};
net.Socket.prototype.connect=blocked;net.connect=blocked;net.createConnection=blocked;tls.connect=blocked;http.request=blocked;http.get=blocked;https.request=blocked;https.get=blocked;http2.connect=blocked;dns.lookup=blocked;dns.resolve=blocked;dns.promises.lookup=blocked;dns.promises.resolve=blocked;dgram.createSocket=blocked;globalThis.fetch=blocked;globalThis.WebSocket=blocked;syncBuiltinESMExports();\n`;
}

function npmCli(executable, name) {
  const directory = path.dirname(executable);
  const candidates = [
    path.join(directory, `node_modules/npm/bin/${name}-cli.js`),
    path.join(directory, `../lib/node_modules/npm/bin/${name}-cli.js`),
  ];
  const result = candidates.find((file) => fs.existsSync(file));
  assert.ok(result, "The selected official runtime must include npm/npx");
  return result;
}

function bundleHashes(directory) {
  return Object.fromEntries(
    BUNDLE.map((name) => [
      name,
      sha(fs.readFileSync(path.join(directory, name))),
    ]),
  );
}

/** Runs under the target runtime, outside the checkout, with only synthetic data. */
export function verifyCompatibilityCell({
  candidate,
  directory,
  toolchainRoot = root,
}) {
  const nodeVersion = process.versions.node;
  assert.ok(
    RUNTIME_VERSIONS.includes(nodeVersion) || nodeVersion === "24.13.0",
    "Unplanned compatibility runtime",
  );
  assert.ok(process.platform === "win32" || process.platform === "linux");
  assert.equal(process.arch, "x64");
  assert.ok(["0.3.0", "0.3.1", "0.4.0"].includes(candidate.version));
  const archive = verifyTarballFile(candidate.tarball, candidate.sha256);
  assert.equal(archive.metadata.version, candidate.version);
  fs.mkdirSync(directory); // Exclusive: no previous run is reused or repaired.
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "z7on-inspector-compatibility-"),
  );
  assert.ok(
    !workspace.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`),
    "Recipient installation must be genuinely outside the source checkout",
  );
  const home = path.join(workspace, "empty home");
  const cache = path.join(workspace, "empty npm cache");
  const temporary = path.join(workspace, "temporary files");
  const recipient = path.join(workspace, "recipient project with spaces");
  writeJson(path.join(directory, "private-recipient-location.json"), {
    workspace,
    purpose:
      "Owned synthetic recipient; retained on a failed check for diagnosis.",
  });
  for (const folder of [home, cache, temporary, recipient])
    fs.mkdirSync(folder);
  for (const config of ["user.npmrc", "global.npmrc"])
    fs.writeFileSync(path.join(home, config), "", { flag: "wx" });
  const attempts = path.join(workspace, "connection-attempts.txt");
  const guard = path.join(workspace, "offline guard.mjs");
  fs.writeFileSync(attempts, "", { flag: "wx" });
  fs.writeFileSync(guard, compatibilityGuard(attempts), { flag: "wx" });
  const env = minimalEnvironment({
    home,
    cache,
    temporary,
    guard,
    nodeExecutable: process.execPath,
  });
  const spawn = (args, timeout = 40_000, additions = {}) =>
    spawnSync(process.execPath, args, {
      cwd: recipient,
      env: { ...env, ...additions },
      encoding: "utf8",
      timeout,
      maxBuffer: 2 * 1024 * 1024,
    });
  const check = (result, expected = 0, code) => {
    assert.equal(
      result.error,
      undefined,
      "Child process failed or exceeded its harness timeout",
    );
    assert.equal(
      result.status,
      expected,
      `Expected exit ${expected}; received ${result.status}: ${result.stderr}`,
    );
    if (code)
      assert.ok(
        result.stderr.includes(code),
        `Missing safe error code ${code}`,
      );
    return result;
  };
  const run = (args) =>
    spawn([
      npmCli(process.execPath, "npx"),
      "--no-install",
      "z7on-inspect",
      ...args,
    ]);
  const out = (name) => path.join(recipient, name);
  const input = out("transaction with spaces.json");
  const raw = compatibilityTransaction();
  fs.writeFileSync(
    input,
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: raw }),
    { flag: "wx" },
  );

  // Prove the guard is active separately, then record only inspection attempts.
  check(
    spawn([
      "--input-type=module",
      "-e",
      "await fetch('https://offline-guard.invalid/')",
    ]),
    91,
    "UNEXPECTED_NETWORK",
  );
  assert.equal(fs.readFileSync(attempts, "utf8"), "blocked\n");
  fs.writeFileSync(attempts, "");
  assert.deepEqual(fs.readdirSync(cache), []);
  const tarballName = path.basename(candidate.tarball);
  fs.copyFileSync(
    candidate.tarball,
    out(tarballName),
    fs.constants.COPYFILE_EXCL,
  );
  assert.equal(sha(fs.readFileSync(out(tarballName))), candidate.sha256);
  const npmVersion = check(
    spawn([npmCli(process.execPath, "npm"), "--version"]),
  ).stdout.trim();
  check(
    spawn(
      [
        npmCli(process.execPath, "npm"),
        "install",
        `./${tarballName}`,
        "--ignore-scripts",
        "--offline",
        "--no-audit",
        "--no-fund",
      ],
      40_000,
    ),
  );
  const installed = out("node_modules/@z7onlabs/solana-inspector");
  for (const [name, bytes] of archive.files)
    assert.deepEqual(
      fs.readFileSync(path.join(installed, name)),
      bytes,
      `Installed bytes changed: ${name}`,
    );
  assert.equal(check(run(["--version"])).stdout.trim(), candidate.version);
  assert.ok(
    check(run(["--help"])).stdout.includes("30 seconds of worker processing"),
  );

  const first = out("inspection first");
  check(
    run(["--input", input, "--wallet", WALLET, "--out", first, "--feedback"]),
  );
  const expected = bundleHashes(first);
  const second = out("inspection replay");
  check(
    run([
      "--input",
      path.join(first, "manifest.json"),
      "--wallet",
      WALLET,
      "--out",
      second,
    ]),
  );
  assert.deepEqual(bundleHashes(second), expected);
  const report = readJson(path.join(first, "report.json"));
  assert.equal(report.version, "solana-inspection-v2");
  assert.equal(report.financial.pnlUsd, null);
  assert.equal(report.coverage.historyComplete, false);
  assert.equal(report.trust.authenticated, false);
  assert.equal(report.summary.suppliedTransactions, 1);
  const receipt = fs.readFileSync(path.join(first, "feedback.json"), "utf8");
  assert.equal(JSON.parse(receipt).sent, false);
  for (const secret of [
    WALLET,
    raw.transaction.signatures[0],
    recipient,
    report.inputSha256,
  ])
    assert.ok(!receipt.includes(secret));
  assert.ok(
    report.transactions[0].economic.fees.every(
      (fee) => !fee.chargedToAnalyzedWallet,
    ),
  );
  assert.equal(
    report.transactions[0].economic.rawMovements[0].rawAmount,
    "100",
  );

  check(
    run(["--input", input, "--wallet", WALLET, "--out", first]),
    3,
    "output_already_exists",
  );
  assert.deepEqual(bundleHashes(first), expected);
  const invalid = out("invalid.json");
  fs.writeFileSync(
    invalid,
    '{"error":{"code":-1,"message":"DO_NOT_LEAK_PROVIDER_CONTENT"}}',
    { flag: "wx" },
  );
  const invalidOut = out("invalid output");
  const failed = check(
    run(["--input", invalid, "--wallet", WALLET, "--out", invalidOut]),
    2,
    "rpc_error_response",
  );
  assert.ok(!failed.stderr.includes("DO_NOT_LEAK_PROVIDER_CONTENT"));
  assert.equal(fs.existsSync(invalidOut), false);
  const altered = out("altered bundle");
  fs.mkdirSync(altered);
  for (const name of BUNDLE)
    fs.copyFileSync(path.join(first, name), path.join(altered, name));
  fs.appendFileSync(path.join(altered, "report.html"), "altered");
  check(
    run([
      "--input",
      path.join(altered, "manifest.json"),
      "--wallet",
      WALLET,
      "--out",
      out("altered output"),
    ]),
    2,
    "manifest_artifact_hash_mismatch",
  );
  assert.equal(fs.existsSync(out("altered output")), false);

  const mixedInput = out("mixed observations.json");
  const conflicting = compatibilityTransaction("conflicting-synthetic", 101);
  const missing = compatibilityTransaction("unused");
  missing.transaction.signatures = [];
  fs.writeFileSync(
    mixedInput,
    JSON.stringify([
      raw,
      raw,
      compatibilityTransaction("conflicting-synthetic"),
      conflicting,
      conflicting,
      missing,
    ]),
    { flag: "wx" },
  );
  const mixedOut = out("mixed observations");
  check(run(["--input", mixedInput, "--wallet", WALLET, "--out", mixedOut]));
  const mixed = readJson(path.join(mixedOut, "report.json"));
  assert.equal(mixed.summary.suppliedTransactions, 6);
  assert.equal(mixed.summary.uniqueTransactions, 2);
  assert.equal(mixed.summary.duplicateTransactions, 2);
  assert.equal(mixed.summary.conflictingSignatures, 1);
  assert.equal(mixed.summary.eligibleTransactions, 1);
  assert.equal(mixed.summary.unidentifiedObservations, 1);
  assert.equal(mixed.sample.state, "blocked");
  assert.equal(mixed.transactions.length, 6);

  const sdk = out("sdk consumer.mjs");
  const sdkOut = out("sdk output");
  fs.writeFileSync(
    sdk,
    `import assert from 'node:assert/strict';import fs from 'node:fs';import {createHash} from 'node:crypto';import {inspectSolanaEvidence} from '@z7onlabs/solana-inspector';import {executeInspector,INSPECTOR_VERSION} from '@z7onlabs/solana-inspector/node';
const raw=${JSON.stringify(raw)};const hash=x=>createHash('sha256').update(x).digest('hex');const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':x!==null&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);const bytes=fs.readFileSync(${JSON.stringify(input)});const report=inspectSolanaEvidence({walletAddress:${JSON.stringify(WALLET)},inputSha256:hash(bytes),transactions:[{raw,payloadSha256:hash(canonical(raw))}]});assert.equal(report.summary.suppliedTransactions,1);assert.equal(report.financial.pnlUsd,null);
// Compare the full JSON contract: optional undefined JS properties are omitted
// by JSON, while nulls, arrays and exact amount strings must remain identical.
assert.deepEqual(JSON.parse(JSON.stringify(report)),JSON.parse(fs.readFileSync(${JSON.stringify(path.join(first, "report.json"))})));assert.equal(INSPECTOR_VERSION,${JSON.stringify(candidate.version)});await executeInspector({input:${JSON.stringify(input)},wallet:${JSON.stringify(WALLET)},out:${JSON.stringify(sdkOut)}});`,
    { flag: "wx" },
  );
  check(spawn([sdk]));
  assert.deepEqual(bundleHashes(sdkOut), expected);

  const resolve = createRequire(path.join(toolchainRoot, "package.json"));
  const nodeTypes = resolve.resolve("@types/node/package.json");
  const undiciTypes = createRequire(nodeTypes).resolve(
    "undici-types/package.json",
  );
  for (const [source, target] of [
    [nodeTypes, "node_modules/@types/node"],
    [undiciTypes, "node_modules/undici-types"],
  ])
    fs.cpSync(path.dirname(source), out(target), {
      recursive: true,
      dereference: true,
      force: false,
      errorOnExist: true,
    });
  const typed = out("typed consumer.mts");
  fs.writeFileSync(
    typed,
    `import {inspectSolanaEvidence,type SolanaInspectionReport} from '@z7onlabs/solana-inspector';import {executeInspector,type InspectorOptions} from '@z7onlabs/solana-inspector/node';const result:SolanaInspectionReport=inspectSolanaEvidence({walletAddress:'${WALLET}',inputSha256:'${"a".repeat(64)}',transactions:[]});const gain:null=result.financial.pnlUsd;const options:InspectorOptions={input:'a.json',wallet:'${WALLET}',out:'output'};void gain;void options;void executeInspector;
// @ts-expect-error externally granting shared ownership is forbidden
inspectSolanaEvidence({walletAddress:'${WALLET}',inputSha256:'${"a".repeat(64)}',transactions:[],ownedWallets:[]});`,
    { flag: "wx" },
  );
  check(
    spawn([
      resolve.resolve("typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      typed,
    ]),
  );

  const cancel = out("cancel consumer.mjs");
  const cancelled = out("cancelled output");
  fs.writeFileSync(
    cancel,
    `import {executeInspector} from '@z7onlabs/solana-inspector/node';const controller=new AbortController();const pending=executeInspector({input:${JSON.stringify(input)},wallet:${JSON.stringify(WALLET)},out:${JSON.stringify(cancelled)},signal:controller.signal});setTimeout(()=>controller.abort(),5);try{await pending;process.exitCode=99}catch(error){process.exitCode=error.exitCode;}`,
    { flag: "wx" },
  );
  check(spawn([cancel]), 130);
  assert.equal(fs.existsSync(cancelled), false);
  const fault = out("output fault.mjs");
  fs.writeFileSync(
    fault,
    `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const code=process.argv[2];const target=process.argv[3];const original=fs.promises.link;fs.promises.link=async function(a,b){if(b.startsWith(target)){const error=new Error(code);error.code=code;throw error;}return original(a,b)};syncBuiltinESMExports();const {executeInspector}=await import('@z7onlabs/solana-inspector/node');try{await executeInspector({input:${JSON.stringify(input)},wallet:${JSON.stringify(WALLET)},out:target});process.exitCode=99}catch(error){if(error.code!==code)throw error;process.exitCode=3}`,
    { flag: "wx" },
  );
  for (const code of ["ENOSPC", "EACCES", "ENOTSUP"]) {
    const target = out(`fault ${code}`);
    check(spawn([fault, code, target]), 3);
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(bundleHashes(first), expected);
  }
  assert.equal(
    fs
      .readdirSync(recipient)
      .some((file) => file.startsWith(".z7on-inspection-")),
    false,
  );
  let symlink = "not_run_windows";
  let permissions = "not_run_windows";
  if (process.platform === "linux") {
    const linked = out("linked input.json");
    fs.symlinkSync(input, linked);
    check(
      run([
        "--input",
        linked,
        "--wallet",
        WALLET,
        "--out",
        out("symlink output"),
      ]),
      2,
      "input_not_regular_file",
    );
    assert.equal(fs.existsSync(out("symlink output")), false);
    symlink = "passed";
    if (process.getuid?.() === 0)
      permissions = "not_run_root_bypasses_permission_bits";
    else {
      const denied = out("denied parent");
      fs.mkdirSync(denied, { mode: 0o500 });
      try {
        check(
          run([
            "--input",
            input,
            "--wallet",
            WALLET,
            "--out",
            path.join(denied, "output"),
          ]),
          3,
          "local_io_or_processing_error",
        );
        assert.equal(fs.existsSync(path.join(denied, "output")), false);
      } finally {
        fs.chmodSync(denied, 0o700);
      }
      permissions = "passed";
    }
  }
  assert.equal(
    fs.readFileSync(attempts, "utf8"),
    "",
    "Unexpected network attempt during installation/inspection/replay/error/feedback/SDK",
  );
  assert.equal(sha(fs.readFileSync(candidate.tarball)), candidate.sha256);
  const proof = {
    schema: "solana-inspector-compatibility-v1",
    status: "passed",
    platform: process.platform,
    osRelease: os.release(),
    arch: process.arch,
    node: process.version,
    npm: npmVersion,
    packageVersion: candidate.version,
    candidateSha256: candidate.sha256,
    reportVersion: report.version,
    fixture: "synthetic-compatibility-v1",
    guardSelfCheckBlocked: true,
    inspectionConnectionAttempts: 0,
    emptyInitialCacheAndConfig: true,
    credentialFreeEnvironment: true,
    recipientOutsideSourceCheckout: true,
    installedCommandShim: "npx --no-install z7on-inspect",
    cli: "passed",
    sdkRuntimeExports: [".", "./node"],
    sdkTypes: {
      status: "passed",
      typescript: readJson(resolve.resolve("typescript/package.json")).version,
      nodeTypes: readJson(nodeTypes).version,
    },
    replayAndSdkByteIdentical: true,
    errorFeedbackCancellation: "passed",
    simulatedOutputFaults: ["ENOSPC", "EACCES", "ENOTSUP"],
    linuxSymlink: symlink,
    linuxPermissions: permissions,
    bundleSha256: expected,
    mixedObservationsBundleSha256: bundleHashes(mixedOut),
    realArchiveProcessed: false,
    limitations: [
      "Synthetic compatibility fixtures do not demonstrate protocol coverage.",
      "JavaScript connection guards are not an OS network sandbox.",
      "Installation preparation is separate from offline inspection.",
    ],
  };
  // Preserve only known synthetic report files, not caches, executable copies,
  // or POSIX test symlinks. Installation itself ran outside the checkout.
  const evidence = path.join(directory, "recipient-evidence");
  fs.mkdirSync(evidence);
  for (const [label, source] of [
    ["first", first],
    ["replay", second],
    ["sdk", sdkOut],
    ["mixed", mixedOut],
  ]) {
    const target = path.join(evidence, label);
    fs.mkdirSync(target);
    for (const name of BUNDLE)
      fs.copyFileSync(
        path.join(source, name),
        path.join(target, name),
        fs.constants.COPYFILE_EXCL,
      );
  }
  fs.copyFileSync(
    path.join(first, "feedback.json"),
    path.join(evidence, "feedback.json"),
    fs.constants.COPYFILE_EXCL,
  );
  fs.copyFileSync(
    attempts,
    path.join(evidence, "connection-attempts.txt"),
    fs.constants.COPYFILE_EXCL,
  );
  writeJson(path.join(directory, "compatibility.json"), proof);
  const ownedTemporaryRoot = path.resolve(os.tmpdir());
  assert.equal(path.dirname(workspace), ownedTemporaryRoot);
  assert.ok(
    path.basename(workspace).startsWith("z7on-inspector-compatibility-"),
  );
  fs.rmSync(workspace, { recursive: true, force: true });
  return proof;
}

export function parseCompatibilityArguments(args) {
  /** @type {{nodes: string[], build?: string, out?: string, "expected-sha"?: string, cell?: string}} */
  const parsed = { nodes: [] };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    assert.ok(
      ["--build", "--out", "--node", "--expected-sha", "--cell"].includes(
        key,
      ) &&
        value &&
        !value.startsWith("--"),
      "Invalid compatibility arguments",
    );
    if (key === "--node") parsed.nodes.push(value);
    else {
      assert.equal(
        parsed[key.slice(2)],
        undefined,
        "Repeated compatibility option",
      );
      parsed[key.slice(2)] = value;
    }
  }
  assert.ok(
    parsed.build && parsed.out,
    "Use --build POINTER --out NEW_DIRECTORY [--node EXECUTABLE] [--expected-sha SHA256]",
  );
  if (parsed["expected-sha"])
    assert.match(parsed["expected-sha"], /^[a-f0-9]{64}$/);
  return parsed;
}

function main() {
  const options = parseCompatibilityArguments(process.argv.slice(2));
  const candidate = readJson(path.resolve(options.build));
  assertReviewedCandidate(candidate, options["expected-sha"]);
  verifyTarballFile(candidate.tarball, candidate.sha256);
  const output = path.resolve(options.out);
  const permitted = path.join(root, ".local-data/inspector");
  assert.ok(
    output.startsWith(`${permitted}${path.sep}`),
    "Compatibility evidence must stay in ignored private storage",
  );
  if (options.cell) {
    assert.equal(options.cell, process.versions.node);
    const proof = verifyCompatibilityCell({ candidate, directory: output });
    process.stdout.write(`${JSON.stringify(proof)}\n`);
    return;
  }
  fs.mkdirSync(output);
  const nodes = options.nodes.length
    ? options.nodes.map((node) => path.resolve(node))
    : RUNTIME_VERSIONS.map((version) => {
        const spec = runtimeSpec(version);
        return path.join(
          permitted,
          "runtimes",
          spec.stem,
          process.platform === "win32" ? "node.exe" : "bin/node",
        );
      });
  const cells = [];
  for (const node of nodes) {
    const version = spawnSync(node, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
    }).stdout?.trim();
    assert.ok(
      version &&
        RUNTIME_VERSIONS.map((value) => `v${value}`)
          .concat("v24.13.0")
          .includes(version),
      "Runtime unavailable or unplanned",
    );
    assert.ok(
      !cells.some((cell) => cell.node === version),
      "Duplicate matrix runtime",
    );
    process.stderr.write(
      `Checking installed candidate under ${process.platform}/${version}; offline synthetic evidence only.\n`,
    );
    const directory = path.join(output, `${process.platform}-${version}`);
    const clean = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        [
          "SYSTEMROOT",
          "WINDIR",
          "PATH",
          "TEMP",
          "TMP",
          "PATHEXT",
          "COMSPEC",
        ].includes(key.toUpperCase()),
      ),
    );
    const run = spawnSync(
      node,
      [
        script,
        "--build",
        path.resolve(options.build),
        "--out",
        directory,
        "--cell",
        version.slice(1),
        "--expected-sha",
        candidate.sha256,
      ],
      {
        cwd: root,
        env: clean,
        encoding: "utf8",
        timeout: 300_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    if (run.error || run.status !== 0) {
      writeJson(path.join(output, "blocked.json"), {
        schema: "solana-inspector-compatibility-v1",
        status: "blocked",
        node: version,
        candidateSha256: candidate.sha256,
        completedCells: cells,
        reason:
          "Cell failed; inspect private cell logs. No successful matrix claim.",
      });
      fs.writeFileSync(
        path.join(output, "cell-error.txt"),
        run.stderr || String(run.error),
        { flag: "wx" },
      );
      throw new Error(
        `Compatibility failed on ${version}; private diagnostics retained.`,
      );
    }
    const proof = readJson(path.join(directory, "compatibility.json"));
    if (cells.length) {
      assert.deepEqual(
        proof.bundleSha256,
        cells[0].bundleSha256,
        "Cross-runtime report bytes differ",
      );
      assert.deepEqual(
        proof.mixedObservationsBundleSha256,
        cells[0].mixedObservationsBundleSha256,
        "Cross-runtime mixed-evidence bytes differ",
      );
    }
    cells.push(proof);
  }
  const proof = {
    schema: "solana-inspector-compatibility-matrix-v1",
    status: "passed",
    packageVersion: candidate.version,
    candidateSha256: candidate.sha256,
    sameCandidateAndOutputBytes: true,
    cells,
  };
  writeJson(path.join(output, "compatibility.json"), proof);
  process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Compatibility: ${error.message}\n`);
    process.exitCode = 1;
  }
}
