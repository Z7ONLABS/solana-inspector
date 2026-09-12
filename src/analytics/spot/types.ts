import type { MetricDatum } from "@/types/analytics";

export type SpotValueStatus = "observed" | "derived";

export type SpotUsdPriceSourceKind =
  "stablecoin_allowlist" | "relay" | "dune" | "coingecko_onchain";

export type SpotExplicitUsdSourceKind = Extract<
  SpotUsdPriceSourceKind,
  "relay" | "dune"
>;

export interface SpotAssetRef {
  /** Canonical chain slug. Asset identity is case-sensitive. */
  readonly chain: string;
  /** Mint on Solana or normalized contract/native identifier on EVM. */
  readonly assetId: string;
  readonly symbol?: string;
}

export interface SpotUsdValue {
  /** Decimal string containing a total USD value, not a unit price. */
  readonly value: string;
  readonly status: SpotValueStatus;
  /** Only providers that explicitly report a total executed USD value qualify. */
  readonly sourceKind: SpotExplicitUsdSourceKind;
  readonly source: string;
}

export interface SpotLeg {
  readonly asset: SpotAssetRef;
  /** Raw token amount expressed in display units. */
  readonly amount: string;
  /** Optional total value at execution time. Prices are the fallback. */
  readonly usdValue?: SpotUsdValue;
}

export type CanonicalSpotFee = SpotLeg;

interface CanonicalSpotEventBase {
  readonly id: string;
  readonly executedAt: string;
  /** Ordering inside a timestamp. Upstream should use chain transaction order. */
  readonly eventOrder?: number;
}

export interface CanonicalSpotSwap extends CanonicalSpotEventBase {
  readonly kind: "swap";
  readonly wallet: string;
  readonly input: SpotLeg;
  readonly output: SpotLeg;
  /** Empty means the canonical source explicitly observed no fees. */
  readonly fees: readonly CanonicalSpotFee[];
}

export interface CanonicalSpotTransfer extends CanonicalSpotEventBase {
  readonly kind: "transfer";
  readonly asset: SpotAssetRef;
  readonly amount: string;
  /** Only `preserved` is safe for a transfer between two owned wallets. */
  readonly costBasisStatus: "preserved" | "unknown" | "not_applicable";
  /** Null identifies the boundary outside the linked-wallet group. */
  readonly fromWallet: string | null;
  readonly toWallet: string | null;
}

export interface SpotAssetPrice {
  readonly id: string;
  readonly asset: SpotAssetRef;
  readonly observedAt: string;
  /** Evidence is unusable at or after this timestamp. */
  readonly staleAfter: string;
  /** USD per one display unit. No stablecoin peg is assumed. */
  readonly priceUsd: string;
  /** Normalized evidence confidence from 0 through 1. */
  readonly confidence: number;
  /** Required for CoinGecko on-chain evidence; optional for direct provider evidence. */
  readonly liquidityUsd: string | null;
  readonly status: SpotValueStatus;
  readonly sourceKind: SpotUsdPriceSourceKind;
  readonly source: string;
}

export interface AnalyzeSpotActivityInput {
  readonly ownedWallets: readonly string[];
  readonly settlementAssetKeys: readonly string[];
  readonly swaps: readonly CanonicalSpotSwap[];
  readonly transfers: readonly CanonicalSpotTransfer[];
  readonly prices?: readonly SpotAssetPrice[];
  /** A price must be at or before the event and no older than this age. */
  readonly maxPriceAgeMs?: number;
}

export type SpotEpisodeInvalidReason =
  | "external_outbound_inventory"
  | "fee_usd_unavailable"
  | "inventory_history_incomplete"
  | "swap_usd_value_unavailable"
  | "transfer_cost_basis_unknown"
  | "unknown_inbound_inventory";

export interface SpotEpisode {
  readonly id: string;
  readonly asset: SpotAssetRef;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly closed: boolean;
  readonly eligibleForMetrics: boolean;
  readonly swapIds: readonly string[];
  readonly transferIds: readonly string[];
  readonly invalidReasons: readonly SpotEpisodeInvalidReason[];
  /** Includes acquisition fees allocated to this position. */
  readonly acquisitionCostUsd: MetricDatum;
  /** Proceeds before disposition fees. */
  readonly grossProceedsUsd: MetricDatum;
  readonly feesUsd: MetricDatum;
  readonly realizedPnlUsd: MetricDatum;
  /** Realized PnL divided by acquisition cost for a valid zero-to-zero episode. */
  readonly closedReturnPct: MetricDatum;
}

export interface SpotOpenPosition {
  readonly asset: SpotAssetRef;
  readonly quantity: string;
  readonly costBasisUsd: MetricDatum;
  readonly averageCostUsd: MetricDatum;
  readonly episodeId: string;
}

export interface SpotAnalyticsMetrics {
  readonly closedEpisodes: number;
  readonly validClosedEpisodes: number;
  readonly validEpisodeCoveragePct: MetricDatum;
  readonly validClosedEpisodePnlUsd: MetricDatum;
  readonly weightedClosedReturnPct: MetricDatum;
  readonly winRatePct: MetricDatum;
  readonly profitFactor: MetricDatum;
}

export interface SpotAnalyticsResult {
  readonly methodologyVersion: "spot-moving-average-v1";
  readonly episodes: readonly SpotEpisode[];
  readonly openPositions: readonly SpotOpenPosition[];
  readonly metrics: SpotAnalyticsMetrics;
}

/** Local-only v2 decimal values. The existing numeric v1 API is unchanged. */
export interface SpotExactEpisodeValues {
  readonly acquisitionCostUsd: string | null;
  readonly grossProceedsUsd: string | null;
  readonly feesUsd: string | null;
  readonly realizedPnlUsd: string | null;
  readonly closedReturnPct: string | null;
}

export type SpotExactEpisode = SpotEpisode & {
  readonly exact: SpotExactEpisodeValues;
};
export type SpotExactAnalyticsResult = {
  readonly methodologyVersion: "spot-moving-average-local-exact-v2";
  readonly episodes: readonly SpotExactEpisode[];
  readonly openPositions: readonly (SpotOpenPosition & {
    readonly exact: {
      costBasisUsd: string | null;
      averageCostUsd: string | null;
    };
  })[];
  readonly metrics: {
    closedEpisodes: number;
    validClosedEpisodes: number;
    validEpisodeCoveragePct: string | null;
    validClosedEpisodePnlUsd: string | null;
    weightedClosedReturnPct: string | null;
    winRatePct: string | null;
    profitFactor: string | null;
  };
};
