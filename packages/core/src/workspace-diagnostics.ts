export interface AllowanceCounter { used: number; limit: number; }

/** Reservations are conservative safety limits, not measured billing or dollars. */
export interface ModelAllowanceSnapshot {
  period: 'month' | 'batch';
  label: string;
  resetsAt: string | null;
  inputByteUnits: AllowanceCounter;
  outputTokens: AllowanceCounter;
  calls?: AllowanceCounter;
}

export interface WorkspaceDiagnostics {
  checkedAt: string;
  allowance: { status: 'available'; snapshot: ModelAllowanceSnapshot } | { status: 'unavailable' | 'not-configured' };
  access: {
    mode: 'local' | 'entra' | 'cloudflare';
    role: 'local' | 'owner';
    members: { owner: number; operator: number; reviewer: number } | null;
  };
}
