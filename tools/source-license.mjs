import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const SOURCE_LICENSE = 'Apache-2.0';
export const LICENSE_SHA256 = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30';
export const PUBLICATION_APPROVAL = Object.freeze({
  date: '2026-10-20',
  license: SOURCE_LICENSE,
  confirmedBy: 'repository owner',
  scope: 'included source, examples and reviewed demo media',
  history: 'fresh root with GitHub no-reply attribution; private preparation history excluded',
  distribution: 'source only; no signed or notarized desktop download',
});

export function validateProductLicense(name, bytes) {
  assert.equal(name, 'LICENSE', 'Only the approved root product LICENSE is allowed');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), LICENSE_SHA256,
    'Product LICENSE differs from the approved Apache-2.0 text');
}

export function validatePublicationApproval(approval) {
  assert.deepEqual(approval, PUBLICATION_APPROVAL, 'Source publication approval is missing or changed');
}
