import PptxGenJS from 'pptxgenjs';
import type { Artifact, FinancialAnalysis, FinancialPeriodReport, FinancialTotals } from '../../../packages/core/src/types';
import type { PresentationDownload } from './presentation-export';

const FONT = 'Arial';
const COLOR = { text: '18212F', muted: '586678', blue: '315ED0', pale: 'F3F5F8', line: 'DFE4EC', white: 'FFFFFF' };
const MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation' as const;
const CATEGORY_ROWS = 7;
const METRICS = [
  ['revenue', 'revenueMinor', 'Revenue'], ['cost', 'costMinor', 'Cost'],
  ['gross_profit', 'grossProfitMinor', 'Gross profit'], ['gross_margin', 'grossMarginPercent', 'Gross margin'],
] as const;

function plain(value: string, limit = 200): string {
  const clean = value.replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(clean).length > limit ? `${Array.from(clean).slice(0, limit - 1).join('')}…` : clean;
}
/** Format the saved integer directly; large amounts never pass through decimal division. */
function money(value: number | null): string {
  if (value === null) return 'Unknown';
  const minor = BigInt(value), absolute = minor < 0n ? -minor : minor;
  const whole = String(absolute / 100n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${minor < 0n ? '-' : ''}${whole}.${String(absolute % 100n).padStart(2, '0')}`;
}
const number = (value: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
const percentage = (value: number | null) => value === null ? 'Undefined' : `${number(value)}%`;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const minor = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function checkedAnalysis(artifact: Artifact): FinancialAnalysis {
  const a = artifact.financialAnalysis;
  if (!a || a.kind !== 'financial-period' || a.schemaVersion !== 1 || a.calculatorVersion !== 'financial-period/v1') {
    throw new Error('PowerPoint export needs a saved financial calculation.');
  }
  const fail = () => { throw new Error('The saved financial calculation cannot be exported. Open the report and check its data.'); };
  if (!['USD', 'EUR', 'GBP'].includes(a.currency) || a.minorUnitScale !== 2 || !/^[a-f0-9]{64}$/.test(a.contentHash) ||
    !/^source_[a-f0-9]{64}$/.test(a.sourceId) || !/^financial_(?:version_)?[a-f0-9]{64}$/.test(a.datasetId) ||
    typeof a.sourceName !== 'string' || a.sourceName.length > 200 || typeof a.id !== 'string' || a.id.length > 200 ||
    typeof a.createdAt !== 'string' || !Number.isFinite(Date.parse(a.createdAt)) || typeof artifact.id !== 'string' || artifact.id.length > 200 ||
    typeof artifact.createdAt !== 'string' || !Number.isFinite(Date.parse(artifact.createdAt)) ||
    !Array.isArray(artifact.citations) || artifact.citations.length > 10 || !artifact.citations.includes(a.sourceId) ||
    artifact.citations.some(id => typeof id !== 'string' || id.length > 200) || !Array.isArray(a.checks) || a.checks.length > 10) fail();
  const validateTotals = (totals: FinancialTotals, known: boolean) => {
    if (!totals || !totals.evidence || totals.evidence.contentHash !== a.contentHash || !Array.isArray(totals.evidence.records) ||
      totals.evidence.records.length > 10_000 || totals.evidence.records.some(record => !Number.isSafeInteger(record) || record < 2)) fail();
    if (!known) {
      if (totals.revenueMinor !== null || totals.costMinor !== null || totals.grossProfitMinor !== null || totals.grossMarginPercent !== null || totals.marginReason !== 'unknown_period') fail();
      return;
    }
    if (!minor(totals.revenueMinor) || totals.revenueMinor < 0 || !minor(totals.costMinor) || totals.costMinor < 0 || !minor(totals.grossProfitMinor) ||
      totals.grossProfitMinor !== totals.revenueMinor - totals.costMinor ||
      totals.grossMarginPercent !== (totals.revenueMinor === 0 ? null : totals.grossProfitMinor / totals.revenueMinor * 100) ||
      totals.marginReason !== (totals.revenueMinor === 0 ? 'zero_revenue' : null)) fail();
  };
  const validateReport = (report: FinancialPeriodReport) => {
    if (!report || !report.period || !validDate(report.period.from) || !validDate(report.period.through) || report.period.from > report.period.through || report.period.timezone !== 'UTC' ||
      report.period.days !== (Date.parse(`${report.period.through}T00:00:00Z`) - Date.parse(`${report.period.from}T00:00:00Z`)) / 86_400_000 + 1 ||
      !Number.isSafeInteger(report.recordsIncluded) || report.recordsIncluded < 0 || report.recordsIncluded > 10_000 ||
      !report.coverage || !['declared-complete', 'partial', 'unknown'].includes(report.coverage.status) ||
      !Array.isArray(report.categories) || report.categories.length > 10_000) fail();
    if ((report.coverage.status === 'unknown' && report.recordsIncluded > 0) || (report.coverage.status === 'partial' && report.recordsIncluded === 0)) fail();
    const known = report.coverage.status === 'declared-complete' || report.recordsIncluded > 0;
    validateTotals(report.totals, known);
    if (report.totals.evidence.records.length !== report.recordsIncluded) fail();
    let revenue = 0n, cost = 0n, rows = 0;
    const categories = new Set<string>();
    for (const category of report.categories) {
      if (!category || typeof category.category !== 'string' || !category.category || category.category.length > 128 || categories.has(category.category) ||
        !Number.isSafeInteger(category.recordsIncluded) || category.recordsIncluded < 1 || category.recordsIncluded > 10_000) fail();
      validateTotals(category.totals, true);
      if (category.totals.evidence.records.length !== category.recordsIncluded) fail();
      categories.add(category.category); rows += category.recordsIncluded;
      revenue += BigInt(category.totals.revenueMinor!); cost += BigInt(category.totals.costMinor!);
    }
    if (rows !== report.recordsIncluded || (known && (revenue !== BigInt(report.totals.revenueMinor!) || cost !== BigInt(report.totals.costMinor!)))) fail();
  };
  validateReport(a.current);
  if (a.previous !== null) {
    validateReport(a.previous);
    if (a.previous.period.through >= a.current.period.from) fail();
  }
  if (!Array.isArray(a.comparisons) || a.comparisons.length !== 4 || new Set(a.comparisons.map(metric => metric.key)).size !== 4) fail();
  for (const [key, property] of METRICS) {
    const metric = a.comparisons.find(item => item.key === key);
    if (!metric || metric.current !== a.current.totals[property] || metric.previous !== (a.previous?.totals[property] ?? null) ||
      metric.unit !== (key === 'gross_margin' ? 'percentage-points' : 'minor-units') ||
      [metric.current, metric.previous, metric.absoluteChange, metric.percentChange].some(value => value !== null && !finite(value))) fail();
    const comparable = a.previous && a.current.coverage.status === 'declared-complete' && a.previous.coverage.status === 'declared-complete' && metric!.current !== null && metric!.previous !== null;
    const change = comparable ? metric!.current! - metric!.previous! : null;
    const growth = comparable && key !== 'gross_margin' && metric!.previous! > 0 ? change! / metric!.previous! * 100 : null;
    if (metric!.absoluteChange !== change || metric!.percentChange !== growth) fail();
  }
  return a;
}

/** Excel/native chart numbers keep 15 significant digits. Omit a chart if cents would be lost. */
function chartValue(value: number): number | null {
  if (Math.abs(value) > 999_999_999_999_999) return null;
  const converted = value / 100;
  const decimal = String(Math.abs(converted));
  if (!/^\d+(?:\.\d{1,2})?$/.test(decimal)) return null;
  const [whole, fraction = ''] = decimal.split('.');
  const restored = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return restored === BigInt(Math.abs(value)) ? converted : null;
}

/** Browser-safe export of the saved financial snapshot. No model narrative or new inference. */
export async function buildFinancialPresentation(artifact: Artifact): Promise<PresentationDownload> {
  const a = checkedAnalysis(artifact);
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'Rivet'; pptx.company = 'Rivet';
  pptx.title = 'Financial report'; pptx.subject = 'Saved recognized revenue and cost calculation';
  pptx.theme = { headFontFace: FONT, bodyFontFace: FONT };
  const period = `${a.current.period.from} to ${a.current.period.through} UTC`;
  const prior = a.previous ? `${a.previous.period.from} to ${a.previous.period.through} UTC` : 'Not requested';
  const exactTotals = (totals: FinancialTotals) => ({ revenueMinor: totals.revenueMinor, costMinor: totals.costMinor,
    grossProfitMinor: totals.grossProfitMinor, grossMarginPercent: totals.grossMarginPercent, marginReason: totals.marginReason });
  const receipt = [
    `Artifact: ${plain(artifact.id)}`, `Artifact saved: ${plain(artifact.createdAt, 40)}`,
    `Calculation: ${plain(a.id)}`, `Calculation saved: ${plain(a.createdAt, 40)}`,
    `Input file label: ${plain(a.sourceName)}`, `Source ID: ${a.sourceId}`, `Dataset version: ${a.datasetId}`,
    `Input SHA-256: ${a.contentHash}`, `Calculator: ${a.calculatorVersion}`, `Currency: ${a.currency}; minor unit scale: 2`,
    `Current period: ${period}`, `Previous period: ${prior}`, `Saved artifact citations: ${artifact.citations.map(id => plain(id)).join(', ')}`,
    `Saved exact current amounts and unrounded ratios: ${JSON.stringify(exactTotals(a.current.totals))}`,
    `Saved exact previous amounts and unrounded ratios: ${a.previous ? JSON.stringify(exactTotals(a.previous.totals)) : 'Not requested'}`,
    `Saved comparisons: ${JSON.stringify(a.comparisons)}`,
    'Currency text retains every saved minor unit. Percentages display at most two decimals; these notes retain the unrounded saved values.',
    'Completeness is an uploader declaration. Format and arithmetic checks do not independently verify source truth or business claims.',
    'This file includes aggregate results only. The original CSV, raw record IDs and model-written narrative are excluded.',
  ].join('\n');
  const slide = (title: string, subtitle: string, index: number) => {
    const s = pptx.addSlide(); s.background = { color: COLOR.white };
    s.addText('RIVET  /  FINANCIAL REPORT', { x: 0.6, y: 0.35, w: 11, h: 0.3, fontFace: FONT, fontSize: 10, bold: true, charSpacing: 1.5, color: COLOR.muted, margin: 0 });
    s.addText(title, { x: 0.6, y: 0.95, w: 12.1, h: 0.6, fontFace: FONT, fontSize: 30, bold: true, color: COLOR.text, margin: 0, fit: 'shrink' });
    s.addText(subtitle, { x: 0.6, y: 1.63, w: 12.1, h: 0.45, fontFace: FONT, fontSize: 14, color: COLOR.muted, margin: 0, fit: 'shrink' });
    s.addText(`Saved calculation · ${period}`, { x: 0.6, y: 7.03, w: 11.4, h: 0.2, fontFace: FONT, fontSize: 9, color: COLOR.muted, margin: 0 });
    s.addText(`${index} / 6`, { x: 12, y: 7.03, w: 0.7, h: 0.2, fontFace: FONT, fontSize: 9, color: COLOR.muted, margin: 0, align: 'right' });
    s.addNotes(receipt); return s;
  };
  const body = (s: PptxGenJS.Slide, content: string, y: number, h = 0.6, options: Partial<PptxGenJS.TextPropsOptions> = {}) =>
    s.addText(content, { x: 0.65, y, w: 12, h, fontFace: FONT, fontSize: 17, color: COLOR.text, margin: 0, valign: 'top', fit: 'shrink', ...options });
  const table = (s: PptxGenJS.Slide, headers: string[], rows: string[][], widths: number[], y: number, rowHeight: number) => {
    s.addTable([headers.map(label => ({ text: label, options: { bold: true, color: COLOR.muted, fill: { color: COLOR.pale } } })),
      ...rows.map(row => row.map(value => ({ text: value })))],
    { x: 0.65, y, w: 12, colW: widths, rowH: rowHeight, fontFace: FONT, fontSize: 14, color: COLOR.text,
      margin: [0.08, 0.1, 0.08, 0.1], border: { type: 'solid', pt: 0.5, color: COLOR.line }, valign: 'middle', autoPage: false, verbose: false });
  };

  const overview = slide('Financial report', 'Recognized revenue and corresponding costs from supplied records.', 1);
  body(overview, period, 2.45, 0.5, { fontSize: 22 });
  const headlineValues = [
    ['Revenue', money(a.current.totals.revenueMinor), a.currency],
    ['Gross profit', money(a.current.totals.grossProfitMinor), a.currency],
    ['Gross margin', a.current.coverage.status === 'unknown' ? 'Unknown' : percentage(a.current.totals.grossMarginPercent), 'Gross profit ÷ revenue'],
  ];
  headlineValues.forEach(([label, value, unit], index) => {
    const x = 0.65 + index * 4.05;
    overview.addText(label, { x, y: 3.4, w: 3.65, h: 0.4, fontFace: FONT, fontSize: 17, color: COLOR.muted, margin: 0 });
    overview.addText(value, { x, y: 3.97, w: 3.65, h: 0.8, fontFace: FONT, fontSize: value.length > 14 ? 25 : 37, bold: true, color: COLOR.blue, margin: 0, fit: 'shrink' });
    overview.addText(unit, { x, y: 4.93, w: 3.65, h: 0.45, fontFace: FONT, fontSize: 14, color: COLOR.muted, margin: 0 });
  });
  body(overview, a.current.coverage.status === 'declared-complete' ? 'The uploader declared complete coverage. This declaration has not been independently verified.'
    : a.current.coverage.status === 'unknown' ? 'No records establish this period. Amounts remain unknown.' : 'These amounts describe the supplied records. Full-period completeness is unknown.', 6.03, 0.55, { fontSize: 16, color: COLOR.muted });

  const comparison = slide('Period comparison', `Current: ${period}   Previous: ${prior}`, 2);
  table(comparison, ['Metric', 'Current', 'Previous', 'Change', 'Change %'], METRICS.map(([key, , label]) => {
    const metric = a.comparisons.find(item => item.key === key)!;
    const value = (amount: number | null, report: FinancialPeriodReport | null) => !report ? 'Not requested' : report.coverage.status === 'unknown' ? 'Unknown' : key === 'gross_margin' ? percentage(amount) : money(amount);
    return [`${label}\n${key === 'gross_margin' ? '%' : a.currency}`, value(metric.current, a.current), value(metric.previous, a.previous),
      metric.absoluteChange === null ? 'Unavailable' : key === 'gross_margin' ? `${number(metric.absoluteChange)} pp` : money(metric.absoluteChange),
      metric.percentChange === null ? 'Unavailable' : `${metric.percentChange > 0 ? '+' : ''}${number(metric.percentChange)}%`];
  }), [3.6, 2.1, 2.1, 2.1, 2.1], 2.36, 0.6);
  const comparisonNotice = !a.previous ? 'No previous period was requested.'
    : a.current.coverage.status !== 'declared-complete' || a.previous.coverage.status !== 'declared-complete'
      ? 'Changes remain unavailable because complete coverage was not declared for both periods.'
      : 'Growth from a zero or negative baseline is undefined. Gross margin changes use percentage points.';
  body(comparison, comparisonNotice, 5.85, 0.56, { fontSize: 15, color: COLOR.muted });
  if (a.previous && a.previous.period.days !== a.current.period.days) body(comparison, 'The periods contain different numbers of days. These are period totals without daily normalization.', 6.42, 0.34, { fontSize: 12, color: COLOR.muted });

  const chart = slide('Revenue, cost and gross profit', `Supplied-record totals in ${a.currency}. Exact amounts appear in the comparison table.`, 3);
  const chartKeys = ['revenueMinor', 'costMinor', 'grossProfitMinor'] as const;
  const currentKnown = chartKeys.every(key => a.current.totals[key] !== null);
  const previousKnown = Boolean(a.previous && chartKeys.every(key => a.previous!.totals[key] !== null));
  const currentValues = currentKnown ? chartKeys.map(key => chartValue(a.current.totals[key]!)) : [];
  const previousValues = previousKnown ? chartKeys.map(key => chartValue(a.previous!.totals[key]!)) : [];
  const precise = [...currentValues, ...previousValues].every(value => value !== null);
  if (currentKnown && precise) {
    const labels = ['Revenue', 'Cost', 'Gross profit'];
    chart.addChart(pptx.ChartType.bar, [
      { name: 'Current period', labels, values: currentValues as number[] },
      ...(previousKnown ? [{ name: 'Previous period', labels, values: previousValues as number[] }] : []),
    ], { x: 0.65, y: 2.32, w: 12, h: 3.85, catAxisLabelFontFace: FONT, catAxisLabelFontSize: 13, catAxisLabelColor: COLOR.muted,
      valAxisLabelFontFace: FONT, valAxisLabelFontSize: 12, valAxisLabelColor: COLOR.muted, valAxisLabelFormatCode: '#,##0.00',
      catAxisLineShow: false, valAxisLineShow: false, valGridLine: { color: COLOR.line, size: 0.5 },
      chartColors: [COLOR.blue, 'B9C7E5'], showLegend: previousKnown, legendPos: 'b', legendFontSize: 12,
      showTitle: false, showValue: false, barDir: 'col', barGrouping: 'clustered',
      showValAxisTitle: true, valAxisTitle: a.currency, valAxisTitleFontSize: 12 });
    body(chart, a.previous && !previousKnown ? 'Previous-period values are unknown, so that series is omitted.'
      : 'Amounts reflect supplied records. The chart does not establish why a difference occurred.', 6.35, 0.5, { fontSize: 14, color: COLOR.muted });
  } else {
    body(chart, currentKnown ? 'Exact amounts exceed chart precision' : 'Current-period totals are unknown', 3.03, 0.7, { fontSize: 28, bold: true });
    body(chart, currentKnown ? 'The chart is omitted to preserve the saved currency amounts. The table retains every minor unit.'
      : 'The chart is omitted because no records establish this period. Missing amounts cannot become zero.', 4.1, 1.1, { fontSize: 21, color: COLOR.muted });
  }

  const categories = slide('Current category totals', `Supplied records for ${period}. All currency amounts are ${a.currency}.`, 4);
  const shown = a.current.categories.slice(0, CATEGORY_ROWS);
  if (shown.length) {
    table(categories, ['Category', 'Revenue', 'Cost', 'Gross profit', 'Gross margin'], shown.map(row => [plain(row.category, 32), money(row.totals.revenueMinor),
      money(row.totals.costMinor), money(row.totals.grossProfitMinor), percentage(row.totals.grossMarginPercent)]), [3.2, 2.2, 2.2, 2.2, 2.2], 2.3, 0.44);
    body(categories, `Showing ${shown.length} of ${a.current.categories.length} observed categories in saved label order.${a.current.categories.length > CATEGORY_ROWS ? ' This is a subset, not a ranking. The report retains every category.' : ''} Long labels are abbreviated here and retained in notes.`, 6.17, 0.62, { fontSize: 13, color: COLOR.muted });
    categories.addNotes(`Displayed category amounts and complete labels:\n${JSON.stringify(shown.map(row => ({ category: plain(row.category, 128), recordsIncluded: row.recordsIncluded, ...exactTotals(row.totals) })), null, 2)}`);
  } else {
    body(categories, a.current.coverage.status === 'unknown' ? 'Category amounts are unknown' : 'No category records in this period', 3.04, 0.7, { fontSize: 28, bold: true });
    body(categories, 'The calculation does not invent category rows or infer that an absent category has zero revenue.', 4.1, 0.9, { fontSize: 21, color: COLOR.muted });
  }

  const limits = slide('Coverage and calculation limits', 'Arithmetic checks do not verify accounting accuracy or causes.', 5);
  const coverage = (report: FinancialPeriodReport, label: string) => `${label}: ${report.coverage.status === 'declared-complete' ? 'uploader declared complete coverage' : report.coverage.status === 'unknown' ? 'no records establish the period' : 'supplied records with incomplete coverage'}.`;
  body(limits, coverage(a.current, 'Current period'), 2.34, 0.56, { bold: true });
  body(limits, a.previous ? coverage(a.previous, 'Previous period') : 'Previous period: not requested.', 3.04, 0.56);
  body(limits, 'Revenue means provided recognized net revenue. Cost means the corresponding supplied cost.', 3.87, 0.63, { fontSize: 17 });
  body(limits, 'Gross profit equals revenue minus cost. Gross margin divides that result by positive revenue. Net profit and cash flow are outside this calculation.', 4.67, 0.79, { fontSize: 17 });
  body(limits, 'Raw refunds and negative adjustments are unsupported. Source truth, completeness and business explanations still need review.', 5.68, 0.79, { fontSize: 17, color: COLOR.muted });

  const provenance = slide('Source and saved calculation', 'This presentation preserves one saved calculation.', 6);
  const details = [
    ['Input file', plain(a.sourceName)], ['Current period', period], ['Previous period', prior],
    ['Calculation saved', plain(a.createdAt, 40)], ['Calculator', a.calculatorVersion], ['Input SHA-256', a.contentHash],
  ];
  details.forEach(([label, value], index) => {
    body(provenance, label, 2.4 + index * 0.52, 0.35, { w: 2.15, fontSize: 14, color: COLOR.muted });
    body(provenance, value, 2.4 + index * 0.52, 0.42, { x: 3, w: 9.55, fontSize: label === 'Input SHA-256' ? 12 : 15 });
  });
  body(provenance, 'Source, dataset and artifact identifiers remain in slide notes with exact saved amounts. Re-export a later report to capture changed inputs or periods.', 6.13, 0.63, { fontSize: 14, color: COLOR.muted });

  const output = await pptx.write({ outputType: 'arraybuffer', compression: true });
  if (!(output instanceof ArrayBuffer)) throw new Error('The financial presentation could not be prepared. Try the export again.');
  return { data: output, fileName: `rivet-financial-${a.current.period.from}.pptx`, mimeType: MIME };
}
