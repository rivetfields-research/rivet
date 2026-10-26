import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const REFERENCE_MEDIA_PATHS = Object.freeze([
  'docs/media/rivet-workflow.gif',
  'docs/media/rivet-workflow.mp4',
]);

// Exact product-page recording and its 2x GIF; reuse requested on 2026-10-26.
export const APPROVED_REFERENCE_MEDIA = Object.freeze({
  'docs/media/rivet-workflow.gif': Object.freeze({
    sha256: '9d2a1a07ecb338d935d36a3d9966c0b9e6b8f8b4d00f3338aa378bf9babd3e0c',
    bytes: 2108587,
  }),
  'docs/media/rivet-workflow.mp4': Object.freeze({
    sha256: '4225d4e2ba9808af8445d94cebd6ccf1efaa37cc4ca6b39a870d6c7d5cd44718',
    bytes: 2328875,
  }),
});
const MAX_BYTES = 8 * 1024 * 1024;
const GIF_HEADERS = ['GIF87a', 'GIF89a'].map(header => Buffer.from(header, 'ascii'));
const MP4_HEADER = Buffer.from('ftyp', 'ascii');

export function isReferenceMediaPath(name) {
  return REFERENCE_MEDIA_PATHS.includes(name);
}

export function validateReferenceMedia(name, bytes, approval = APPROVED_REFERENCE_MEDIA[name]) {
  assert(isReferenceMediaPath(name), `Reference media path is not allowed: ${name}`);
  assert(approval, `Reference media is not approved yet: ${name}`);
  assert.match(approval.sha256 ?? '', /^[0-9a-f]{64}$/, 'Media approval needs an exact SHA-256');
  assert(Number.isSafeInteger(approval.bytes) && approval.bytes > 0 && approval.bytes < MAX_BYTES, 'Media approval exceeds the existing size boundary');
  assert(Buffer.isBuffer(bytes) && bytes.length === approval.bytes, `Reference media byte count mismatch: ${name}`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), approval.sha256, `Reference media SHA-256 mismatch: ${name}`);
  if (name.endsWith('.gif')) {
    assert(bytes.length >= 14 && GIF_HEADERS.some(header => bytes.subarray(0, 6).equals(header))
      && bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0 && bytes.at(-1) === 0x3b,
    'Reference GIF signature is invalid');
  } else {
    assert(bytes.length >= 24 && bytes.subarray(4, 8).equals(MP4_HEADER)
      && bytes.readUInt32BE(0) >= 16 && bytes.readUInt32BE(0) <= bytes.length,
    'Reference MP4 signature is invalid');
  }
  return { sha256: approval.sha256, bytes: approval.bytes,
    mediaType: name.endsWith('.gif') ? 'image/gif' : 'video/mp4' };
}
