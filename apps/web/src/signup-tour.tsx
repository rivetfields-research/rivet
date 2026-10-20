import { useState } from 'react';
import { ArrowLeft, ArrowRight, Database, MessageCircle, FileText, Minus, X, Route } from 'lucide-react';
import { readSaved, saveLocal } from './api';
import { allowsManualImports } from './workspace-scope';

export const signupTourSteps = () => [
  {title: 'Connect a source', text: allowsManualImports() ? 'Upload a file or connect an account in Sources.' : 'Connect an account in Sources, then select its data for your question.', label: 'Connect source', view: 'tables', connect: 'data'},
  {title: 'Ask your first question', text: 'Choose your sources and ask a question on Home.', label: 'Ask a question', view: 'home'},
  {title: 'Your reports', text: 'Your saved reports appear here after you create one.', label: 'Open reports', view: 'dashboards'},
];
export function SignupTour() {
  const steps = signupTourSteps();
  const [progress, setProgress] = useState(() => {
    const saved = readSaved<{active: boolean; step: number; visited: number[]; minimized?: boolean}>('welcome-tour', {active:false, step:0, visited:[]});
    return {active: new URLSearchParams(location.search).get('welcome') === '1' || saved.active === true,
      minimized: saved.minimized === true,
      step: Number.isInteger(saved.step) && saved.step >= 0 && saved.step < steps.length ? saved.step : 0,
      visited: Array.isArray(saved.visited) ? saved.visited.filter(value => Number.isInteger(value) && value >= 0 && value < steps.length) : []};
  });
  const update = (next: typeof progress) => { setProgress(next); saveLocal('welcome-tour', next); };
  const step = progress.step;
  const dismiss = () => {
    update({...progress, active:false});
    const url = new URL(location.href); url.searchParams.delete('welcome');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  };
  if (!progress.active) return null;
  if (progress.minimized) return <button className="signup-tour-launcher" aria-label="Open getting started" title="Getting started" onClick={() => update({...progress, minimized:false})}><Route size={21}/><span className="tour-launcher-progress">{progress.visited.length} / {steps.length}</span></button>;
  const current = steps[step];
  const open = () => {
    update({...progress, visited: [...new Set([...progress.visited, step])]});
    const url = new URL(location.pathname, location.origin);
    url.searchParams.set('view', current.view); url.searchParams.set('welcome', '1');
    if (current.connect) url.searchParams.set('connect', current.connect);
    location.assign(url.pathname + url.search);
  };
  return <aside className="signup-tour" aria-label="Welcome tour">
    <div className="signup-tour-top"><span>Getting started <span className="tour-count">{step + 1} / {steps.length}</span></span><div className="tour-window-controls"><button className="icon-button" aria-label="Minimize tour" title="Minimize" onClick={() => update({...progress, minimized:true})}><Minus size={15}/></button><button className="icon-button" aria-label="Skip tour" title="Close tour" onClick={dismiss}><X size={15}/></button></div></div>
    <div className="signup-tour-content"><div className="tour-symbol">{step === 0 ? <Database size={23}/> : step === 1 ? <MessageCircle size={23}/> : <FileText size={23}/>}</div><h2>{current.title}</h2><p>{current.text}</p></div>
    <div className="signup-tour-actions"><button className="org-button org-primary" onClick={open}>{current.label}<ArrowRight size={14}/></button>
      <button disabled={step === 0} className="org-button" onClick={() => update({...progress, step: step - 1})} aria-label="Back" title="Previous step"><ArrowLeft size={16}/></button>
    <div className="signup-tour-progress" aria-label="Tour progress">{steps.map((item, index) => <button key={item.view} aria-label={`Go to ${item.title}${progress.visited.includes(index) ? ' · Visited' : ''}`} title={`${item.title}${progress.visited.includes(index) ? ' · Visited' : ''}`} aria-current={index === step ? 'step' : undefined} className={`${index === step ? 'current' : ''} ${progress.visited.includes(index) ? 'visited' : ''}`} onClick={() => update({...progress, step:index})}><span/></button>)}</div>
      <button className="org-button" onClick={() => step === steps.length - 1 ? dismiss() : update({...progress, step: step + 1})}>{step === steps.length - 1 ? 'Finish tour' : 'Next'}<ArrowRight size={14}/></button>
    </div>
  </aside>;
}
