import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import type { SourceDocument } from './types.ts';
import { HarnessError } from './errors.ts';

const MAX_FILES = 100;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const PRIVATE_NAME = /(?:credentials?|secrets?|passwords?|private[-_]?keys?|api[-_]?keys?|id_rsa)/i;

/** The directory is an explicit, local approval boundary; never follow symlinks. */
export function loadSources(sourceDir: string): SourceDocument[] {
  let directoryStat;
  try { directoryStat = lstatSync(sourceDir); }
  catch { throw new HarnessError('The approved source directory does not exist or cannot be read.', 400, 'invalid_source_directory'); }
  if (directoryStat.isSymbolicLink()) throw new HarnessError('The source directory cannot be a symlink.', 400, 'invalid_source_directory');
  if (!directoryStat.isDirectory()) throw new HarnessError('The approved source path must be a directory.', 400, 'invalid_source_directory');
  const root = realpathSync(sourceDir);
  const documents: SourceDocument[] = [];
  let totalBytes = 0;
  let inspectedEntries = 0;
  const inside = (path: string) => {
    const rel = relative(root, path);
    return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
  };
  const visit = (directory: string, depth: number) => {
    if (depth > 8) return;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++inspectedEntries > 2000) throw new HarnessError('The approved source directory exceeds the 2,000-entry scan limit.', 413, 'source_limit');
      if (entry.name.startsWith('.') || PRIVATE_NAME.test(entry.name) || entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !inside(realpathSync(path))) continue;
      if (stat.isDirectory()) { visit(path, depth + 1); continue; }
      if (!stat.isFile() || !['.md', '.txt'].includes(extname(path).toLowerCase()) || stat.size > MAX_FILE_BYTES) continue;
      if (documents.length >= MAX_FILES || totalBytes + stat.size > MAX_TOTAL_BYTES) {
        throw new HarnessError('Approved sources exceed the 100-file / 1 MiB workspace limit.', 413, 'source_limit');
      }
      const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let content: string;
      try {
        const opened = fstatSync(descriptor);
        if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > MAX_FILE_BYTES) continue;
        const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
        let captured = 0;
        while (captured < buffer.length) {
          const bytesRead = readSync(descriptor, buffer, captured, buffer.length - captured, null);
          if (!bytesRead) break;
          captured += bytesRead;
        }
        if (captured > MAX_FILE_BYTES || totalBytes + captured > MAX_TOTAL_BYTES) continue;
        content = buffer.subarray(0, captured).toString('utf8');
      } finally { closeSync(descriptor); }
      const bytes = Buffer.byteLength(content);
      if (bytes > MAX_FILE_BYTES || content.includes('\0')) continue;
      totalBytes += bytes;
      const relativePath = relative(root, path).split('\\').join('/');
      const id = `source_${createHash('sha256').update(relativePath).update('\0').update(content).digest('hex').slice(0, 24)}`;
      const heading = content.match(/^#\s+(.+)$/m)?.[1];
      documents.push({ id, title: (heading ?? basename(path, extname(path))).slice(0, 160), path: relativePath, bytes, content });
    }
  };
  visit(root, 0);
  return documents;
}

export function searchSources(sources: SourceDocument[], query: string) {
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 12);
  return sources.map(source => {
    const searchable = `${source.title}\n${source.content}`.toLowerCase();
    const score = terms.filter(term => searchable.includes(term)).length;
    const hit = Math.max(0, source.content.toLowerCase().indexOf(terms.find(term => source.content.toLowerCase().includes(term)) ?? ''));
    return { source, score, hit };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.source.path.localeCompare(b.source.path)).slice(0, 5)
    .map(({ source, hit }) => ({ id: source.id, title: source.title, path: source.path, snippet: source.content.slice(Math.max(0, hit - 120), Math.max(0, hit - 120) + 700) }));
}
