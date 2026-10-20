import { createHash } from 'node:crypto';
import type { AdminUsage, AdminUsageRow, AllowanceCredit, UsageResetPreview } from '../../../packages/core/src/usage-admin-types.ts';
import type { ModelAllowanceSnapshot } from '../../../packages/core/src/workspace-diagnostics.ts';
import type { OrganizationIdentity, OrganizationWorkspaceLimits } from '../../../packages/core/src/organization-types.ts';
import { OrganizationError, OrganizationStore } from './organizations.ts';

type PersonalUsage = Omit<AdminUsageRow, 'preview'> & {limits: OrganizationWorkspaceLimits};
export function createUsageAdministration(options: {
  store: OrganizationStore; installation: () => ModelAllowanceSnapshot;
  installationLimits: {inputByteLimit: number; outputTokenLimit: number};
  users: () => PersonalUsage[];
  now?: () => number;
}) {
  function current() {
    const installation = options.installation();
    if (!installation.resetsAt) throw new OrganizationError(503, 'usage_unavailable', 'The allowance reset date could not be verified.');
    const users = options.users().sort((a, b) => a.id.localeCompare(b.id));
    if (users.some(row => row.allowance && row.allowance.label !== installation.label)) {
      throw new OrganizationError(409, 'usage_changed', 'The allowance period changed. Refresh usage before continuing.');
    }
    const day = new Date(options.now?.() ?? Date.now()).toISOString().slice(0,10);
    const dailyReset = new Date(Date.parse(day) + 86_400_000).toISOString();
    if (users.some(row => row.daily && row.daily.resetsAt !== dailyReset)) throw new OrganizationError(409, 'usage_changed', 'The daily allowance period changed. Refresh usage before continuing.');
    return {installation, users, day};
  }
  function preview(scope: string, state: ReturnType<typeof current>): {preview: UsageResetPreview; adjustments: AllowanceCredit[]; period: string} {
    let adjustments: AllowanceCredit[], evidence: unknown;
    const daily = scope.startsWith('daily:'), period = daily ? state.day : state.installation.label;
    if (daily) {
      const target = scope.slice(6), selected = target === 'all-users' ? state.users : state.users.filter(row => row.id === target);
      if (target !== 'all-users' && (!selected.length || selected[0].status !== 'ready' || !selected[0].daily)) throw new OrganizationError(409, 'usage_unavailable', 'Only active members with ready daily allowances can receive a reset.');
      evidence = selected;
      adjustments = selected.filter(row => row.status === 'ready' && row.daily).map(row => ({workspaceId: row.id, inputByteUnits: 0, outputTokens: 0,
        dailyRuns: Math.max(0, row.limits.dailyRuns - (row.daily!.limit - row.daily!.used)),
      })).filter(item => item.dailyRuns > 0);
    } else if (scope === 'installation') {
      adjustments = [{workspaceId: 'installation', inputByteUnits: options.installationLimits.inputByteLimit, outputTokens: options.installationLimits.outputTokenLimit}];
      evidence = state.installation;
    } else {
      const selected = scope === 'all-users' ? state.users : state.users.filter(row => row.id === scope);
      if (scope !== 'all-users' && (!selected.length || selected[0].status !== 'ready')) {
        throw new OrganizationError(409, 'usage_unavailable', 'Only active members with ready, writable private workspaces can receive a reset.');
      }
      evidence = selected;
      adjustments = selected.filter(row => row.status === 'ready' && row.allowance).map(row => ({workspaceId: row.id,
        inputByteUnits: Math.max(0, row.limits.inputByteUnits - (row.allowance!.inputByteUnits.limit - row.allowance!.inputByteUnits.used)),
        outputTokens: Math.max(0, row.limits.outputTokens - (row.allowance!.outputTokens.limit - row.allowance!.outputTokens.used)),
      })).filter(item => item.inputByteUnits > 0 || item.outputTokens > 0);
    }
    return {adjustments, period, preview: {scope,
      expected: createHash('sha256').update(JSON.stringify([period, scope, evidence, adjustments])).digest('hex'),
      people: scope === 'installation' ? 0 : adjustments.length,
      inputByteUnits: adjustments.reduce((sum, item) => sum + item.inputByteUnits, 0),
      outputTokens: adjustments.reduce((sum, item) => sum + item.outputTokens, 0),
      ...(daily ? {dailyRuns: adjustments.reduce((sum, item) => sum + (item.dailyRuns ?? 0), 0)} : {}),
    }};
  }
  return {
    snapshot(): AdminUsage {
      const state = current();
      return {period: state.installation.label, resetsAt: state.installation.resetsAt!,
        installation: {allowance: state.installation, preview: preview('installation', state).preview},
        users: state.users.map(({limits: _limits, ...row}) => ({...row, preview: row.status === 'ready' ? preview(row.id, state).preview : null,
          dailyPreview: row.status === 'ready' && row.daily ? preview(`daily:${row.id}`, state).preview : null})),
        allUsers: preview('all-users', state).preview, allDaily: preview('daily:all-users', state).preview, history: options.store.usageResetHistory(), limitHistory: options.store.controlHistory('daily_limit')};
    },
    reset(input: Record<string, unknown>, actor: OrganizationIdentity) {
      return options.store.recordUsageReset(input, actor, () => {
        const state = current(), next = preview(String(input.scope), state);
        if (next.preview.expected !== input.expected) throw new OrganizationError(409, 'usage_changed', 'Usage or membership changed. Refresh and review the amounts again.');
        if (!next.adjustments.length) throw new OrganizationError(409, 'allowance_full', 'The selected users already have their full allowance.');
        return {period: next.period, adjustments: next.adjustments};
      });
    },
  };
}
