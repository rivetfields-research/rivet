import { useState } from 'react';
import { ArrowRight, ChevronRight, Search } from 'lucide-react';
import type { Source } from '../../../packages/core/src/types';

export function ModuleSourceSelection({ sources, selectedIds, onChange, disabled = false, onBrowse }: { sources: Source[]; selectedIds: string[]; onChange: (ids: string[]) => void; disabled?: boolean; onBrowse: () => void }) {
  const [query, setQuery] = useState('');
  const visible = sources.filter(source => source.title.toLowerCase().includes(query.toLowerCase()));
  const missing = selectedIds.filter(id => !sources.some(source => source.id === id));
  const toggle = (id: string) => onChange(selectedIds.includes(id) ? selectedIds.filter(value => value !== id) : [...selectedIds, id]);
  return <details className="module-file-selection"><summary>Files <span>{selectedIds.length} selected</span><ChevronRight size={13} /></summary>
    <fieldset disabled={disabled}><legend className="sr-only">Files for this task</legend>
      {sources.length > 6 && <label className="module-search"><Search size={13}/><input type="search" aria-label="Find files to select" placeholder="Find a file" value={query} onChange={event => setQuery(event.target.value)}/></label>}
      <div className="module-file-options">{visible.map(source => <label key={source.id}><input type="checkbox" checked={selectedIds.includes(source.id)} disabled={!selectedIds.includes(source.id) && selectedIds.length >= 100} onChange={() => toggle(source.id)}/><span>{source.title}</span></label>)}{missing.map(id => <label key={id}><input type="checkbox" checked onChange={() => toggle(id)}/><span>Unavailable file <small>{id}</small></span></label>)}</div>
      {!sources.length && <p className="module-tiny">No files available.</p>}
      {query && !visible.length && <p className="module-tiny">No matching files.</p>}
      <p className="module-tiny">{selectedIds.length ? 'Only these files will be attached.' : 'No files attached.'}</p>
    </fieldset><button type="button" className="module-link" onClick={onBrowse}>Browse files <ArrowRight size={12}/></button>
  </details>;
}
