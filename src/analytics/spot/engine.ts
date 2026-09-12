import Decimal from "decimal.js";

import { unavailable } from "../value";
import {
  accumulator,
  accumulatorDatum,
  addResolved,
  decimalDatum,
  ExactSpotDecimal,
  missing,
  parseDecimal,
  resolved,
  type DecimalAccumulator,
  type ResolvedDecimal,
} from "./decimal";
import { calculateSpotMetrics, calculateSpotExactMetrics } from "./metrics";
import {
  DEFAULT_MAX_PRICE_AGE_MS,
  SpotPriceIndex,
  spotAssetKey,
} from "./prices";
import type {
  AnalyzeSpotActivityInput,
  CanonicalSpotFee,
  CanonicalSpotSwap,
  CanonicalSpotTransfer,
  SpotAnalyticsResult,
  SpotAssetRef,
  SpotEpisode,
  SpotEpisodeInvalidReason,
  SpotOpenPosition,
  SpotExactAnalyticsResult,
  SpotExactEpisode,
} from "./types";
import { SPOT_ANALYTICS_VERSION } from "./version";

interface EpisodeBuilder {
  Decimal: typeof Decimal;
  id: string;
  asset: SpotAssetRef;
  openedAt: string;
  closedAt: string | null;
  swapIds: string[];
  transferIds: string[];
  invalidReasons: Set<SpotEpisodeInvalidReason>;
  acquisitionCostUsd: DecimalAccumulator;
  grossProceedsUsd: DecimalAccumulator;
  feesUsd: DecimalAccumulator;
  realizedPnlUsd: DecimalAccumulator;
}

interface AssetState {
  Decimal: typeof Decimal;
  asset: SpotAssetRef;
  quantity: Decimal;
  costBasisUsd: Decimal;
  basisKnown: boolean;
  sequence: number;
  current: EpisodeBuilder | null;
}

type OrderedEvent =
  | (CanonicalSpotSwap & { readonly eventType: "swap" })
  | (CanonicalSpotTransfer & { readonly eventType: "transfer" });

function validateTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new Error(`${label} is not a valid timestamp`);
  return parsed;
}

function validateEventBase(
  event: CanonicalSpotSwap | CanonicalSpotTransfer,
): void {
  if (event.id.trim() === "")
    throw new Error("Spot event id must not be blank");
  validateTimestamp(event.executedAt, `Event ${event.id} executedAt`);
  if (
    event.eventOrder !== undefined &&
    (!Number.isSafeInteger(event.eventOrder) || event.eventOrder < 0)
  ) {
    throw new Error(
      `Event ${event.id} eventOrder must be a non-negative integer`,
    );
  }
}

function startEpisode(state: AssetState, openedAt: string): EpisodeBuilder {
  state.sequence += 1;
  const builder: EpisodeBuilder = {
    Decimal: state.Decimal,
    id: `${spotAssetKey(state.asset)}:${state.sequence}`,
    asset: state.asset,
    openedAt,
    closedAt: null,
    swapIds: [],
    transferIds: [],
    invalidReasons: new Set(),
    acquisitionCostUsd: accumulator(state.Decimal),
    grossProceedsUsd: accumulator(state.Decimal),
    feesUsd: accumulator(state.Decimal),
    realizedPnlUsd: accumulator(state.Decimal),
  };
  state.current = builder;
  return builder;
}

function currentEpisode(state: AssetState, executedAt: string): EpisodeBuilder {
  return state.current ?? startEpisode(state, executedAt);
}

function pushUnique(target: string[], id: string): void {
  if (target.at(-1) !== id && !target.includes(id)) target.push(id);
}

function invalidate(
  builder: EpisodeBuilder,
  reason: SpotEpisodeInvalidReason,
): void {
  builder.invalidReasons.add(reason);
}

function unavailableAccumulator(
  target: DecimalAccumulator,
  reason: string,
): void {
  addResolved(target, missing(reason));
}

function finalizeEpisode(
  builder: EpisodeBuilder,
  exactOutput = false,
): SpotEpisode | SpotExactEpisode {
  const acquisitionCostUsd = accumulatorDatum(
    builder.acquisitionCostUsd,
    "acquisition_cost_unavailable",
  );
  const grossProceedsUsd = accumulatorDatum(
    builder.grossProceedsUsd,
    "gross_proceeds_unavailable",
  );
  const feesUsd = accumulatorDatum(builder.feesUsd, "fees_usd_unavailable");
  const realizedPnlUsd = accumulatorDatum(
    builder.realizedPnlUsd,
    "realized_pnl_unavailable",
  );
  const eligibleForMetrics =
    builder.closedAt !== null &&
    builder.invalidReasons.size === 0 &&
    acquisitionCostUsd.value !== null &&
    grossProceedsUsd.value !== null &&
    feesUsd.value !== null &&
    realizedPnlUsd.value !== null;

  const closedReturnPct = !builder.closedAt
    ? unavailable("episode_open")
    : !eligibleForMetrics
      ? unavailable("episode_not_eligible")
      : acquisitionCostUsd.value === null || acquisitionCostUsd.value <= 0
        ? unavailable("non_positive_acquisition_cost")
        : decimalDatum(
            new Decimal(realizedPnlUsd.value ?? 0)
              .div(acquisitionCostUsd.value)
              .mul(100),
          );

  return {
    id: builder.id,
    asset: builder.asset,
    openedAt: builder.openedAt,
    closedAt: builder.closedAt,
    closed: builder.closedAt !== null,
    eligibleForMetrics,
    swapIds: [...builder.swapIds],
    transferIds: [...builder.transferIds],
    invalidReasons: [...builder.invalidReasons].sort(),
    acquisitionCostUsd,
    grossProceedsUsd,
    feesUsd,
    realizedPnlUsd,
    closedReturnPct,
    ...(exactOutput
      ? {
          exact: {
            acquisitionCostUsd: builder.acquisitionCostUsd.available
              ? builder.acquisitionCostUsd.value.toString()
              : null,
            grossProceedsUsd: builder.grossProceedsUsd.available
              ? builder.grossProceedsUsd.value.toString()
              : null,
            feesUsd: builder.feesUsd.available
              ? builder.feesUsd.value.toString()
              : null,
            realizedPnlUsd: builder.realizedPnlUsd.available
              ? builder.realizedPnlUsd.value.toString()
              : null,
            closedReturnPct:
              eligibleForMetrics && builder.acquisitionCostUsd.value.gt(0)
                ? builder.realizedPnlUsd.value
                    .div(builder.acquisitionCostUsd.value)
                    .mul(100)
                    .toString()
                : null,
          },
        }
      : {}),
  };
}

function firstKnown(
  preferred: ResolvedDecimal,
  fallback: ResolvedDecimal,
): ResolvedDecimal {
  return preferred.value === null ? fallback : preferred;
}

function addFeeToEpisode(
  builder: EpisodeBuilder,
  feeUsd: ResolvedDecimal,
): void {
  addResolved(builder.feesUsd, feeUsd);
  if (feeUsd.value === null) invalidate(builder, "fee_usd_unavailable");
}

function resolveFees(
  fees: readonly CanonicalSpotFee[],
  executedAt: string,
  prices: SpotPriceIndex,
  Constructor: typeof Decimal,
): ResolvedDecimal {
  let total = new Constructor(0);
  for (const fee of fees) {
    const value = prices.resolveLeg(fee, executedAt);
    if (value.value === null) return missing("fee_usd_unavailable");
    total = total.plus(value.value);
  }
  return resolved(total, Constructor);
}

function getState(
  states: Map<string, AssetState>,
  asset: SpotAssetRef,
  Constructor: typeof Decimal,
): AssetState {
  const key = spotAssetKey(asset);
  const existing = states.get(key);
  if (existing) return existing;
  const created: AssetState = {
    Decimal: Constructor,
    asset,
    quantity: new Constructor(0),
    costBasisUsd: new Constructor(0),
    basisKnown: true,
    sequence: 0,
    current: null,
  };
  states.set(key, created);
  return created;
}

function closeAtZero(
  state: AssetState,
  executedAt: string,
  completed: EpisodeBuilder[],
): void {
  if (!state.quantity.isZero()) return;
  if (state.current) {
    state.current.closedAt = executedAt;
    completed.push(state.current);
  }
  state.current = null;
  state.costBasisUsd = new state.Decimal(0);
  state.basisKnown = true;
}

function acquire(
  state: AssetState,
  swap: CanonicalSpotSwap,
  amount: Decimal,
  principalUsd: ResolvedDecimal,
  feeUsd: ResolvedDecimal,
  completed: EpisodeBuilder[],
): void {
  closeAtZero(state, swap.executedAt, completed);
  const episode = currentEpisode(state, swap.executedAt);
  pushUnique(episode.swapIds, swap.id);
  addFeeToEpisode(episode, feeUsd);

  const totalCost =
    principalUsd.value === null || feeUsd.value === null
      ? missing(
          feeUsd.value === null
            ? "fee_usd_unavailable"
            : "swap_usd_value_unavailable",
        )
      : resolved(principalUsd.value.plus(feeUsd.value), state.Decimal);
  addResolved(episode.acquisitionCostUsd, totalCost);

  if (totalCost.value === null) {
    invalidate(
      episode,
      feeUsd.value === null
        ? "fee_usd_unavailable"
        : "swap_usd_value_unavailable",
    );
    state.basisKnown = false;
  } else if (state.basisKnown) {
    state.costBasisUsd = state.costBasisUsd.plus(totalCost.value);
  }
  state.quantity = state.quantity.plus(amount);
}

function synthesizeUnknownInventory(
  state: AssetState,
  amount: Decimal,
  executedAt: string,
  swapId?: string,
): EpisodeBuilder {
  const episode = currentEpisode(state, executedAt);
  if (swapId) pushUnique(episode.swapIds, swapId);
  invalidate(episode, "inventory_history_incomplete");
  unavailableAccumulator(
    episode.acquisitionCostUsd,
    "unknown_inventory_cost_basis",
  );
  state.quantity = state.quantity.plus(amount);
  state.basisKnown = false;
  return episode;
}

function dispose(
  state: AssetState,
  swap: CanonicalSpotSwap,
  amount: Decimal,
  proceedsUsd: ResolvedDecimal,
  feeUsd: ResolvedDecimal,
  completed: EpisodeBuilder[],
): void {
  if (state.quantity.lt(amount)) {
    synthesizeUnknownInventory(
      state,
      amount.minus(state.quantity),
      swap.executedAt,
      swap.id,
    );
  }
  const episode = currentEpisode(state, swap.executedAt);
  pushUnique(episode.swapIds, swap.id);
  addResolved(episode.grossProceedsUsd, proceedsUsd);
  addFeeToEpisode(episode, feeUsd);
  if (proceedsUsd.value === null)
    invalidate(episode, "swap_usd_value_unavailable");

  const priorQuantity = state.quantity;
  const disposedCost = state.basisKnown
    ? resolved(state.costBasisUsd.mul(amount).div(priorQuantity), state.Decimal)
    : missing("unknown_inventory_cost_basis");
  const pnl =
    proceedsUsd.value === null ||
    feeUsd.value === null ||
    disposedCost.value === null
      ? missing(
          feeUsd.value === null
            ? "fee_usd_unavailable"
            : proceedsUsd.value === null
              ? "swap_usd_value_unavailable"
              : "unknown_inventory_cost_basis",
        )
      : resolved(
          proceedsUsd.value.minus(disposedCost.value).minus(feeUsd.value),
          state.Decimal,
        );
  addResolved(episode.realizedPnlUsd, pnl);

  if (state.basisKnown && disposedCost.value !== null) {
    state.costBasisUsd = state.costBasisUsd.minus(disposedCost.value);
  }
  state.quantity = state.quantity.minus(amount);
  closeAtZero(state, swap.executedAt, completed);
}

function processSwap(
  swap: CanonicalSpotSwap,
  ownedWallets: Set<string>,
  settlements: Set<string>,
  prices: SpotPriceIndex,
  states: Map<string, AssetState>,
  completed: EpisodeBuilder[],
  Constructor: typeof Decimal,
): void {
  if (!ownedWallets.has(swap.wallet)) {
    throw new Error(`Swap ${swap.id} wallet is not in ownedWallets`);
  }
  if (spotAssetKey(swap.input.asset) === spotAssetKey(swap.output.asset)) {
    throw new Error(`Swap ${swap.id} has the same input and output asset`);
  }

  const inputAmount = parseDecimal(
    swap.input.amount,
    `Swap ${swap.id} input`,
    false,
    Constructor,
  );
  const outputAmount = parseDecimal(
    swap.output.amount,
    `Swap ${swap.id} output`,
    false,
    Constructor,
  );
  const inputUsd = prices.resolveLeg(swap.input, swap.executedAt);
  const outputUsd = prices.resolveLeg(swap.output, swap.executedAt);
  const feeUsd = resolveFees(swap.fees, swap.executedAt, prices, Constructor);
  const inputTracked = !settlements.has(spotAssetKey(swap.input.asset));
  const outputTracked = !settlements.has(spotAssetKey(swap.output.asset));

  if (inputTracked) {
    dispose(
      getState(states, swap.input.asset, Constructor),
      swap,
      inputAmount,
      firstKnown(outputUsd, inputUsd),
      feeUsd,
      completed,
    );
  }
  if (outputTracked) {
    acquire(
      getState(states, swap.output.asset, Constructor),
      swap,
      outputAmount,
      firstKnown(inputUsd, outputUsd),
      inputTracked ? resolved(0, Constructor) : feeUsd,
      completed,
    );
  }
}

function processTransfer(
  transfer: CanonicalSpotTransfer,
  ownedWallets: Set<string>,
  settlements: Set<string>,
  states: Map<string, AssetState>,
  completed: EpisodeBuilder[],
  Constructor: typeof Decimal,
): void {
  const fromOwned =
    transfer.fromWallet !== null && ownedWallets.has(transfer.fromWallet);
  const toOwned =
    transfer.toWallet !== null && ownedWallets.has(transfer.toWallet);
  if (
    (!fromOwned && !toOwned) ||
    settlements.has(spotAssetKey(transfer.asset))
  ) {
    return;
  }
  const amount = parseDecimal(
    transfer.amount,
    `Transfer ${transfer.id} amount`,
    false,
    Constructor,
  );
  const state = getState(states, transfer.asset, Constructor);

  if (fromOwned && toOwned) {
    if (state.current) {
      pushUnique(state.current.transferIds, transfer.id);
      if (transfer.costBasisStatus !== "preserved") {
        invalidate(state.current, "transfer_cost_basis_unknown");
        unavailableAccumulator(
          state.current.acquisitionCostUsd,
          "transfer_cost_basis_unknown",
        );
        unavailableAccumulator(
          state.current.realizedPnlUsd,
          "transfer_cost_basis_unknown",
        );
        state.basisKnown = false;
      }
    }
    return;
  }

  if (toOwned) {
    const episode = currentEpisode(state, transfer.executedAt);
    pushUnique(episode.transferIds, transfer.id);
    invalidate(episode, "unknown_inbound_inventory");
    unavailableAccumulator(
      episode.acquisitionCostUsd,
      "unknown_inbound_inventory",
    );
    state.quantity = state.quantity.plus(amount);
    state.basisKnown = false;
    return;
  }

  if (state.quantity.lt(amount)) {
    synthesizeUnknownInventory(
      state,
      amount.minus(state.quantity),
      transfer.executedAt,
    );
  }
  const episode = currentEpisode(state, transfer.executedAt);
  pushUnique(episode.transferIds, transfer.id);
  invalidate(episode, "external_outbound_inventory");
  if (state.basisKnown) {
    state.costBasisUsd = state.costBasisUsd.minus(
      state.costBasisUsd.mul(amount).div(state.quantity),
    );
  }
  state.quantity = state.quantity.minus(amount);
  unavailableAccumulator(episode.realizedPnlUsd, "external_outbound_inventory");
  closeAtZero(state, transfer.executedAt, completed);
}

function openPosition(
  state: AssetState,
  exactOutput = false,
): SpotOpenPosition | null {
  if (state.quantity.isZero() || !state.current) return null;
  return {
    asset: state.asset,
    quantity: state.quantity.toString(),
    costBasisUsd: state.basisKnown
      ? decimalDatum(state.costBasisUsd)
      : unavailable("unknown_inventory_cost_basis"),
    averageCostUsd: state.basisKnown
      ? decimalDatum(state.costBasisUsd.div(state.quantity))
      : unavailable("unknown_inventory_cost_basis"),
    episodeId: state.current.id,
    ...(exactOutput
      ? {
          exact: {
            costBasisUsd: state.basisKnown
              ? state.costBasisUsd.toString()
              : null,
            averageCostUsd: state.basisKnown
              ? state.costBasisUsd.div(state.quantity).toString()
              : null,
          },
        }
      : {}),
  };
}

/**
 * Reconstructs linked-wallet spot inventory with moving-average cost basis.
 * Canonical leg amounts exclude separately itemized fees. A fee affects USD
 * economics only when its explicit value or an acceptably fresh price exists.
 */
function analyzeSpotCore(
  input: AnalyzeSpotActivityInput,
  exactOutput = false,
): SpotAnalyticsResult {
  const Constructor = exactOutput ? ExactSpotDecimal : Decimal;
  const ownedWallets = new Set(input.ownedWallets);
  if (ownedWallets.size === 0)
    throw new Error("ownedWallets must not be empty");
  if ([...ownedWallets].some((wallet) => wallet.trim() === "")) {
    throw new Error("Owned wallet must not be blank");
  }
  const settlements = new Set(input.settlementAssetKeys);
  const prices = new SpotPriceIndex(
    input.prices ?? [],
    input.maxPriceAgeMs ?? DEFAULT_MAX_PRICE_AGE_MS,
    Constructor,
  );
  const states = new Map<string, AssetState>();
  const completed: EpisodeBuilder[] = [];
  const seen = new Set<string>();
  const events: OrderedEvent[] = [
    ...input.transfers.map((event) => ({
      ...event,
      eventType: "transfer" as const,
    })),
    ...input.swaps.map((event) => ({ ...event, eventType: "swap" as const })),
  ].sort((left, right) => {
    if (
      exactOutput &&
      left.eventOrder !== undefined &&
      right.eventOrder !== undefined
    ) {
      const provenOrder = left.eventOrder - right.eventOrder;
      if (provenOrder !== 0) return provenOrder;
    }
    const time =
      validateTimestamp(left.executedAt, `Event ${left.id} executedAt`) -
      validateTimestamp(right.executedAt, `Event ${right.id} executedAt`);
    if (time !== 0) return time;
    const order = (left.eventOrder ?? 0) - (right.eventOrder ?? 0);
    if (order !== 0) return order;
    const type = left.eventType.localeCompare(right.eventType);
    return type === 0 ? left.id.localeCompare(right.id) : type;
  });

  for (const event of events) {
    validateEventBase(event);
    const key = `${event.eventType}:${event.id}`;
    if (seen.has(key)) throw new Error(`Duplicate spot event: ${key}`);
    seen.add(key);
    if (event.eventType === "swap") {
      processSwap(
        event,
        ownedWallets,
        settlements,
        prices,
        states,
        completed,
        Constructor,
      );
    } else {
      processTransfer(
        event,
        ownedWallets,
        settlements,
        states,
        completed,
        Constructor,
      );
    }
  }

  const allEpisodes = [
    ...completed,
    ...[...states.values()]
      .map((state) => state.current)
      .filter((episode): episode is EpisodeBuilder => episode !== null),
  ]
    .map((episode) => finalizeEpisode(episode, exactOutput))
    .sort((left, right) => {
      const time = Date.parse(left.openedAt) - Date.parse(right.openedAt);
      return time === 0 ? left.id.localeCompare(right.id) : time;
    });
  const openPositions = [...states.values()]
    .map((state) => openPosition(state, exactOutput))
    .filter((position): position is SpotOpenPosition => position !== null)
    .sort((left, right) =>
      spotAssetKey(left.asset).localeCompare(spotAssetKey(right.asset)),
    );

  return {
    methodologyVersion: SPOT_ANALYTICS_VERSION,
    episodes: allEpisodes,
    openPositions,
    metrics: calculateSpotMetrics(allEpisodes),
  };
}

/** Legacy numeric API and v1 precision remain unchanged for deployed snapshots. */
export function analyzeSpotActivity(
  input: AnalyzeSpotActivityInput,
): SpotAnalyticsResult {
  return analyzeSpotCore(input);
}

/** Opt-in local analysis: same moving-average core, 100-digit decimal arithmetic. */
export function analyzeSpotActivityExact(
  input: AnalyzeSpotActivityInput,
): SpotExactAnalyticsResult {
  const result = analyzeSpotCore(input, true);
  const episodes = result.episodes as readonly SpotExactEpisode[];
  return {
    methodologyVersion: "spot-moving-average-local-exact-v2",
    episodes,
    openPositions:
      result.openPositions as SpotExactAnalyticsResult["openPositions"],
    metrics: calculateSpotExactMetrics(episodes),
  };
}
