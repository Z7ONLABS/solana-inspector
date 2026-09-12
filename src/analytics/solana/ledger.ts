import {
  analyzeSpotActivityExact,
  calculateSpotExactMetrics,
  spotAssetKey,
  STABLECOIN_ALLOWLIST,
  SpotPriceIndex,
  type CanonicalSpotSwap,
  type CanonicalSpotTransfer,
  type SpotAssetPrice,
  type SpotAssetRef,
  type SpotExactEpisode,
} from "../spot";
import { ExactSpotDecimal as Decimal } from "../spot/decimal";
import { unavailable } from "../value";
import { buildSolanaEpisodeChecks } from "./episode-checks";
import type { WalletEpisodeChecks } from "../../types/episode-checks";
import {
  SOLANA_WRAPPED_SOL_MINT,
  type SolanaEconomicTransaction,
} from "./types";
import {
  SolanaAccountLedger,
  type SolanaAccountInventory,
} from "./account-ledger";

export const SOLANA_LOCAL_LEDGER_VERSION = "solana-local-ledger-v4" as const;

export type SolanaLedgerCoverage = {
  historyComplete: boolean;
  tokenAccountHistoryComplete: boolean;
  discontinuityCount: number;
  /** Verified archive/checkpoint hashes, not a claim derived from a query option. */
  proofSha256: readonly string[];
  from?: string;
  toExclusive?: string;
};

export type SolanaLedgerIssue = {
  code: string;
  assetKey: string | null;
  signature: string | null;
};
export type SolanaLedgerEpisode = SpotExactEpisode & {
  financialScope: "wallet_all_activity";
  routing: "fomo_routed" | "wallet_all_activity" | "mixed";
  evidenceReasons: string[];
  signatures: string[];
  payloadSha256: string[];
  checks?: WalletEpisodeChecks;
};

export type SolanaLedgerReport = {
  version: typeof SOLANA_LOCAL_LEDGER_VERSION;
  walletAddress: string;
  financialScope: "wallet_all_activity";
  summary: ReturnType<typeof calculateSpotExactMetrics> & {
    observedTransactions: number;
    reconciledTransactions: number;
    /** Exact movement/account reconciliation, independent of financial eligibility. */
    quantityReconciledTransactions: number;
    unsupportedTransactions: number;
    /** Fee-only expenses are not arbitrarily charged to a memecoin episode. */
    unallocatedFeeExpenseUsd: string | null;
    wholeWalletPnlUsd: null;
  };
  episodes: SolanaLedgerEpisode[];
  openPositions: Array<{
    asset: SpotAssetRef;
    quantity: string;
    costBasisUsd: string | null;
    reasons: string[];
  }>;
  balances: Array<{
    asset: SpotAssetRef;
    rawAmount: string | null;
    decimals: number;
    quantity: string | null;
    settlement: boolean;
    lastObservedAt?: string | null;
    slot?: number | null;
    accountAddresses?: string[];
    coverage?: "touched_accounts";
    aggregation?: "observed_accounts";
    oldestObservationAt?: string | null;
  }>;
  accountInventory: SolanaAccountInventory[];
  quantityReconciliation: Array<{
    signature: string | null;
    state: "reconciled" | "unresolved";
    assets: Array<{
      assetKey: string;
      state: "reconciled" | "unresolved";
      reasons: string[];
    }>;
  }>;
  issues: SolanaLedgerIssue[];
  expenses: Array<{
    signature: string | null;
    kind: string;
    asset: SpotAssetRef;
    rawAmount: string;
    chargedToAnalyzedWallet: boolean;
    usdValue: string | null;
    allocatedToEpisode: boolean;
  }>;
  provenance: {
    coverageProofSha256: string[];
    transactionPayloadSha256: string[];
    priceIds: string[];
  };
};

type Segment = {
  asset: SpotAssetRef;
  decimals: number;
  key: string;
  preRaw: string | null;
  postRaw: string | null;
  swaps: CanonicalSpotSwap[];
  transfers: CanonicalSpotTransfer[];
  transactions: SolanaEconomicTransaction[];
  reasons: Set<string>;
};

const SETTLEMENTS = new Set([
  ...STABLECOIN_ALLOWLIST.filter((asset) => asset.chain === "solana").map(
    spotAssetKey,
  ),
  "solana:native",
  `solana:${SOLANA_WRAPPED_SOL_MINT}`,
]);
const HASH = /^[a-f0-9]{64}$/;
const FINANCIAL_ONLY_BLOCKERS = new Set([
  "mixed_transaction_routing_unsupported",
  "chain_economic_order_unproven",
  "multiple_economic_actions_unsupported",
  "canonical_fee_coverage_mismatch",
  "token_2022_extension_state_unproven",
  "token_supply_change_cost_basis_unproven",
]);

function raw(value: string | null): bigint | null {
  return value !== null && /^\d+$/.test(value) ? BigInt(value) : null;
}

function rawDelta(value: string | null): bigint | null {
  return value !== null && /^-?\d+$/.test(value) ? BigInt(value) : null;
}

function units(amount: string, decimals: number): bigint | null {
  try {
    if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 30)
      return null;
    const value = new Decimal(amount).mul(new Decimal(10).pow(decimals));
    return value.isFinite() && value.isInteger() && value.gte(0)
      ? BigInt(value.toFixed(0))
      : null;
  } catch {
    return null;
  }
}

function display(amount: string, decimals: number): string {
  // Reports preserve exact token units as expanded decimal strings. Decimal's
  // toString() switches tiny quantities to exponent notation (e.g. 1e-9), which
  // is not a canonical public amount and previously rejected an entire report.
  return new Decimal(amount).div(new Decimal(10).pow(decimals)).toFixed();
}

function boundary(
  from: string | null,
  to: string | null,
  wallet: string,
): bigint {
  return BigInt(Number(to === wallet) - Number(from === wallet));
}

function feeTotals(
  fees: readonly { asset: SpotAssetRef; amount: string }[],
): string {
  const totals = new Map<string, InstanceType<typeof Decimal>>();
  for (const fee of fees) {
    const amount = new Decimal(fee.amount);
    if (!amount.isFinite() || amount.lt(0))
      throw new Error("Invalid fee amount");
    if (amount.isZero()) continue;
    const key = spotAssetKey(fee.asset);
    totals.set(key, (totals.get(key) ?? new Decimal(0)).plus(amount));
  }
  return JSON.stringify(
    [...totals]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, amount]) => [key, amount.toString()]),
  );
}

function maskEpisode(
  episode: SpotExactEpisode,
  reasons: string[],
): SpotExactEpisode {
  if (reasons.length === 0 && episode.eligibleForMetrics) return episode;
  return {
    ...episode,
    eligibleForMetrics: false,
    acquisitionCostUsd: unavailable("local_ledger_evidence_incomplete"),
    grossProceedsUsd: unavailable("local_ledger_evidence_incomplete"),
    feesUsd: unavailable("local_ledger_evidence_incomplete"),
    realizedPnlUsd: unavailable("local_ledger_evidence_incomplete"),
    closedReturnPct: unavailable("local_ledger_evidence_incomplete"),
    exact: {
      acquisitionCostUsd: null,
      grossProceedsUsd: null,
      feesUsd: null,
      realizedPnlUsd: null,
      closedReturnPct: null,
    },
  };
}

/**
 * Offline wallet-wide inventory adapter. No RPC, database or file access.
 * Exact pre/post owner balances and decoded movements must reconcile per asset;
 * a global parse-rate or a query's tokenAccounts=all option is never sufficient.
 */
export function analyzeSolanaLedger(input: {
  walletAddress: string;
  transactions: readonly SolanaEconomicTransaction[];
  prices?: readonly SpotAssetPrice[];
  coverage: SolanaLedgerCoverage;
  maxPriceAgeMs?: number;
}): SolanaLedgerReport {
  if (!input.walletAddress.trim())
    throw new Error("Wallet address is required.");
  if (input.transactions.some((tx) => tx.walletAddress !== input.walletAddress))
    throw new Error("A local ledger cannot infer ownership of another wallet.");
  const issues: SolanaLedgerIssue[] = [];
  const addIssue = (
    code: string,
    assetKey: string | null,
    signature: string | null,
  ) => {
    if (
      !issues.some(
        (issue) =>
          issue.code === code &&
          issue.assetKey === assetKey &&
          issue.signature === signature,
      )
    )
      issues.push({ code, assetKey, signature });
  };
  const prices = input.prices ?? [];
  const priceIndex = new SpotPriceIndex(
    prices,
    input.maxPriceAgeMs ?? 300_000,
    Decimal,
  );
  const baselineReasons = new Set<string>();
  if (!input.coverage.historyComplete)
    baselineReasons.add("wallet_history_incomplete");
  if (!input.coverage.tokenAccountHistoryComplete)
    baselineReasons.add("historical_token_account_universe_unproven");
  if (
    !Number.isSafeInteger(input.coverage.discontinuityCount) ||
    input.coverage.discontinuityCount !== 0
  )
    baselineReasons.add("history_discontinuity");
  if (
    input.coverage.proofSha256.length === 0 ||
    input.coverage.proofSha256.some((value) => !HASH.test(value))
  )
    baselineReasons.add("coverage_proof_unavailable");
  if (
    (input.coverage.from &&
      !Number.isFinite(Date.parse(input.coverage.from))) ||
    (input.coverage.toExclusive &&
      !Number.isFinite(Date.parse(input.coverage.toExclusive))) ||
    (input.coverage.from &&
      input.coverage.toExclusive &&
      Date.parse(input.coverage.from) >= Date.parse(input.coverage.toExclusive))
  )
    baselineReasons.add("invalid_coverage_range");
  for (const code of baselineReasons) addIssue(code, null, null);

  const transactions = [...input.transactions].sort(
    (left, right) =>
      (left.slot ?? Number.MAX_SAFE_INTEGER) -
        (right.slot ?? Number.MAX_SAFE_INTEGER) ||
      (left.transactionIndex ?? Number.MAX_SAFE_INTEGER) -
        (right.transactionIndex ?? Number.MAX_SAFE_INTEGER) ||
      (left.signature ?? "").localeCompare(right.signature ?? ""),
  );
  const seen = new Map<string, string>();
  const duplicateConflicts = new Set<string>();
  for (const tx of transactions) {
    if (!tx.signature) continue;
    const prior = seen.get(tx.signature);
    if (prior && prior !== tx.provenance.payloadSha256)
      duplicateConflicts.add(tx.signature);
    seen.set(tx.signature, tx.provenance.payloadSha256);
  }
  seen.clear();
  const slotTransactions = new Map<number, SolanaEconomicTransaction[]>();
  for (const tx of transactions) {
    if (tx.slot === null) continue;
    const group = slotTransactions.get(tx.slot) ?? [];
    if (!group.some((item) => item.signature === tx.signature)) group.push(tx);
    slotTransactions.set(tx.slot, group);
  }
  const active = new Map<string, Segment>();
  const segments: Segment[] = [];
  const balances = new Map<string, SolanaLedgerReport["balances"][number]>();
  const accountLedger = new SolanaAccountLedger(input.walletAddress);
  const quantityReconciliation: SolanaLedgerReport["quantityReconciliation"] =
    [];
  const expenses: SolanaLedgerReport["expenses"] = [];
  let unallocatedFees = new Decimal(0);
  let unallocatedFeesKnown = true;
  let reconciledTransactions = 0;
  let quantityReconciledTransactions = 0;
  let observedTransactions = 0;
  let unsupportedTransactions = 0;

  transactions.forEach((tx, transactionOrder) => {
    if (
      tx.signature &&
      seen.has(tx.signature) &&
      !duplicateConflicts.has(tx.signature)
    )
      return;
    observedTransactions += 1;
    if (tx.signature) seen.set(tx.signature, tx.provenance.payloadSha256);
    const shared = new Set<string>();
    const signed =
      tx.signature !== null && HASH.test(tx.provenance.payloadSha256);
    if (!signed) shared.add("transaction_provenance_unavailable");
    if (
      !input.coverage.proofSha256.includes(
        tx.provenance.archivePayloadSha256 ?? tx.provenance.payloadSha256,
      )
    )
      shared.add("transaction_not_bound_to_coverage_proof");
    if (
      tx.provenance.commitment !== "finalized" ||
      tx.provenance.commitmentEvidence === "unknown"
    )
      shared.add("finality_unproven");
    const sameSlot = (
      tx.slot === null ? [] : (slotTransactions.get(tx.slot) ?? [])
    ).filter(
      (other) =>
        other !== tx &&
        other.signature !== tx.signature &&
        other.slot === tx.slot,
    );
    if (
      !tx.orderProven ||
      tx.slot === null ||
      (sameSlot.length > 0 &&
        (tx.transactionIndex === null ||
          sameSlot.some(
            (other) =>
              other.transactionIndex === null ||
              other.transactionIndex === tx.transactionIndex,
          )))
    )
      shared.add("chain_event_order_unproven");
    if (!tx.executedAt || !Number.isFinite(Date.parse(tx.executedAt)))
      shared.add("timestamp_unavailable");
    if (
      tx.executedAt &&
      ((input.coverage.from &&
        Date.parse(tx.executedAt) < Date.parse(input.coverage.from)) ||
        (input.coverage.toExclusive &&
          Date.parse(tx.executedAt) >= Date.parse(input.coverage.toExclusive)))
    )
      shared.add("event_outside_verified_range");
    if (tx.signature && duplicateConflicts.has(tx.signature))
      shared.add("conflicting_transaction_revision");
    const orderEntries = tx.economicOrder ?? [];
    const actionIds = [...tx.swaps, ...tx.transfers].map((event) => event.id);
    const orderedActions = new Map(
      orderEntries.map((entry) => [entry.eventId, entry.ordinal]),
    );
    const localOrderProven =
      tx.economicOrderProven === true &&
      actionIds.every((id) => orderedActions.has(id)) &&
      new Set(orderEntries.map((entry) => entry.ordinal)).size ===
        orderEntries.length &&
      orderEntries.every(
        (entry) =>
          Number.isSafeInteger(entry.ordinal) &&
          entry.ordinal >= 0 &&
          entry.ordinal < 9_000,
      );
    if (tx.sourceScope === "mixed" && !localOrderProven)
      shared.add("mixed_transaction_routing_unsupported");
    if (actionIds.length > 1 && !localOrderProven)
      shared.add("chain_economic_order_unproven");
    if (tx.state === "unsupported") shared.add("unsupported_transaction");
    if (tx.swaps.length > 1)
      shared.add("multiple_economic_actions_unsupported");
    if (tx.swaps.length === 1) {
      try {
        if (
          feeTotals(tx.swaps[0].fees) !==
          feeTotals(tx.fees.filter((fee) => fee.chargedToAnalyzedWallet))
        )
          shared.add("canonical_fee_coverage_mismatch");
      } catch {
        shared.add("invalid_fee_amount");
      }
    }
    if (tx.state !== "parsed") unsupportedTransactions += 1;

    // Unknown effects may hide a round trip without a surviving balance delta.
    // v2 uses explicit effect scope, not a regex over display/error strings.
    // Old records and newly injected blockers without a scope remain fail-closed.
    const effectScopeUnknown =
      tx.state === "unsupported" ||
      tx.blockers.some((code) => {
        const evidence = tx.blockerEvidence?.filter(
          (item) => item.code === code,
        );
        return (
          !evidence?.length ||
          evidence.some((item) => item.scope === "transaction")
        );
      });
    if (effectScopeUnknown)
      for (const [key, segment] of active) {
        segment.reasons.add("unknown_transaction_effect_scope");
        addIssue("unknown_transaction_effect_scope", key, tx.signature);
      }

    const allAssetKeys = new Set([
      ...tx.balanceEvidence.map((item) => spotAssetKey(item.asset)),
      ...tx.swaps.flatMap((swap) => [
        spotAssetKey(swap.input.asset),
        spotAssetKey(swap.output.asset),
      ]),
      ...tx.transfers.map((event) => spotAssetKey(event.asset)),
      ...tx.fees
        .filter((fee) => fee.chargedToAnalyzedWallet)
        .map((fee) => spotAssetKey(fee.asset)),
    ]);
    if (allAssetKeys.size === 0 && (tx.state !== "parsed" || shared.size > 0)) {
      for (const key of active.keys()) allAssetKeys.add(key);
      if (allAssetKeys.size === 0)
        for (const code of shared) addIssue(code, null, tx.signature);
    }
    let reconciled = shared.size === 0;
    let quantitiesReconciled = [...shared].every((reason) =>
      FINANCIAL_ONLY_BLOCKERS.has(reason),
    );
    const quantityAssets: SolanaLedgerReport["quantityReconciliation"][number]["assets"] =
      [];
    const transactionSegments = new Set<Segment>();
    for (const key of allAssetKeys) {
      const evidence = tx.balanceEvidence.find(
        (item) => spotAssetKey(item.asset) === key,
      );
      const reasons = new Set(shared);
      if (
        tx.taintedAssets.includes(key) ||
        tx.taintedAssets.includes(key.slice("solana:".length)) ||
        tx.taintedAssets.includes("*") ||
        (tx.state === "partial" && tx.taintedAssets.length === 0)
      ) {
        reasons.add("unsupported_asset_activity");
        for (const blocker of tx.blockers) {
          const scopes = tx.blockerEvidence?.filter(
            (item) => item.code === blocker,
          );
          if (
            !scopes?.length ||
            scopes.some(
              (item) =>
                item.scope !== "asset" ||
                item.assetIds.includes(key.slice("solana:".length)),
            )
          )
            reasons.add(blocker);
        }
      }
      if (
        !evidence ||
        !evidence.complete ||
        evidence.accountAddresses.length === 0 ||
        new Set(evidence.accountAddresses).size !==
          evidence.accountAddresses.length
      )
        reasons.add("owner_balance_evidence_incomplete");
      const pre = raw(evidence?.preRaw ?? null);
      const post = raw(evidence?.postRaw ?? null);
      const delta = rawDelta(evidence?.deltaRaw ?? null);
      if (
        pre === null ||
        post === null ||
        delta === null ||
        post - pre !== delta
      )
        reasons.add("invalid_raw_balance_evidence");
      const prior = balances.get(key);
      const inventory = evidence
        ? accountLedger.observe(
            evidence,
            tx,
            !shared.has("chain_event_order_unproven") &&
              !shared.has("conflicting_transaction_revision"),
          )
        : null;
      for (const reason of inventory?.reasons ?? []) reasons.add(reason);
      if (prior && evidence && prior.decimals !== evidence.decimals)
        reasons.add("asset_decimals_changed");
      let reconstructed = BigInt(0);
      for (const movement of tx.rawMovements.filter(
        (item) => spotAssetKey(item.asset) === key,
      )) {
        const amount = raw(movement.rawAmount);
        if (amount === null) {
          reasons.add("invalid_raw_movement");
          continue;
        }
        const exactUnits =
          movement.quantityEvidence?.state === "exact"
            ? movement.quantityEvidence
            : null;
        if (exactUnits) {
          const debit = raw(exactUnits.debitRaw);
          const credit = raw(exactUnits.creditRaw);
          if (debit === null || credit === null)
            reasons.add("invalid_raw_movement");
          else {
            if (movement.fromWallet === input.walletAddress)
              reconstructed -= debit;
            if (movement.toWallet === input.walletAddress)
              reconstructed += credit;
          }
        } else
          reconstructed +=
            amount *
            boundary(
              movement.fromWallet,
              movement.toWallet,
              input.walletAddress,
            );
        if (movement.classification === "unresolved")
          reasons.add("unresolved_asset_movement");
      }
      for (const fee of tx.fees.filter(
        (item) =>
          item.chargedToAnalyzedWallet &&
          item.kind === "network" &&
          spotAssetKey(item.asset) === key,
      )) {
        const amount = raw(fee.rawAmount);
        if (amount === null) reasons.add("invalid_fee_amount");
        else reconstructed -= amount;
      }
      if (delta !== null && reconstructed !== delta)
        reasons.add("unexplained_asset_balance_residual");

      // Raw reconciliation is deliberately frozen before financial gates below.
      // An exact Token-2022 movement or a quote-to-quote conversion can reconcile
      // quantities without proving extension state, historical prices or PnL.
      const quantityReasons = [...reasons].filter((reason) => {
        if (FINANCIAL_ONLY_BLOCKERS.has(reason)) return false;
        if (reason === "unsupported_asset_activity") {
          const relevant = tx.blockers.filter((code) =>
            tx.blockerEvidence?.some(
              (item) =>
                item.code === code &&
                (item.scope === "transaction" ||
                  item.assetIds.length === 0 ||
                  item.assetIds.includes(key.slice("solana:".length))),
            ),
          );
          return (
            relevant.length === 0 ||
            relevant.some((code) => !FINANCIAL_ONLY_BLOCKERS.has(code))
          );
        }
        return true;
      });
      if (quantityReasons.length) quantitiesReconciled = false;
      quantityAssets.push({
        assetKey: key,
        state: quantityReasons.length ? "unresolved" : "reconciled",
        reasons: quantityReasons.sort(),
      });

      const assetSwaps = tx.swaps.filter(
        (swap) =>
          spotAssetKey(swap.input.asset) === key ||
          spotAssetKey(swap.output.asset) === key,
      );
      const assetTransfers = tx.transfers.filter(
        (event) => spotAssetKey(event.asset) === key,
      );
      if (assetSwaps.length > 0 && !tx.feesComplete)
        reasons.add("fee_coverage_incomplete");
      if (
        assetSwaps.some(
          (swap) =>
            SETTLEMENTS.has(spotAssetKey(swap.input.asset)) ===
            SETTLEMENTS.has(spotAssetKey(swap.output.asset)),
        )
      )
        reasons.add("non_quote_swap_financials_unsupported");
      const chargedAssetFees = tx.fees.filter(
        (fee) => fee.chargedToAnalyzedWallet && spotAssetKey(fee.asset) === key,
      );
      if (
        chargedAssetFees.some(
          (fee) =>
            units(fee.amount, fee.decimals) !== raw(fee.rawAmount) ||
            (evidence && evidence.decimals !== fee.decimals),
        )
      )
        reasons.add("fee_amount_not_exact");
      if (
        !SETTLEMENTS.has(key) &&
        chargedAssetFees.some((fee) => raw(fee.rawAmount) !== BigInt(0))
      )
        reasons.add("non_settlement_fee_disposal_basis_unproven");

      // Independently reconcile canonical gross legs against actual net units.
      if (evidence) {
        let economic = BigInt(0);
        const amountOf = (amount: string) => {
          const value = units(amount, evidence.decimals);
          if (value === null) reasons.add("canonical_amount_not_exact");
          return value ?? BigInt(0);
        };
        for (const swap of assetSwaps) {
          if (spotAssetKey(swap.input.asset) === key)
            economic -= amountOf(swap.input.amount);
          if (spotAssetKey(swap.output.asset) === key)
            economic += amountOf(swap.output.amount);
        }
        for (const event of assetTransfers)
          economic +=
            amountOf(event.amount) *
            boundary(event.fromWallet, event.toWallet, input.walletAddress);
        for (const fee of chargedAssetFees)
          economic -= raw(fee.rawAmount) ?? BigInt(0);
        for (const movement of tx.rawMovements.filter(
          (item) =>
            item.classification === "lifecycle" &&
            spotAssetKey(item.asset) === key,
        ))
          economic +=
            (raw(movement.rawAmount) ?? BigInt(0)) *
            boundary(
              movement.fromWallet,
              movement.toWallet,
              input.walletAddress,
            );
        if (delta !== null && economic !== delta)
          reasons.add("canonical_economic_balance_residual");
      }
      if (reasons.size) reconciled = false;
      for (const code of reasons) addIssue(code, key, tx.signature);
      if (!evidence) {
        for (const reason of reasons) active.get(key)?.reasons.add(reason);
        continue;
      }
      balances.set(key, {
        asset: evidence.asset,
        rawAmount: inventory?.post?.toString() ?? null,
        decimals: evidence.decimals,
        quantity:
          inventory?.post === null || inventory?.post === undefined
            ? null
            : display(inventory.post.toString(), evidence.decimals),
        settlement: SETTLEMENTS.has(key),
        lastObservedAt: tx.executedAt,
        slot: tx.slot,
        accountAddresses:
          inventory?.accounts
            .filter(
              (account) =>
                account.owner === input.walletAddress && !account.closed,
            )
            .map((account) => account.address) ?? [],
        coverage: "touched_accounts",
        aggregation: "observed_accounts",
        oldestObservationAt:
          inventory?.accounts
            .filter(
              (account) =>
                account.owner === input.walletAddress && !account.closed,
            )
            .map((account) => account.lastObservedAt)
            .filter((date): date is string => date !== null)
            .sort()[0] ?? tx.executedAt,
      });
      if (SETTLEMENTS.has(key)) continue;
      const inventoryPre = inventory?.pre ?? null;
      const inventoryPost = inventory?.post ?? null;
      let segment = active.get(key);
      if (segment && inventoryPre === BigInt(0) && segment.postRaw !== "0") {
        segment.reasons.add("asset_balance_discontinuity");
        segments.push(segment);
        active.delete(key);
        segment = undefined;
      }
      if (!segment) {
        if (
          assetSwaps.length === 0 &&
          assetTransfers.length === 0 &&
          inventoryPre === BigInt(0) &&
          inventoryPost === BigInt(0)
        )
          continue;
        segment = {
          key,
          asset: evidence.asset,
          decimals: evidence.decimals,
          preRaw: inventoryPre?.toString() ?? null,
          postRaw: null,
          swaps: [],
          transfers: [],
          transactions: [],
          reasons: new Set(baselineReasons),
        };
        if (inventoryPre !== BigInt(0))
          segment.reasons.add("initial_zero_inventory_unproven");
        active.set(key, segment);
      }
      segment.postRaw = inventoryPost?.toString() ?? null;
      transactionSegments.add(segment);
      segment.transactions.push(tx);
      for (const reason of reasons) segment.reasons.add(reason);
      if (tx.executedAt) {
        assetSwaps.forEach((swap, index) =>
          segment!.swaps.push({
            ...swap,
            eventOrder:
              transactionOrder * 10_000 +
              1 +
              (localOrderProven
                ? orderedActions.get(swap.id)!
                : (swap.eventOrder ?? index)),
            fees: swap.fees.filter((fee) => new Decimal(fee.amount).gt(0)),
          }),
        );
        assetTransfers.forEach((event, index) =>
          segment!.transfers.push({
            ...event,
            eventOrder:
              transactionOrder * 10_000 +
              1 +
              (localOrderProven
                ? orderedActions.get(event.id)!
                : (event.eventOrder ?? 5_000 + index)),
          }),
        );
        // Unsupported non-settlement fee units still leave inventory; no fake zero.
        chargedAssetFees
          .filter((fee) => (raw(fee.rawAmount) ?? BigInt(0)) > BigInt(0))
          .forEach((fee, index) =>
            segment!.transfers.push({
              kind: "transfer",
              id: `fee-disposal:${fee.id}`,
              executedAt: tx.executedAt!,
              eventOrder: transactionOrder * 10_000 + 9_000 + index,
              asset: fee.asset,
              amount: fee.amount,
              fromWallet: input.walletAddress,
              toWallet: null,
              costBasisStatus: "unknown",
            }),
          );
      }
      if (inventoryPost === BigInt(0)) {
        segments.push(segment);
        active.delete(key);
      }
    }
    // A token's economics depend on its quote and charged fee assets too. An
    // unexplained USDC/SOL delta must not leave the token's PnL apparently valid.
    for (const segment of transactionSegments) {
      const relatedSwaps = tx.swaps.filter((swap) =>
        [
          spotAssetKey(swap.input.asset),
          spotAssetKey(swap.output.asset),
        ].includes(segment.key),
      );
      const relevant = new Set([
        segment.key,
        ...relatedSwaps.flatMap((swap) => [
          spotAssetKey(swap.input.asset),
          spotAssetKey(swap.output.asset),
        ]),
        ...(relatedSwaps.length
          ? tx.fees
              .filter((fee) => fee.chargedToAnalyzedWallet)
              .map((fee) => spotAssetKey(fee.asset))
          : []),
      ]);
      for (const issue of issues)
        if (
          issue.signature === tx.signature &&
          issue.assetKey !== null &&
          relevant.has(issue.assetKey)
        )
          segment.reasons.add(issue.code);
    }
    if (reconciled) reconciledTransactions += 1;
    if (quantitiesReconciled) quantityReconciledTransactions += 1;
    quantityReconciliation.push({
      signature: tx.signature,
      state: quantitiesReconciled ? "reconciled" : "unresolved",
      assets: quantityAssets,
    });
    for (const fee of tx.fees) {
      const allocated =
        tx.swaps.length === 1 &&
        tx.state === "parsed" &&
        fee.chargedToAnalyzedWallet;
      let usdValue: string | null = null;
      if (fee.chargedToAnalyzedWallet && tx.executedAt) {
        if (raw(fee.rawAmount) === BigInt(0)) usdValue = "0";
        else {
          try {
            usdValue =
              priceIndex
                .resolveLeg(
                  { asset: fee.asset, amount: fee.amount },
                  tx.executedAt,
                )
                .value?.toString() ?? null;
          } catch {
            usdValue = null;
          }
        }
      }
      expenses.push({
        signature: tx.signature,
        kind: fee.kind,
        asset: fee.asset,
        rawAmount: fee.rawAmount,
        chargedToAnalyzedWallet: fee.chargedToAnalyzedWallet,
        usdValue,
        allocatedToEpisode: allocated,
      });
      if (fee.chargedToAnalyzedWallet && !allocated) {
        if (usdValue === null) unallocatedFeesKnown = false;
        else unallocatedFees = unallocatedFees.plus(usdValue);
      }
    }
  });
  segments.push(...active.values());

  const episodes: SolanaLedgerEpisode[] = [];
  const openPositions: SolanaLedgerReport["openPositions"] = [];
  segments.forEach((segment, segmentIndex) => {
    const first = segment.transactions[0];
    if (!first?.executedAt || segment.swaps.length === 0) return;
    const transfers = [...segment.transfers];
    if (segment.preRaw !== null && BigInt(segment.preRaw) > BigInt(0))
      transfers.unshift({
        kind: "transfer",
        id: `unproven-initial:${segmentIndex}`,
        asset: segment.asset,
        amount: display(segment.preRaw, segment.decimals),
        executedAt: first.executedAt,
        eventOrder: Math.max(
          0,
          Math.min(...segment.swaps.map((swap) => swap.eventOrder ?? 0)) - 1,
        ),
        fromWallet: null,
        toWallet: input.walletAddress,
        costBasisStatus: "unknown",
      });
    try {
      const settlementAssetKeys = [
        ...new Set([
          ...SETTLEMENTS,
          ...segment.swaps
            .flatMap((swap) => [
              spotAssetKey(swap.input.asset),
              spotAssetKey(swap.output.asset),
            ])
            .filter((key) => key !== segment.key),
        ]),
      ];
      const result = analyzeSpotActivityExact({
        ownedWallets: [input.walletAddress],
        settlementAssetKeys,
        swaps: segment.swaps,
        transfers,
        prices,
        maxPriceAgeMs: input.maxPriceAgeMs,
      });
      const engineRemaining = result.openPositions
        .filter((position) => spotAssetKey(position.asset) === segment.key)
        .reduce((sum, position) => sum.plus(position.quantity), new Decimal(0));
      if (
        segment.postRaw === null ||
        !engineRemaining.eq(display(segment.postRaw, segment.decimals))
      )
        segment.reasons.add("episode_inventory_reconciliation_failed");
      const routingSet = new Set(
        segment.transactions
          .filter((tx) => tx.swaps.length > 0)
          .map((tx) => tx.sourceScope),
      );
      const routing =
        routingSet.size === 1 && routingSet.has("fomo_routed")
          ? "fomo_routed"
          : routingSet.size > 1
            ? "mixed"
            : "wallet_all_activity";
      for (const episode of result.episodes) {
        const reasons = [
          ...new Set([...segment.reasons, ...episode.invalidReasons]),
        ].sort();
        episodes.push({
          ...maskEpisode(episode, reasons),
          id: `${segmentIndex}:${episode.id}`,
          financialScope: "wallet_all_activity",
          routing,
          evidenceReasons: reasons,
          checks: buildSolanaEpisodeChecks({
            asset: segment.asset,
            episode: maskEpisode(episode, reasons),
            reasons,
            swaps: segment.swaps,
            transactions: segment.transactions,
            reconciliation: quantityReconciliation,
            prices: priceIndex,
          }),
          signatures: segment.transactions
            .map((tx) => tx.signature)
            .filter((value): value is string => value !== null),
          payloadSha256: segment.transactions.map(
            (tx) => tx.provenance.payloadSha256,
          ),
        });
      }
      for (const position of result.openPositions)
        openPositions.push({
          asset: position.asset,
          quantity: position.quantity,
          costBasisUsd: segment.reasons.size
            ? null
            : position.exact.costBasisUsd,
          reasons: [...segment.reasons].sort(),
        });
    } catch {
      addIssue("episode_reconstruction_failed", segment.key, first.signature);
    }
  });
  return {
    version: SOLANA_LOCAL_LEDGER_VERSION,
    walletAddress: input.walletAddress,
    financialScope: "wallet_all_activity",
    summary: {
      ...calculateSpotExactMetrics(episodes),
      observedTransactions,
      reconciledTransactions,
      quantityReconciledTransactions,
      unsupportedTransactions,
      unallocatedFeeExpenseUsd: unallocatedFeesKnown
        ? unallocatedFees.toString()
        : null,
      wholeWalletPnlUsd: null,
    },
    episodes,
    openPositions,
    accountInventory: accountLedger.snapshot(),
    quantityReconciliation,
    balances: [...balances.values()].sort((a, b) =>
      spotAssetKey(a.asset).localeCompare(spotAssetKey(b.asset)),
    ),
    issues,
    expenses,
    provenance: {
      coverageProofSha256: [...input.coverage.proofSha256],
      transactionPayloadSha256: [
        ...new Set(transactions.map((tx) => tx.provenance.payloadSha256)),
      ],
      priceIds: prices.map((price) => price.id),
    },
  };
}
