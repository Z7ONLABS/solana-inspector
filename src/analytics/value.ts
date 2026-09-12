import type {
  KnownMetricStatus,
  MetricDatum,
  MetricStatus,
  SampleFloor,
  SampleSize,
} from "@/types/analytics";

export function unavailable(reason: string): MetricDatum {
  return { value: null, status: "unavailable", reason };
}

export function known(
  value: number,
  status: KnownMetricStatus = "observed",
): MetricDatum {
  if (!Number.isFinite(value)) {
    return unavailable("non_finite_value");
  }

  return { value, status };
}

export function validateDatum(datum: MetricDatum): MetricDatum {
  if (datum.status === "unavailable" || datum.value === null) {
    return unavailable(datum.reason ?? "missing_value");
  }

  return known(datum.value, datum.status);
}

export function combineKnownStatus(data: readonly MetricDatum[]): MetricStatus {
  if (
    data.some((datum) => datum.status === "unavailable" || datum.value === null)
  ) {
    return "unavailable";
  }

  return data.some((datum) => datum.status === "derived")
    ? "derived"
    : "observed";
}

export function sumData(
  data: readonly MetricDatum[],
  emptyValue = 0,
): MetricDatum {
  if (data.length === 0) {
    return known(emptyValue);
  }

  const validated = data.map(validateDatum);
  const status = combineKnownStatus(validated);
  if (status === "unavailable") {
    return unavailable(
      validated.find((datum) => datum.status === "unavailable")?.reason ??
        "missing_component",
    );
  }

  return known(
    validated.reduce((total, datum) => total + (datum.value ?? 0), 0),
    status,
  );
}

export function scaleDatum(datum: MetricDatum, factor: number): MetricDatum {
  const validated = validateDatum(datum);
  if (validated.status === "unavailable" || validated.value === null) {
    return validated;
  }
  if (!Number.isFinite(factor) || factor < 0) {
    return unavailable("invalid_scale_factor");
  }

  return known(validated.value * factor, validated.status);
}

export function assessSampleFloor(
  sample: SampleSize,
  floor: SampleFloor,
): string | null {
  if (!Number.isInteger(sample.closedEpisodes) || sample.closedEpisodes < 0) {
    return "invalid_closed_episode_count";
  }
  if (!Number.isInteger(sample.activeDays) || sample.activeDays < 0) {
    return "invalid_active_day_count";
  }
  if (
    !Number.isInteger(floor.minClosedEpisodes) ||
    floor.minClosedEpisodes < 1
  ) {
    return "invalid_min_closed_episodes";
  }
  if (!Number.isInteger(floor.minActiveDays) || floor.minActiveDays < 1) {
    return "invalid_min_active_days";
  }
  if (sample.closedEpisodes < floor.minClosedEpisodes) {
    return `sample_floor_closed_episodes:${sample.closedEpisodes}/${floor.minClosedEpisodes}`;
  }
  if (sample.activeDays < floor.minActiveDays) {
    return `sample_floor_active_days:${sample.activeDays}/${floor.minActiveDays}`;
  }

  return null;
}
