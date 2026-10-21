# Contributing

Rivet is an Apache-2.0 desktop source alpha. Contributions intentionally submitted
for inclusion are under [Apache-2.0](LICENSE), unless explicitly stated otherwise.
Only submit work you are authorized to share. Third-party components keep their
own licenses and notices.

First-time contributors are welcome. A small documentation correction, a clear
bug report or a focused regression test can help. Source checks need Git, Node
**24.19.0** and npm; they do not need a model, Electron, provider credentials or
access to a private repository. Read [README.md](README.md),
[SECURITY.md](SECURITY.md) and [SOURCE_BOUNDARY.md](SOURCE_BOUNDARY.md) first.

## Scope A Change

Start with an [existing issue](https://github.com/rivetfields-research/rivet/issues)
and comment that you would like to work on it. If none covers the problem, open a
[bug report](https://github.com/rivetfields-research/rivet/issues/new?template=bug_report.md)
or [focused proposal](https://github.com/rivetfields-research/rivet/issues/new?template=feature_request.md).
Describe the observable problem, expected behavior and how to verify the change;
confirm scope with a maintainer before taking on a larger change. Use a separate
branch for each agreed change. Reuse the current desktop/local modules,
framework and tests; preserve source permissions, cancellation, durable recovery
and local data.
Keep unrelated changes and other contributors' edits intact.

The pinned harness baseline is not complete cloud/local parity. Parent connector
UI and OAuth work must be reviewed separately before import. Do not copy broad
working directories, operational records, customer fixtures, credentials or
unapproved artwork to fill gaps.

## Fork And Set Up

Create a fork with GitHub's [Fork button](https://github.com/rivetfields-research/rivet/fork).
If you already use an authenticated GitHub CLI, the equivalent command is:

```sh
gh repo fork rivetfields-research/rivet --clone=false --remote=false
```

Replace `YOUR_GITHUB_USERNAME` below with your GitHub username. `origin` is your
fork; `upstream` is the public Rivet repository. These commands start a new branch
from its current `main` in a fresh clone:

```sh
git clone https://github.com/YOUR_GITHUB_USERNAME/rivet.git
cd rivet
git remote add upstream https://github.com/rivetfields-research/rivet.git
git fetch upstream main
git switch -c codex/my-first-contribution upstream/main
```

Select Node 24.19.0 with your usual version manager. If you use `nvm`, the
repository's `.nvmrc` supplies the version:

```sh
nvm install
nvm use
```

Verify that `node --version` prints `v24.19.0`, then install and check the
unmodified source before making your change:

```sh
node --version
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

The install disables dependency scripts and does not download Electron or model
weights. The full check verifies source provenance, types, the selected test
suite and the renderer build. Documentation changes run the same full check.
Checks keep temporary homes, data and caches under `.local-checks/`; never stage
that directory, `node_modules/` or `dist/`. There is no required `.env` file or
secret setup. Do not start `apps/server/src/index.ts` as a desktop substitute;
its connector defaults differ. Native packaging is a separate workflow in the
[README](README.md#build-a-local-mac-alpha), not a first-PR prerequisite.

## Validate And Record Provenance

Make one focused change and add a test for a meaningful behavior change. The
suite uses an explicit file list in `tools/check.mjs` and the imported `TEST_FILES`
list in `tools/export-source.mjs`: a new test file must be deliberately registered
in the runner to execute in `npm test` and CI. Keep public-repository additions
in `tools/check.mjs`; preserve the pinned export list.

The runner isolates test homes/data and inherited credentials and runs an explicit
test list. Add tests for meaningful behavior and failure modes after reviewing
their imports, writes and network use. Native UI, browser, inference and live
provider checks require their own authorized session. Scripted responses do not
establish model capability, connector authorization or native installation.

`SOURCE_MANIFEST.json` records provenance: where each file came from and the
reviewed hash of its current bytes. Before regenerating it, inspect `git status`
and the diff for every intended path. `git diff` omits untracked files; open and
review each new file separately before recording it.

```sh
git status --short
git diff --check
git diff
```

The existing `tools/record-provenance.mjs` recorder takes no path arguments. It
walks the source tree and accepts only its explicit reviewed lists. For a changed
baseline file, add or update that exact path and its reason in `reasons`; the
recorder writes its hash and reason under `localChanges`. For a new support/test
file, add its exact path to `added`; the recorder lists it under `addedFiles`.
README and CONTRIBUTING are already approved support paths. Include any recorder
or test-runner edit in your review and PR. Do not expand the lists to a directory,
glob or blanket working-tree import. Keep original `files` blob/hash fields,
the pinned source commit, captured parent hashes and media approvals intact.

After reviewing those explicit paths, regenerate the manifest and inspect its
diff before running the full check:

```sh
node tools/record-provenance.mjs
git diff -- SOURCE_MANIFEST.json
npm run check
```

A provenance error means a file differs from its recorded bytes or reviewed path
list. Review that file and its origin before updating the record; do not bypass
the check. The recorder does not approve rights or authorize importing private
parent work. If a check fails, fix the cause, review any further edits, regenerate
provenance and rerun the check.

Stage only the paths you reviewed. For example, a README-only correction stages
these two files; replace this explicit list with your actual reviewed paths for
a different change:

```sh
git add -- README.md SOURCE_MANIFEST.json
npm run audit:staged
git diff --cached --check
git diff --cached --stat
git diff --cached
git status --short
```

The audit requires the staged index to match the complete reviewed manifest and
working files. It rejects ignored/generated paths, links, unexpected bytes and
selected credential patterns. It cannot certify authorship, rights or all content.
If you edit after staging, regenerate provenance, rerun checks and restage the
affected paths before auditing again.

## Open Your First PR

After checks and the staged review pass, commit on your branch and push to your
fork:

```sh
git commit -m "docs: clarify source setup"
git push -u origin codex/my-first-contribution
```

Use a commit message that describes your actual change. On the public repository's
[pull-request page](https://github.com/rivetfields-research/rivet/compare), choose
**compare across forks**, base `rivetfields-research/rivet:main`, and your fork's
`codex/my-first-contribution` branch. With an already authenticated GitHub CLI,
this opens the same PR form (replace `YOUR_GITHUB_USERNAME`):

```sh
gh pr create --repo rivetfields-research/rivet --base main --head YOUR_GITHUB_USERNAME:codex/my-first-contribution --web
```

Fill in the [PR template](.github/pull_request_template.md). Link the agreed issue
with `Refs #ISSUE_NUMBER` (or `Closes #ISSUE_NUMBER` only if this resolves it),
describe what changes for a user, and record the Node version, check results and
test count. State what you did not test, including native UI, inference and live
providers. Explain source-boundary and third-party impacts even when there are
none. Wait for CI and maintainer review; address feedback on the same branch and
repeat provenance, checks and the staged audit before each new commit.

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
need explicit maintainer approval and their own validation. Keep decisions in
issues rather than parallel progress ledgers. Report security concerns privately
as described in [SECURITY.md](SECURITY.md).
