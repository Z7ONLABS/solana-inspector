# Where did the unexplained 0.01 SOL come from?

**SYNTHETIC, with a deliberately unexplained difference. Not blockchain data.**

[Open the generated, explained report — no installation](https://www.z7onlabs.com/examples/solana-inspector/0.4.0/unexplained-difference/report.html).

## Question

The wallet sends 0.1 SOL, but its recorded balance falls by only 0.09 SOL. Can an
application invent a 0.01 SOL incoming transfer to make the row balance?

## Evidence

In `examples/unexplained-difference/input.json`:

- The explicit system transfer is `100000000` lamports (0.1 SOL).
- The analyzed wallet's balance changes `1000000000 → 910000000`:
  an observed delta of `-90000000` lamports.
- A separate sponsor pays the `5000`-lamport network fee.
- Expected wallet delta from recognized movements is `-100000000`.
- Observed minus expected is `10000000` lamports (0.01 SOL).

## Answer

The difference is **unexplained by the supplied evidence**. The inspector keeps
the explicit transfer and exposes the residual; it must not manufacture a credit,
profit or payer to make the result reconcile. `unexplained_balance_change` is an
economic limitation, separate from the universal supplied-file finality limit.

## Limitation

This fabricated contradiction does not identify a real Solana bug, lost funds,
theft, or a parser's general error rate. A residual alone cannot establish its
cause. The inspector generates a report successfully while reconciliation remains
limited; CLI exit code `0` is not an economic success flag.

## Next check

Check whether the real source file retained all execution metadata and inner
instructions; compare instruction amounts and pre/post balances with the original
response. Do not edit an original record to erase a discrepancy. The inspector
does not fetch a replacement response or validate it against the chain.
