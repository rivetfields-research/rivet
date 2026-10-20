import type { ReactNode } from 'react';
import { Markdown } from './markdown';
import { splitReportSections } from './report-sections';

export interface ReportNarrative { content: string; citations: string[] }

export function reportBody(content: string, title: string) {
  const heading = content.match(/^\s*#{1,2}[ \t]+(.+?)[ \t]*\r?\n/);
  const normalize = (text: string) => text.replace(/[ \t]+#+$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return heading && normalize(heading[1]) === normalize(title) ? content.slice(heading[0].length).replace(/^\s*\n/, '') : content;
}

export function ReportBody({ content, citations, onSource, children, takeaways, scope }: ReportNarrative & {
  onSource: (id: string) => void; children: ReactNode; takeaways?: ReactNode; scope?: ReactNode;
}) {
  const sections = splitReportSections(content);
  if (takeaways) return <div className="report-reading-layout">
    {scope && <div className="report-scope">{scope}</div>}
    <section className="report-takeaways" aria-label="Key takeaways"><h2>Key takeaways</h2>{takeaways}</section>
    {children}
    {content.trim() && <section className="markdown agent-document-body report-context" aria-label="Report context">
      <h2>Report context</h2>
      <Markdown content={content} citations={citations} onSource={onSource}/>
    </section>}
  </div>;
  return <>
    {scope && <div className="report-scope">{scope}</div>}
    {content.trim() && <section className="markdown agent-document-body agent-report-takeaway" aria-label={sections ? 'Key takeaway' : 'Report summary'}>
      {sections && <h2>Key takeaway</h2>}
      <Markdown content={sections?.takeaway ?? content} citations={citations} onSource={onSource}/>
    </section>}
    {children}
    {sections && <div className="markdown agent-document-body agent-report-explanation">
      <section aria-label="What it means"><h2>What it means</h2><Markdown content={sections.interpretation} citations={citations} onSource={onSource}/></section>
      <section aria-label="Next step"><h2>Next step</h2><Markdown content={sections.nextStep} citations={citations} onSource={onSource}/></section>
    </div>}
  </>;
}
