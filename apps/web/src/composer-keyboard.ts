import type { KeyboardEvent } from 'react';

/** Enter sends; Shift/Option+Enter inserts a line. Never submit an IME selection. */
export function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>, send: () => void) {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
  event.preventDefault();
  if (!event.repeat) send();
}
