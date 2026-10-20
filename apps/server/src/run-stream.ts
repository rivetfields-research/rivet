import type { ServerResponse } from 'node:http';
import type { RunUpdate } from '../../../packages/core/src/types.ts';

export interface RunStreamApi {
  getRunUpdate(id: string, after: number): RunUpdate | undefined;
  subscribe(id: string, listener: () => void): () => void;
}

/** Durable cursors, with no polling of complete event histories. */
export function streamRun(api: RunStreamApi, id: string, after: number, response: ServerResponse) {
  // Validate before committing streaming headers, so errors remain ordinary JSON.
  if (!api.getRunUpdate(id, after)) return false;
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  let cursor = after, blocked = false, closed = false, pumping = false;
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => { if (closed) return; closed = true; unsubscribe(); if (heartbeat) clearInterval(heartbeat); response.off('drain', drained); };
  const pump = () => {
    if (closed || blocked || pumping) return;
    pumping = true;
    try {
      for (;;) {
        const update = api.getRunUpdate(id, cursor);
        if (!update) { cleanup(); response.end(); return; }
        cursor = update.cursor;
        const accepted = response.write(`id: ${cursor}\ndata: ${JSON.stringify(update)}\n\n`);
        if (!update.hasMore && !['queued', 'running'].includes(update.run.status)) { cleanup(); response.end(); return; }
        if (!accepted) { blocked = true; return; }
        if (!update.hasMore) return;
      }
    } catch {
      // Reconnect through the last delivered cursor; never emit private error data.
      cleanup(); response.end();
    } finally { pumping = false; }
  };
  const drained = () => { blocked = false; pump(); };
  response.on('close', cleanup);
  response.on('drain', drained);
  unsubscribe = api.subscribe(id, pump);
  heartbeat = setInterval(() => { if (!closed && !blocked) blocked = !response.write(': keep-alive\n\n'); }, 15_000);
  heartbeat.unref();
  pump();
  return true;
}
