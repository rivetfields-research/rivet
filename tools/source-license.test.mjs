import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PUBLICATION_APPROVAL, SOURCE_LICENSE, validateProductLicense, validatePublicationApproval } from './source-license.mjs';

const license = readFileSync(new URL('../LICENSE', import.meta.url));

test('only the exact approved Apache license at the root is accepted', () => {
  assert.doesNotThrow(() => validateProductLicense('LICENSE', license));
  for (const name of ['LICENSE.md', 'nested/LICENSE', '../LICENSE']) {
    assert.throws(() => validateProductLicense(name, license), /approved root/);
  }
  assert.throws(() => validateProductLicense('LICENSE', Buffer.concat([license, Buffer.from('changed')])), /differs/);
  assert.throws(() => validateProductLicense('LICENSE', Buffer.from('Apache-2.0')), /differs/);
});

test('the recorded approval is source-only and cannot silently widen distribution', () => {
  assert.doesNotThrow(() => validatePublicationApproval(structuredClone(PUBLICATION_APPROVAL)));
  for (const value of [undefined, {}, { ...PUBLICATION_APPROVAL, license: 'UNLICENSED' },
    { ...PUBLICATION_APPROVAL, distribution: 'signed desktop downloads' }]) {
    assert.throws(() => validatePublicationApproval(value), /approval is missing or changed/);
  }
});

test('both private npm package roots and locks use the approved source license', () => {
  for (const directory of ['', 'apps/desktop/']) {
    const pkg = JSON.parse(readFileSync(new URL(`../${directory}package.json`, import.meta.url)));
    const lock = JSON.parse(readFileSync(new URL(`../${directory}package-lock.json`, import.meta.url)));
    assert.equal(pkg.license, SOURCE_LICENSE);
    assert.equal(pkg.private, true);
    assert.equal(lock.packages[''].license, SOURCE_LICENSE);
    assert.equal(lock.packages[''].version, pkg.version);
  }
});
