import Decimal from "decimal.js";

import type { MetricDatum } from "@/types/analytics";
import { known, unavailable } from "../value";

export interface ResolvedDecimal {
  readonly value: Decimal | null;
  readonly reason?: string;
}

export interface DecimalAccumulator {
  value: Decimal;
  available: boolean;
  reason?: string;
}

export const ExactSpotDecimal = Decimal.clone({ precision: 100 });

export function accumulator(
  Constructor: typeof Decimal = Decimal,
): DecimalAccumulator {
  return { value: new Constructor(0), available: true };
}

export function addResolved(
  target: DecimalAccumulator,
  component: ResolvedDecimal,
): void {
  if (component.value === null) {
    target.available = false;
    target.reason ??= component.reason ?? "missing_component";
    return;
  }

  target.value = target.value.plus(component.value);
}

export function missing(reason: string): ResolvedDecimal {
  return { value: null, reason };
}

export function resolved(
  value: Decimal.Value,
  Constructor: typeof Decimal = Decimal,
): ResolvedDecimal {
  return { value: new Constructor(value) };
}

export function accumulatorDatum(
  value: DecimalAccumulator,
  fallbackReason: string,
): MetricDatum {
  return value.available
    ? decimalDatum(value.value)
    : unavailable(value.reason ?? fallbackReason);
}

export function decimalDatum(value: Decimal): MetricDatum {
  const asNumber = value.toNumber();
  return Number.isFinite(asNumber)
    ? known(asNumber, "derived")
    : unavailable("non_finite_decimal_value");
}

export function parseDecimal(
  value: string,
  label: string,
  allowZero = false,
  Constructor: typeof Decimal = Decimal,
): Decimal {
  let parsed: Decimal;
  try {
    parsed = new Constructor(value);
  } catch {
    throw new Error(`${label} must be a valid decimal string`);
  }

  if (
    !parsed.isFinite() ||
    (allowZero ? parsed.isNegative() : !parsed.isPositive())
  ) {
    throw new Error(
      `${label} must be a ${allowZero ? "non-negative" : "positive"} finite decimal`,
    );
  }
  return parsed;
}
