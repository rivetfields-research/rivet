import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { readablePostText, usePostTextLabels } from './post-presentation';

export function Markdown({ content, citations = [], onSource }: { content: string; citations?: string[]; onSource: (id: string) => void }) {
  const postLabels = usePostTextLabels();
  return <ReactMarkdown remarkPlugins={[remarkGfm, readablePostText(postLabels)]} urlTransform={(url) => url.startsWith('source:') ? citations.includes(url.slice(7)) ? url : '' : defaultUrlTransform(url)} components={{
    table: ({ children }) => <div className="report-table-scroll" role="region" aria-label="Report table" tabIndex={0}><table>{children}</table></div>,
    // A model occasionally uses image syntax for a calculation receipt. It is
    // still an authorized source link, never a fetchable image or a new chart.
    img: ({ alt, src }) => src?.startsWith('source:') && citations.includes(src.slice(7))
      ? <button className="inline-source" data-source-id={src.slice(7)} onClick={event => { event.currentTarget.focus({ preventScroll: true }); onSource(src.slice(7)); }}>{alt || 'Calculation source'}</button>
      : <span className="image-placeholder">{alt ? `[Image: ${alt}]` : '[Image omitted]'}</span>,
    a: ({ href, children }) => href?.startsWith('source:') && citations.includes(href.slice(7))
      ? <button className="inline-source" data-source-id={href.slice(7)} onClick={event => { event.currentTarget.focus({ preventScroll: true }); onSource(href.slice(7)); }}>{children}</button>
      : <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
  }}>{content}</ReactMarkdown>;
}
