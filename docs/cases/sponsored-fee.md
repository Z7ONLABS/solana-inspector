# Did my wallet pay this network fee?

**SYNTHETIC example. Not blockchain data or a real transaction.**

## Question

The record contains a 5,000-lamport network fee. Should an application also subtract
that fee from the wallet that sends 0.1 SOL?

## Evidence

In `examples/sponsored-fee/input.json`:

- `transaction.message.accountKeys[0]` is the synthetic sponsor, ending in `13`;
  the analyzed wallet ends in `12` and is a separate signer.
- `meta.fee` is `5000`; the sponsor's balance changes `1000000 → 995000` lamports.
- `instructions[0].parsed.info.lamports` is `100000000` (0.1 SOL).
- The wallet's supplied balance changes `1000000000 → 900000000` lamports.

## Answer

The **supplied** record attributes 5,000 lamports to the sponsor. The wallet's
100,000,000-lamport debit matches the explicit transfer exactly. Charging the
network fee to that wallet again would add a debit not supported by this file.
The native movement residual is `0`.

## Limitation

Zero local residual is not proof of blockchain authenticity, complete history,
finality, or account ownership. `finality_unavailable` remains visible. The example
does not prove who economically reimbursed the sponsor outside this transaction.

## Next check

Compare the application's fee attribution with the first account and `meta.fee`
in its actual execution record. Keep any sponsor reimbursement separate unless
there is explicit evidence. See [the SDK assertion](../../recipes/README.md).
