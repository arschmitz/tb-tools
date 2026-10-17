import path from 'node:path';
import { SECTION_VERSION } from './sections.mjs';

// A read transaction keeps every question on one SQLite snapshot without copying the index.
export async function openEvaluationIndex(file) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('BEGIN');
    db.prepare('SELECT count(*) FROM records').get();
    const version = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='sectionVersion'").get()?.value || 'null');
    if (version !== SECTION_VERSION) throw new Error('Index section version differs from the current search code. Rebuild a separate evaluation cache.');
    const directory = path.dirname(file);
    let records, byId, counts;
    function all() {
      records ??= db.prepare('SELECT body FROM records').all().map(row => JSON.parse(row.body));
      byId ??= new Map(records.map(record => [record.id, record]));
      counts ??= records.reduce((result, record) => result.set(record.repository, (result.get(record.repository) || 0) + 1), new Map());
      return records;
    }
    return { db, directory,
      get(id) { all(); return byId.get(id) || null; },
      count(repository) { all(); return counts.get(repository) || 0; },
      all(repository) { return repository ? all().filter(record => record.repository === repository) : all(); },
      file(record) { return path.join(directory, record.visibility, 'records', `${record.id}.json`); },
      close() { db.exec('ROLLBACK'); db.close(); },
    };
  } catch (error) { db.close(); throw error; }
}
