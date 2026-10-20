import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { DesktopModelNotice } from './desktop-model-notice';

test('desktop model-free browsing explains the missing choice without declaring the workspace broken', () => {
  const html = renderToStaticMarkup(<DesktopModelNotice configured={false}/>);
  assert.match(html, /Choose a local model for AI answers/);
  assert.match(html, /Saved reports and imports are still available/);
  assert.match(html, />Choose model /);
  assert.doesNotMatch(html, /Rivet is unavailable|contact.*owner|service status/);
});

test('a configured but unavailable local model keeps a settings recovery action', () => {
  const html = renderToStaticMarkup(<DesktopModelNotice configured/>);
  assert.match(html, /Your local model is unavailable/);
  assert.match(html, /Saved reports and imports are still available/);
  assert.match(html, />Model settings /);
  assert.doesNotMatch(html, /Rivet is unavailable|Choose model/);
});
