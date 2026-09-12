# Three questions, three synthetic files

**Every input here is SYNTHETIC teaching data, not a blockchain response.**
Program identifiers illustrate known wire formats; accounts, signatures, dates
and economic events are invented. These examples demonstrate behavior, not real-world
coverage, demand, performance across all protocols, or superiority over another
parser. No private archived transactions are included.

| Case | Question | Expected local answer |
| --- | --- | --- |
| [Sponsored fee](../docs/cases/sponsored-fee.md) | Did the wallet pay the network fee? | No: sponsor pays 5,000 lamports; wallet sends exactly 0.1 SOL. |
| [Swap and separate transfer](../docs/cases/swap-extra-transfer.md) | Is the wallet's 2 TOKEN net increase the swap output? | No: the candidate swap receives 2.5 TOKEN, then 0.5 TOKEN is transferred separately. |
| [Unexplained difference](../docs/cases/unexplained-difference.md) | Why did the wallet lose 0.09 SOL when the instruction sends 0.1 SOL? | The supplied evidence leaves 0.01 SOL unexplained; it is not a proven incoming transfer. |

All three use the analyzed wallet `11111111111111111111111111111112`.

## Reproduce the shipped report, not a mockup

```sh
npm run build
node --test examples/examples.test.mjs
node examples/generate-reports.mjs
```

Open `examples/<case>/report/report.html` from disk. Its companion `report.json`
contains exact strings; the generated manifest records the package version and
hashes. Every HTML page uses the same reader and inspection engine as the CLI.
The generator refuses to overwrite existing report folders. For another run:

```sh
node examples/generate-reports.mjs --out-root "./.local/second example run"
```

For an installed package, run the documented command against one input:

```sh
npx --no-install z7on-inspect --input examples/sponsored-fee/input.json --wallet 11111111111111111111111111111112 --out sponsored-report
```

Use a new output directory for each run. **Exit 0 means a report was generated**,
including for the deliberate contradiction; it does not mean the evidence
reconciles, proves execution, or establishes complete wallet history.

## What the tests independently check

The tests compute expected deltas directly from literal input balances using
`BigInt`, inspect explicit instruction amounts and decode the teaching CPI event's
amount fields. They compare those values with the existing engine. Expected
outcomes are not snapshots copied from the engine's own report. They also check
the passing SDK expectation and require deliberately wrong expectations to fail.

Because inputs are supplied files, all reports retain provenance limitations:
no chain authentication, verified finality, complete history, PnL or tax guarantee.

## Public teaching views are annotated, not replay originals

After generating the original CLI reports, create the public presentation copy:

```sh
node --test examples/public-views.test.mjs
node examples/generate-public-views.mjs
```

The output is `.local/public-examples/0.4.0/<case>/report.html`. It adds a static
**SYNTHETIC** banner and a short question/evidence/answer/limitation/next-check
explanation to the existing reader. The banner remains visible without JavaScript.
The reader script, CSP, styles and economic JSON are unchanged; no new analysis is
performed. The public view's HTML bytes deliberately differ from the CLI original.

The four untouched CLI files live under `original/`. Download **all four into one
folder** before reproducing with the installed CLI:

```sh
npx --no-install z7on-inspect --input path/to/original/manifest.json --wallet 11111111111111111111111111111112 --out new-replay-folder
```

Do not mix the annotated HTML into that bundle or treat it as an artifact covered
by the original manifest. The root-level `report.json` is an exact companion copy
for the annotated view's no-JavaScript fallback. License and notice files accompany
each public view.

Use `--source-root DIRECTORY` for original reports generated elsewhere and
`--out-root NEW_DIRECTORY` for another presentation run. The generator verifies
original hashes and refuses existing output folders; it never changes originals.
