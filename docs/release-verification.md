# Solana Inspector 0.4.0 — release verification

Verification date: **2026-09-12**. This record describes executed technical
checks, not customer validation, universal protocol coverage or a security
certification. Building and checking a candidate is separate from publishing it.

## Exact candidate

| Field | Value |
| --- | --- |
| Package | `@z7onlabs/solana-inspector` |
| Version | `0.4.0` |
| File | `z7onlabs-solana-inspector-0.4.0.tgz` |
| SHA-256 | `25af612df021347a7b14522c0f325f0f3f37fb83ceaf19f3d07433e1295f26c6` |
| Result contract | `solana-inspection-v2` |
| Source licence | Apache-2.0, with retained third-party notices |

The checks below used this exact archive. The Linux build reproduced its hash;
equivalent source or a similar file inventory was not accepted instead of
byte-identical package output. Dependency installation and runtime preparation
are separate from the offline inspection checks.

## Executed compatibility matrix

| Node | Windows x64 | Ubuntu 24.04 x64 |
| --- | --- | --- |
| 22.12.0 | Passed | Passed |
| 22.23.2 | Passed | Passed |
| 24.0.0 | Passed | Passed |
| 24.21.0 | Passed | Passed |

Windows checks ran locally on Windows build 26200. Linux checks ran on the
standard Ubuntu 24.04 GitHub Actions runner. The public
[successful Linux run](https://github.com/Z7ONLABS/solana-inspector/actions/runs/34672554548)
used source commit `5aa1ed4`. It also ran source tests, TypeScript checks,
package verification and synthetic examples. The
[manual workflow](../.github/workflows/compatibility.yml) retains no build
artifacts; viewing detailed GitHub logs may require signing in.

Every matrix cell checked:

- Installation outside the source checkout, paths containing spaces, initially
  empty npm configuration/cache and an environment without provider credentials.
- The installed `npx --no-install z7on-inspect` command; both documented SDK
  entrypoints (`.` and `./node`) and their TypeScript types.
- CLI/SDK/replay agreement, including byte-identical deterministic artifacts
  across the matrix's synthetic fixtures.
- Invalid inputs, optional local feedback, cancellation and simulated `ENOSPC`,
  `EACCES` and `ENOTSUP` output failures. These tests did not fill a real disk.
- A self-tested connection guard and zero attempted inspection connections
  observed by that guard. JavaScript hooks are **not** an operating-system
  network sandbox and do not prove every hypothetical connection mechanism.
- Linux-specific symlink and permission protections on Linux; those checks were
  not represented as Windows results.

These eight combinations do not establish compatibility with macOS, ARM,
other filesystems, every intermediate Node version or a graphical Linux
desktop. In particular, desktop `xdg-open` integration was not verified.

## Archived-data regression, reported only in aggregate

A separate Windows x64 / Node 24.13.0 run used **472 previously archived
observations**, not freshly queried blockchain data. Two fresh inspections and
an additional replay produced identical deterministic artifacts. The complete
JSON, original input and HTML were byte-identical to the reviewed 0.3.1 results;
only `inspectorVersion` in the completed manifests changed to `0.4.0`.

Four case-specific checks covered fee sponsorship, a swap with additional
transfers, Token-2022 passthrough and an unexplained native-balance difference.
The existing independent raw-instruction/balance oracle checked **11 accounts
and 12 distinct transfers**. The original archives and oracle were not changed.
All 33 extracted source modules matched the reviewed predecessor after line-ending
normalization, apart from the intended package-version constant.

These are regression results on a bounded, selected archive, not a representative
sample of Solana or proof of chain authenticity. The original inputs, identities,
paths and detailed reports remain private and are not included in this repository.
No claims about a parser's general error rate follow from these cases.

## Public synthetic examples and presentation checks

The [three public teaching cases](../examples/README.md) use invented accounts,
signatures, dates and events. Their seven tests check original instruction
quantities and balance differences independently of the inspector output, plus
an SDK assertion that passes the intended expectation and rejects deliberately
wrong ones.

Two additional presentation tests check escaped explanatory text, a static
**SYNTHETIC — not blockchain data** label with JavaScript disabled, an unchanged
reader script/CSP/style set, no remote resources in the generated HTML, and
byte-identical original replay bundles. They also execute the CLI to reproduce
each original bundle. These DOM/CSP checks alone are not a complete browser,
accessibility or security audit.

The annotated public HTML is a presentation derivative, not an original artifact
covered by the replay manifest. Its `original/` directory retains all four CLI
files unchanged; download those together for replay. The adjacent `report.json`
supports the annotated page's no-JavaScript fallback. License and notice files
accompany the presentation.

From a prepared source checkout, reproduce the example checks with:

```sh
pnpm build
node --test examples/examples.test.mjs
node --test examples/public-views.test.mjs
pnpm pack:check
```

The compiled report reader remains the same implementation used by the CLI;
the teaching annotations introduce no new economic calculations.

## What remains limited or unvalidated

Limits remain one wallet, 1,000 observations, 32 MiB input, 128 MiB combined
output and 30 seconds of worker processing. The last limit is not a promise
that the whole command completes in 30 seconds. Inputs must retain the original
`getTransaction`/`jsonParsed` evidence; an address or signature alone fetches
nothing. Older manifests are explicitly rejected by a different package version.

Successful execution means a report was generated, not that every effect
reconciles. Supplied files and hashes do not establish execution, ownership,
finality, complete history or ordering. There is no PnL, ROI, tax guarantee,
historical-price service or universal protocol decoder.

The tool may help developers inspect fee attribution, separate gross movements
from net balances and preserve an unresolved discrepancy with its evidence.
**Independent user usefulness, time savings, repeated adoption and commercial
demand are not yet validated.** The examples and tests demonstrate specific
behavior; they do not establish superiority over alternatives or willingness
to pay. Feedback and reproducible external cases are the next evidence needed.
