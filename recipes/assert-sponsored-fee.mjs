import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { inspectSolanaEvidence } from "@z7onlabs/solana-inspector";

export const EXAMPLE_WALLET = "11111111111111111111111111111112";
export const EXAMPLE_SPONSOR = "11111111111111111111111111111113";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Trusted checked-in teaching fixture only, not an untrusted-file importer.
 * For user files use the bounded CLI or executeInspector from the /node SDK.
 * The payload hash binds this JSON serialization, not authenticity on chain.
 */
export async function inspectTeachingFixture(file) {
  const bytes = await readFile(file);
  const envelope = JSON.parse(bytes.toString("utf8"));
  assert.match(envelope._z7onExample, /^SYNTHETIC/);
  return inspectSolanaEvidence({
    walletAddress: EXAMPLE_WALLET,
    inputSha256: sha256(bytes),
    transactions: [{
      raw: envelope.result,
      payloadSha256: sha256(JSON.stringify(envelope.result)),
    }],
  });
}

/**
 * Application expectation, not new economic logic or a general audit.
 * @param {import("@z7onlabs/solana-inspector").SolanaInspectionReport} report
 * @param {{payerWallet: string, walletDeltaRaw: string}} expected
 */
export function assertSponsoredFee(report, expected = {
  payerWallet: EXAMPLE_SPONSOR,
  walletDeltaRaw: "-100000000",
}) {
  assert.equal(report.transactions.length, 1);
  const observation = report.transactions[0];
  const network = observation.economic.fees.filter((fee) => fee.kind === "network");
  assert.equal(network.length, 1);
  assert.equal(network[0].rawAmount, "5000", "network fee must be 5000 lamports");
  assert.equal(network[0].payerWallet, expected.payerWallet, "unexpected fee payer");
  assert.equal(network[0].chargedToAnalyzedWallet, false, "wallet must not pay sponsored fee");
  const balance = observation.economic.balanceEvidence.find((row) => row.asset.assetId === "native");
  assert.ok(balance?.movementCheck, "native movement check must be present");
  assert.equal(balance.movementCheck.observedDeltaRaw, expected.walletDeltaRaw, "unexpected wallet delta");
  assert.equal(balance.movementCheck.unexplainedDifferenceRaw, "0", "native movement check must reconcile");
  assert.equal(report.trust.authenticated, false);
  assert.equal(report.coverage.historyComplete, false);
  assert.equal(report.financial.pnlUsd, null);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await inspectTeachingFixture(new URL("../examples/sponsored-fee/input.json", import.meta.url));
  assertSponsoredFee(report);
  console.log("PASS: synthetic sponsor pays 5000 lamports; wallet sends 100000000 lamports; residual is zero. This does not authenticate a transaction.");
}
