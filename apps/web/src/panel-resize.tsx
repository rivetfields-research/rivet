import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { workspaceBrowserStorage } from './workspace-scope';

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
type Side = 'left' | 'right';

export function clampPanelWidth(width: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, Number.isFinite(width) ? width : min)));
}

/** Preferences are cosmetic. Unavailable or malformed storage never blocks work. */
export function readPanelWidth(storage: Storage | undefined, key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = storage?.getItem(key);
    const value: unknown = raw && raw.length < 100 ? JSON.parse(raw) : null;
    if (typeof value === 'number' && Number.isFinite(value)) return clampPanelWidth(value, min, max);
  } catch { /* The browser can deny access to persistent preferences. */ }
  return clampPanelWidth(fallback, min, max);
}

export function savePanelWidth(storage: Storage | undefined, key: string, width: number): void {
  try { storage?.setItem(key, JSON.stringify(width)); } catch { /* Keep resizing available for this visit. */ }
}

function browserStorage(): Storage | undefined {
  try { return typeof window === 'undefined' ? undefined : workspaceBrowserStorage(); } catch { return undefined; }
}

export function panelLimits(min: number, max: number, containerWidth: number, remainingWidth: number, desktop: boolean, containerThreshold = 0) {
  const available = Math.floor(containerWidth - remainingWidth);
  return { min, max: Math.max(min, Math.min(max, available)), enabled: desktop && containerWidth > containerThreshold && available >= min };
}

export function panelKeyboardWidth(key: string, width: number, min: number, max: number, side: Side, shift = false): number | null {
  if (key === 'Home') return min;
  if (key === 'End') return max;
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
  const direction = (key === 'ArrowRight' ? 1 : -1) * (side === 'left' ? 1 : -1);
  return clampPanelWidth(width + direction * (shift ? 40 : 10), min, max);
}

type Options = {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  containerRef: RefObject<HTMLElement | null>;
  minimumRemainingWidth: number;
  enabled?: boolean;
  desktopQuery?: string;
  desktopMinContainerWidth?: number;
};

export type PanelResizeController = {
  width: number;
  min: number;
  max: number;
  enabled: boolean;
  setWidth: (width: number) => void;
  reset: () => void;
};

export function usePanelResize({ storageKey, defaultWidth, minWidth, maxWidth, containerRef, minimumRemainingWidth, enabled = true, desktopQuery = '(min-width: 901px)', desktopMinContainerWidth = 0 }: Options): PanelResizeController {
  const [preferred, setPreferred] = useState(() => readPanelWidth(browserStorage(), storageKey, defaultWidth, minWidth, maxWidth));
  const [layout, setLayout] = useState({ width: 0, desktop: false });
  useEffect(() => { setPreferred(readPanelWidth(browserStorage(), storageKey, defaultWidth, minWidth, maxWidth)); }, [storageKey, defaultWidth, minWidth, maxWidth]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const media = window.matchMedia(desktopQuery);
    const measure = () => {
      const width = container.getBoundingClientRect().width;
      setLayout(previous => previous.width === width && previous.desktop === media.matches ? previous : { width, desktop: media.matches });
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(container);
    media.addEventListener('change', measure);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); media.removeEventListener('change', measure); window.removeEventListener('resize', measure); };
  }, [containerRef, desktopQuery, enabled]);
  const limits = panelLimits(minWidth, maxWidth, layout.width, minimumRemainingWidth, enabled && layout.desktop, desktopMinContainerWidth);
  // A smaller viewport clamps the visible width without erasing the wider preference.
  const width = clampPanelWidth(preferred, limits.min, limits.max);
  const setWidth = (next: number) => {
    const value = clampPanelWidth(next, limits.min, limits.max);
    setPreferred(value);
    savePanelWidth(browserStorage(), storageKey, value);
  };
  return { width, ...limits, setWidth, reset: () => setWidth(defaultWidth) };
}

type Drag = { pointerId: number; x: number; width: number; element: HTMLDivElement; cursor: string; userSelect: string };

/** The separator moves only its adjacent panel; it never pans the workspace. */
export function PanelResizeHandle({ panel, side, controls, label, className = '' }: { panel: PanelResizeController; side: Side; controls: string; label: string; className?: string }) {
  const drag = useRef<Drag | null>(null);
  const [resizing, setResizing] = useState(false);
  const finish = useCallback(() => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (current.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
    if (document.body.style.cursor === 'col-resize') document.body.style.cursor = current.cursor;
    if (document.body.style.userSelect === 'none') document.body.style.userSelect = current.userSelect;
    setResizing(false);
  }, []);
  useEffect(() => finish, [finish]);
  useEffect(() => { if (!panel.enabled) finish(); }, [panel.enabled, finish]);
  useEffect(() => {
    const blur = () => finish();
    window.addEventListener('blur', blur);
    return () => window.removeEventListener('blur', blur);
  }, [finish]);
  return <div role="separator" aria-orientation="vertical" aria-label={label} aria-controls={controls} aria-valuemin={panel.min} aria-valuemax={panel.max} aria-valuenow={panel.width} aria-valuetext={`${panel.width} pixels`} aria-disabled={!panel.enabled || undefined} tabIndex={panel.enabled ? 0 : -1} hidden={!panel.enabled} className={`panel-resize-handle ${resizing ? 'is-resizing' : ''} ${className}`} title={`${label} · Drag or use arrow keys · Double-click to reset`}
    onPointerDown={event => {
      if (!panel.enabled || !event.isPrimary || event.button !== 0 || drag.current) return;
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { return; }
      event.preventDefault();
      event.currentTarget.focus();
      drag.current = { pointerId: event.pointerId, x: event.clientX, width: panel.width, element: event.currentTarget, cursor: document.body.style.cursor, userSelect: document.body.style.userSelect };
      document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; setResizing(true);
    }}
    onPointerMove={event => {
      const current = drag.current;
      if (!panel.enabled || !current || current.pointerId !== event.pointerId) return;
      panel.setWidth(current.width + (event.clientX - current.x) * (side === 'left' ? 1 : -1));
    }}
    onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) finish(); }}
    onPointerCancel={event => { if (drag.current?.pointerId === event.pointerId) finish(); }}
    onLostPointerCapture={event => { if (drag.current?.pointerId === event.pointerId) finish(); }}
    onDoubleClick={() => { if (panel.enabled) panel.reset(); }}
    onKeyDown={event => {
      if (!panel.enabled) return;
      if (event.key === 'Escape' && drag.current) { event.preventDefault(); panel.setWidth(drag.current.width); finish(); return; }
      const next = panelKeyboardWidth(event.key, panel.width, panel.min, panel.max, side, event.shiftKey);
      if (next !== null) { event.preventDefault(); panel.setWidth(next); }
    }}/>
}
