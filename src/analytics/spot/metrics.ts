import Decimal from "decimal.js";

import { decimalDatum, ExactSpotDecimal } from "./decimal";
import type {
  SpotAnalyticsMetrics,
  SpotEpisode,
  SpotExactEpisode,
  SpotExactAnalyticsResult,
} from "./types";
import { unavailable } from "../value";

const MIN_VALID_EPISODES = 30;

export function calculateSpotExactMetrics(
  episodes: readonly SpotExactEpisode[],
): SpotExactAnalyticsResult["metrics"] {
  const closed = episodes.filter((episode) => episode.closed);
  const valid = closed.filter((episode) => episode.eligibleForMetrics);
  const pnl = valid.reduce(
    (sum, episode) => sum.plus(episode.exact.realizedPnlUsd!),
    new ExactSpotDecimal(0),
  );
  const cost = valid.reduce(
    (sum, episode) => sum.plus(episode.exact.acquisitionCostUsd!),
    new ExactSpotDecimal(0),
  );
  const gains = valid.reduce(
    (sum, episode) =>
      ExactSpotDecimal.max(episode.exact.realizedPnlUsd!, 0).plus(sum),
    new ExactSpotDecimal(0),
  );
  const losses = valid.reduce(
    (sum, episode) =>
      ExactSpotDecimal.min(episode.exact.realizedPnlUsd!, 0).abs().plus(sum),
    new ExactSpotDecimal(0),
  );
  return {
    closedEpisodes: closed.length,
    validClosedEpisodes: valid.length,
    validEpisodeCoveragePct: closed.length
      ? new ExactSpotDecimal(valid.length)
          .div(closed.length)
          .mul(100)
          .toString()
      : null,
    validClosedEpisodePnlUsd: valid.length ? pnl.toString() : null,
    weightedClosedReturnPct:
      valid.length && cost.gt(0) ? pnl.div(cost).mul(100).toString() : null,
    winRatePct:
      valid.length >= MIN_VALID_EPISODES
        ? new ExactSpotDecimal(
            valid.filter((episode) =>
              new ExactSpotDecimal(episode.exact.realizedPnlUsd!).gt(0),
            ).length,
          )
            .div(valid.length)
            .mul(100)
            .toString()
        : null,
    profitFactor:
      valid.length >= MIN_VALID_EPISODES && losses.gt(0)
        ? gains.div(losses).toString()
        : null,
  };
}

export function calculateSpotMetrics(
  episodes: readonly SpotEpisode[],
): SpotAnalyticsMetrics {
  const closed = episodes.filter((episode) => episode.closed);
  const valid = closed.filter((episode) => episode.eligibleForMetrics);
  const coverage =
    closed.length === 0
      ? unavailable("no_closed_episodes")
      : decimalDatum(new Decimal(valid.length).div(closed.length).mul(100));

  const pnlValues = valid.map((episode) => episode.realizedPnlUsd.value);
  const costValues = valid.map((episode) => episode.acquisitionCostUsd.value);
  const validValuesKnown =
    pnlValues.every((value): value is number => value !== null) &&
    costValues.every((value): value is number => value !== null);

  const totalPnl = validValuesKnown
    ? pnlValues.reduce((sum, value) => sum.plus(value), new Decimal(0))
    : null;
  const totalCost = validValuesKnown
    ? costValues.reduce((sum, value) => sum.plus(value), new Decimal(0))
    : null;
  const sampleReason = `sample_floor_valid_episodes:${valid.length}/${MIN_VALID_EPISODES}`;

  let winRate = unavailable(sampleReason);
  let profitFactor = unavailable(sampleReason);
  if (valid.length >= MIN_VALID_EPISODES && validValuesKnown) {
    const wins = pnlValues.filter((value) => value > 0).length;
    winRate = decimalDatum(new Decimal(wins).div(valid.length).mul(100));

    const grossProfit = pnlValues.reduce(
      (sum, value) => (value > 0 ? sum.plus(value) : sum),
      new Decimal(0),
    );
    const grossLoss = pnlValues.reduce(
      (sum, value) => (value < 0 ? sum.plus(Math.abs(value)) : sum),
      new Decimal(0),
    );
    profitFactor = grossLoss.isZero()
      ? unavailable("no_losing_episodes")
      : decimalDatum(grossProfit.div(grossLoss));
  }

  return {
    closedEpisodes: closed.length,
    validClosedEpisodes: valid.length,
    validEpisodeCoveragePct: coverage,
    validClosedEpisodePnlUsd:
      totalPnl === null || valid.length === 0
        ? unavailable("no_valid_closed_episodes")
        : decimalDatum(totalPnl),
    weightedClosedReturnPct:
      totalPnl === null || totalCost === null || !totalCost.isPositive()
        ? unavailable("no_valid_acquisition_cost")
        : decimalDatum(totalPnl.div(totalCost).mul(100)),
    winRatePct: winRate,
    profitFactor,
  };
}
