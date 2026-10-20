/** Detach the customer sign-in window before sending it to the authorization provider. */
export function brokerSignInWindow(open: () => Window | null = () => window.open('about:blank', '_blank')) {
  let target: Window | null = null;
  let navigated = false;
  // Detaching the opener also removes authority to close some cross-origin windows.
  const close = () => {
    if (target && !navigated && !target.closed) target.close();
    target = null; navigated = false;
  };
  return {
    reserve() {
      close();
      try {
        target = open();
        if (!target) return false;
        target.opener = null;
        target.document.title = 'Rivet - Sign-in';
        const referrer = target.document.createElement('meta');
        referrer.name = 'referrer'; referrer.content = 'no-referrer';
        target.document.head.append(referrer);
        target.document.body.textContent = 'Opening sign-in...';
        return true;
      } catch { close(); return false; }
    },
    navigate(url: string) {
      if (!target || target.closed) return false;
      try { target.location.replace(url); navigated = true; return true; }
      catch { close(); return false; }
    },
    isClosed: () => !target || target.closed,
    close,
  };
}
