// Development/test only: no disk persistence and no connection to a hosted database.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

class LocalDb {
  sqlite = new DatabaseSync(':memory:');
  prepare(sql) {
    const database = this;
    return { sql, args: [], bind(...args) { return { ...this, args }; },
      async all() { return { results: database.sqlite.prepare(this.sql).all(...this.args) }; },
      async first(column) { const row = database.sqlite.prepare(this.sql).get(...this.args); return column ? row?.[column] ?? null : row ?? null; },
      async run() { const result = database.sqlite.prepare(this.sql).run(...this.args); return { meta: { changes: Number(result.changes) } }; },
    };
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map(statement => ({ meta: { changes: Number(this.sqlite.prepare(statement.sql).run(...statement.args).changes) } }));
      this.sqlite.exec('COMMIT'); return results;
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  close() { this.sqlite.close(); }
}

export function createLocalDb() {
  const database = new LocalDb();
  try {
    const directory = new URL('./db/drizzle/', import.meta.url);
    for (const filename of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
      database.sqlite.exec(readFileSync(new URL(filename, directory), 'utf8'));
    }
    return database;
  } catch (error) { database.close(); throw error; }
}
