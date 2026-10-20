import { useState } from 'react';
import { ArrowRight } from 'lucide-react';

declare global {
  interface Window {
    rivetDesktop?: { openModelSettings(): Promise<{ ok?: boolean; error?: string }> };
  }
}

export function DesktopModelNotice({ configured }: { configured: boolean }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  async function openSettings() {
    if (opening) return;
    setOpening(true); setError('');
    try {
      const result = await window.rivetDesktop?.openModelSettings();
      if (result?.ok !== true) throw new Error();
    } catch {
      setError('Open Model settings from the Rivet Alpha app menu. Your saved work is unchanged.');
    } finally { setOpening(false); }
  }
  return <>
    <div className="availability-note"><span>{configured
      ? 'Your local model is unavailable. Saved reports and imports are still available.'
      : 'Choose a local model for AI answers. Saved reports and imports are still available.'}</span>
      <button className="text-button" disabled={opening} onClick={() => void openSettings()}>{opening ? 'Opening...' : configured ? 'Model settings' : 'Choose model'} <ArrowRight size={13}/></button>
    </div>
    {error && <p role="alert" className="module-alert">{error}</p>}
  </>;
}
