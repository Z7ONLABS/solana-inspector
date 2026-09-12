# Narrow Solana route adapters — sources and limits

Reviewed 2026-09-07. Local implementation: `src/analytics/solana/routes.ts`.
These are narrowly implemented wire contracts and independently written checks,
not a vendored full SDK, complete protocol decoder, or evidence of deployment bytecode equality.
No provider access or dependency installation is required by the adapters.

## Relay: deposit, not settlement or trading profit

Pinned upstream commit: `8f3fe182efcb59dfef149d0d22e9ddf03adfcd0d`.

- [Official Solana network binding](https://github.com/relayprotocol/relay-settlement/blob/8f3fe182efcb59dfef149d0d22e9ddf03adfcd0d/packages/networks/src/networks/solana.ts)
  identifies the **Solana production** depository `99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2`.
  This is not inferred from Eclipse's identical address.
- [Official SDK IDL](https://github.com/relayprotocol/relay-settlement/blob/8f3fe182efcb59dfef149d0d22e9ddf03adfcd0d/packages/sdk/src/messages/common/solana-vm/idls/RelayDepositoryIdl.ts)
  specifies `deposit_token`, discriminator `0b9c60da27a3b413`, u64 LE amount,
  32-byte identifier and ten ordered account roles. The sender is the debited
  owner; the depositor is a separate credited role, not assumed identical.
- [SDK package metadata](https://github.com/relayprotocol/relay-settlement/blob/8f3fe182efcb59dfef149d0d22e9ddf03adfcd0d/packages/sdk/package.json)
  declares MIT and author Uneven Labs. The repository root's license was not
  established; do not extend this package-level declaration to arbitrary Rust
  sources or copy the entire repository.

The adapter accepts only successful legacy SPL `deposit_token` with exact
instruction length, roles, matching transfer CPI, unchanged source/vault owners,
matching mint/decimals and exact source/vault balance changes. It identifies the
existing movement as a deposit; it does not create another transfer, swap, sale,
Fomo attribution or ownership relationship. The local archive contained 153 such
calls, all individually reconciled. No `execute_transfer` or `deposit_native`
variant was needed, so those variants are not implemented.

## DFlow v4: documented user and reconciled hops

Pinned Carbon reference commit: `e901103c93833c9c79407cb4321561e30796ad51`.

- [Swap discriminator and six fixed roles](https://github.com/sevenlabs-hq/carbon/blob/e901103c93833c9c79407cb4321561e30796ad51/decoders/dflow-aggregator-v4-decoder/src/instructions/swap.rs).
- [Swap parameters](https://github.com/sevenlabs-hq/carbon/blob/e901103c93833c9c79407cb4321561e30796ad51/decoders/dflow-aggregator-v4-decoder/src/types/swap_params.rs).
- [Per-AMM swap event](https://github.com/sevenlabs-hq/carbon/blob/e901103c93833c9c79407cb4321561e30796ad51/decoders/dflow-aggregator-v4-decoder/src/events/swap_event.rs).
- [Fee event](https://github.com/sevenlabs-hq/carbon/blob/e901103c93833c9c79407cb4321561e30796ad51/decoders/dflow-aggregator-v4-decoder/src/events/fee_event.rs).

Carbon is a third-party MIT decoder reference, not an assertion from DFlow about
the queried wallet. We retain only the `Swap` fixed header/role facts and event
layouts actually present in the archive; no general Borsh action enum, destination
variants, code generation or Carbon Rust runtime is imported.

The fixed-header check is intentionally **not** a claim that the complete action
payload was decoded. Successful execution, explicit user authority, legacy SPL
movements, per-hop event amounts and wallet balance reconciliation are required
together. Each event must follow a matching AMM invocation in the same outer
instruction. Intermediate hops collapse to one wallet input/output. A pool with
opposing balance deltas is not automatically a second trader. A matched router
does not independently identify the app of origin.

V4 associates events with their specific invocation, not merely the last inner
instruction. Interposed native wrapping, unwrapping and `syncNative` require a
balanced lifecycle. A later independent user transfer stays a transfer, not an
inferred extra fee. A third party's swap is not the analyzed wallet's swap.
Isolated Token-2022 temporary-account paths require exact linear quantities and
stable ownership; this does not prove historical extensions or financial coverage.
Unknown effects, mixed funds, hooks, ambiguous ownership and unmatched events
retain exclusions. A router boundary does not authorize every nested program.

## Narrow lifecycle evidence needed by the three real cases

Pinned official Pump public-docs commit:
`9c82f61cb711b044a17f770ab8ce9f9bdf78f333`.

- [Pump AMM wire definitions](https://github.com/pump-fun/pump-public-docs/blob/9c82f61cb711b044a17f770ab8ce9f9bdf78f333/idl/pump_amm.json):
  accumulator close `f945a4da9667548a` and its event `929fbdac925838f4`.
- [Fee query wire definition](https://github.com/pump-fun/pump-public-docs/blob/9c82f61cb711b044a17f770ab8ce9f9bdf78f333/idl/pump_fees.json):
  `GetFees`, `e7257e55cf5b3f34`, has two read-only roles.

The independently written adapter only reconciles an observed accumulator
creation/closure and its lamport refund using ordered accounts, event, signer
and balances. A refund is rent, not profit. Read-only event boundaries are not
treated as swaps or fee amounts. This is not a general Pump/Meteora parser.

No license file was established for that documentation repository at the pinned
revision. No SDK, full IDL or source implementation was copied; only the minimal
public wire facts needed for interoperability were referenced. Do not assume
the repository is MIT or redistribute it as part of this project.

## Fee evidence and exactness

Fomo app attribution is separate: a positive USDC vault delta with observed Fomo
ownership must reconcile to an explicit user debit. A two-edge intermediary path
is allowed only with the same outer instruction, verified instruction order,
exact equal amounts, stable intermediary balance/ownership, and exactly those
two movements touching it. Preexisting fungible stock is not claimed to belong
to the user. Fan-in, fan-out, balance drift and ambiguous ordering fail closed.
Direct separately ordered fee instructions remain separate from gross swap
amounts. A sponsor's network fee is not charged to the analyzed wallet.

Integer arithmetic uses `bigint`; presentation uses exact decimal strings. No
prices, fees in USD, PnL or ledger completeness are supplied by these adapters.

## Reuse decision

The standalone TypeScript package preserves the existing exact economic engine;
the web application consumes the same package through adapters. No SolanaFM
ExplorerKit (GPL-3), deBridge parser (LGPL-2.1), full Carbon Rust stack, dual-Anchor
SDK dependency tree or opaque provider classification was adopted. Their useful
ideas do not justify replacing the engine or bypassing evidence checks.

## Carbon notice

The minimal DFlow role/discriminator/event-layout reference is derived from the
MIT-licensed Carbon sources above. Retain this notice with that implementation.

MIT License

Copyright (c) 2024 SevenLabs IT Consulting - FZCO

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
