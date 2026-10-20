export interface ReportSections {
  takeaway: string;
  interpretation: string;
  nextStep: string;
}

/** Only rearrange the agreed outline. Unrecognized/legacy Markdown stays intact. */
export function splitReportSections(content: string): ReportSections | null {
  // References and footnotes can resolve across sections only in one Markdown tree.
  if (/^\s*(```|~~~)/m.test(content) || /^ {0,3}\[[^\]\r\n]+\]:/m.test(content)) return null;
  const headings = [...content.matchAll(/^##[ \t]+([^\r\n]+)[ \t]*\r?$/gm)];
  const expected = ['key takeaway', 'what it means', 'next step'];
  if (headings.length !== expected.length || content.slice(0, headings[0]?.index).trim()) return null;
  if (headings.some((heading, index) => heading[1].trim().toLowerCase() !== expected[index])) return null;
  const parts = headings.map((heading, index) => content.slice(heading.index! + heading[0].length, headings[index + 1]?.index).trim());
  if (parts.some(part => !part)) return null;
  return { takeaway: parts[0], interpretation: parts[1], nextStep: parts[2] };
}
