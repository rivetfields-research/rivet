export function tableSourceLink(sourceId: string): string {
  return `?${new URLSearchParams({ view: 'tables', file: sourceId })}`;
}

export function selectedTableSource(search: string): string | null {
  const params = new URLSearchParams(search);
  const file = params.get('file');
  return params.get('view') === 'tables' && file && file.length <= 512 ? file : null;
}

export function rememberTableSource(sourceId: string | null) {
  const url = new URL(location.href);
  if (sourceId) url.searchParams.set('file', sourceId);
  else url.searchParams.delete('file');
  history.replaceState(history.state, '', url);
}
