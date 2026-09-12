import Decimal from "decimal.js";

import type { SpotAssetPrice, SpotAssetRef, SpotLeg } from "./types";
import { selectSpotPriceEvidence } from "./valuation";
import {
  missing,
  parseDecimal,
  resolved,
  type ResolvedDecimal,
} from "./decimal";

export const DEFAULT_MAX_PRICE_AGE_MS = 5 * 60 * 1000;

export function spotAssetKey(asset: SpotAssetRef): string {
  if (asset.chain.trim() === "")
    throw new Error("Asset chain must not be blank");
  if (asset.assetId.trim() === "")
    throw new Error("Asset identifier must not be blank");
  return `${asset.chain}:${asset.assetId}`;
}

function timestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new Error(`${label} is not a valid timestamp`);
  return parsed;
}

export class SpotPriceIndex {
  readonly #prices: readonly SpotAssetPrice[];
  readonly #maxAgeMs: number;
  readonly #Decimal: typeof Decimal;

  constructor(
    prices: readonly SpotAssetPrice[],
    maxAgeMs: number,
    Constructor: typeof Decimal = Decimal,
  ) {
    this.#Decimal = Constructor;
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
      throw new Error("maxPriceAgeMs must be a non-negative finite number");
    }
    this.#maxAgeMs = maxAgeMs;

    const seenIds = new Set<string>();
    for (const point of prices) {
      if (point.id.trim() === "") throw new Error("Price id must not be blank");
      if (seenIds.has(point.id))
        throw new Error(`Duplicate price id: ${point.id}`);
      seenIds.add(point.id);
      if (point.source.trim() === "")
        throw new Error(`Price ${point.id} source must not be blank`);
      parseDecimal(point.priceUsd, `Price ${point.id}`);
      timestamp(point.observedAt, `Price ${point.id} observedAt`);
      timestamp(point.staleAfter, `Price ${point.id} staleAfter`);
      spotAssetKey(point.asset);
    }
    this.#prices = [...prices];
  }

  resolveLeg(leg: SpotLeg, executedAt: string): ResolvedDecimal {
    const amount = parseDecimal(
      leg.amount,
      "Spot leg amount",
      false,
      this.#Decimal,
    );
    const selected = selectSpotPriceEvidence(
      leg.asset,
      executedAt,
      this.#prices,
      { maxAgeMs: this.#maxAgeMs },
    );
    if (
      selected.state === "observed" &&
      selected.evidence.sourceKind === "stablecoin_allowlist"
    ) {
      return resolved(
        new this.#Decimal(selected.evidence.priceUsd).mul(amount),
        this.#Decimal,
      );
    }

    if (leg.usdValue) {
      if (leg.usdValue.source.trim() === "") {
        throw new Error("Spot leg USD source must not be blank");
      }
      if (
        leg.usdValue.sourceKind !== "relay" &&
        leg.usdValue.sourceKind !== "dune"
      ) {
        throw new Error(
          "Spot leg total USD evidence must come from Relay or Dune",
        );
      }
      if (leg.usdValue.status !== "observed") {
        return missing("swap_usd_value_unavailable");
      }
      return resolved(
        parseDecimal(
          leg.usdValue.value,
          "Spot leg USD value",
          true,
          this.#Decimal,
        ),
        this.#Decimal,
      );
    }

    if (selected.state === "unavailable") {
      return missing("swap_usd_value_unavailable");
    }

    return resolved(
      new this.#Decimal(selected.evidence.priceUsd).mul(amount),
      this.#Decimal,
    );
  }
}
