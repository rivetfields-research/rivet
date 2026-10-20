import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { replacePostText } from '../../data-layer/src/tabular/post-presentation';

interface Node { type: string; value?: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } }
const literal = (text: string) => text.replace(/[\\`*_{}\[\]()<>#!|]/g, '\\$&');

/** Match the screen's text labels without touching code blocks, links or citation targets. */
export function readablePostMarkdown(markdown: string, labels: ReadonlyMap<string, string>): string {
  if (!labels.size) return markdown;
  const escaped = new Map([...labels].map(([id, label]) => [id, literal(label)]));
  const edits: { start: number; end: number; text: string }[] = [];
  const visit = (node: Node) => {
    if (['link', 'linkReference', 'code', 'html', 'image', 'definition'].includes(node.type)) return;
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if ((node.type === 'text' || node.type === 'inlineCode') && node.value && start !== undefined && end !== undefined && replacePostText(node.value, labels) !== node.value) {
      edits.push({ start, end, text: node.type === 'inlineCode' ? literal(replacePostText(node.value, labels)) : replacePostText(markdown.slice(start, end), escaped) });
    }
    node.children?.forEach(visit);
  };
  visit(unified().use(remarkParse).parse(markdown));
  for (const edit of edits.sort((a,b) => b.start - a.start)) markdown = markdown.slice(0,edit.start) + edit.text + markdown.slice(edit.end);
  return markdown;
}
