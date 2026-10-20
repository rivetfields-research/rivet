# Rivet Contributor Instructions

Read README.md, CONTRIBUTING.md, SECURITY.md and SOURCE_BOUNDARY.md first.
The source is Apache-2.0. Keep the approved LICENSE, NOTICE and third-party
attribution intact. Use Node 24.19.0 and `npm run check`.
The check scope is explicit: no browser, Electron, inference or live providers.
Preserve source permissions, desktop environment isolation, cancellation and
durable recovery. Keep all test data inside `.local-checks/` and preserve others'
edits. Do not add operational/customer records, credentials or private captures.
The original source checkout, private history, production and credentials are
outside the write boundary. Keep changes scoped to this repository and preserve
the pinned baseline and explicitly recorded working-tree ports. Broader parent
connector/OAuth changes are not automatically imported.
Commits, pushes, merges, tags/releases, downloads and deployments follow the
user's explicit scope. npm packages remain private to prevent accidental registry
publication. Public desktop binaries require separate signing, notices and
installation review; source approval does not waive those gates.
Before a commit, stage only manifest paths and run `npm run audit:staged`.
Keep decisions in GitHub issues rather than parallel progress ledgers.
