import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AnalysisResult, NormalizedDataset } from '../../../packages/data-layer/src/tabular/types';
import { postPresentations, postTextLabels, replacePostText, type PostPresentation } from '../../../packages/data-layer/src/tabular/post-presentation';
import { api } from './api';

export type PresentedResult = AnalysisResult & { readonly postLabels?: ReadonlyMap<string, PostPresentation> };
const Context = createContext<PresentedResult | undefined>(undefined);

export function PostPresentationProvider({ result, children, snapshot = false, labels }: { result: AnalysisResult; children: ReactNode; snapshot?: boolean; labels?: Record<string, PostPresentation> }) {
  const parent = useContext(Context);
  const saved = useMemo(() => labels ? { ...result, postLabels: new Map(Object.entries(labels)) } : undefined, [result, labels]);
  if (saved) return <Context.Provider value={saved}>{children}</Context.Provider>;
  return snapshot ? <Context.Provider value={result}>{children}</Context.Provider> : parent?.id === result.id ? children : <LoadPostPresentation result={result}>{children}</LoadPostPresentation>;
}

function LoadPostPresentation({ result, children }: { result: AnalysisResult; children: ReactNode }) {
  const [dataset, setDataset] = useState<NormalizedDataset>();
  useEffect(() => {
    if (result.request.groupBy !== 'post') return;
    const controller = new AbortController();
    void api<{ dataset: NormalizedDataset }>(`/api/datasets/tabular/${encodeURIComponent(result.datasetId)}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) })
      .then(saved => { if (!controller.signal.aborted) setDataset(saved.dataset); })
      .catch(() => { /* The saved calculation and evidence remain usable without display metadata. */ });
    return () => controller.abort();
  }, [result.datasetId, result.request.groupBy]);
  const display = useMemo(() => dataset ? { ...result, postLabels: postPresentations(dataset, result) } : result, [dataset, result]);
  return <Context.Provider value={display}>{children}</Context.Provider>;
}

export function usePresentedResult(result: AnalysisResult): PresentedResult {
  const display = useContext(Context);
  return display?.id === result.id ? display : result;
}

export function usePostTextLabels(): ReadonlyMap<string, string> {
  const result = useContext(Context);
  return useMemo(() => result ? postTextLabels(result, result.postLabels) : new Map<string, string>(), [result]);
}

interface TextNode { type: string; value?: string; children?: TextNode[] }
/** Change visible literal URNs only, never links, code blocks, citations or stored Markdown. */
export function readablePostText(labels: ReadonlyMap<string, string>) {
  return () => (tree: TextNode) => {
    const visit = (node: TextNode) => {
      if (['link', 'linkReference', 'code', 'html', 'image', 'definition'].includes(node.type)) return;
      if ((node.type === 'text' || node.type === 'inlineCode') && node.value) {
        const next = replacePostText(node.value, labels);
        if (next !== node.value) { node.value = next; node.type = 'text'; }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
