import type { SolanaLedgerReport } from "./ledger";
import type { SOLANA_LOCAL_LEDGER_VERSION } from "./ledger";
import type { SPOT_ANALYTICS_VERSION } from "../spot/version";
import type {
  NormalizedSolanaTransaction,
  SOLANA_LOCAL_PARSER_VERSION,
  SolanaEconomicTransaction,
} from "./types";

/** Experimental public input. No caller-controlled ownership, policy or coverage. */
export type SolanaInspectionInput = {
  walletAddress: string;
  inputSha256: string;
  transactions: readonly { raw: unknown; payloadSha256: string }[];
};

export type SolanaInspectionTransaction = {
  inputIndex: number;
  payloadSha256: string;
  /** First observation with this supplied signature; null when it is absent. */
  identityFirstInputIndex: number | null;
  /** First identical canonical raw record, regardless of caller hash claims. */
  duplicateOfInputIndex: number | null;
  inclusion: {
    /** Counts this supplied signature once, even when its revisions conflict. */
    countedInIdentifiedTransactions: boolean;
    /** Identity/deduplication eligibility, not economic or financial validity. */
    includedInEconomicTotals: boolean;
    exclusionReasons: Array<
      | "exact_duplicate_observation"
      | "conflicting_transaction_revision"
      | "transaction_identity_unavailable"
    >;
  };
  normalized: NormalizedSolanaTransaction;
  economic: SolanaEconomicTransaction;
  limitations: string[];
  /** Review guidance, not a claim that supplying it will satisfy ledger gates. */
  requirements: { code: string; neededEvidence: string }[];
};

export type SolanaInspectionReport = {
  version: "solana-inspection-v2";
  methodology: {
    parserVersion: typeof SOLANA_LOCAL_PARSER_VERSION;
    ledgerVersion: typeof SOLANA_LOCAL_LEDGER_VERSION;
    costEngineVersion: typeof SPOT_ANALYTICS_VERSION;
  };
  walletAddress: string;
  source: "user-supplied";
  inputSha256: string;
  trust: {
    authenticated: false;
    /** This pure API cannot verify hashes against original file bytes. */
    hashesVerified: false;
    finalityVerified: false;
    ownershipVerified: false;
    chainOrderVerified: false;
  };
  coverage: {
    historyComplete: false;
    tokenAccountHistoryComplete: false;
    scope: "supplied-transactions-only";
  };
  financial: {
    pnlUsd: null;
    returnPct: null;
    state: "unavailable";
    reasons: string[];
  };
  summary: {
    /** All input observations, including duplicates, conflicts and missing identities. */
    suppliedTransactions: number;
    /** Distinct nonempty supplied signatures; not authenticated/validated signatures. */
    uniqueTransactions: number;
    /** Repeated canonical raw records, including observations without a signature. */
    duplicateTransactions: number;
    /** Distinct canonical raw records, including records without a signature. */
    distinctRevisions: number;
    conflictingSignatures: number;
    /** All observations of conflicted signatures, including exact repeated revisions. */
    conflictedObservations: number;
    /** All observations without a supplied signature, including exact repeats. */
    unidentifiedObservations: number;
    /** First observations of identified, non-conflicted revisions. */
    eligibleTransactions: number;
    /** All records excluded from economic totals; reasons may overlap. */
    excludedObservations: number;
    /** Parser candidates among eligible observations, including economic blockers. */
    swapCandidates: number;
    /**
     * Candidates with no blocker other than finality_unavailable. That blocker
     * is a provenance limitation, not evidence of on-chain authenticity: this
     * count covers eligible observations only. It does not confirm swaps or
     * make their financial results available.
     */
    locallyReconciledSwapCandidates: number;
    /** Raw movements among eligible observations only; not authenticated execution. */
    observedMovements: number;
    /** Eligible observations only; includes finality_unavailable. Exclusions are separate. */
    transactionsWithLimitations: number;
    /** Eligible observations only; excludes finality_unavailable, not economic/order blockers. */
    transactionsWithEconomicLimitations: number;
  };
  transactions: SolanaInspectionTransaction[];
  sample: {
    state: "available" | "blocked";
    /** Numeric ordering inside unverified input, never authenticated chain order. */
    orderBasis: "supplied-slot-only" | "unavailable";
    accountInventory: SolanaLedgerReport["accountInventory"];
    quantityReconciliation: SolanaLedgerReport["quantityReconciliation"];
    issues: SolanaLedgerReport["issues"];
    reasons: string[];
  };
  limitations: string[];
};
