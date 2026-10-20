import { Check, Circle, CircleAlert, LoaderCircle, X } from 'lucide-react';
import type { RunEvent, RunStatus } from '../../../packages/core/src/types';
import { runProgressSteps } from './run-progress-state';
import './run-progress.css';

export function RunProgress({ events, status, error, example = false }: { events: RunEvent[]; status: RunStatus; error?: string | null; example?: boolean }) {
  const steps = runProgressSteps(events, status, error, example);
  const unfinished = steps.some(step => ['failed', 'stopped', 'interrupted'].includes(step.state));
  return <ol className="run-progress" aria-label={example ? 'Illustrative task progress' : 'Task progress'} aria-live={example ? 'off' : 'polite'} aria-atomic="true">
    {steps.map(step => {
      const Icon = step.state === 'complete' ? Check : step.state === 'active' ? LoaderCircle
        : step.state === 'failed' || step.state === 'interrupted' ? CircleAlert
        : step.state === 'stopped' ? X : Circle;
      return <li key={step.label} data-state={step.state} aria-label={`${step.label}: ${step.description}`} aria-current={step.state === 'active' ? 'step' : undefined}>
        <span className={`run-progress-mark ${step.state}`} aria-hidden="true"><Icon size={step.state === 'complete' || step.state === 'active' ? 14 : 18} className={step.state === 'active' ? 'run-progress-spinner' : undefined}/></span>
        <span>{step.label}</span>
        {['failed', 'stopped', 'interrupted'].includes(step.state) && <small>{step.description}</small>}
        {unfinished && step.state === 'pending' && <small>{step.description}</small>}
        {step.description === 'Queued' && <small>Queued</small>}
      </li>;
    })}
  </ol>;
}
