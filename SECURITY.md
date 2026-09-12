# Security and sensitive data

The Inspector accepts untrusted JSON but is not a sandbox for arbitrary code.
Use supported Node releases, review inputs and keep analysis output private when
the original data is private. The offline tests are connection-guard checks, not
a certification or an operating-system sandbox.

Do not publish private data or exploit details in an ordinary issue. Use GitHub's
private vulnerability reporting for this repository. If that option is not
available, ask for a private reporting channel in Discussions without including
the sensitive details. Maintainers do not promise a response SLA or bug bounty.

This experimental release has no automatic updater. Fixes require a separately
reviewed release and explicit upgrade. Preserve the original version when you
need to reproduce an older report.
