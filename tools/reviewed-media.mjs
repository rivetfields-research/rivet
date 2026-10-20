import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const REFERENCE_MEDIA_PATHS = Object.freeze([
  'docs/media/rivet-workflow.gif',
  'docs/media/rivet-workflow.mp4',
]);

// Exact reviewed exports; the owner approved public source inclusion on 2026-10-20.
export const APPROVED_REFERENCE_MEDIA = Object.freeze({
  'docs/media/rivet-workflow.gif': Object.freeze({
    sha256: '96016637c1a9bf4168abc1209f040c83821c2485023c6a314acf35c833a916a9',
    bytes: 1788297,
  }),
  'docs/media/rivet-workflow.mp4': Object.freeze({
    sha256: '836524de20db8c59c8c520f2658753b7c719ba0caf0423218611d819b67738bc',
    bytes: 950825,
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
