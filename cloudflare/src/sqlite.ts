import type { SqlDatabase, SqlRow, SqlValue, SqlStatement } from "../../server/sqlite-port";

/** Cloudflare owns the database lifetime and synchronous transaction boundaries. */
export class DurableSqlite implements SqlDatabase {
  constructor(private readonly storage: DurableObjectStorage) {}
  schemaVersion() {
    const exists = this.storage.sql.exec<{n:number}>("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='ledger_schema'").one().n;
    if (!exists) return 0;
    return this.storage.sql.exec<{version:number}>("SELECT version FROM ledger_schema WHERE id=1").one().version;
  }
  setSchemaVersion(version: number) {
    this.storage.sql.exec("CREATE TABLE IF NOT EXISTS ledger_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL)").toArray();
    this.storage.sql.exec("INSERT INTO ledger_schema VALUES(1,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version",version).toArray();
  }
  query<Row extends SqlRow = SqlRow, Params extends SqlValue[] = SqlValue[]>(statement: string): SqlStatement<Row, Params> {
    const rows = (...params: Params) => this.storage.sql.exec<Row>(statement, ...params).toArray();
    return { get: (...params) => rows(...params)[0] ?? null, all: rows, run: (...params) => rows(...params) };
  }
  exec(statement: string) { this.storage.sql.exec(statement).toArray(); }
  transaction<Result>(body: () => Result) {
    const run = () => this.storage.transactionSync(body);
    return Object.assign(run, { immediate: run });
  }
  close() { /* Storage belongs to the Durable Object, not this adapter. */ }
}
