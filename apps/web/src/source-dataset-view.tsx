import { useId, useState } from 'react';
import type { SourceDocument } from '../../../packages/core/src/types';
import { SourceCsvTable, type SourceSection } from './source-table';
const SECTIONS: { id: SourceSection; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'preview', label: 'Preview' },
  { id: 'fields', label: 'Fields' },
];

export function SourceDatasetView({ source, onSource }: { source: SourceDocument; onSource: (id: string) => void }) {
  const [section, setSection] = useState<SourceSection>('overview');
  const id = useId();
  function openPreview() {
    setSection('preview');
    document.getElementById(`${id}-preview`)?.focus();
  }
  return <div className="source-dataset-view">
    <div className="source-section-tabs" role="tablist" aria-label="Source sections">
      {SECTIONS.map((item, index) => <button key={item.id} type="button" role="tab" id={`${id}-${item.id}`}
        aria-selected={section === item.id} aria-controls={`${id}-panel`} tabIndex={section === item.id ? 0 : -1}
        onClick={() => setSection(item.id)} onKeyDown={event => {
          const next = event.key === 'ArrowRight' ? (index + 1) % SECTIONS.length
            : event.key === 'ArrowLeft' ? (index + SECTIONS.length - 1) % SECTIONS.length
              : event.key === 'Home' ? 0 : event.key === 'End' ? SECTIONS.length - 1 : null;
          if (next === null) return;
          event.preventDefault();
          const target = SECTIONS[next]!;
          setSection(target.id);
          document.getElementById(`${id}-${target.id}`)?.focus();
        }}>{item.label}</button>)}
    </div>
    <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${section}`} tabIndex={0}>
      <SourceCsvTable source={source} onSource={onSource} section={section} onPreview={openPreview}/>
    </div>
  </div>;
}
