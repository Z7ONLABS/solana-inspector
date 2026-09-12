export type MetricStatus = "observed" | "derived" | "unavailable";

export type KnownMetricStatus = Exclude<MetricStatus, "unavailable">;

export interface MetricDatum {
  readonly value: number | null;
  readonly status: MetricStatus;
  readonly reason?: string;
}

export interface SampleFloor {
  readonly minClosedEpisodes: number;
  readonly minActiveDays: number;
}

export interface SampleSize {
  readonly closedEpisodes: number;
  readonly activeDays: number;
}

export const DEFAULT_SAMPLE_FLOOR: Readonly<SampleFloor> = Object.freeze({
  minClosedEpisodes: 30,
  minActiveDays: 10,
});

export type TradeSide = "buy" | "sell";
export type TradeDirection = "long" | "short";

export interface CanonicalFill {
  readonly id: string;
  readonly market: string;
  readonly executedAt: string;
  readonly side: TradeSide;
  readonly size: number;
  readonly notional: MetricDatum;
  readonly closedPnl: MetricDatum;
  readonly builderFee: MetricDatum;
  readonly venueFee: MetricDatum;
}

export interface TradeEpisode {
  readonly id: string;
  readonly market: string;
  readonly direction: TradeDirection;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly closed: boolean;
  readonly maxAbsPosition: number;
  readonly fillIds: readonly string[];
  readonly realizedPnl: MetricDatum;
  readonly fees: MetricDatum;
  readonly netPnl: MetricDatum;
  readonly notional: MetricDatum;
}

export interface DrawdownResult {
  readonly amount: MetricDatum;
  readonly percentage: MetricDatum;
  readonly amountPeakIndex: number | null;
  readonly amountTroughIndex: number | null;
  readonly percentagePeakIndex: number | null;
  readonly percentageTroughIndex: number | null;
}

export interface TwrSubperiod {
  /** Equity immediately after the prior external flow. Must be positive. */
  readonly openingValue: MetricDatum;
  /** Equity immediately before this subperiod's ending external flow. */
  readonly closingValue: MetricDatum;
  /** Deposits are positive and withdrawals are negative; assumed at period end. */
  readonly externalFlowAtEnd: MetricDatum;
}

export interface MetricOptions {
  readonly sample?: SampleSize;
  readonly floor?: SampleFloor;
}

export interface StyleAction {
  readonly id: string;
  readonly occurredAt: string;
  readonly tokenKey: string | null;
  readonly usdValue: MetricDatum;
  /** Economic focus-token direction when it can be reconstructed. */
  readonly side?: TradeSide | null;
}

export type AnalysisEligibilityState = "ready" | "limited" | "activity_only";

export interface AnalysisEligibilityResult {
  readonly state: AnalysisEligibilityState;
  readonly reasons: readonly string[];
}

export interface AnalysisEligibilityInput {
  readonly eligibleActions: number;
  readonly activeDays: number;
  readonly periodComplete: boolean;
  readonly deepHistoryAvailable: boolean;
  readonly activityOnlyReason?: string;
}
