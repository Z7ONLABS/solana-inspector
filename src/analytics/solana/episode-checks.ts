import {
  spotAssetKey,
  type CanonicalSpotSwap,
  type SpotAssetRef,
  type SpotExactEpisode,
  SpotPriceIndex,
} from "../spot";
import type {
  WalletEpisodeCheck,
  WalletEpisodeChecks,
} from "../../types/episode-checks";
import type { SolanaEconomicTransaction } from "./types";
import type { SolanaLedgerReport } from "./ledger";

// All structural ledger blockers fail closed here, including future/account-level
// reason codes. Only these known price-only exclusions are independent of history.
const VALUATION_ONLY_REASONS = new Set([
  "fee_usd_unavailable",
  "swap_usd_value_unavailable",
]);
const TRADE_EVIDENCE_REASONS = new Set([
  "canonical_amount_not_exact",
  "canonical_economic_balance_residual",
  "chain_event_order_unproven",
  "chain_economic_order_unproven",
  "economic_instruction_order_unproven",
  "mixed_transaction_routing_unsupported",
  "conflicting_transaction_revision",
  "transaction_provenance_unavailable",
  "transaction_not_bound_to_coverage_proof",
  "finality_unproven",
]);
const FEE_EVIDENCE_REASONS = new Set([
  "fee_coverage_incomplete",
  "canonical_fee_coverage_mismatch",
  "fee_amount_not_exact",
  "invalid_fee_amount",
]);
const gate = (reasons: readonly string[]): WalletEpisodeCheck => {
  const unique = [...new Set(reasons)].sort();
  return { state: unique.length ? "unavailable" : "proven", reasons: unique };
};

/** Explains existing ledger evidence. It neither calculates PnL nor grants eligibility. */
export function buildSolanaEpisodeChecks(input: {
  asset: SpotAssetRef;
  episode: SpotExactEpisode;
  reasons: string[];
  swaps: readonly CanonicalSpotSwap[];
  transactions: readonly SolanaEconomicTransaction[];
  reconciliation: SolanaLedgerReport["quantityReconciliation"];
  prices: SpotPriceIndex;
}): WalletEpisodeChecks {
  const key = spotAssetKey(input.asset);
  const selected = input.swaps.filter((s) =>
    input.episode.swapIds.includes(s.id),
  );
  const buys = selected.filter(
    (s) => spotAssetKey(s.output.asset) === key,
  ).length;
  const sells = selected.filter(
    (s) => spotAssetKey(s.input.asset) === key,
  ).length;
  const related = input.transactions.filter(
    (tx) =>
      tx.swaps.some((s) => input.episode.swapIds.includes(s.id)) ||
      tx.transfers.some((t) => input.episode.transferIds.includes(t.id)),
  );
  // Canonical event recognition alone does not establish its exact economic
  // amounts. Raw quantities below remain independent and may still reconcile.
  const tradeReasons = input.reasons.filter((reason) =>
    TRADE_EVIDENCE_REASONS.has(reason),
  );
  if (!buys) tradeReasons.push("acquisition_not_reconstructed");
  if (!sells) tradeReasons.push("disposal_not_reconstructed");
  const transactionsCoverSwaps = selected.every((swap) =>
    related.some((tx) => tx.swaps.some((event) => event.id === swap.id)),
  );
  if (
    selected.length !== input.episode.swapIds.length ||
    !transactionsCoverSwaps
  )
    tradeReasons.push("swap_evidence_missing");
  if (related.some((tx) => !tx.orderProven || tx.economicOrderProven !== true))
    tradeReasons.push("economic_order_unproven");
  if (
    related
      .filter((tx) =>
        tx.swaps.some((s) => input.episode.swapIds.includes(s.id)),
      )
      .some((tx) => tx.state !== "parsed")
  )
    tradeReasons.push("swap_transaction_partially_interpreted");
  const quantityReasons: string[] = [];
  if (!related.length) quantityReasons.push("balance_evidence_unavailable");
  for (const tx of related) {
    const row = input.reconciliation.find(
      (r) => r.signature !== null && r.signature === tx.signature,
    );
    const relevantAssets = new Set([
      key,
      ...selected
        .filter((swap) => tx.swaps.some((s) => s.id === swap.id))
        .flatMap((swap) => [
          spotAssetKey(swap.input.asset),
          spotAssetKey(swap.output.asset),
        ]),
      ...tx.fees
        .filter((fee) => fee.chargedToAnalyzedWallet)
        .map((fee) => spotAssetKey(fee.asset)),
    ]);
    for (const assetKey of relevantAssets) {
      const asset = row?.assets.find((a) => a.assetKey === assetKey);
      if (!asset) quantityReasons.push("balance_evidence_unavailable");
      else if (asset.state !== "reconciled")
        quantityReasons.push(
          ...(asset.reasons.length
            ? asset.reasons
            : ["asset_quantities_unreconciled"]),
        );
    }
  }
  // feesComplete is parser intent; the ledger additionally reconciles canonical
  // fee sets and exact units against the observed charges.
  const feeReasons = input.reasons.filter((reason) =>
    FEE_EVIDENCE_REASONS.has(reason),
  );
  if (
    !selected.length ||
    !transactionsCoverSwaps ||
    related.some((tx) => !tx.feesComplete)
  )
    feeReasons.push("fee_coverage_incomplete");
  const inventoryReasons = input.reasons.filter(
    (r) => !VALUATION_ONLY_REASONS.has(r),
  );
  // Unknown basis cannot become known merely because a diagnostic category is absent.
  if (!buys) inventoryReasons.push("acquisition_cost_not_established");
  const valuationReasons: string[] = [];
  if (!selected.length) valuationReasons.push("price_requirements_unavailable");
  if (feeReasons.length) valuationReasons.push("fee_set_unproven");
  for (const swap of selected) {
    const quote =
      spotAssetKey(swap.output.asset) === key ? swap.input : swap.output;
    if (input.prices.resolveLeg(quote, swap.executedAt).value === null)
      valuationReasons.push("historical_quote_price_unavailable");
    for (const fee of swap.fees) {
      if (input.prices.resolveLeg(fee, swap.executedAt).value === null)
        valuationReasons.push("historical_fee_price_unavailable");
    }
  }
  const financialReasons = [...input.reasons];
  if (!input.episode.eligibleForMetrics && !financialReasons.length)
    financialReasons.push("ledger_financial_result_unavailable");
  if (input.episode.exact.realizedPnlUsd === null)
    financialReasons.push("net_result_unavailable");
  return {
    version: "solana-episode-checks-v1",
    buys,
    sells,
    transactionIds: [
      ...new Set(
        related
          .map((tx) => tx.signature)
          .filter((s): s is string => s !== null),
      ),
    ],
    gates: {
      trades: gate(tradeReasons),
      quantities: gate(quantityReasons),
      fees: gate(feeReasons),
      inventory: gate(inventoryReasons),
      valuation: gate(valuationReasons),
      financialResult: gate(financialReasons),
    },
  };
}
