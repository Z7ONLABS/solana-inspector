# 0.4.0 verification

This records executed technical checks, not independent user utility, broad
protocol coverage, a security certification, or commercial demand.

## Candidate identity

- Package: `@z7onlabs/solana-inspector@0.4.0`
- Tarball: `z7onlabs-solana-inspector-0.4.0.tgz`
- SHA-256: `25af612df021347a7b14522c0f325f0f3f37fb83ceaf19f3d07433e1295f26c6`
- Size: 198,603 bytes; 108 regular files.
- Build source fingerprint: `1bfc8dd551d83a90a6a9f26dfb65c1011c60d32b2d05576b08a0ea1e7fcf8201`.
- Result contract: `solana-inspection-v2`.

Two fresh builds on Windows x64 / Node 24.13.0 / npm 11.6.2 produced identical
tarballs. The 33 extracted runtime source files match the preceding implementation
after line-ending normalization, except the package-version constant changing
from 0.3.1 to 0.4.0. No economic rule or financial eligibility changed.

## Executed locally

- Strict TypeScript check and standalone build: passed.
- 123 synthetic unit tests: passed (inspection, exact arithmetic, narrow route
  evidence, identity/exclusion UI, complete output limits and safe-write failures).
- Seven synthetic example checks: passed. Literal balances/instructions and
  declared expectations, SDK recipe positive/negative cases and real CLI output
  agree. These examples do not count as archived chain coverage.
- Installed-package journey on Windows x64 / Node 24.13.0: passed outside the
  checkout, in a path with spaces, with empty npm configuration/cache. Exercises
  installed `npx --no-install`, both SDK entries, exact replay, cancellation,
  invalid input and preservation of previous output.
- Node connection guard observed no attempts during CLI/SDK/replay execution.
  An intentional blocked-fetch probe confirms that the guard is active; this is
  application instrumentation, not an operating-system network sandbox.
- Actual tar verification: passed. Exact allowlist, bidirectional hashes,
  source inventory, runtime metadata without registry dependencies/scripts,
  licences, regular USTAR members, no traversal or unexpected files.
- Three archive test groups: passed, including malformed/truncated data, wrong
  hash, traversal, symlinks, unsafe modes and checksum rejection.

## Checks not inferred from earlier releases

The preceding binary had its own Windows/Linux matrix and real-corpus tests.
Those do not automatically approve the new tarball. The manual public workflow
rebuilds with fixed tools, requires the reviewed SHA-256, and then exercises the
installed package on Node 22.12.0, 22.23.2, 24.0.0 and 24.21.0 on Ubuntu 24.04.
Its presence is not a claim it has run; consult the linked release/CI result
before describing those new cells as passed.

macOS, ARM, graphical desktop opening and all Node/browser versions are not
claimed tested here. The separate application release record may add actual
checks without changing this immutable tarball. Archived non-public transaction
files are not included in this source repository or release package.

## Reproduce locally

After installing the pinned development dependencies:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
pnpm test:examples
pnpm test:package
node --test tests/archive.test.mjs
```

The build writes to a new local output folder and tests create isolated synthetic
outputs; no registry or website publication is triggered. Package installation/download can need a network;
inspection of supplied files does not.
