export interface AdminControlChange {
  id: string; kind: 'daily_limit' | 'staff'; target: string; before: number; after: number;
  reason: string; actor: string; at: string;
}
export interface AdminStaffPerson {
  id: string; name: string; email: string; organizations: string[];
  access: 'owner' | 'admin' | 'none'; eligible: boolean; version: number;
}
export interface AdminStaffSnapshot {
  canManage: boolean; people: AdminStaffPerson[]; history: AdminControlChange[];
}
