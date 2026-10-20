import { useEffect, useState } from 'react';
import type { Run, RunSummary } from '../../../packages/core/src/types';
import { api, readSaved } from './api';
import { workspaceBrowserStorage } from './workspace-scope';
import { conversationId, MAX_SIDEBAR_PINS, parseSidebarPins, sidebarConversations, sidebarPinKey, sidebarSummary } from './sidebar-pins';

export function useSidebarPins(profile: string, runs: RunSummary[]) {
  const key = sidebarPinKey(profile);
  const [pins, setPins] = useState(() => parseSidebarPins(readSaved(key, [])));
  const [resolved, setResolved] = useState(new Map<string, RunSummary | null>());
  const [notice, setNotice] = useState('');
  const [retry, setRetry] = useState(0);
  // Only IDs are stored locally. Titles/status for older pins require a fresh authorized read.
  const available = new Set(runs.map(conversationId));
  const missing = pins.filter(id => !available.has(id)).join(',');
  useEffect(() => {
    if (!missing) { setResolved(new Map()); return; }
    const controller = new AbortController();
    setResolved(new Map());
    for (const id of missing.split(',')) {
      void api<{ turns: Run[] }>(`/api/runs/${encodeURIComponent(id)}/session`, { signal: controller.signal }).then(result => {
        const latest = sidebarConversations(result.turns.filter(run => conversationId(run) === id && run.profileId === profile).map(sidebarSummary))[0];
        if (!controller.signal.aborted) setResolved(previous => new Map(previous).set(id, latest ?? null));
      }).catch(() => {
        if (!controller.signal.aborted) setResolved(previous => new Map(previous).set(id, null));
      });
    }
    return () => controller.abort();
  }, [missing, profile, retry]);

  function toggle(id: string) {
    if (!pins.includes(id) && pins.length >= MAX_SIDEBAR_PINS) {
      setNotice(`You can pin up to ${MAX_SIDEBAR_PINS} conversations. Unpin one to add another.`);
      return;
    }
    const next = pins.includes(id) ? pins.filter(pin => pin !== id) : parseSidebarPins([...pins, id]);
    setPins(next);
    try {
      workspaceBrowserStorage().setItem(key, JSON.stringify(next));
      setNotice('');
    } catch { setNotice('Pins are kept for this visit only. Browser storage is unavailable.'); }
  }

  return { pins, resolved, toggle, notice, retry: () => setRetry(value => value + 1) };
}
