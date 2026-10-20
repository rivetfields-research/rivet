# Contributing

Rivet is an Apache-2.0 desktop source alpha. Contributions intentionally submitted
for inclusion are under [Apache-2.0](LICENSE), unless explicitly stated otherwise.
Only submit work you are authorized to share. Third-party components keep their
own licenses and notices.

## Scope A Change

Start with an existing issue or discuss a focused proposal with the maintainers.
Describe the observable problem and expected behavior. Use a separate branch for
each agreed change. Reuse the current desktop/local modules, framework and tests;
preserve source permissions, cancellation, durable recovery and local data.
Keep unrelated changes and other contributors' edits intact.

The pinned harness baseline is not complete cloud/local parity. Parent connector
UI and OAuth work must be reviewed separately before import. Do not copy broad
working directories, operational records, customer fixtures, credentials or
unapproved artwork to fill gaps.

## Validate

Use Node 24.19.0 and the README's locked install:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

The runner isolates test homes/data and inherited credentials and runs an explicit
test list. Add tests for meaningful behavior and failure modes after reviewing
their imports, writes and network use. Native UI, browser, inference and live
provider checks require their own authorized session. Scripted responses do not
establish model capability, connector authorization or native installation.

`SOURCE_MANIFEST.json` preserves upstream provenance. Review intended diffs before
recording each changed hash and reason under `localChanges`; list new support
paths under `addedFiles`. `tools/record-provenance.mjs` accepts only its explicit
reviewed paths. Extend that list deliberately for a new file, never as a blanket
working-tree import. Keep original blob/hash fields intact.

After staging only reviewed source paths, run:

```sh
npm run audit:staged
git diff --cached --check
```

The audit requires the staged index to match the complete reviewed manifest and
working files. It rejects ignored/generated paths, links, unexpected bytes and
selected credential patterns. It cannot certify authorship, rights or all content.

## Review And Rights

Use the PR template: problem, resulting behavior, validation, source-boundary
impact and remaining limitations. Identify third-party material and its origin.
Do not submit source or assets you are not authorized to share. Keep third-party
notices intact; dependency or attribution changes need review.

Reference animation files have a separate exact-path/hash/signature review gate
described in [SOURCE_BOUNDARY.md](SOURCE_BOUNDARY.md#reviewed-reference-media).
Source-manifest hashes alone do not authorize media. Never copy unreviewed
captures or broaden the binary exception to a directory or extension.

Public source approval does not authorize a deployment, npm publication, or a
signed/distributed desktop installer. Those actions and product-license changes
need explicit maintainer approval and their own validation. Keep decisions in issues rather than
parallel progress ledgers. Report security concerns privately as described in
[SECURITY.md](SECURITY.md).
