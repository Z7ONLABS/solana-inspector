# Is a net balance change the same as a swap output?

**SYNTHETIC example. Not blockchain data, a real swap, or a quoted market price.**
`TOKEN` is an invented asset with six decimals. The public DFlow program identifier
is used only to exercise the existing narrow DFlow-v4 evidence rule.

## Question

The wallet's TOKEN balance rises by 2.0. Did the swap receive only 2.0 TOKEN?

## Evidence

In `examples/swap-extra-transfer/input.json`:

- Outer instruction `0` uses the supported DFlow-v4 discriminator.
- Its supplied CPI transfers (`meta.innerInstructions[0].instructions[1..2]`)
  send `5000000` USDC raw units and receive `2500000` TOKEN raw units.
- The corresponding CPI event records the same input/output quantities and
  matching mint/program roles; the tests independently decode these quantities.
- Outer instruction `1` separately transfers `500000` TOKEN raw units away.
- The wallet's TOKEN balance changes `0 → 2000000`. Its USDC changes
  `10000000 → 5000000`. The wallet separately pays 5,000 lamports network fee.

## Answer

The supplied instruction pattern supports **one locally reconciled swap candidate:
5 USDC for 2.5 TOKEN**, followed by a separate 0.5 TOKEN transfer in the same
transaction. The 2.0 TOKEN net increase is not the gross swap output. This tests
intra-transaction instruction ordering, not ordering across a blockchain history.

## Limitation

The route proof is limited to this exact supported pattern, not every DFlow
instruction or every AMM. This is not Fomo attribution. Account ownership and
execution are supplied assertions, not independently verified facts. The report
therefore retains finality limitations and does not produce PnL or a token price.

## Next check

When comparing with an indexer's trade row, check gross swap amounts separately
from later transfers and final balances. An unsupported CPI must remain a
limitation rather than be guessed into a swap.
