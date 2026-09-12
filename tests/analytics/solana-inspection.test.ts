// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectSolanaEvidence,
  SOLANA_INSPECTION_LIMITS,
  SolanaInspectionInputError,
  type SolanaInspectionInput,
} from "../../src/analytics/solana/inspection";
import { normalizeSolanaTransaction } from "../../src/analytics/solana/normalize";
import { parseSolanaEconomicEvents } from "../../src/analytics/solana/economic";
import { SOLANA_LOCAL_PARSER_VERSION } from "../../src/analytics/solana/types";
import { SOLANA_LOCAL_LEDGER_VERSION } from "../../src/analytics/solana/ledger";
import { SPOT_ANALYTICS_VERSION } from "../../src/analytics/spot/version";
import {
  FOMO_SOLANA_FEE_OWNER,
  SOLANA_USDC_MINT,
} from "../../src/analytics/solana/route-constants";
import { SOLANA_SYSTEM_PROGRAM } from "../../src/analytics/solana/normalize";
import { solanaSwapFixture } from "../helpers/solana-economic";
import { inspectionRequirements } from "../../src/analytics/solana/inspection-requirements";

// Synthetic transactions only. A valid base58 public key is not proof of ownership.
const WALLET = "11111111111111111111111111111112";
const HASH = "a".repeat(64);
const INPUT_HASH = "b".repeat(64);

function native(
  options: {
    slot?: number;
    signature?: string;
    failed?: boolean;
    sponsor?: boolean;
  } = {},
) {
  const sponsor = options.sponsor ?? false;
  return {
    version: "legacy",
    slot: options.slot ?? 42,
    transactionIndex: 999,
    blockTime: 1_700_000_000,
    transaction: {
      signatures: [options.signature ?? "synthetic-native-transfer"],
      message: {
        accountKeys: [
          ...(sponsor ? [{ pubkey: "fixture-sponsor", signer: true }] : []),
          { pubkey: WALLET, signer: true },
          { pubkey: "fixture-recipient", signer: false },
        ],
        instructions: [
          {
            programId: SOLANA_SYSTEM_PROGRAM,
            program: "system",
            parsed: {
              type: "transfer",
              info: {
                source: WALLET,
                destination: "fixture-recipient",
                lamports: 100,
              },
            },
          },
        ],
      },
    },
    meta: {
      err: options.failed
        ? { InstructionError: [0, "InsufficientFunds"] }
        : null,
      fee: 5,
      preBalances: [...(sponsor ? [100] : []), 1_000, 100],
      postBalances: [
        ...(sponsor ? [95] : []),
        1_000 - (sponsor ? 0 : 5) - (options.failed ? 0 : 100),
        options.failed ? 100 : 200,
      ],
      preTokenBalances: [],
      postTokenBalances: [],
      innerInstructions: [],
    },
  };
}

function swap(fomo = true) {
  return JSON.parse(
    JSON.stringify(solanaSwapFixture({ sponsor: true }))
      .replaceAll("fixture-wallet", WALLET)
      .replaceAll(
        "fixture-fee-owner",
        fomo ? FOMO_SOLANA_FEE_OWNER : "other-app-owner",
      ),
  );
}

function input(...transactions: unknown[]): SolanaInspectionInput {
  return {
    walletAddress: WALLET,
    inputSha256: INPUT_HASH,
    transactions: transactions.map((raw) => ({ raw, payloadSha256: HASH })),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("experimental user-supplied Solana inspection", () => {
  it.each([false, true])(
    "exposes existing balance arithmetic without inventing fees (sponsor=%s)",
    (sponsor) => {
      const raw = native({ sponsor });
      raw.meta.postBalances[sponsor ? 1 : 0] += 55;
      const tx = inspectSolanaEvidence(input(raw)).transactions[0];
      const balance = tx.economic.balanceEvidence.find(
        (entry) => entry.asset.assetId === "native",
      );
      expect(balance?.movementCheck).toEqual({
        basis: "recognized-movements",
        recognizedDeltaRaw: "-100",
        paidNetworkFeeRaw: sponsor ? "0" : "5",
        expectedDeltaRaw: sponsor ? "-100" : "-105",
        observedDeltaRaw: sponsor ? "-45" : "-50",
        unexplainedDifferenceRaw: "55",
      });
      expect(tx.economic.blockers).toContain("unexplained_balance_change");
      expect(tx.economic.fees).toHaveLength(1);
      expect(tx.economic.fees[0].rawAmount).toBe("5");
      expect(tx.economic.fees[0].chargedToAnalyzedWallet).toBe(!sponsor);
      expect(
        tx.requirements.some(
          (entry) => entry.code === "unexplained_balance_change",
        ),
      ).toBe(true);
    },
  );

  it("does not turn incomplete observations into a zero residual", () => {
    const raw = native();
    raw.meta.postBalances = [];
    const tx = inspectSolanaEvidence(input(raw)).transactions[0];
    expect(
      tx.economic.balanceEvidence.every(
        (entry) => entry.movementCheck === undefined,
      ),
    ).toBe(true);
    expect(tx.economic.blockers.length).toBeGreaterThan(0);
  });

  it("uses the existing normalizer/parser without granting finality, history, prices or PnL", () => {
    const raw = native();
    const report = inspectSolanaEvidence(input(raw));
    const normalized = normalizeSolanaTransaction(raw, {
      source: "user-supplied",
      payloadSha256: HASH,
      commitment: "unknown",
      commitmentEvidence: "unknown",
    });
    normalized.transactionIndex = null;
    expect(report.transactions[0].normalized).toEqual(normalized);
    expect(report.transactions[0].economic).toEqual(
      parseSolanaEconomicEvents(normalized, {
        walletAddress: WALLET,
        transactionOrder: 0,
      }),
    );
    expect(report.version).toBe("solana-inspection-v2");
    expect(report.methodology).toEqual({
      parserVersion: SOLANA_LOCAL_PARSER_VERSION,
      ledgerVersion: SOLANA_LOCAL_LEDGER_VERSION,
      costEngineVersion: SPOT_ANALYTICS_VERSION,
    });
    expect(Object.values(report.trust)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(report.coverage).toEqual({
      historyComplete: false,
      tokenAccountHistoryComplete: false,
      scope: "supplied-transactions-only",
    });
    expect(report.financial).toMatchObject({
      pnlUsd: null,
      returnPct: null,
      state: "unavailable",
    });
    expect(report.transactions[0].economic.blockers).toContain(
      "finality_unavailable",
    );
    expect(report.transactions[0].limitations).toContain(
      "supplied_transaction_index_not_trusted",
    );
  });

  it("preserves exact token amounts, recognized Fomo fee evidence, and sponsor fee separation", () => {
    const report = inspectSolanaEvidence(input(swap()));
    const tx = report.transactions[0].economic;
    expect(tx.swaps).toHaveLength(1);
    expect(tx.swaps[0].input).toMatchObject({
      asset: { assetId: SOLANA_USDC_MINT },
      amount: "5",
    });
    expect(
      tx.rawMovements.some((movement) => movement.rawAmount === "2500000"),
    ).toBe(true);
    expect(tx.routingEvidence.state).toBe("fomo_routed");
    expect(tx.fees.find((fee) => fee.kind === "network")).toMatchObject({
      rawAmount: "5000",
      chargedToAnalyzedWallet: false,
    });
    expect(report.financial.pnlUsd).toBeNull();
  });

  it("does not call another app Fomo or admit an opaque swap program", () => {
    const tx = inspectSolanaEvidence(input(swap(false))).transactions[0]
      .economic;
    expect(tx.routingEvidence.state).not.toBe("fomo_routed");
    expect(tx.swaps).toHaveLength(0);
    expect(tx.blockers).toContain("instruction_effect_unsupported");
  });

  it("separates locally reconciled swap candidates from economic limitations without confirming them", () => {
    const complete = swap();
    const unexplainedBalance = swap();
    unexplainedBalance.slot += 1;
    unexplainedBalance.transaction.signatures = ["synthetic-swap-balance-gap"];
    unexplainedBalance.meta.postBalances[1] -= 5;
    const report = inspectSolanaEvidence(input(complete, unexplainedBalance));
    expect(report.summary).toMatchObject({
      swapCandidates: 2,
      locallyReconciledSwapCandidates: 1,
      transactionsWithLimitations: 2,
      transactionsWithEconomicLimitations: 1,
    });
    expect(report.summary).not.toHaveProperty("reconstructedSwaps");
    expect(report.transactions[0].economic.blockers).toEqual([
      "finality_unavailable",
    ]);
    expect(report.transactions[1].economic.blockers).toEqual(
      expect.arrayContaining([
        "finality_unavailable",
        "unexplained_balance_change",
      ]),
    );
    expect(
      report.transactions.every((tx) => tx.economic.state === "partial"),
    ).toBe(true);
    expect(report.trust.authenticated).toBe(false);
    expect(report.trust.finalityVerified).toBe(false);
    expect(report.coverage.historyComplete).toBe(false);
    expect(report.financial.pnlUsd).toBeNull();
  });

  it("does not count duplicate candidates twice or dismiss order blockers as provenance", () => {
    const first = swap();
    const second = swap();
    second.transaction.signatures = ["synthetic-swap-same-slot"];
    const report = inspectSolanaEvidence(input(first, first, second));
    expect(report.summary).toMatchObject({
      uniqueTransactions: 2,
      duplicateTransactions: 1,
      swapCandidates: 2,
      locallyReconciledSwapCandidates: 0,
      transactionsWithLimitations: 2,
      transactionsWithEconomicLimitations: 2,
    });
    expect(
      report.transactions.every((tx) =>
        tx.economic.blockers.includes("transaction_order_unproven"),
      ),
    ).toBe(true);
    expect(report.sample.state).toBe("blocked");
  });

  it("adds evidence guidance for every blocker without changing the underlying economic result", () => {
    const raw = native();
    raw.meta.postBalances[0] += 1;
    const report = inspectSolanaEvidence(input(raw));
    const tx = report.transactions[0];
    expect(tx.requirements.map((item) => item.code)).toEqual(
      tx.economic.blockers,
    );
    expect(tx.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "finality_unavailable",
          neededEvidence: expect.stringContaining("User-supplied JSON"),
        }),
        expect.objectContaining({
          code: "unexplained_balance_change",
          neededEvidence: expect.stringContaining(
            "without inventing a transfer or fee",
          ),
        }),
      ]),
    );
    expect(tx.economic).toEqual(
      parseSolanaEconomicEvents(tx.normalized, {
        walletAddress: WALLET,
        transactionOrder: 0,
      }),
    );
  });

  it.each([
    ["transaction_order_unproven", "block position"],
    ["economic_instruction_order_unproven", "inner instruction"],
    ["token_2022_extension_state_unproven", "transfer-hook"],
    [
      "token_2022_transfer_difference_unexplained",
      "Do not assume the difference is a fee",
    ],
    ["instruction_effect_unsupported", "Official instruction semantics"],
    ["token_account_owner_unknown", "Historical ownership"],
    ["token_account_owner_changed", "Close authority"],
    ["future_unknown_blocker", "No specific resolution is established"],
    ["constructor", "No specific resolution is established"],
  ])(
    "explains missing evidence for %s without claiming it is resolved",
    (code, detail) => {
      const codes = [code, code];
      expect(inspectionRequirements(codes)).toEqual([
        { code, neededEvidence: expect.stringContaining(detail) },
      ]);
      expect(codes).toEqual([code, code]);
    },
  );

  it("orders distinct supplied slots only, never trusting supplied transactionIndex", () => {
    const early = native({ slot: 10, signature: "early" });
    const late = native({ slot: 20, signature: "late" });
    const report = inspectSolanaEvidence(input(late, early));
    expect(report.sample).toMatchObject({
      state: "available",
      orderBasis: "supplied-slot-only",
    });
    expect(
      report.transactions.map((tx) => tx.normalized.transactionIndex),
    ).toEqual([null, null]);
    expect(report.transactions[0].economic.transfers[0].eventOrder).toBe(1);
    expect(report.transactions[1].economic.transfers[0].eventOrder).toBe(0);
    expect(report.trust.chainOrderVerified).toBe(false);
  });

  it("blocks same-slot aggregation even with different caller indices, preserving both transaction details", () => {
    const first = native({ signature: "one" });
    const second = native({ signature: "two" });
    second.transactionIndex = 1000;
    const report = inspectSolanaEvidence(input(first, second));
    expect(report.sample).toMatchObject({
      state: "blocked",
      orderBasis: "unavailable",
      accountInventory: [],
      quantityReconciliation: [],
    });
    expect(report.sample.reasons).toContain("same_slot_order_unproven");
    expect(report.transactions).toHaveLength(2);
    expect(
      report.transactions.every((tx) => tx.economic.rawMovements.length === 1),
    ).toBe(true);
    expect(
      report.transactions.every((tx) => tx.economic.orderProven === false),
    ).toBe(true);
  });

  it("reuses account continuity for supplied observations without claiming financial reconciliation", () => {
    const early = native({ slot: 10, signature: "continuity-early" });
    const late = native({ slot: 20, signature: "continuity-late" });
    late.meta.preBalances = [895, 200];
    late.meta.postBalances = [790, 300];
    const report = inspectSolanaEvidence(input(late, early));
    expect(report.sample.accountInventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          address: WALLET,
          rawAmount: "790",
          slot: 20,
        }),
      ]),
    );
    expect(
      report.sample.issues.some(
        (issue) => issue.code === "account_balance_discontinuity",
      ),
    ).toBe(false);
    expect(
      report.sample.quantityReconciliation.every(
        (item) => item.state === "unresolved",
      ),
    ).toBe(true);
    expect(report.financial.pnlUsd).toBeNull();
    late.meta.preBalances[0] = 900;
    const contradicted = inspectSolanaEvidence(input(early, late));
    expect(
      contradicted.sample.issues.some(
        (issue) => issue.code === "account_balance_discontinuity",
      ),
    ).toBe(true);
  });

  it("preserves missing-time details without inventing timestamps or complete history", () => {
    const raw = { ...native(), blockTime: null };
    const report = inspectSolanaEvidence(input(raw));
    expect(report.transactions[0].normalized.blockTime).toBeNull();
    expect(report.transactions[0].economic.rawMovements).toHaveLength(1);
    expect(report.transactions[0].economic.blockers).toContain(
      "block_time_unavailable",
    );
    expect(report.financial.pnlUsd).toBeNull();
  });

  it("blocks aggregation when a slot is absent", () => {
    const report = inspectSolanaEvidence(input({ ...native(), slot: null }));
    expect(report.sample.state).toBe("blocked");
    expect(report.sample.reasons).toContain("transaction_slot_unavailable");
    expect(report.transactions).toHaveLength(1);
  });

  it("deduplicates identical supplied records without double-counting their movements", () => {
    const report = inspectSolanaEvidence(input(native(), native()));
    expect(report.summary).toMatchObject({
      suppliedTransactions: 2,
      uniqueTransactions: 1,
      duplicateTransactions: 1,
      observedMovements: 1,
    });
    expect(report.transactions[1].duplicateOfInputIndex).toBe(0);
    expect(report.sample.state).toBe("available");
  });

  it("does not accept matching caller hashes as proof that conflicting records are identical", () => {
    const altered = native();
    altered.meta.fee = 10;
    const report = inspectSolanaEvidence(input(native(), altered));
    expect(report.summary.conflictingSignatures).toBe(1);
    expect(report.summary.duplicateTransactions).toBe(0);
    expect(report.summary).toMatchObject({
      suppliedTransactions: 2,
      uniqueTransactions: 1,
      distinctRevisions: 2,
      conflictedObservations: 2,
      unidentifiedObservations: 0,
      eligibleTransactions: 0,
      excludedObservations: 2,
      observedMovements: 0,
      transactionsWithLimitations: 0,
      transactionsWithEconomicLimitations: 0,
    });
    expect(report.sample.state).toBe("blocked");
    expect(report.sample.reasons).toContain("conflicting_transaction_revision");
    expect(
      report.transactions.every((tx) =>
        tx.limitations.includes("conflicting_transaction_revision"),
      ),
    ).toBe(true);
  });

  it("deduplicates the second revision in A, B, B while excluding every conflicted observation", () => {
    const a = swap();
    const b = swap();
    b.meta.fee += 1;
    const report = inspectSolanaEvidence(input(a, b, b));
    expect(report.summary).toMatchObject({
      suppliedTransactions: 3,
      uniqueTransactions: 1,
      distinctRevisions: 2,
      duplicateTransactions: 1,
      conflictingSignatures: 1,
      conflictedObservations: 3,
      eligibleTransactions: 0,
      excludedObservations: 3,
      swapCandidates: 0,
      locallyReconciledSwapCandidates: 0,
      observedMovements: 0,
    });
    expect(report.transactions).toHaveLength(3);
    expect(report.transactions.map((tx) => tx.duplicateOfInputIndex)).toEqual([
      null,
      null,
      1,
    ]);
    expect(report.transactions.map((tx) => tx.identityFirstInputIndex)).toEqual(
      [0, 0, 0],
    );
    expect(
      report.transactions.map(
        (tx) => tx.inclusion.countedInIdentifiedTransactions,
      ),
    ).toEqual([true, false, false]);
    expect(report.transactions[2].inclusion).toMatchObject({
      includedInEconomicTotals: false,
      exclusionReasons: [
        "exact_duplicate_observation",
        "conflicting_transaction_revision",
      ],
    });
    for (const tx of report.transactions) {
      expect(tx.inclusion.includedInEconomicTotals).toBe(false);
      expect(tx.economic.rawMovements.length).toBeGreaterThan(0);
      expect(tx.requirements).toContainEqual(
        expect.objectContaining({ code: "conflicting_transaction_revision" }),
      );
    }
    expect(report.sample.state).toBe("blocked");
    expect(report.financial.pnlUsd).toBeNull();
  });

  it.each([
    [0, 1, 0, 1],
    [1, 0, 1, 0],
  ])(
    "keeps a conflicting identity excluded regardless of revision order %s",
    (...order) => {
      const a = native();
      const b = native();
      b.meta.fee += 1;
      const report = inspectSolanaEvidence(
        input(...order.map((index) => [a, b][index])),
      );
      expect(report.summary).toMatchObject({
        suppliedTransactions: 4,
        uniqueTransactions: 1,
        distinctRevisions: 2,
        duplicateTransactions: 2,
        conflictingSignatures: 1,
        conflictedObservations: 4,
        eligibleTransactions: 0,
        excludedObservations: 4,
        observedMovements: 0,
      });
      expect(report.transactions.map((tx) => tx.duplicateOfInputIndex)).toEqual(
        [null, null, 0, 1],
      );
    },
  );

  it("deduplicates equal raw content despite discordant unverified payload hashes", () => {
    const a = native();
    const reordered = Object.fromEntries(Object.entries(a).reverse());
    const supplied: SolanaInspectionInput = {
      ...input(a),
      transactions: [
        { raw: a, payloadSha256: HASH },
        { raw: reordered, payloadSha256: "c".repeat(64) },
      ],
    };
    const report = inspectSolanaEvidence(supplied);
    expect(report.summary).toMatchObject({
      uniqueTransactions: 1,
      distinctRevisions: 1,
      duplicateTransactions: 1,
      conflictingSignatures: 0,
      eligibleTransactions: 1,
      excludedObservations: 1,
      observedMovements: 1,
    });
    expect(report.transactions[1].duplicateOfInputIndex).toBe(0);
    expect(report.transactions.map((tx) => tx.payloadSha256)).toEqual([
      HASH,
      "c".repeat(64),
    ]);
    expect(
      report.transactions.map((tx) => tx.normalized.provenance.payloadSha256),
    ).toEqual([HASH, "c".repeat(64)]);
    expect(report.transactions[1].inclusion.exclusionReasons).toEqual([
      "exact_duplicate_observation",
    ]);
    expect(report.trust.hashesVerified).toBe(false);
  });

  it("preserves missing-identity observations and repeats without counting them as identified or economic activity", () => {
    const missing = native();
    missing.transaction.signatures = [];
    const changedMissing = structuredClone(missing);
    changedMissing.meta.fee += 1;
    const report = inspectSolanaEvidence(
      input(missing, missing, changedMissing),
    );
    expect(report.summary).toMatchObject({
      suppliedTransactions: 3,
      uniqueTransactions: 0,
      distinctRevisions: 2,
      duplicateTransactions: 1,
      conflictingSignatures: 0,
      conflictedObservations: 0,
      unidentifiedObservations: 3,
      eligibleTransactions: 0,
      excludedObservations: 3,
      observedMovements: 0,
    });
    expect(report.transactions).toHaveLength(3);
    expect(report.transactions[1].duplicateOfInputIndex).toBe(0);
    for (const tx of report.transactions) {
      expect(tx.identityFirstInputIndex).toBeNull();
      expect(tx.inclusion.countedInIdentifiedTransactions).toBe(false);
      expect(tx.inclusion.includedInEconomicTotals).toBe(false);
      expect(tx.inclusion.exclusionReasons).toContain(
        "transaction_identity_unavailable",
      );
      expect(tx.economic.rawMovements).toHaveLength(1);
    }
    expect(report.sample.reasons).toContain("transaction_identity_unavailable");
    expect(report.sample.accountInventory).toEqual([]);
  });

  it("counts eligible records separately from conflicts and missing identities without laundering economic blockers", () => {
    const a = native({ signature: "conflict", slot: 10 });
    const b = structuredClone(a);
    b.meta.fee += 1;
    const eligible = native({ signature: "eligible", slot: 20 });
    const missing = native({ slot: 30 });
    missing.transaction.signatures = [];
    const report = inspectSolanaEvidence(input(a, b, b, eligible, missing));
    expect(report.summary).toMatchObject({
      suppliedTransactions: 5,
      uniqueTransactions: 2,
      distinctRevisions: 4,
      duplicateTransactions: 1,
      conflictingSignatures: 1,
      conflictedObservations: 3,
      unidentifiedObservations: 1,
      eligibleTransactions: 1,
      excludedObservations: 4,
      observedMovements: 1,
      transactionsWithLimitations: 1,
      transactionsWithEconomicLimitations: 1,
    });
    expect(report.transactions[3].inclusion).toEqual({
      countedInIdentifiedTransactions: true,
      includedInEconomicTotals: true,
      exclusionReasons: [],
    });
    expect(report.transactions[3].economic.blockers).toContain(
      "transaction_order_unproven",
    );
    expect(report.sample.state).toBe("blocked");
    expect(report.coverage.historyComplete).toBe(false);
    expect(report.financial.pnlUsd).toBeNull();
  });

  it("retains exact shared-parser results for ordinary distinct signatures", () => {
    const raws = [
      native({ signature: "early", slot: 10, sponsor: true }),
      native({ signature: "late", slot: 20, failed: true }),
    ];
    const report = inspectSolanaEvidence(input(...raws));
    raws.forEach((raw, index) => {
      const normalized = normalizeSolanaTransaction(raw, {
        source: "user-supplied",
        payloadSha256: HASH,
        commitment: "unknown",
        commitmentEvidence: "unknown",
      });
      normalized.transactionIndex = null;
      expect(report.transactions[index].economic).toEqual(
        parseSolanaEconomicEvents(normalized, {
          walletAddress: WALLET,
          transactionOrder: index,
        }),
      );
    });
    expect(report.summary).toMatchObject({
      uniqueTransactions: 2,
      eligibleTransactions: 2,
      excludedObservations: 0,
    });
  });

  it("keeps failed transaction fees without treating attempted transfers as completed", () => {
    const tx = inspectSolanaEvidence(
      input(native({ failed: true, sponsor: true })),
    ).transactions[0].economic;
    expect(tx.succeeded).toBe(false);
    expect(tx.transfers).toHaveLength(0);
    expect(tx.fees[0]).toMatchObject({
      kind: "network",
      chargedToAnalyzedWallet: false,
    });
  });

  it("does not mutate input or share raw instruction objects with the result", () => {
    const raw = native();
    const before = JSON.stringify(raw);
    const report = inspectSolanaEvidence(input(raw));
    expect(JSON.stringify(raw)).toBe(before);
    raw.transaction.message.instructions[0].parsed.info.lamports = 77;
    expect(
      report.transactions[0].normalized.instructions[0].info?.lamports,
    ).toBe(100);
  });

  it("is byte-identical for repeated inputs and never invokes network capabilities", () => {
    const network = vi.fn(() => {
      throw new Error("Network forbidden");
    });
    vi.stubGlobal("fetch", network);
    vi.stubGlobal("WebSocket", network);
    const original = input(native(), swap());
    expect(JSON.stringify(inspectSolanaEvidence(original))).toBe(
      JSON.stringify(inspectSolanaEvidence(original)),
    );
    expect(network).not.toHaveBeenCalled();
  });

  it.each([
    "historyComplete",
    "tokenAccountHistoryComplete",
    "prices",
    "ownedWallets",
    "feeOwner",
    "feeTokenAccounts",
    "supportedSwapPrograms",
    "transactionOrder",
  ])("rejects public policy override %s", (key) => {
    expect(() =>
      inspectSolanaEvidence({ ...input(native()), [key]: true }),
    ).toThrow(SolanaInspectionInputError);
  });

  it("ignores trust claims nested in the raw provider object", () => {
    const report = inspectSolanaEvidence(
      input({
        ...native(),
        commitment: "finalized",
        historyComplete: true,
        ownedWallets: ["another-wallet"],
        prices: [{ priceUsd: "1" }],
      }),
    );
    expect(report.transactions[0].normalized.provenance.commitment).toBe(
      "unknown",
    );
    expect(report.financial.pnlUsd).toBeNull();
    expect(report.coverage.historyComplete).toBe(false);
  });

  it.each([
    "",
    WALLET.toLowerCase().replace("2", "0"),
    "1".repeat(31),
    "1".repeat(33),
    ` ${WALLET}`,
    `${WALLET} `,
  ])("rejects invalid or transformed wallet %s", (walletAddress) => {
    expect(() =>
      inspectSolanaEvidence({ ...input(native()), walletAddress }),
    ).toThrow("invalid_wallet");
  });

  it.each(["", "a".repeat(63), "A".repeat(64), "g".repeat(64)])(
    "rejects malformed hashes %s",
    (value) => {
      expect(() =>
        inspectSolanaEvidence({ ...input(native()), inputSha256: value }),
      ).toThrow("invalid_hash");
      expect(() =>
        inspectSolanaEvidence({
          ...input(native()),
          transactions: [{ raw: native(), payloadSha256: value }],
        }),
      ).toThrow("invalid_hash");
    },
  );

  it("rejects unknown per-entry keys, empty input and non-object raw values", () => {
    expect(() => inspectSolanaEvidence(input())).toThrow("invalid_input");
    expect(() => inspectSolanaEvidence(input(null))).toThrow("invalid_input");
    expect(() =>
      inspectSolanaEvidence({
        ...input(native()),
        transactions: [{ raw: native(), payloadSha256: HASH, coverage: true }],
      } as unknown as SolanaInspectionInput),
    ).toThrow("invalid_input");
  });

  it("rejects accessors, cyclic objects, sparse arrays and non-JSON values without executing getters", () => {
    const getter = vi.fn(() => native());
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const sparse = new Array(2);
    for (const raw of [
      Object.defineProperty({}, "value", { enumerable: true, get: getter }),
      cycle,
      { x: BigInt(1) },
      { x: undefined },
      { x: sparse },
      { x: new Date() },
    ]) {
      expect(() => inspectSolanaEvidence(input(raw))).toThrow("invalid_input");
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects resource limits rather than silently truncating", () => {
    expect(() =>
      inspectSolanaEvidence({
        ...input(native()),
        transactions: Array.from(
          { length: SOLANA_INSPECTION_LIMITS.transactions + 1 },
          () => ({ raw: native(), payloadSha256: HASH }),
        ),
      }),
    ).toThrow("input_limit_exceeded");
    let raw: unknown = native();
    for (let i = 0; i < 40; i++) raw = { nested: raw };
    expect(() => inspectSolanaEvidence(input(raw))).toThrow(
      "input_limit_exceeded",
    );
    expect(() =>
      inspectSolanaEvidence(
        input({
          ...native(),
          log: "x".repeat(SOLANA_INSPECTION_LIMITS.stringCharacters + 1),
        }),
      ),
    ).toThrow("input_limit_exceeded");
  });

  it("preserves unsafe-quantity blockers instead of laundering rounded JSON numbers into evidence", () => {
    const raw = native();
    raw.meta.preBalances[0] = Number.MAX_SAFE_INTEGER + 1;
    const report = inspectSolanaEvidence(input(raw));
    expect(report.transactions[0].normalized.blockers).toContain(
      "native_balance_unknown_or_unsafe",
    );
    expect(report.financial.pnlUsd).toBeNull();
  });

  it("rejects excessive cumulative JSON nodes even when each array fits its individual cap", () => {
    const rows =
      Math.ceil(
        SOLANA_INSPECTION_LIMITS.nodes / SOLANA_INSPECTION_LIMITS.arrayLength,
      ) + 1;
    const nodes = Array.from({ length: rows }, () =>
      Array.from({ length: SOLANA_INSPECTION_LIMITS.arrayLength }, () => null),
    );
    expect(() => inspectSolanaEvidence(input({ ...native(), nodes }))).toThrow(
      "input_limit_exceeded",
    );
  });
});
