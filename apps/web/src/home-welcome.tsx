import { RivetMark } from './rivet-mark';
import { WorkspaceBrand } from './workspace-brand';
import { workspaceGreeting, type WorkspaceSession } from './session-access';
import type { ProviderStatus, Source } from '../../../packages/core/src/types';
import { analyticalQuestions } from '../../../packages/core/src/answer-suggestions';

export function homeModelLabel(provider: ProviderStatus | undefined): string {
  if (!provider) return 'Checking Rivet';
  return provider.available ? 'Rivet available' : 'Rivet unavailable';
}

export function sourceStarters(selectedIds: readonly string[], sources: readonly Source[], seed = 0): readonly {label: string; prompt: string}[] {
  if (!selectedIds.length) return [];
  const selected = selectedIds.map(id => sources.find(source => source.id === id));
  if (selected.some(source => !source)) return [];
  const questions = analyticalQuestions(selected.filter((source): source is Source => Boolean(source)), seed);
  if (questions.length) return questions.map(prompt => ({label:prompt,prompt}));
  return ['Summarize these files', 'What can we learn?', 'What information is missing?'].map(prompt => ({ label: prompt, prompt }));
}

export function QuestionSuggestions({ questions, onChoose, disabled = false, concealed = false }: { questions: readonly string[]; onChoose: (question: string) => void; disabled?: boolean; concealed?: boolean }) {
  if (!questions.length) return null;
  return <div className="home-prompt-chips" role="group" aria-label="Suggested questions" aria-hidden={concealed || undefined} style={{ visibility: concealed ? 'hidden' : undefined }}>{questions.slice(0,3).map(question => <button key={question} type="button" disabled={disabled || concealed} onClick={() => { if (!concealed && !disabled) onChoose(question); }}>{question}</button>)}</div>;
}

export function HomeWelcome({ session, healthcare = false }: { session: WorkspaceSession | null; healthcare?: boolean }) {
  const customer = session?.mode === 'authenticated' && session.organizationId ? session.workspaceName?.trim() : undefined;
  return <div className="home-heading">
    <span className="home-mark">{healthcare || customer ? <RivetMark size={32}/> : <WorkspaceBrand compact size={32}/>}</span>
    <h1>{healthcare ? 'What would you like to work on?' : workspaceGreeting(session)}</h1>
    <p>{healthcare ? 'Turn your data into a clear answer.' : 'What would you like to understand?'}</p>
  </div>;
}
