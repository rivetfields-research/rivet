import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { APPROVED_REFERENCE_MEDIA, REFERENCE_MEDIA_PATHS, isReferenceMediaPath, validateReferenceMedia } from './reviewed-media.mjs';

const gifName = 'docs/media/rivet-workflow.gif';
const mp4Name = 'docs/media/rivet-workflow.mp4';
// Header-only synthetic buffers exercise the guard, not playback or capture safety.
const gif = Buffer.from([...'GIF89a'].map(c => c.charCodeAt(0)).concat([1, 0, 1, 0, 0, 0, 0, 0x3b]));
const mp4 = Buffer.alloc(24);
mp4.writeUInt32BE(24, 0); mp4.write('ftyp', 4); mp4.write('isom', 8);
const approval = bytes => ({ sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });

test('only the two exact repository-relative reference media filenames are recognized', () => {
  assert.deepEqual(REFERENCE_MEDIA_PATHS, [gifName, mp4Name]);
  for (const name of REFERENCE_MEDIA_PATHS) assert.equal(isReferenceMediaPath(name), true);
  for (const name of ['docs/media/private.gif', 'docs/media/private.mp4', 'docs/media/rivet-workflow.GIF',
    'docs/media/rivet-workflow.mp4.bak', 'docs/media/../media/rivet-workflow.gif',
    '/docs/media/rivet-workflow.gif', 'apps/web/public/rivet-workflow.gif', 'docs\\media\\rivet-workflow.gif']) {
    assert.equal(isReferenceMediaPath(name), false);
    assert.throws(() => validateReferenceMedia(name, gif, approval(gif)), /path is not allowed/);
  }
});
test('media requires a separate explicit approval, not just a matching source-manifest hash', () => {
  assert.throws(() => validateReferenceMedia(gifName, gif, null), /not approved/);
  assert.throws(() => validateReferenceMedia(gifName, gif, { bytes: gif.length }), /exact SHA-256/);
  assert.throws(() => validateReferenceMedia(gifName, gif, { ...approval(gif), sha256: '0'.repeat(64) }), /SHA-256 mismatch/);
  assert.throws(() => validateReferenceMedia(gifName, gif, { ...approval(gif), bytes: gif.length + 1 }), /byte count mismatch/);
});
test('exact approved GIF87a and GIF89a signatures, dimensions and trailer are checked', () => {
  assert.equal(validateReferenceMedia(gifName, gif, approval(gif)).mediaType, 'image/gif');
  const older = Buffer.from(gif); older.write('GIF87a', 0);
  assert.equal(validateReferenceMedia(gifName, older, approval(older)).bytes, older.length);
  for (const mutate of [b => b.write('GIF00a', 0), b => { b[0] |= 0x80; }, b => b.writeUInt16LE(0, 6), b => { b[b.length - 1] = 0; }]) {
    const invalid = Buffer.from(gif); mutate(invalid);
    assert.throws(() => validateReferenceMedia(gifName, invalid, approval(invalid)), /GIF signature/);
  }
  assert.throws(() => validateReferenceMedia(gifName, mp4, approval(mp4)), /GIF signature/);
});
test('an approved MP4 must have the ftyp signature and a bounded first box', () => {
  assert.equal(validateReferenceMedia(mp4Name, mp4, approval(mp4)).mediaType, 'video/mp4');
  for (const mutate of [b => b.write('moov', 4), b => { b[4] |= 0x80; }, b => b.writeUInt32BE(8, 0), b => b.writeUInt32BE(100, 0)]) {
    const invalid = Buffer.from(mp4); mutate(invalid);
    assert.throws(() => validateReferenceMedia(mp4Name, invalid, approval(invalid)), /MP4 signature/);
  }
  assert.throws(() => validateReferenceMedia(mp4Name, gif, approval(gif)), /MP4 signature/);
});
test('a valid signature cannot hide changed bytes or extend the existing file-size boundary', () => {
  const changed = Buffer.from(mp4); changed[changed.length - 1] = 1;
  assert.throws(() => validateReferenceMedia(mp4Name, changed, approval(mp4)), /SHA-256 mismatch/);
  for (const bytes of [0, 8 * 1024 * 1024, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => validateReferenceMedia(gifName, gif, { ...approval(gif), bytes }), /size boundary/);
  }
});
test('every active approval is for an exact present file with its reviewed bytes and signature', () => {
  const manifest = JSON.parse(readFileSync(new URL('../SOURCE_MANIFEST.json', import.meta.url), 'utf8'));
  for (const [name, review] of Object.entries(APPROVED_REFERENCE_MEDIA)) {
    assert(isReferenceMediaPath(name));
    validateReferenceMedia(name, readFileSync(new URL(`../${name}`, import.meta.url)), review);
    const record = manifest.addedFiles.find(file => file.path === name);
    assert.equal(record.sha256, review.sha256);
    assert.equal(record.bytes, review.bytes);
    assert.equal(record.origin.kind, 'reviewed-reference-media');
    assert.equal(record.origin.reviewedSha256, review.sha256);
    assert.equal(record.origin.approvalScope, 'Owner-approved public source inclusion, including media rights, on 2026-10-20.');
    assert.match(record.origin.capture, /QA\/sample social CSV/);
  }
  assert.deepEqual(Object.keys(APPROVED_REFERENCE_MEDIA).sort(), [...REFERENCE_MEDIA_PATHS].sort());
});
test('README has one linked preview, a full-quality link and precise hosted-capture limits', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const previews = [...readme.matchAll(/\[!\[[^\]]*\]\(docs\/media\/rivet-workflow\.gif\)\]\(docs\/media\/rivet-workflow\.mp4\)/g)];
  assert.equal(previews.length, 1);
  assert(previews[0].index < readme.indexOf('## Current Capabilities'));
  assert.match(readme, /\[Watch the full-quality MP4\]\(docs\/media\/rivet-workflow\.mp4\)/);
  assert.match(readme, /Edited hosted-UI capture using a 240-row QA\/sample social CSV, not verified\s+live-account performance/);
  assert.match(readme, /does not demonstrate completed OAuth, native-desktop\s+parity or email delivery/);
});
