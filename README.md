# Solana Inspector

**Inspect a Solana transaction file without uploading it.** See exact movements,
who paid the network fee, and which balance changes the supplied instructions
do not explain. A residual is an evidence gap, not proof that your application,
provider or blockchain is wrong.

Apache-2.0, local CLI and TypeScript SDK. No wallet connection, API key, server,
telemetry or automatic data collection. This is a small developer tool, not a
portfolio tracker or a complete Solana protocol decoder.

## Try a case first

The [three synthetic cases](https://github.com/Z7ONLABS/solana-inspector/blob/v0.4.0/examples/README.md) explain fee sponsorship, a
swap followed by a separate transfer, and an intentionally unexplained balance.
They are teaching examples, not transactions fetched from blockchain. See
`examples/` for their inputs and independently declared expectations.

## Install the release locally

Use Node **22.12+ in the 22.x line or Node 24.x**. Download the versioned `.tgz`
and its SHA-256 file from the release page, compare the hash, then in a new folder:

```sh
npm install ./z7onlabs-solana-inspector-0.4.0.tgz --ignore-scripts --offline --no-audit --no-fund
npx --no-install z7on-inspect --input transaction.json --wallet YOUR_SOLANA_ADDRESS --out inspection-01
```

Open `inspection-01/report.html`. Keep all four output files for replay:
`input.json`, `report.json`, `report.html`, `manifest.json`.

```sh
npx --no-install z7on-inspect --input inspection-01/manifest.json --wallet YOUR_SOLANA_ADDRESS --out inspection-02
```

Installation/download is separate from inspection. The release has no runtime
registry dependencies or install scripts. `private: true` prevents accidental
npm publication; it does not restrict the Apache-2.0 source licence.

## Your input

Provide a standard Solana `getTransaction` response using `jsonParsed`, its
result object, or an array of these, plus the exact wallet address. Retain
metadata, balances, instructions and signatures. An address or signature alone
does **not** fetch anything. Your existing provider remains responsible for
acquiring the data. Do not put credentials, seed phrases or private keys in files.

The report preserves exact integer/decimal strings. It separates duplicated
observations, contradictory revisions, missing identities and economic
limitations. Unknown protocols and incomplete effects remain explicitly limited.
The report includes original evidence: review it before sharing it publicly.

Exit `0` means the report was generated, **not** that every effect reconciles.
Exit `2` means input error; `3` processing/output error; `124` worker time limit;
`130` cancellation. `--feedback` creates an optional local receipt only; nothing
is sent. The output parent must exist and the output directory must be new.

## Scope and limits

- One wallet, 1,000 observations, 32 MiB input, 128 MiB complete output.
- 30 seconds of processing in the worker, not the entire command.
- Imported JSON is not authenticated against the chain; hashes bind bytes only.
- A sample does not establish history completeness, ownership or chain order.
- No PnL, ROI, price history, tax calculations or universal protocol coverage.
- Native/SPL and narrow documented route patterns are supported; see
  [protocol provenance and limitations](docs/protocol-provenance.md).
- Manifests from other package versions are explicitly rejected. Keep the
  original release to replay them; 0.4.0 does not convert older manifests.
- The HTML reader is self-contained; its no-JavaScript fallback needs the
  accompanying `report.json`. Printing captures the selected view, not all data.
- Safe output publication requires hard links on the same filesystem. Unsupported
  filesystems fail rather than weakening protections or overwriting old reports.

0.4.0 retains the `solana-inspection-v2` result contract and the economic method
from 0.3.1. Packaging/licensing changed, not financial coverage. Windows x64 and
Ubuntu 24.04 x64 were tested for the predecessor on Node 22.12.0, 22.23.2, 24.0.0
and 24.21.0; see release verification for **0.4.0's actually executed checks**.
Do not infer macOS/ARM or every runtime version from that earlier matrix.

## SDK

`@z7onlabs/solana-inspector` exports `inspectSolanaEvidence` and result/input types.
`@z7onlabs/solana-inspector/node` exports the bounded `executeInspector` file API.
The pure SDK requires explicit input/payload SHA-256 strings but does not verify
them against file bytes; use the Node API for byte-bound file verification.
See [the small assertion recipe](https://github.com/Z7ONLABS/solana-inspector/blob/v0.4.0/recipes/assert-sponsored-fee.mjs).

`internal/*` exports support the existing application adapter. They are not a
new stable integration promise; prefer the two documented SDK entrypoints.

## Build and contribute

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm test:examples
pnpm test:package
```

Pinned tools are project-local. The build vendors decimal.js with its MIT
notice and compiles the same source graph used by CLI and SDK. No remote data
is needed to build or run synthetic tests after dependencies are installed.
Please report a concrete question, the version, observed/expected behavior and
the smallest **safe synthetic** input. Never upload private customer data or keys.

## Licence

[Apache-2.0](LICENSE): use, study, modify, distribute and integrate commercially,
subject to its terms and preserved third-party notices. When redistributing the
HTML reader's code (including a generated report), retain LICENSE, NOTICE and
applicable third-party notices alongside it. Original transaction data may have
separate privacy/permission constraints; open-source code does not waive them.
No guarantees of
accuracy, fitness, chain authenticity or financial eligibility. Previous binary
releases retain their original files and licences; this is a new source release.
