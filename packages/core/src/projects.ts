import type { DatabaseSync } from 'node:sqlite';
import { HarnessError } from './errors.ts';
import type { Project, ProjectInput, RunSummary, SourceDocument } from './types.ts';

export function projectStore(db: DatabaseSync, sources: () => SourceDocument[]) {
  db.exec('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  function getProject(id: string): Project | undefined {
    const row = db.prepare('SELECT data FROM projects WHERE id=?').get(id);
    return row ? JSON.parse(row.data as string) : undefined;
  }
  function projectRuns(id: string): RunSummary[] {
    return db.prepare("SELECT data FROM runs WHERE json_extract(data,'$.projectId')=? ORDER BY rowid DESC").all(id).map(row => {
      const {events: _events, result, reply, ...run} = JSON.parse(row.data as string);
      return {...run, artifactTitle: result?.title ?? null, hasReply: Boolean(reply)} as RunSummary;
    }).filter((run, i, all) => all.findIndex(other => (other.sessionId ?? other.id) === (run.sessionId ?? run.id)) === i);
  }
  return {
    getProject, projectRuns,
    listProjects(): Project[] {
      return db.prepare('SELECT data FROM projects').all().map(row => {
        const project = JSON.parse(row.data as string) as Project;
        const latest = projectRuns(project.id)[0];
        return {...project, updatedAt: latest && latest.updatedAt > project.updatedAt ? latest.updatedAt : project.updatedAt};
      }).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    saveProject(input: ProjectInput): Project {
      if (!input || typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(input.id) ||
          typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120 ||
          typeof input.brief !== 'string' || input.brief.length > 3000 || !Number.isSafeInteger(input.version) || input.version < 0 ||
          !Array.isArray(input.sourceIds) || input.sourceIds.length > 100 || input.sourceIds.some(id => typeof id !== 'string') ||
          Object.keys(input).some(key => !['id','name','brief','version','sourceIds'].includes(key))) {
        throw new HarnessError('Give the project a name, a brief of up to 3,000 characters and up to 100 files.',400,'invalid_project');
      }
      const previous = getProject(input.id);
      const sourceIds = [...new Set(input.sourceIds)];
      // An uncertain save can safely be retried without creating another project.
      if (previous && previous.version === input.version + 1 && previous.name === input.name.trim() && previous.brief === input.brief.trim() && JSON.stringify(previous.sourceIds) === JSON.stringify(sourceIds)) return previous;
      if ((previous?.version ?? 0) !== input.version) throw new HarnessError('This project changed. Reopen it before saving.',409,'project_conflict');
      const available = new Set(sources().map(source => source.id));
      // Retain existing references so a project remains editable after a file is archived.
      // New attachments still require an available input; task admission checks every input.
      if (sourceIds.some(id => !available.has(id) && !previous?.sourceIds.includes(id))) throw new HarnessError('A selected file is no longer available. Refresh the file selection.',422,'unknown_source');
      if (!previous && Number(db.prepare('SELECT COUNT(*) AS count FROM projects').get()!.count) >= 1000) throw new HarnessError('This workspace supports up to 1,000 projects.',409,'project_limit');
      const now = new Date().toISOString();
      const project: Project = {id:input.id,name:input.name.trim(),brief:input.brief.trim(),sourceIds,version:input.version+1,createdAt:previous?.createdAt ?? now,updatedAt:now};
      db.prepare('INSERT INTO projects(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(project.id,JSON.stringify(project));
      return project;
    },
  };
}
