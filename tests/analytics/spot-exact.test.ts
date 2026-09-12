import { describe, expect, it } from "vitest";
import {
  analyzeSpotActivity,
  analyzeSpotActivityExact,
  type CanonicalSpotSwap,
} from "../../src/analytics/spot";

describe("opt-in local exact decimal spot output", () => {
  it("preserves sub-number differences without changing legacy v1 output", () => {
    const token = { chain: "solana", assetId: "token" };
    const quote = { chain: "solana", assetId: "quote" };
    const leg = (amount: string) => ({
      asset: quote,
      amount,
      usdValue: {
        value: amount,
        status: "observed" as const,
        sourceKind: "relay" as const,
        source: "test",
      },
    });
    const swaps: CanonicalSpotSwap[] = [
      {
        kind: "swap",
        id: "buy",
        wallet: "wallet",
        executedAt: "2026-01-01T00:00:00Z",
        input: leg("9007199254740993.000000000000000001"),
        output: { asset: token, amount: "1" },
        fees: [],
      },
      {
        kind: "swap",
        id: "sell",
        wallet: "wallet",
        executedAt: "2026-01-01T00:01:00Z",
        input: { asset: token, amount: "1" },
        output: leg("9007199254740993.000000000000000003"),
        fees: [],
      },
    ];
    const input = {
      ownedWallets: ["wallet"],
      settlementAssetKeys: ["solana:quote"],
      swaps,
      transfers: [],
    };
    const exact = analyzeSpotActivityExact(input);
    expect(exact.methodologyVersion).toBe("spot-moving-average-local-exact-v2");
    expect(exact.episodes[0].exact.acquisitionCostUsd).toBe(
      "9007199254740993.000000000000000001",
    );
    expect(exact.episodes[0].exact.realizedPnlUsd).toBe("2e-18");
    expect(exact.metrics.validClosedEpisodePnlUsd).toBe("2e-18");
    const legacy = analyzeSpotActivity(input);
    expect(legacy.methodologyVersion).toBe("spot-moving-average-v1");
    expect(legacy.episodes[0]).not.toHaveProperty("exact");
  });
});
