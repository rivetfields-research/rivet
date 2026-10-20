import PptxGenJS from 'pptxgenjs';
import type { Artifact, WeeklyUsageAnalysis } from '../../../packages/core/src/types';

export interface PresentationDownload {
  data: ArrayBuffer;
  fileName: string;
  mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
}

const COLOR = { text: '18212F', muted: '586678', blue: '315ED0', pale: 'F3F5F8', line: 'DFE4EC', white: 'FFFFFF' };
const FONT = 'Arial';
const MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation' as const;
const number = (value: number | null) => value === null ? 'Unknown / undefined' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
const shortNumber = (value: number | null) => value === null ? '—' : number(value);
const percentage = (value: number | null) => value === null ? '—' : `${value > 0 ? '+' : ''}${number(value)}%`;

/** Plain text only: no HTML, links, external media, control characters or unbounded slide text. */
function text(value: string, limit = 240): string {
  const clean = value.replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(clean).length > limit ? `${Array.from(clean).slice(0, limit - 1).join('')}…` : clean;
}

function checkedAnalysis(artifact: Artifact): WeeklyUsageAnalysis {
  const a = artifact.analysis;
  if (!a || a.kind !== 'weekly-usage' || a.schemaVersion !== 1 || a.calculatorVersion !== 'weekly-usage/v1') {
    throw new Error('PowerPoint export needs a saved weekly usage calculation.');
  }
  const validValue = (value: number | null) => value === null || (typeof value === 'number' && Number.isFinite(value));
  const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
  const validDays = (days: WeeklyUsageAnalysis['daily']['current']) => Array.isArray(days) && days.length === 7 &&
    days.every(day => validDate(day.date) && [day.events, day.activeUsers].every(value => validValue(value) && (value === null || (Number.isSafeInteger(value) && value >= 0))));
  const keys = ['active_users', 'events', 'events_per_active_user'];
  if (!validDate(a.current.period.from) || !validDate(a.current.period.through) || !validDays(a.daily.current) ||
      (a.previous && (!validDate(a.previous.period.from) || !validDate(a.previous.period.through) || !a.daily.previous || !validDays(a.daily.previous))) ||
      (!a.previous && a.daily.previous !== null) ||
      a.comparisons.length !== 3 || new Set(a.comparisons.map(metric => metric.key)).size !== 3 ||
      a.comparisons.some(metric => !keys.includes(metric.key) || ![metric.current, metric.previous, metric.absoluteChange, metric.percentChange].every(validValue)) ||
      a.checks.length > 10 || !/^[a-f0-9]{64}$/i.test(a.contentHash) || artifact.citations.length > 100) {
    throw new Error('The saved calculation cannot be exported. Open the report and check its data.');
  }
  return a;
}

/**
 * Exports the saved calculator snapshot, not a new analysis or a model-written slide deck.
 * Browser-safe and deliberately excludes raw task text, narrative claims and source rows.
 * Import this module lazily from the download action to keep the editor bundle small.
 */
export async function buildUsagePresentation(artifact: Artifact): Promise<PresentationDownload> {
  const a = checkedAnalysis(artifact);
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'Rivet';
  pptx.subject = 'Saved weekly usage calculation';
  pptx.title = text(artifact.title || 'Weekly usage report', 160);
  pptx.company = 'Rivet';
  pptx.theme = { headFontFace: FONT, bodyFontFace: FONT };

  const period = `${a.current.period.from} – ${a.current.period.through} UTC`;
  const previousPeriod = a.previous ? `${a.previous.period.from} – ${a.previous.period.through} UTC` : 'Not requested';
  const receipt = [
    `Artifact: ${text(artifact.id, 200)}`, `Artifact saved: ${text(artifact.createdAt, 40)}`,
    `Calculation: ${text(a.id, 200)}`, `Calculation saved: ${text(a.createdAt, 40)}`,
    `Source: ${text(a.sourceName, 200)}`, `Source ID: ${text(a.sourceId, 200)}`,
    `Dataset: ${text(a.datasetId, 200)}`, `Input SHA-256: ${a.contentHash}`,
    `Calculator: ${a.calculatorVersion}`, `Current period: ${period}`, `Previous period: ${previousPeriod}`,
    `Saved artifact citations: ${artifact.citations.map(id => text(id, 200)).join(', ') || 'None'}`,
    'Numbers are copied from the saved calculation, with display rounding to at most two decimal places. Native chart data and notes retain the saved numeric values.',
    'Any completeness declaration comes from the uploader. The source data and narrative conclusions have not been independently verified.',
  ].join('\n');

  const slide = (title: string, subtitle: string, index: number) => {
    const s = pptx.addSlide();
    s.background = { color: COLOR.white };
    s.addText('RIVET  /  WEEKLY USAGE', { x: 0.6, y: 0.35, w: 10.5, h: 0.3, fontFace: FONT, fontSize: 10, bold: true, charSpacing: 1.5, color: COLOR.muted, margin: 0 });
    s.addText(text(title, 140), { x: 0.6, y: 0.95, w: 12.1, h: 0.6, fontFace: FONT, fontSize: 30, bold: true, color: COLOR.text, margin: 0, breakLine: false, fit: 'shrink' });
    s.addText(text(subtitle, 210), { x: 0.6, y: 1.63, w: 12.1, h: 0.45, fontFace: FONT, fontSize: 14, color: COLOR.muted, margin: 0, fit: 'shrink' });
    s.addText(`Saved calculation · ${period}`, { x: 0.6, y: 7.03, w: 11.4, h: 0.2, fontSize: 9, color: COLOR.muted, margin: 0 });
    s.addText(`${index} / 6`, { x: 12, y: 7.03, w: 0.7, h: 0.2, fontSize: 9, color: COLOR.muted, margin: 0, align: 'right' });
    s.addNotes(receipt);
    return s;
  };
  const body = (s: PptxGenJS.Slide, content: string, y: number, h = 0.6, options: Partial<PptxGenJS.TextPropsOptions> = {}) =>
    s.addText(content, { x: 0.65, y, w: 12, h, fontFace: FONT, fontSize: 17, color: COLOR.text, margin: 0, valign: 'top', breakLine: false, fit: 'shrink', ...options });
  const table = (s: PptxGenJS.Slide, headers: string[], rows: string[][], widths: number[], y: number, rowHeight: number) => {
    s.addTable([
      headers.map(label => ({ text: label, options: { bold: true, color: COLOR.muted, fill: { color: COLOR.pale } } })),
      ...rows.map(row => row.map(value => ({ text: value }))),
    ], { x: 0.65, y, w: 12, colW: widths, rowH: rowHeight, fontFace: FONT, fontSize: 15, color: COLOR.text,
      margin: [0.12, 0.12, 0.12, 0.12], border: { type: 'solid', pt: 0.5, color: COLOR.line },
      valign: 'middle', autoPage: false, verbose: false });
  };

  const overview = slide('Weekly usage report', pptx.title, 1);
  body(overview, period, 2.42, 0.55, { fontSize: 22 });
  a.comparisons.forEach((metric, index) => {
    const x = 0.65 + index * 4.05;
    overview.addText(text(metric.label, 44), { x, y: 3.47, w: 3.65, h: 0.45, fontSize: 17, color: COLOR.muted, margin: 0 });
    overview.addText(shortNumber(metric.current), { x, y: 4.04, w: 3.65, h: 0.8, fontSize: 42, bold: true, color: COLOR.blue, margin: 0, fit: 'shrink' });
    overview.addText(text(metric.unit, 30), { x, y: 4.99, w: 3.65, h: 0.35, fontSize: 14, color: COLOR.muted, margin: 0 });
  });
  body(overview, 'Counts describe the supplied records. A dash means unknown or undefined.', 6.02, 0.5, { fontSize: 16, color: COLOR.muted });

  const comparison = slide('Week in numbers', `Current: ${period}   |   Previous: ${previousPeriod}`, 2);
  table(comparison, ['Metric', 'Current', 'Previous', 'Change', 'Change %'], a.comparisons.map(metric => [
    `${text(metric.label, 44)}\n${text(metric.unit, 30)}`, shortNumber(metric.current), shortNumber(metric.previous), shortNumber(metric.absoluteChange), percentage(metric.percentChange),
  ]), [4, 2, 2, 2, 2], 2.42, 0.65);
  const reasons = [...new Set(a.comparisons.map(metric => metric.reason).filter((reason): reason is string => !!reason))];
  body(comparison, reasons.length ? reasons.map(reason => text(reason, 200)).join('\n') : 'Changes use the saved current and previous periods. Coverage for both periods was declared complete by the uploader.', 5.58, 0.9, { fontSize: 15, color: COLOR.muted });
  comparison.addNotes(`Saved comparison values (before display rounding):\n${JSON.stringify(a.comparisons, null, 2)}`);

  const daily = slide('Daily events', period, 3);
  const currentKnown = a.daily.current.every(day => day.events !== null);
  const previousKnown = !!a.daily.previous && a.daily.previous.every(day => day.events !== null);
  if (currentKnown) {
    daily.addChart(pptx.ChartType.bar, [
      { name: 'Current week', labels: a.daily.current.map(day => day.date.slice(5)), values: a.daily.current.map(day => day.events!) },
      ...(previousKnown ? [{ name: 'Previous week, aligned by day', labels: a.daily.current.map(day => day.date.slice(5)), values: a.daily.previous!.map(day => day.events!) }] : []),
    ], { x: 0.6, y: 2.35, w: 12, h: 3.75, catAxisLabelFontFace: FONT, catAxisLabelFontSize: 12, catAxisLabelColor: COLOR.muted,
      valAxisLabelFontFace: FONT, valAxisLabelFontSize: 12, valAxisLabelColor: COLOR.muted, valAxisMinVal: 0,
      valAxisLabelFormatCode: '0', catAxisLineShow: false, valAxisLineShow: false, valGridLine: { color: COLOR.line, size: 0.5 },
      chartColors: [COLOR.blue, 'B9C7E5'], showLegend: previousKnown, legendPos: 'b', legendFontSize: 12,
      showTitle: false, showValue: false, barDir: 'col', barGrouping: 'clustered',
      showValAxisTitle: true, valAxisTitle: 'Events', valAxisTitleFontSize: 12 });
    body(daily, a.daily.previous && !previousKnown ? 'Previous-week chart omitted: some daily values are unknown. Both periods are listed in the next table.' : 'Dates on the horizontal axis are UTC. Previous-week values, when shown, align by day of week.', 6.35, 0.4, { fontSize: 13, color: COLOR.muted });
  } else {
    body(daily, 'Some dates have unknown activity', 3.05, 0.65, { fontSize: 28, bold: true });
    body(daily, 'The chart is withheld because missing records cannot be treated as zero. The next slide preserves every known value and marks the gaps.', 4.05, 1.25, { fontSize: 22, color: COLOR.muted });
  }

  const records = slide('Daily records', 'Exact saved counts. Unknown values stay marked with a dash.', 4);
  table(records, ['Current date (UTC)', 'Events', 'Users', 'Prior date (UTC)', 'Events', 'Users'], a.daily.current.map((day, index) => {
    const prior = a.daily.previous?.[index];
    return [day.date, shortNumber(day.events), shortNumber(day.activeUsers), prior?.date ?? '—', shortNumber(prior?.events ?? null), shortNumber(prior?.activeUsers ?? null)];
  }), [2.8, 1.6, 1.6, 2.8, 1.6, 1.6], 2.28, 0.46);
  body(records, 'Users are distinct within each day. Adding daily users does not give the number of distinct weekly users.', 6.36, 0.42, { fontSize: 13, color: COLOR.muted });

  const limits = slide('Coverage and calculation checks', 'These checks do not establish that the upload or every narrative claim is true.', 5);
  const coverageText = a.coverage.current.status === 'declared-complete' ? 'Current period: uploader declared complete coverage.' : `Current period: ${text(a.coverage.current.message, 240)}`;
  body(limits, coverageText, 2.32, 0.6, { fontSize: 17, bold: true });
  const shownChecks = a.checks.slice(0, 5);
  shownChecks.forEach((check, index) => body(limits, `${check.status === 'passed' ? 'Checked' : 'Note'} · ${text(check.message, 280)}`, 3.17 + index * 0.56, 0.49, { fontSize: 15 }));
  body(limits, 'Interpretation still needs review. Usage counts alone do not establish revenue, savings or causes.', 6.29, 0.46, { fontSize: 14, color: COLOR.muted });
  limits.addNotes([`Current coverage: ${text(a.coverage.current.message, 800)}`, `Previous coverage: ${a.coverage.previous ? text(a.coverage.previous.message, 800) : 'Not requested'}`,
    ...a.checks.map(check => `${text(check.id, 60)} [${check.status}]: ${text(check.message, 1000)}`)].join('\n'));

  const provenance = slide('Source and saved calculation', 'This presentation is a snapshot. Re-export the report to reflect a later calculation.', 6);
  const details = [
    ['Input file', text(a.sourceName, 200)], ['Current period', period], ['Previous period', previousPeriod],
    ['Calculation saved', text(a.createdAt, 40)], ['Calculator', a.calculatorVersion], ['Input SHA-256', a.contentHash],
  ];
  details.forEach(([label, value], index) => {
    body(provenance, label, 2.42 + index * 0.52, 0.35, { w: 2.15, fontSize: 14, color: COLOR.muted });
    body(provenance, value, 2.42 + index * 0.52, 0.42, { x: 3, w: 9.55, fontSize: label === 'Input SHA-256' ? 12 : 15 });
  });
  body(provenance, 'Source, dataset, artifact and citation identifiers are retained in the slide notes. This file contains aggregate results; it does not embed the original CSV.', 6.13, 0.55, { fontSize: 14, color: COLOR.muted });

  const output = await pptx.write({ outputType: 'arraybuffer', compression: true });
  if (!(output instanceof ArrayBuffer)) throw new Error('The presentation could not be prepared. Try the export again.');
  return { data: output, fileName: `rivet-usage-${a.current.period.from}.pptx`, mimeType: MIME };
}
