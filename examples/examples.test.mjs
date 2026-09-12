import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  assertSponsoredFee, EXAMPLE_SPONSOR, EXAMPLE_WALLET, inspectTeachingFixture,
} from "../recipes/assert-sponsored-fee.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const slugs = ["sponsored-fee", "swap-extra-transfer", "unexplained-difference"];
const file = (slug) => new URL(`./${slug}/input.json`, import.meta.url);
const load = async (slug) => JSON.parse(await readFile(file(slug), "utf8"));
const balance = (tx, mint) => tx.economic.balanceEvidence.find((row) => row.asset.assetId === mint);
const nativeDelta = (raw, address) => {
  const index = raw.transaction.message.accountKeys.findIndex((row) => row.pubkey === address);
  assert.notEqual(index, -1);
  return BigInt(raw.meta.postBalances[index]) - BigInt(raw.meta.preBalances[index]);
};
const tokenDelta = (raw, address) => {
  const index = raw.transaction.message.accountKeys.findIndex((row) => row.pubkey === address);
  const pre = raw.meta.preTokenBalances.find((row) => row.accountIndex === index);
  const post = raw.meta.postTokenBalances.find((row) => row.accountIndex === index);
  assert.ok(pre && post);
  return BigInt(post.uiTokenAmount.amount) - BigInt(pre.uiTokenAmount.amount);
};

// Independent teaching-wire oracle: do not import the production route decoder.
function decodeBase58(text) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const char of text) {
    const digit = alphabet.indexOf(char);
    assert.notEqual(digit, -1);
    value = value * 58n + BigInt(digit);
  }
  const bytes = [];
  while (value) {
    bytes.unshift(Number(value % 256n));
    value /= 256n;
  }
  for (const char of text) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

test("all fixtures are explicitly synthetic, bounded and have no remote/private inputs", async () => {
  const signatures = new Set();
  for (const slug of slugs) {
    const text = await readFile(file(slug), "utf8");
    const envelope = JSON.parse(text);
    assert.match(envelope._z7onExample, /^SYNTHETIC/);
    assert.equal(envelope.jsonrpc, "2.0");
    assert.equal(envelope.result.meta.err, null);
    assert.doesNotMatch(text, /https?:\/\/|apiKey|privateKey|seedPhrase/);
    assert.ok(Buffer.byteLength(text) < 32_000);
    assert.match(envelope.result.transaction.signatures[0], /^SYNTHETIC-.*-not-a-chain-signature$/);
    signatures.add(envelope.result.transaction.signatures[0]);
    const explanation = await readFile(new URL(`../docs/cases/${slug}.md`, import.meta.url), "utf8");
    for (const heading of ["Question", "Evidence", "Answer", "Limitation", "Next check"]) {
      assert.ok(explanation.includes(`## ${heading}`));
    }
  }
  assert.equal(signatures.size, 3);
});

test("sponsor fee and wallet debit match the literal original balances/instruction", async () => {
  const { result: raw } = await load("sponsored-fee");
  assert.equal(raw.transaction.message.accountKeys[0].pubkey, EXAMPLE_SPONSOR);
  assert.equal(raw.meta.fee, 5000);
  assert.equal(raw.transaction.message.instructions[0].parsed.info.lamports, 100000000);
  assert.equal(nativeDelta(raw, EXAMPLE_SPONSOR), -5000n);
  assert.equal(nativeDelta(raw, EXAMPLE_WALLET), -100000000n);
  const report = await inspectTeachingFixture(file("sponsored-fee"));
  assertSponsoredFee(report);
  assert.equal(balance(report.transactions[0], "native").movementCheck.expectedDeltaRaw,
    (-BigInt(raw.transaction.message.instructions[0].parsed.info.lamports)).toString());
  assert.deepEqual(report.transactions[0].economic.blockers, ["finality_unavailable"]);
});

test("SDK recipe rejects an intentionally wrong payer and wrong economic expectation", async () => {
  const report = await inspectTeachingFixture(file("sponsored-fee"));
  assert.throws(() => assertSponsoredFee(report, {
    payerWallet: EXAMPLE_WALLET, walletDeltaRaw: "-100000000",
  }), /unexpected fee payer/);
  assert.throws(() => assertSponsoredFee(report, {
    payerWallet: EXAMPLE_SPONSOR, walletDeltaRaw: "-100005000",
  }), /unexpected wallet delta/);
});

test("DFlow candidate uses gross CPI legs; the following token transfer remains separate", async () => {
  const { result: raw } = await load("swap-extra-transfer");
  const cpi = raw.meta.innerInstructions[0].instructions;
  const outgoing = cpi[1].parsed.info;
  const incoming = cpi[2].parsed.info;
  const subsequent = raw.transaction.message.instructions[1].parsed.info;
  assert.equal(outgoing.amount, "5000000");
  assert.equal(incoming.amount, "2500000");
  assert.equal(subsequent.amount, "500000");
  assert.equal(subsequent.source, incoming.destination);
  assert.equal(tokenDelta(raw, outgoing.source), -5000000n);
  assert.equal(tokenDelta(raw, incoming.destination), 2500000n - 500000n);
  assert.equal(tokenDelta(raw, subsequent.destination), 500000n);
  assert.equal(nativeDelta(raw, EXAMPLE_WALLET), -5000n);
  const encoded = decodeBase58(cpi[3].data);
  assert.equal(encoded.subarray(0, 16).toString("hex"), "e445a52e51cb9a1d40c6cde8260871e2");
  assert.equal(encoded.readBigUInt64LE(80), 5000000n);
  assert.equal(encoded.readBigUInt64LE(120), 2500000n);
  const report = await inspectTeachingFixture(file("swap-extra-transfer"));
  const tx = report.transactions[0].economic;
  assert.equal(tx.executionProtocol, "dflow-v4");
  assert.equal(tx.swaps.length, 1);
  assert.equal(tx.swaps[0].input.amount, "5");
  assert.equal(tx.swaps[0].output.amount, "2.5");
  assert.equal(tx.transfers.length, 1);
  assert.equal(tx.transfers[0].amount, "0.5");
  assert.equal(tx.rawMovements.length, 3);
  assert.equal(tx.rawMovements.find((movement) => movement.outerIndex === 1).classification, "transfer");
  const outputMint = raw.meta.preTokenBalances.find((row) =>
    raw.transaction.message.accountKeys[row.accountIndex].pubkey === incoming.destination).mint;
  assert.equal(balance(report.transactions[0], outputMint).deltaRaw, "2000000");
  assert.equal(balance(report.transactions[0], outputMint).movementCheck.unexplainedDifferenceRaw, "0");
  assert.equal(report.summary.locallyReconciledSwapCandidates, 1);
  assert.equal(tx.routingEvidence.state, "not_observed");
  assert.deepEqual(tx.blockers, ["finality_unavailable"]);
});

test("deliberate residual is calculated from original values, never fabricated as a credit", async () => {
  const { result: raw } = await load("unexplained-difference");
  const indicated = BigInt(raw.transaction.message.instructions[0].parsed.info.lamports);
  const observed = nativeDelta(raw, EXAMPLE_WALLET);
  const difference = observed - (-indicated);
  assert.equal(indicated, 100000000n);
  assert.equal(observed, -90000000n);
  assert.equal(difference, 10000000n);
  const report = await inspectTeachingFixture(file("unexplained-difference"));
  const tx = report.transactions[0].economic;
  assert.equal(balance(report.transactions[0], "native").movementCheck.unexplainedDifferenceRaw,
    difference.toString());
  assert.ok(tx.blockers.includes("unexplained_balance_change"));
  assert.equal(tx.rawMovements.length, 1);
  assert.equal(tx.rawMovements[0].rawAmount, "100000000");
  assert.equal(tx.rawMovements[0].fromWallet, EXAMPLE_WALLET);
  assert.equal(tx.transfers.length, 1);
  assert.notEqual(tx.transfers[0].toWallet, EXAMPLE_WALLET);
  assert.equal(report.summary.transactionsWithEconomicLimitations, 1);
});

test("all teaching reports keep provenance/history/financial limitations", async () => {
  for (const slug of slugs) {
    const report = await inspectTeachingFixture(file(slug));
    assert.equal(report.version, "solana-inspection-v2");
    assert.equal(report.source, "user-supplied");
    assert.equal(Object.values(report.trust).every((value) => value === false), true);
    assert.equal(report.coverage.historyComplete, false);
    assert.equal(report.financial.pnlUsd, null);
    assert.equal(report.financial.returnPct, null);
    assert.equal(report.financial.state, "unavailable");
  }
});

test("HTML demonstrations are generated by the real CLI with identical economic objects", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "z7on synthetic examples "));
  try {
    const child = spawnSync(process.execPath, [path.join(root, "examples/generate-reports.mjs"),
      "--out-root", temporary], {
      cwd: root, encoding: "utf8", timeout: 120_000, windowsHide: true,
    });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    for (const slug of slugs) {
      const output = path.join(temporary, slug, "report");
      const emitted = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
      const direct = await inspectTeachingFixture(file(slug));
      // The CLI canonically serializes a payload; the teaching SDK recipe hashes
      // JSON.stringify(raw). Those caller-supplied byte bindings intentionally
      // differ. Compare every economic field and all other provenance fields.
      const economics = (report) => report.transactions.map(({ economic }) => {
        const { payloadSha256: _serializationHash, ...provenance } = economic.provenance;
        return { ...economic, provenance };
      });
      assert.deepEqual(economics(emitted), economics(direct));
      const html = await readFile(path.join(output, "report.html"), "utf8");
      assert.ok(html.includes("report.json"));
      assert.ok(html.includes("SYNTHETIC-"));
      assert.ok(html.includes("Content-Security-Policy"));
      assert.doesNotMatch(html, /<(?:script|iframe)[^>]+src=["']https?:/i);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
