import { useEffect, useRef, useState } from 'react';
import { ApiError, api, message } from './api';
import type { BrokerChoice } from '../../../packages/core/src/broker-connections';
import { brokerSignInWindow } from './broker-sign-in-window';

type Pending = { id: string; provider: string; url: string; expiresAt: string };
export function useBrokerConnection(enabled: boolean, refresh: () => Promise<unknown>, feedbackScope = 'connections') {
  const [pending, setPending] = useState<Pending | null>(null);
  const [choice, setChoice] = useState<BrokerChoice | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [signInState, setSignInState] = useState<'waiting' | 'blocked' | 'closed'>('waiting');
  const signIn = useRef<ReturnType<typeof brokerSignInWindow> | null>(null);
  const epoch = useRef(0), locked = useRef(false);
  const currentScope = useRef(feedbackScope);
  currentScope.current = feedbackScope;
  useEffect(() => { setError(''); }, [feedbackScope]);
  useEffect(() => () => { epoch.current++; signIn.current?.close(); }, []);
  useEffect(() => { if (!enabled) { epoch.current++; signIn.current?.close(); setPending(null); setChoice(null); setBusy(false); } }, [enabled]);
  const path = (item: Pending) => `/api/connections/${item.provider}/broker/${item.id}`;
  async function run(work: () => Promise<void>) {
    if (!enabled || locked.current) return false;
    const current = epoch.current;
    locked.current = true; setBusy(true); setError('');
    try { await work(); return current === epoch.current; } catch (err) {
      if (current === epoch.current) {
        if (currentScope.current === feedbackScope) setError(message(err));
        if (err instanceof ApiError && err.status === 410) { signIn.current?.close(); setPending(null); setChoice(null); }
      }
      return false;
    } finally { locked.current = false; if (current === epoch.current) setBusy(false); }
  }
  async function check() {
    if (!pending) return;
    const current = epoch.current;
    await run(async () => {
      const result = await api<BrokerChoice>(path(pending));
      if (current === epoch.current) setChoice(result);
    });
  }
  useEffect(() => {
    if (!enabled || !pending || choice?.accounts.length || busy) return;
    const timer = setTimeout(() => {
      if (signInState === 'waiting' && signIn.current?.isClosed()) setSignInState('closed');
      void check();
    }, error ? 10_000 : 4000);
    return () => clearTimeout(timer);
  }, [enabled, pending, choice, error, busy, signInState]);
  useEffect(() => {
    if (!enabled || !pending || choice?.accounts.length) return;
    const returned = () => { if (document.visibilityState === 'visible') void check(); };
    window.addEventListener('focus', returned);
    document.addEventListener('visibilitychange', returned);
    return () => { window.removeEventListener('focus', returned); document.removeEventListener('visibilitychange', returned); };
  }, [enabled, pending, choice]);
  return { pending, choice, error, busy, signInState, check,
    openSignIn() {
      if (!enabled || !pending) return;
      signIn.current ??= brokerSignInWindow();
      setSignInState(signIn.current.reserve() && signIn.current.navigate(pending.url) ? 'waiting' : 'blocked');
    },
    async begin(provider: string) {
      if (!enabled || locked.current || pending) return;
      // Reserve during the user's click, before awaiting the server, to avoid popup blockers.
      signIn.current ??= brokerSignInWindow();
      const opened = signIn.current.reserve();
      const current = epoch.current;
      const ok = await run(async () => {
        const result = await api<Pending>(`/api/connections/${provider}/broker`, { method: 'POST', body: '{}' });
        if (current === epoch.current) {
          setPending(result); setChoice(null);
          setSignInState(opened && signIn.current!.navigate(result.url) ? 'waiting' : 'blocked');
        }
      });
      if (!ok) signIn.current.close();
    },
    async confirm(id: string): Promise<boolean> {
      let done = false;
      await run(async () => {
        if (!pending) return;
        const current = epoch.current;
        await api(path(pending), { method: 'POST', body: JSON.stringify({ accounts: [{ id }] }) });
        if (current !== epoch.current) return;
        signIn.current?.close(); setPending(null); setChoice(null); done = true; await refresh();
      });
      return done;
    },
    async cancel(): Promise<boolean> {
      let done = false;
      await run(async () => {
        const current = epoch.current;
        if (pending) await api(path(pending), { method: 'DELETE' });
        if (current !== epoch.current) return;
        signIn.current?.close(); setPending(null); setChoice(null); done = true;
      });
      return done;
    },
  };
}
