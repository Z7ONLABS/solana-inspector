# Use an inspection result in a test

The recipe consumes the **existing SDK** and checks an application's stated
expectations. It does not calculate a second ledger, fetch data, sign transactions,
or turn local evidence into authenticated blockchain facts.

From this repository after installing the pinned development dependencies:

```sh
npm run build
node recipes/assert-sponsored-fee.mjs
node --test examples/examples.test.mjs
```

The example is deliberately small: a sponsor pays a 5,000-lamport network fee,
while the analyzed wallet transfers 100,000,000 lamports. The recipe checks both
the payer and the exact wallet balance delta. The test suite also supplies an
intentionally **wrong expected payer and wrong expected delta**, and requires each
assertion to fail. A passing process alone is not a reconciliation assertion.

`inspectTeachingFixture` uses ordinary `JSON.parse` only for our trusted, bounded,
checked-in examples. Do not copy that loader for arbitrary user files: use the CLI
or `executeInspector` from `@z7onlabs/solana-inspector/node` for the production input
limits, duplicate-key rejection and worker budget. The pure SDK does not verify
that caller-supplied hashes match original file bytes.

The recipe imports the package by its public name, so a developer can adapt the
assertion to a report from an installed package. Do not reuse the synthetic wallet
as an account to fund, contact or investigate. No private keys are provided or
needed. This is a local test example, **not a hosted CI product or financial audit**.
