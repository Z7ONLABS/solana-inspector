// Explicitly reviewed 0.4.0 integration surface. Do not widen by directory glob.
export const OPEN_SOURCE_MODULES = Object.freeze([
  "analytics/solana/account-ledger",
  "analytics/solana/economic",
  "analytics/solana/episode-checks",
  "analytics/solana/fomo-fee-evidence",
  "analytics/solana/inspection-requirements",
  "analytics/solana/inspection-types",
  "analytics/solana/inspection",
  "analytics/solana/ledger",
  "analytics/solana/normalize",
  "analytics/solana/route-constants",
  "analytics/solana/routes",
  "analytics/solana/token-quantity-evidence",
  "analytics/solana/types",
  "analytics/spot/decimal",
  "analytics/spot/engine",
  "analytics/spot/index",
  "analytics/spot/metrics",
  "analytics/spot/prices",
  "analytics/spot/types",
  "analytics/spot/valuation",
  "analytics/spot/version",
  "analytics/value",
  "inspector/browser/reader",
  "inspector/node/cli",
  "inspector/node/html",
  "inspector/node/index",
  "inspector/node/input",
  "inspector/node/output-budget",
  "inspector/node/run",
  "inspector/node/worker",
  "lib/wallet-address",
  "types/analytics",
  "types/episode-checks"
]);

export function openSourceExports() {
  return Object.fromEntries(OPEN_SOURCE_MODULES.map((name) => [
    `./internal/${name}`,
    { types: `./dist/src/${name}.d.ts`, import: `./dist/src/${name}.js` },
  ]));
}
