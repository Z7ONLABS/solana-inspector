import Decimal from "decimal.js";

import type {
  SpotAssetPrice,
  SpotAssetRef,
  SpotUsdPriceSourceKind,
} from "./types";

export const DEFAULT_MIN_PRICE_CONFIDENCE = 0.8;
export const DEFAULT_MIN_ONCHAIN_LIQUIDITY_USD = "25000";

/**
 * This allowlist establishes asset identity only. It never creates a synthetic
 * $1 observation: an actual price and freshness evidence are still required.
 */
export const STABLECOIN_ALLOWLIST = [
  {
    chain: "solana",
    assetId: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    symbol: "USDC",
  },
  {
    chain: "base",
    assetId: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    symbol: "USDC",
  },
  {
    chain: "bnb",
    assetId: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
    symbol: "USDC",
  },
  {
    chain: "monad",
    assetId: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
    symbol: "USDC",
  },
] as const;

export type SpotPriceSelection =
  | { readonly state: "observed"; readonly evidence: SpotAssetPrice }
  | { readonly state: "unavailable"; readonly reason: string };

export type SpotPriceSelectionPolicy = {
  readonly maxAgeMs: number;
  readonly minConfidence?: number;
  readonly minOnchainLiquidityUsd?: string;
};

function timestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new Error(`${label} is not a valid timestamp`);
  return parsed;
}

function canonicalAssetId(asset: SpotAssetRef): string {
  const chain = asset.chain.trim().toLowerCase();
  const assetId = asset.assetId.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(assetId) && chain !== "solana"
    ? assetId.toLowerCase()
    : assetId;
}

export function isAllowlistedStablecoin(asset: SpotAssetRef): boolean {
  const chain = asset.chain.trim().toLowerCase();
  const assetId = canonicalAssetId(asset);
  return STABLECOIN_ALLOWLIST.some(
    (stablecoin) =>
      stablecoin.chain === chain && stablecoin.assetId === assetId,
  );
}

function sameAsset(left: SpotAssetRef, right: SpotAssetRef): boolean {
  return (
    left.chain.trim().toLowerCase() === right.chain.trim().toLowerCase() &&
    canonicalAssetId(left) === canonicalAssetId(right)
  );
}

function sourcePriority(sourceKind: SpotUsdPriceSourceKind): number {
  switch (sourceKind) {
    case "stablecoin_allowlist":
      return 3;
    case "relay":
    case "dune":
      return 2;
    case "coingecko_onchain":
      return 1;
  }
}

function positiveDecimal(value: string, label: string): Decimal {
  let parsed: Decimal;
  try {
    parsed = new Decimal(value);
  } catch {
    throw new Error(`${label} must be a decimal string`);
  }
  if (!parsed.isFinite() || !parsed.isPositive()) {
    throw new Error(`${label} must be positive and finite`);
  }
  return parsed;
}

/**
 * Selects point-in-time unit-price evidence using the documented hierarchy.
 * Rejected evidence never falls back to a token amount masquerading as USD.
 */
export function selectSpotPriceEvidence(
  asset: SpotAssetRef,
  executedAt: string,
  evidence: readonly SpotAssetPrice[],
  policy: SpotPriceSelectionPolicy,
): SpotPriceSelection {
  if (!Number.isFinite(policy.maxAgeMs) || policy.maxAgeMs < 0) {
    throw new Error("maxAgeMs must be a non-negative finite number");
  }
  const minConfidence = policy.minConfidence ?? DEFAULT_MIN_PRICE_CONFIDENCE;
  if (
    !Number.isFinite(minConfidence) ||
    minConfidence < 0 ||
    minConfidence > 1
  ) {
    throw new Error("minConfidence must be between 0 and 1");
  }
  const minLiquidity = positiveDecimal(
    policy.minOnchainLiquidityUsd ?? DEFAULT_MIN_ONCHAIN_LIQUIDITY_USD,
    "minOnchainLiquidityUsd",
  );
  const eventTime = timestamp(executedAt, "Spot event executedAt");

  const eligible = evidence
    .filter((point) => sameAsset(asset, point.asset))
    .flatMap((point) => {
      const observedAt = timestamp(
        point.observedAt,
        `Price ${point.id} observedAt`,
      );
      const staleAfter = timestamp(
        point.staleAfter,
        `Price ${point.id} staleAfter`,
      );
      positiveDecimal(point.priceUsd, `Price ${point.id}`);
      if (
        !Number.isFinite(point.confidence) ||
        point.confidence < 0 ||
        point.confidence > 1
      ) {
        throw new Error(`Price ${point.id} confidence must be between 0 and 1`);
      }
      if (staleAfter <= observedAt) {
        throw new Error(
          `Price ${point.id} staleAfter must be after observedAt`,
        );
      }
      if (observedAt > eventTime || eventTime >= staleAfter) return [];
      if (eventTime - observedAt > policy.maxAgeMs) return [];
      if (point.confidence < minConfidence) return [];
      if (
        point.sourceKind === "stablecoin_allowlist" &&
        !isAllowlistedStablecoin(asset)
      ) {
        return [];
      }
      if (point.sourceKind === "coingecko_onchain") {
        if (point.liquidityUsd === null) return [];
        if (
          positiveDecimal(
            point.liquidityUsd,
            `Price ${point.id} liquidityUsd`,
          ).lt(minLiquidity)
        ) {
          return [];
        }
      }
      return [{ point, observedAt }];
    })
    .sort((left, right) => {
      const byPriority =
        sourcePriority(right.point.sourceKind) -
        sourcePriority(left.point.sourceKind);
      return byPriority || right.observedAt - left.observedAt;
    });

  return eligible[0]
    ? { state: "observed", evidence: eligible[0].point }
    : { state: "unavailable", reason: "swap_usd_value_unavailable" };
}
