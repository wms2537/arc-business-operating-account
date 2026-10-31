/** The synchronous SQLite operations used by the accounting projector. */
export type SqlValue = string | number | null;
export type SqlRow = Record<string, SqlValue>;
export interface SqlStatement<Row extends SqlRow, Params extends SqlValue[]> {
  get(...params: Params): Row | null;
  all(...params: Params): Row[];
  run(...params: Params): unknown;
}
export interface SqlDatabase {
  schemaVersion(): number;
  setSchemaVersion(version: number): void;
  query<Row extends SqlRow = SqlRow, Params extends SqlValue[] = SqlValue[]>(sql: string): SqlStatement<Row, Params>;
  exec(sql: string): unknown;
  transaction<Result>(body: () => Result): { (): Result; immediate(): Result };
  close(): void;
}
