import { Database } from "bun:sqlite";
import { Books as CoreBooks } from "./books-core";
import type { SqlDatabase, SqlRow, SqlValue, SqlStatement } from "./sqlite-port";
import type { DeploymentManifest } from "../src/lib/deployment";
export type { BookState } from "./books-core";

class BunSqlite implements SqlDatabase {
  private readonly database: Database;
  constructor(path: string) {
    this.database = new Database(path, { create: true });
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  }
  schemaVersion() {
    const row = this.database.query<{user_version:number},[]>("PRAGMA user_version").get();
    if (!row) throw Error("Could not read the SQLite schema version");
    return row.user_version;
  }
  setSchemaVersion(version: number) { this.database.exec(`PRAGMA user_version=${version}`); }
  query<Row extends SqlRow = SqlRow, Params extends SqlValue[] = SqlValue[]>(sql: string): SqlStatement<Row, Params> {
    const statement = this.database.query<Row, SqlValue[]>(sql);
    return { get: (...params) => statement.get(...params), all: (...params) => statement.all(...params), run: (...params) => statement.run(...params) };
  }
  exec(sql: string) { this.database.exec(sql); }
  transaction<Result>(body: () => Result) {
    const run = () => this.database.transaction(body).immediate();
    return Object.assign(run, { immediate: run });
  }
  close() { this.database.close(); }
}

/** Local/Studio adapter; financial rules live in the shared projector. */
export class Books extends CoreBooks {
  constructor(path: string, manifest: DeploymentManifest) { super(new BunSqlite(path), manifest); }
}
