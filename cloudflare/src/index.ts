import { DurableObject } from "cloudflare:workers";
import { createPublicClient } from "viem";
import { Books } from "../../server/books-core";
import { syncBooks } from "../../server/sync";
import { recordDeliveryReceipt } from "../../server/receipt-service";
import { isolatedArcRpcTransport } from "../../src/lib/arc-rpc";
import { parseManifest } from "../../src/lib/deployment";
import { parseRawBlock } from "../../server/chain";
import { array, record, text, integer, json } from "../../src/lib/boundary";
import { DurableSqlite } from "./sqlite";
import bootstrapSource from "../mainnet-bootstrap.json";

const seed = record(bootstrapSource), manifest = parseManifest(seed.manifest);
const RPC = "https://rpc.blockdaemon.mainnet.arc.io";
const MIN_REFRESH_MS = 20000, IDLE_REFRESH_MS = 45000, STALE_AFTER_MS = 90000;
type SyncState = { at: number; target: number; error: string | null };
const response = (value: unknown, status = 200) => new Response(json(value), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export class LedgerObject extends DurableObject<Env> {
  private readonly ready: Promise<Books>;
  private refreshing: Promise<void> | undefined;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const books = new Books(new DurableSqlite(ctx.storage), manifest);
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS worker_bootstrap(id INTEGER PRIMARY KEY CHECK(id=1),deployment TEXT NOT NULL,seed_digest TEXT NOT NULL)").toArray();
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS worker_sync(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL)").toArray();
      const initialized = ctx.storage.sql.exec<{deployment:string}>("SELECT deployment FROM worker_bootstrap WHERE id=1").toArray()[0];
      if (initialized) {
        if (initialized.deployment !== manifest.instanceId) throw Error("Bootstrap deployment identity changed");
        books.project();
        return books;
      }
      // Validate immutable build input once. Later receipts legitimately change the live digest.
      books.project();
      const all = array(seed.blocks).map(parseRawBlock), remaining = all.filter(b => b.height > books.progress().height);
      for (let offset = 0; offset < remaining.length; offset += 100) { books.captureRange(remaining.slice(offset, offset + 100)); books.project(); }
      const last = all[all.length - 1];
      if (!last || books.progress().height !== last.height || books.digest() !== text(seed.expectedDigest)) throw Error("Worker bootstrap differs from the verified Studio ledger");
      ctx.storage.sql.exec("INSERT INTO worker_bootstrap VALUES(1,?,?)", manifest.instanceId, text(seed.expectedDigest)).toArray();
      return books;
    });
  }
  private state(): SyncState {
    const row = this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM worker_sync WHERE id=1").toArray()[0];
    if (!row) return { at: 0, target: Number(manifest.opening.block), error: "Awaiting live mainnet reconciliation" };
    const value = record(JSON.parse(row.payload));
    return { at: integer(value.at), target: integer(value.target), error: value.error === null ? null : text(value.error) };
  }
  private saveState(state: SyncState) {
    this.ctx.storage.sql.exec("INSERT INTO worker_sync VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", json(state)).toArray();
  }
  private client() { return createPublicClient({ transport: isolatedArcRpcTransport(RPC) }); }
  private async scheduleSoon(books: Books) {
    const state = this.state(), behind = books.progress().height < state.target;
    const desired = behind ? Date.now() + 1000 : Math.max(Date.now() + 1000, state.at + MIN_REFRESH_MS);
    const scheduled = await this.ctx.storage.getAlarm();
    if (scheduled === null || scheduled > desired) await this.ctx.storage.setAlarm(desired);
  }
  private refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshOnce().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async refreshOnce() {
    const books = await this.ready, client = this.client();
    try {
      const target = Number((await client.getBlock({ blockTag: "finalized" })).number);
      await syncBooks(client, books);
      const height = books.progress().height;
      this.saveState({ at: Date.now(), target, error: height < target ? `Catching up verified mainnet books: block ${height} of ${target}` : null });
      await this.ctx.storage.setAlarm(Date.now() + (height < target ? 1000 : IDLE_REFRESH_MS));
    } catch (error) {
      const prior = this.state();
      this.saveState({ ...prior, at: Date.now(), error: error instanceof Error ? error.message : String(error) });
      await this.ctx.storage.setAlarm(Date.now() + IDLE_REFRESH_MS);
      console.error(json({ event: "ledger_sync_failed", deployment: manifest.instanceId, error: this.state().error }));
    }
  }
  private displayedError(books: Books): string | null {
    const state = this.state();
    if (state.error) return state.error;
    if (books.progress().height < state.target) return `Catching up verified mainnet books: block ${books.progress().height} of ${state.target}`;
    if (Date.now() - state.at > STALE_AFTER_MS) return "Rechecking mainnet books after idle; the retained snapshot is not yet refreshed";
    return null;
  }
  async alarm() { await this.refresh(); }
  async describe() {
    const books = await this.ready; await this.scheduleSoon(books);
    return { manifest, rpcUrl: RPC, syncError: this.displayedError(books) };
  }
  async view() {
    const books = await this.ready; await this.scheduleSoon(books);
    return { deployment: manifest.instanceId, progress: books.progress(), balances: books.balances(), journals: books.journals(), issues: books.issues(), fees: books.fees(), receipts: books.receipts(), syncError: this.displayedError(books) };
  }
  async receipt(action: "challenge" | "confirm", input: Record<string, unknown>) {
    const books = await this.ready;
    await this.refresh();
    if (this.state().error) throw Error("Books must be synchronized before recording delivery evidence");
    return recordDeliveryReceipt(this.client(), books, action, input);
  }
}

async function body(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > 16384) throw Error("Request too large");
  const reader = request.body?.getReader(); if (!reader) throw Error("Missing request body");
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 16384) { await reader.cancel(); throw Error("Request too large"); } chunks.push(next.value); }
  const data = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return record(JSON.parse(new TextDecoder().decode(data)));
}
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      if (request.method === "GET" && url.pathname === "/api/deployments") return response([await env.LEDGERS.getByName(manifest.instanceId).describe()]);
      if (url.searchParams.get("deployment") !== manifest.instanceId) return response({ error: "Deployment is not configured" }, 404);
      if (request.method === "GET" && url.pathname === "/api/books") return response(await env.LEDGERS.getByName(manifest.instanceId).view());
      if (request.method === "POST" && (url.pathname === "/api/receipt/challenge" || url.pathname === "/api/receipt/confirm")) {
        const origin = request.headers.get("origin");
        if (origin && origin !== url.origin) return response({ error: "Origin is not allowed" }, 403);
        const input = await body(request);
        return response(await env.LEDGERS.getByName(manifest.instanceId).receipt(url.pathname === "/api/receipt/challenge" ? "challenge" : "confirm", input));
      }
      return response({ error: "This endpoint is read only or does not exist" }, 405);
    } catch (error) {
      console.error(json({ event: "api_request_failed", path: url.pathname, error: error instanceof Error ? error.message : String(error) }));
      return response({ error: error instanceof Error ? error.message : "Request failed" }, 400);
    }
  },
} satisfies ExportedHandler<Env>;
