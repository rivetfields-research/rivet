import { workspaceApiPath } from './workspace-scope';
import { useId, useState } from 'react';
import { Download, FileText } from 'lucide-react';
import { socialMetricLabels, type SocialAnalysis } from '../../../packages/core/src/social-analysis';
import { metricValue } from './visual-analysis';
import './social-analysis.css';

export function SocialAnalysisView({ analysis, runId, onSource }: { analysis: SocialAnalysis; runId: string; onSource: (id: string) => void }) {
  const [metric, setMetric] = useState<keyof typeof socialMetricLabels>('likes');
  const id = useId();
  const posts = analysis.posts.slice(0, 30);
  const hasValues = posts.some(post => post.metrics[metric] !== null);
  const max = Math.max(1, ...posts.map(post => post.metrics[metric] ?? 0));
  const step = 620 / Math.max(1, posts.length);
  return <section className="social-analysis" aria-label="Saved social analysis">
    <div className="social-analysis-meta"><span>{analysis.account} · {analysis.platform}</span><span>{analysis.week.from} – {analysis.week.through} · UTC</span></div>
    <p className="small muted">Posts published in this period. Counts are lifetime totals observed at collection, not engagement earned during the week. Coverage: {analysis.coverage}.</p>
    <div className="social-analysis-chart">
      <header><h2>Performance by post</h2><a className="text-button" href={workspaceApiPath(`/api/runs/${encodeURIComponent(runId)}/social.csv`)} download={`social-posts-${analysis.week.from}.csv`}><Download size={14}/>Download CSV</a></header>
      <label htmlFor={id}>Metric <select id={id} value={metric} onChange={event => setMetric(event.target.value as keyof typeof socialMetricLabels)}>{Object.entries(socialMetricLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      {posts.length && hasValues ? <svg viewBox="0 0 710 270" className="usage-chart-svg" role="img" aria-label={`${socialMetricLabels[metric]} by source post. Unknown counts are labeled Unknown. Exact values appear in Source posts below.`}>
        {[0, 0.5, 1].map(tick => <g key={tick}><line className="usage-gridline" x1={70} x2={690} y1={220 - tick * 180} y2={220 - tick * 180}/><text x={60} y={224 - tick * 180} textAnchor="end">{metricValue(max * tick)}</text></g>)}
        {posts.map((post, index) => { const value = post.metrics[metric]; const x = 70 + index * step; const width = Math.min(65, step * 0.65); return <g key={post.record}>
          {value !== null && <rect className="social-bar" x={x + (step-width)/2} y={220 - value/max*180} width={width} height={value/max*180} rx={3}><title>Record {post.record}: {value} {socialMetricLabels[metric]}</title></rect>}
          <text x={x+step/2} y={value === null ? 202 : Math.max(25, 210 - value/max*180)} textAnchor="middle">{value === null ? 'Unknown' : metricValue(value)}</text>
          <text x={x+step/2} y={245} textAnchor="middle">#{post.record}</text>
        </g>; })}
      </svg> : <p>{posts.length ? `${socialMetricLabels[metric]} were not reported for these posts. Missing counts are unknown, not zero.` : 'No posts in the selected period. This does not establish that no posts were published.'}</p>}
      {analysis.posts.length > 30 && <p className="small muted">Chart shows the first 30 posts. The table and CSV include all {analysis.posts.length} posts.</p>}
    </div>
    <h2>Source posts</h2>
    <div className="social-table-scroll" tabIndex={0} role="region" aria-label="Source post values"><table><thead><tr><th>Record</th><th>Published (UTC)</th>{Object.values(socialMetricLabels).map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{analysis.posts.map(post => <tr key={post.record}><td><a href={post.postUrl} target="_blank" rel="noreferrer">#{post.record}</a></td><td>{post.publishedAt?.slice(0,10) ?? 'Unknown'}</td>{Object.keys(socialMetricLabels).map(key => <td key={key}>{metricValue(post.metrics[key as keyof typeof socialMetricLabels])}</td>)}</tr>)}</tbody></table></div>
    <p className="small muted">A dash means unknown, not zero. Collected {analysis.fetchedAt}.</p>
    <button className="text-button" onClick={() => onSource(analysis.sourceId)}><FileText size={14}/>View source records and calculation</button>
  </section>;
}
