# Source Boundary

This is a curated local export from `rivetfields-research/harness` at
`1574d8b7533b0f63e0b882c36b346e03ffea913d`. A private source-boundary audit
informed the selection. The public source starts fresh Git history with GitHub
no-reply attribution. Neither the internal harness history nor the private
preparation repository's history, issues, PRs, author emails or remotes were
copied. Root `.git` metadata is not part of the source manifest.

## Included

The export follows TypeScript imports from the existing local server entry and
web entry, plus an explicit list of existing tests and desktop/build files.
`SOURCE_MANIFEST.json` contains every exported tracked path, its upstream blob
and content hash, the resolved local-import graph, and staging changes.
All original selected files are regular tracked text blobs read with `git cat-file`.
Later additions, including the reviewed reference media below, have separate provenance.

The shell, model setup, HTTP access guard, core/runtime, CSV/tabular analysis,
presentation modules and renderer are retained. Existing desktop lifecycle,
settings, packaging, HTTP-token, provider-parser, recovery, credential, data-layer
and renderer tests provide the contributor checks. Tests have inline synthetic
inputs; no external customer/tester fixtures or evaluation corpus is copied.

## Excluded

Git metadata/history; infrastructure, deployment manifests and cloud environment files;
operational records and privileged/tester access documents; internal product and
customer docs; external fixtures/evals; screenshots and generated artifacts;
private environment files, credentials, local databases and application data;
hosted/Azure launchers; unrelated tools/tests; public logo assets, favicon and
invitation pages. Public brand images are replaced with existing generic Lucide
icons. Original third-party notices remain verbatim even where artwork is omitted.

## Retained Coupling

This is desktop-focused source, not full code separation. The local entry and
HTTP layer import organization routes, Entra invitation support, Google Drive,
OAuth, connector configuration readers (`meta-config.ts`, `source-provider-config.ts`)
and email composition. These source modules remain even though deployment
configuration, tenant/account records and credentials are excluded. Core retains connector,
sync, sharing, credential and schedule modules. The renderer imports cloud
account, team, billing, onboarding and connector screens. The import closure also
retains `packages/core/src/care-fixtures.ts`, explicitly authored fictional
healthcare examples used by the legacy profile; these are not patient records.
The owner included these examples in the source-rights approval, even though
desktop selects workspace-analyst.

The desktop shell and API guard disable cloud paths at runtime; source presence
and dependency metadata do not establish that every path is reachable. The
original hosted launcher and its full cloud test coverage are absent. Production
dependencies remain locked, including shared OAuth/connector dependencies. Unused
browser-test/Stripe CLI tools and unimported Stripe/Svix hosted SDKs are removed. Directly starting the
ordinary local entry has different defaults and is not the documented workflow.

## Rights And Remaining Distribution Review

On 2026-10-20 the owner approved Apache-2.0 and confirmed authority to publish the
included source, examples and reviewed demo media. LICENSE contains the exact
Apache-2.0 text; NOTICE and existing third-party notices preserve attribution.
Third-party dependencies and trademarks retain their own terms. npm metadata
stays private only to prevent accidental package-registry publication.
The preserved notices are not a complete audit of a future bundled Electron,
Chromium, Node, tsx/esbuild or dependency runtime; no binary runtime is distributed
in this source release.

Source scans can detect selected path/credential patterns and provenance drift.
They cannot certify that every string, contributor, fixture or asset is cleared.
Passing these local checks does not establish model quality, fresh-device
installation, complete source separation or a complete security assessment.

## Baseline And Repository Support

The original export remains pinned to the exact source commit above. A later,
explicitly reviewed port includes parent working-tree changes for the shared
Connect data catalog, desktop capability status, model notice and restricted
model-settings bridge. The report-runtime port pins desktop JSON-object output,
recovers only already-read selected dataset IDs within existing correction
limits, and checks one unambiguous explicit publication-date window before a
calculation is saved. Focused synthetic tests cover exact dates, permission
boundaries, rejected calculations and report persistence. `workingTreeImports`
records the parent HEAD for context and exact captured file hashes; these bytes
are not represented as committed blobs from that HEAD. New files are explicit
local additions with their own origin metadata. Original baseline blob/hash
records are preserved. The packager includes the new workspace preload in its
shell file list; its curated ancillary allowlist and generic icons remain.
Repository-local package/verify/launch commands add full app-inventory and DMG
checks before normal macOS launch. They do not sign, notarize, publish, bypass
Gatekeeper, or change connector/email capabilities. Tests exercise launch with
an inert dispatcher, not native UI automation.

The seven-platform catalog keeps account connection actions unavailable on the
desktop; email remains disabled. Broader cloud/local parity and OAuth architecture
work are outside this port. Native acceptance of the corresponding private
parent build used Ollama with a fictional 48-row CSV, including report recovery
and contributing-row inspection; its exact runtime hashes are imported here.
The subsequent clean-source package launched and recovered the same saved
report. Neither check is a fresh-device installation, real authentication or
general local-model compatibility. Chart rendering was
confirmed by the tester, not automated pixel inspection.

README organization and contributor entry points were informed by the official
[Eigent repository](https://github.com/eigent-ai/eigent) and
[goose repository](https://github.com/block/goose). Only organization patterns
were used; no project code, branding, assets, claims or product license was copied.

The checks-only workflow reuses the official checkout and setup-node commit pins
from harness's `checks.yml` at the pinned source commit, verified against the
official action repositories. It has read-only contents permission, no persisted
checkout credentials, no secret inputs, no artifact uploads and no deployment or
publication job. Its synthetic Ubuntu checks are not native macOS or live proof.

The source check excludes only root Git metadata and named local generated
directories from its source walk. `npm run audit:staged` independently verifies
the exact index, including exclusions for generated/ignored paths. The optional
`--initial` audit checks a single fresh root commit and absence of the original
source commit object. Neither audit is a complete security/rights certification.

## Reviewed Reference Media

The only approved binary-media exception is the exact pair
`docs/media/rivet-workflow.gif` and `docs/media/rivet-workflow.mp4`. Each requires
an explicit reviewed SHA-256 and byte count in `tools/reviewed-media.mjs`, its
matching source-manifest entry, a checked format signature, and the existing
under-8-MiB per-file limit. The source walk, index audit and provenance recorder
share that validator. No directory-wide media or binary exemption is granted;
links, ignored/generated files and every other image/video path stay excluded.

On 2026-10-26 the owner requested the same demo as the public Rivet product page.
The MP4 is byte-for-byte identical to that page's
`/media/rivet-workflow-20261020-paced.mp4`; the looping GIF is derived from the
complete recording at 2x, matching the website's playback speed. Its frames were
reviewed before import. Only these two final exports are imported; raw frames,
capture metadata and private preparation files are excluded. The original source
and media-rights approval remains dated 2026-10-20. A hash/signature check is not
itself a visual, privacy, playback or rights certification.

The README animation links to the full MP4 and identifies an edited hosted-UI
capture using a 240-row QA/sample social CSV, not verified live-account performance.
It shows source data, report creation, vertical bars, a line chart, CSV inspection
and the existing weekly-review setup. No completed OAuth, new schedule, account
connection, native-desktop parity or email delivery is demonstrated. Desktop account
connections and email remain disabled. Source publication does not authorize
an app-binary release or a production deployment.
