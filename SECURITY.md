# Security

This is an experimental source alpha, not a production security guarantee.
Report a suspected vulnerability privately to **info@rivetfields.com**. Send a
minimal description first and ask for a secure transfer route before sharing
sensitive details. Do not include credentials, personal data, provider responses or
real customer identifiers in public issues, screenshots or test fixtures.

Share a minimal synthetic reproduction, affected source path and revision,
expected boundary, observed result, and the local check that exposes it. Do not
probe production or rotate/delete credentials as part of a source review.

The desktop shell uses a per-launch loopback credential and a restricted child
environment. Shared source still implements cloud integrations and privileged
organization flows; their presence is not approval to configure or expose them.
The automated source scan is a limited heuristic, not a full security, privacy,
authorship or content certification. Native sandboxing, signing/notarization,
updates and end-to-end model behavior need separate review before a public
desktop-binary release. No supported-version window or response-time promise is
established yet.
