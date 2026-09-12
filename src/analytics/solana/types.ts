import type {
  CanonicalSpotSwap,
  CanonicalSpotTransfer,
  SpotAssetRef,
} from "../spot/types";

export const SOLANA_LOCAL_PARSER_VERSION = "solana-local-economic-v4" as const;
export const SOLANA_WRAPPED_SOL_MINT =
  "So11111111111111111111111111111111111111112";

export type SolanaProvenance = {
  source: string;
  payloadSha256: string;
  archivePayloadSha256?: string;
  sourcePath?: string;
  fetchedAt?: string;
  commitment: "finalized" | "confirmed" | "processed" | "unknown";
  commitmentEvidence: "request" | "observed" | "unknown";
};

export type SolanaNormalizedInstruction = {
  programId: string | null;
  program: string | null;
  type: string | null;
  info: Record<string, unknown> | null;
  outerIndex: number;
  innerIndex: number | null;
  stackHeight: number | null;
  /** Stable location inside this transaction; never inferred execution order. */
  path: string;
  /** Original instruction account order, including repeated references. */
  accountAddresses?: string[];
  data?: string | null;
  dataEncoding?: "base58" | "unknown";
};

export type SolanaNormalizedAccount = {
  address: string;
  signer: boolean;
  writable?: boolean | null;
  preLamports: string | null;
  postLamports: string | null;
};

export type SolanaTokenAccountBalance = {
  accountAddress: string;
  mint: string;
  decimals: number;
  preOwner: string | null;
  postOwner: string | null;
  preRaw: string | null;
  postRaw: string | null;
  programId?: string | null;
  identityEvidence?: "balance_metadata" | "instruction_lifecycle";
};

export type NormalizedSolanaTransaction = {
  state: "normalized" | "unsupported";
  signature: string | null;
  slot: number | null;
  transactionIndex: number | null;
  blockTime: string | null;
  version: "legacy" | 0 | "unsupported";
  succeeded: boolean | null;
  feePayer: string | null;
  networkFeeRaw: string | null;
  accounts: SolanaNormalizedAccount[];
  tokenAccounts: SolanaTokenAccountBalance[];
  instructions: SolanaNormalizedInstruction[];
  logMessages?: string[];
  provenance: SolanaProvenance;
  blockers: string[];
};

export type SolanaRawMovement = {
  id: string;
  asset: SpotAssetRef;
  rawAmount: string;
  amount: string;
  decimals: number;
  fromAccount: string;
  toAccount: string;
  fromWallet: string | null;
  toWallet: string | null;
  outerIndex: number;
  innerIndex: number | null;
  classification:
    "transfer" | "swap_leg" | "app_fee" | "lifecycle" | "unresolved";
  economicState?: "confirmed" | "unclassified";
  executionProtocol?: string | null;
  /** Endpoint amounts are observations, not an inferred transfer-fee schedule. */
  quantityEvidence?: {
    state: "exact" | "delta_only" | "unavailable";
    programId: string;
    grossRaw: string;
    debitRaw: string | null;
    creditRaw: string | null;
    unexplainedDifferenceRaw: string | null;
  };
  authority?: string | null;
  /** A mint/burn is a supply change, not a trader's buy/sell or a counterparty. */
  tokenAction?: "mint" | "burn";
};

export type SolanaFeeEvent = {
  id: string;
  kind: "network" | "app";
  asset: SpotAssetRef;
  rawAmount: string;
  amount: string;
  decimals: number;
  payerWallet: string | null;
  chargedToAnalyzedWallet: boolean;
};

export type SolanaLifecycleEvent = {
  id: string;
  kind:
    | "create_account"
    | "close_account"
    | "wrap"
    | "unwrap"
    | "allocate"
    | "assign"
    | "advance_nonce"
    | "mint"
    | "burn"
    | "freeze"
    | "thaw"
    | "withdraw_withheld";
  accountAddress: string;
  wallet: string | null;
  /** Actual native transfer/rent amount if proven, never a guessed rent constant. */
  nativeRawAmount: string | null;
  destinationWallet?: string | null;
  asset?: SpotAssetRef;
  rawAmount?: string | null;
  decimals?: number;
  authority?: string | null;
  programOwner?: string | null;
  outerIndex?: number;
  innerIndex?: number | null;
  /** Failed transactions commit fees and may advance a validated durable nonce. */
  effectState?: "observed" | "attempted_unproven";
  /** Accounts explicitly named by the instruction; no ownership inference. */
  relatedAccounts?: string[];
};

export type SolanaWalletBalanceEvidence = {
  asset: SpotAssetRef;
  decimals: number;
  preRaw: string | null;
  postRaw: string | null;
  deltaRaw: string | null;
  accountAddresses: string[];
  complete: boolean;
  /** Diagnostic from the existing movement/balance check, not a fee or a new transfer. */
  movementCheck?: {
    basis: "recognized-movements";
    recognizedDeltaRaw: string;
    paidNetworkFeeRaw: string;
    expectedDeltaRaw: string;
    observedDeltaRaw: string;
    unexplainedDifferenceRaw: string;
  };
  /** These are touched accounts, not necessarily the owner's entire inventory. */
  accountObservations?: Array<{
    address: string;
    preRaw: string | null;
    postRaw: string | null;
    created: boolean;
    closed: boolean;
    mint?: string;
    programId?: string | null;
    preOwner?: string | null;
    postOwner?: string | null;
    identityEvidence?: "balance_metadata" | "instruction_lifecycle";
  }>;
};

export type SolanaEconomicBlocker = {
  code: string;
  scope: "asset" | "transaction" | "evidence";
  assetIds: string[];
};

export type SolanaWalletContext = {
  walletAddress: string;
  ownedWallets?: readonly string[];
  feeTokenAccounts?: ReadonlySet<string>;
  feeOwner?: string;
  /** Explicitly verified local parser registry; unknown programs never auto-enroll. */
  supportedSwapPrograms?: ReadonlySet<string>;
  /** Proven chain transaction order, not array/signature lexicographic order. */
  transactionOrder?: number;
};

export type SolanaEconomicTransaction = {
  parserVersion: typeof SOLANA_LOCAL_PARSER_VERSION;
  state: "parsed" | "partial" | "unsupported";
  signature: string | null;
  walletAddress: string;
  slot: number | null;
  transactionIndex: number | null;
  executedAt: string | null;
  succeeded: boolean | null;
  sourceScope: "fomo_routed" | "wallet_all_activity" | "mixed" | "unavailable";
  economicClassification:
    "swap" | "transfer" | "lifecycle" | "fee_only" | "unresolved";
  executionProtocol?: string | null;
  routingEvidence: {
    state: "fomo_routed" | "not_observed" | "unavailable";
    method: "usdc-fee-owner-and-explicit-transfer" | null;
    feeTokenAccounts: string[];
  };
  orderProven: boolean;
  economicOrderProven?: boolean;
  economicOrder?: Array<{
    eventId: string;
    outerIndex: number;
    innerIndex: number | null;
    ordinal: number;
    atomic: boolean;
  }>;
  swaps: CanonicalSpotSwap[];
  transfers: CanonicalSpotTransfer[];
  rawMovements: SolanaRawMovement[];
  lifecycle: SolanaLifecycleEvent[];
  fees: SolanaFeeEvent[];
  /** False is not equivalent to an empty, observed fee set. */
  feesComplete: boolean;
  balanceEvidence: SolanaWalletBalanceEvidence[];
  taintedAssets: string[];
  blockers: string[];
  /** Explicit financial effect scope. Missing on v1 records: use conservative compatibility handling. */
  blockerEvidence?: SolanaEconomicBlocker[];
  provenance: SolanaProvenance;
};
