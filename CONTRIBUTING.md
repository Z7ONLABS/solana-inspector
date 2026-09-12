# Contributing

Start with a concrete question about a supplied transaction, not a request for a
new dashboard. Questions and small proposals belong in
[Discussions](https://github.com/Z7ONLABS/solana-inspector/discussions).

For a bug, include the version, command, expected result, actual result, and the
smallest **synthetic** reproduction you can share. Do not attach customer files,
API credentials, private keys, seed phrases or local configuration. Public chain
data can still reveal private relationships; public availability is not consent
to redistribute another person's dataset.

## Local development

Use the pinned package manager (`pnpm@11.19.0`) and a supported Node 22/24 runtime.
Run `pnpm install --frozen-lockfile`, then `pnpm typecheck`, `pnpm test`,
`pnpm build`, `pnpm test:examples` and `pnpm test:package`.
Dependency installation is a separate online preparation step. Analysis and
synthetic tests need no RPC provider or database.

Keep changes small. Preserve exact amounts as strings, distinguish observations
from authenticated chain facts, and never turn missing information into zero or
certainty. Parser changes need an independently explained input/balance oracle,
not only snapshots produced by the implementation being tested.

The pure engine, Node file adapter and HTML presentation have different jobs.
Do not add network calls, storage clients or economic calculations to the reader.
New dependencies, protocol layouts and copied fixtures need recorded provenance
and redistribution rights. No generated private archives belong in this repo.

By submitting code you confirm that you have the right to contribute it under
Apache-2.0. Preserve third-party notices and identify adapted portions. Disclose
material AI assistance and personally check generated code and explanations.
There is no contributor agreement assigning ownership and no promised response
time. Respectful, specific reports are more useful than requests for stars.

## Releases

Maintainers manually review a frozen tarball, its inventory, source fingerprint,
tests and checksum before creating a versioned GitHub Release. CI is manual;
it does not publish packages or websites. Existing release assets must not be
overwritten. Do not use `npm publish`: direct versioned downloads are intentional.
