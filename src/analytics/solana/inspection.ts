import { isSolanaAddress } from "../../lib/wallet-address";
import { parseSolanaEconomicEvents } from "./economic";
import { analyzeSolanaLedger, SOLANA_LOCAL_LEDGER_VERSION } from "./ledger";
import { normalizeSolanaTransaction } from "./normalize";
import { SOLANA_LOCAL_PARSER_VERSION } from "./types";
import { SPOT_ANALYTICS_VERSION } from "../spot/version";
import { inspectionRequirements } from "./inspection-requirements";
import type {
  SolanaInspectionInput,
  SolanaInspectionReport,
  SolanaInspectionTransaction,
} from "./inspection-types";

export type {
  SolanaInspectionInput,
  SolanaInspectionReport,
  SolanaInspectionTransaction,
} from "./inspection-types";

/** Structural ceilings supplement, rather than replace, the host's byte/time limits. */
export const SOLANA_INSPECTION_LIMITS = Object.freeze({
  transactions: 1_000,
  depth: 32,
  nodes: 1_000_000,
  arrayLength: 10_000,
  stringCharacters: 1_048_576,
  totalStringCharacters: 16_777_216,
});

export class SolanaInspectionInputError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "invalid_wallet"
      | "invalid_hash"
      | "input_limit_exceeded",
  ) {
    super(`Solana inspection rejected input: ${code}.`);
    this.name = "SolanaInspectionInputError";
  }
}

function fail(code: SolanaInspectionInputError["code"]): never {
  throw new SolanaInspectionInputError(code);
}

/** No getters, custom prototypes or non-JSON values are admitted by the SDK. */
function properties(value: unknown): Record<string, PropertyDescriptor> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length
  )
    return fail("invalid_input");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) => !("value" in descriptor) || !descriptor.enumerable,
    )
  )
    return fail("invalid_input");
  return descriptors;
}

function shape(value: unknown, keys: readonly string[]) {
  const descriptors = properties(value);
  if (
    Object.keys(descriptors).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(descriptors, key))
  )
    return fail("invalid_input");
  return Object.fromEntries(
    keys.map((key) => [key, descriptors[key].value as unknown]),
  );
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    return fail("invalid_hash");
  return value;
}

function jsonCopier() {
  let nodes = 0;
  let characters = 0;
  const ancestors = new Set<object>();
  const checkText = (text: string) => {
    characters += text.length;
    if (
      text.length > SOLANA_INSPECTION_LIMITS.stringCharacters ||
      characters > SOLANA_INSPECTION_LIMITS.totalStringCharacters
    )
      fail("input_limit_exceeded");
  };
  const copy = (value: unknown, depth = 0): unknown => {
    if (
      ++nodes > SOLANA_INSPECTION_LIMITS.nodes ||
      depth > SOLANA_INSPECTION_LIMITS.depth
    )
      return fail("input_limit_exceeded");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      checkText(value);
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return fail("invalid_input");
      // Unsafe quantities are rejected by the existing normalizer, never rounded here.
      return value;
    }
    if (typeof value !== "object") return fail("invalid_input");
    if (ancestors.has(value)) return fail("invalid_input");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > SOLANA_INSPECTION_LIMITS.arrayLength)
          return fail("input_limit_exceeded");
        const descriptors = Object.getOwnPropertyDescriptors(value);
        if (
          Object.getPrototypeOf(value) !== Array.prototype ||
          Object.getOwnPropertySymbols(value).length ||
          Object.keys(descriptors).length !== value.length + 1
        )
          return fail("invalid_input");
        return Array.from({ length: value.length }, (_, index) => {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
            return fail("invalid_input");
          return copy(descriptor.value, depth + 1);
        });
      }
      const descriptors = properties(value);
      // Sorting also gives duplicate comparison a stable, locale-independent shape.
      return Object.fromEntries(
        Object.keys(descriptors)
          .sort()
          .map((key) => {
            checkText(key);
            return [key, copy(descriptors[key].value, depth + 1)];
          }),
      );
    } finally {
      ancestors.delete(value);
    }
  };
  return copy;
}

const FINANCIAL_REASONS = [
  "user_supplied_evidence_unauthenticated",
  "wallet_history_incomplete",
  "historical_token_account_universe_unproven",
  "historical_valuation_not_supplied",
];

/** Reporting distinction only: the original blocker and parser state stay intact. */
const hasEconomicLimitations = (tx: SolanaInspectionTransaction): boolean =>
  tx.economic.blockers.some((code) => code !== "finality_unavailable");

/**
 * Experimental, deterministic inspection of user-supplied JSON. This is not
 * chain verification, a coverage certificate or a way to override ledger gates.
 * The host verifies file hashes and enforces wall-clock/memory/byte budgets.
 */
export function inspectSolanaEvidence(
  input: SolanaInspectionInput,
): SolanaInspectionReport {
  const outer = shape(input, ["walletAddress", "transactions", "inputSha256"]);
  if (
    typeof outer.walletAddress !== "string" ||
    !isSolanaAddress(outer.walletAddress)
  )
    return fail("invalid_wallet");
  const walletAddress = outer.walletAddress;
  const inputSha256 = hash(outer.inputSha256);
  if (!Array.isArray(outer.transactions) || outer.transactions.length === 0)
    return fail("invalid_input");
  if (outer.transactions.length > SOLANA_INSPECTION_LIMITS.transactions)
    return fail("input_limit_exceeded");
  const copy = jsonCopier();
  const supplied = copy(outer.transactions) as unknown[];
  const entries = supplied.map((value, inputIndex) => {
    const entry = shape(value, ["raw", "payloadSha256"]);
    const payloadSha256 = hash(entry.payloadSha256);
    const raw = entry.raw;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
      return fail("invalid_input");
    const normalized = normalizeSolanaTransaction(raw, {
      source: "user-supplied",
      payloadSha256,
      commitment: "unknown",
      commitmentEvidence: "unknown",
    });
    const claimedIndex = normalized.transactionIndex !== null;
    // Standard getTransaction does not prove block position. Never accept a
    // caller-added transactionIndex or an input-array index as chain evidence.
    normalized.transactionIndex = null;
    return {
      inputIndex,
      payloadSha256,
      normalized,
      comparison: JSON.stringify(raw),
      claimedIndex,
      duplicateOfInputIndex: null as number | null,
    };
  });

  const identities = new Map<string, number>();
  const revisions = new Map<string, Set<string>>();
  const rawRecords = new Map<string, number>();
  const conflicts = new Set<string>();
  for (const entry of entries) {
    // Content, not a caller's unverified hash, identifies an exact observation.
    // Compare against every earlier revision, so A, B, B repeats B, not A.
    const previous = rawRecords.get(entry.comparison);
    if (previous !== undefined) entry.duplicateOfInputIndex = previous;
    else rawRecords.set(entry.comparison, entry.inputIndex);
    const signature = entry.normalized.signature;
    if (!signature) continue;
    if (!identities.has(signature)) identities.set(signature, entry.inputIndex);
    const seen = revisions.get(signature) ?? new Set<string>();
    seen.add(entry.comparison);
    revisions.set(signature, seen);
    if (seen.size > 1) conflicts.add(signature);
  }
  const unique = entries.filter(
    (entry) => entry.duplicateOfInputIndex === null,
  );
  const reasons: string[] = [];
  if (conflicts.size) reasons.push("conflicting_transaction_revision");
  if (unique.some((entry) => !entry.normalized.signature))
    reasons.push("transaction_identity_unavailable");
  if (unique.some((entry) => entry.normalized.slot === null))
    reasons.push("transaction_slot_unavailable");
  if (
    new Set(unique.map((entry) => entry.normalized.slot)).size !== unique.length
  )
    reasons.push("same_slot_order_unproven");
  const ordered = reasons.length === 0;
  const ordinal = new Map(
    [...unique]
      .sort((a, b) => (a.normalized.slot ?? 0) - (b.normalized.slot ?? 0))
      .map((entry, index) => [entry.inputIndex, index]),
  );
  const transactions: SolanaInspectionTransaction[] = entries.map((entry) => {
    const signature = entry.normalized.signature;
    const identityFirstInputIndex = signature
      ? (identities.get(signature) ?? null)
      : null;
    const exclusionReasons: SolanaInspectionTransaction["inclusion"]["exclusionReasons"] =
      [];
    if (entry.duplicateOfInputIndex !== null)
      exclusionReasons.push("exact_duplicate_observation");
    if (signature && conflicts.has(signature))
      exclusionReasons.push("conflicting_transaction_revision");
    if (!signature) exclusionReasons.push("transaction_identity_unavailable");
    const economic = parseSolanaEconomicEvents(entry.normalized, {
      walletAddress,
      ...(ordered
        ? {
            transactionOrder: ordinal.get(
              entry.duplicateOfInputIndex ?? entry.inputIndex,
            ),
          }
        : {}),
    });
    return {
      inputIndex: entry.inputIndex,
      payloadSha256: entry.payloadSha256,
      identityFirstInputIndex,
      duplicateOfInputIndex: entry.duplicateOfInputIndex,
      inclusion: {
        countedInIdentifiedTransactions:
          identityFirstInputIndex === entry.inputIndex,
        includedInEconomicTotals: exclusionReasons.length === 0,
        exclusionReasons,
      },
      normalized: entry.normalized,
      economic,
      requirements: inspectionRequirements([
        ...economic.blockers,
        ...exclusionReasons,
      ]),
      limitations: [
        "user_supplied_evidence_unauthenticated",
        ...(entry.claimedIndex
          ? ["supplied_transaction_index_not_trusted"]
          : []),
        ...exclusionReasons,
      ],
    };
  });
  const eligibleTransactions = transactions.filter(
    (tx) => tx.inclusion.includedInEconomicTotals,
  );
  const ledger = ordered
    ? analyzeSolanaLedger({
        walletAddress,
        transactions: eligibleTransactions.map((tx) => tx.economic),
        prices: [],
        coverage: {
          historyComplete: false,
          tokenAccountHistoryComplete: false,
          discontinuityCount: 0,
          proofSha256: [],
        },
      })
    : null;
  return {
    version: "solana-inspection-v2",
    methodology: {
      parserVersion: SOLANA_LOCAL_PARSER_VERSION,
      ledgerVersion: SOLANA_LOCAL_LEDGER_VERSION,
      costEngineVersion: SPOT_ANALYTICS_VERSION,
    },
    walletAddress,
    source: "user-supplied",
    inputSha256,
    trust: {
      authenticated: false,
      hashesVerified: false,
      finalityVerified: false,
      ownershipVerified: false,
      chainOrderVerified: false,
    },
    coverage: {
      historyComplete: false,
      tokenAccountHistoryComplete: false,
      scope: "supplied-transactions-only",
    },
    financial: {
      pnlUsd: null,
      returnPct: null,
      state: "unavailable",
      reasons: [...FINANCIAL_REASONS],
    },
    summary: {
      suppliedTransactions: entries.length,
      uniqueTransactions: identities.size,
      duplicateTransactions: entries.length - unique.length,
      distinctRevisions: unique.length,
      conflictingSignatures: conflicts.size,
      conflictedObservations: transactions.filter((tx) =>
        tx.inclusion.exclusionReasons.includes(
          "conflicting_transaction_revision",
        ),
      ).length,
      unidentifiedObservations: transactions.filter((tx) =>
        tx.inclusion.exclusionReasons.includes(
          "transaction_identity_unavailable",
        ),
      ).length,
      eligibleTransactions: eligibleTransactions.length,
      excludedObservations: entries.length - eligibleTransactions.length,
      swapCandidates: eligibleTransactions.reduce(
        (count, tx) => count + tx.economic.swaps.length,
        0,
      ),
      locallyReconciledSwapCandidates: eligibleTransactions.reduce(
        (count, tx) =>
          count + (hasEconomicLimitations(tx) ? 0 : tx.economic.swaps.length),
        0,
      ),
      observedMovements: eligibleTransactions.reduce(
        (count, tx) => count + tx.economic.rawMovements.length,
        0,
      ),
      transactionsWithLimitations: eligibleTransactions.filter(
        (tx) => tx.economic.blockers.length > 0,
      ).length,
      transactionsWithEconomicLimitations: eligibleTransactions.filter(
        hasEconomicLimitations,
      ).length,
    },
    transactions,
    sample: {
      state: ordered ? "available" : "blocked",
      orderBasis: ordered ? "supplied-slot-only" : "unavailable",
      accountInventory: ledger?.accountInventory ?? [],
      quantityReconciliation: ledger?.quantityReconciliation ?? [],
      issues: ledger?.issues ?? [],
      reasons,
    },
    limitations: [
      "This is an experimental interpretation of supplied JSON, not independently verified chain data.",
      "Hashes identify supplied content; this pure API does not verify original bytes or authenticity.",
      "Order and ownership inside these records are unauthenticated observations, not proof of complete wallet history.",
      "Protocol recognition and Fomo routing are separate; unsupported instructions remain limited.",
      "Account continuity covers supplied observations only; balances are not a current or complete portfolio.",
      "Identity counts use distinct supplied signatures, not signature validation. Conflicted revisions, missing identities and exact duplicate observations remain visible but are excluded from economic totals.",
    ],
  };
}
