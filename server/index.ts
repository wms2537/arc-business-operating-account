import { recordDeliveryReceipt } from "./receipt-service";
import { arcRpcTransport } from "../src/lib/arc-rpc";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createPublicClient, http, type PublicClient } from "viem";
import {
  parseManifest,
  networkSettings,
  deploymentRpcUrl,
  type DeploymentManifest,
} from "../src/lib/deployment";
import { record, json } from "../src/lib/boundary";
import { Books } from "./books";
import { syncBooks, reconcileBooks } from "./sync";
const root = resolve("dist"),
  dataDir = resolve(process.env.BOOKS_DATA_DIR ?? "data/books");
await mkdir(dataDir, { recursive: true });
type Runtime = {
  manifest: DeploymentManifest;
  rpcUrl: string;
  books: Books;
  client: PublicClient;
  syncError: string | null;
  running: boolean;
};
const runtimes: Runtime[] = [];
for (const file of (process.env.BOOKS_MANIFESTS ?? "")
  .split(",")
  .filter(Boolean)) {
  const manifest = parseManifest(JSON.parse(await readFile(file, "utf8")));
  if (
    manifest.environment === "local-anvil" &&
    process.env.ALLOW_LOCAL_CHAIN !== "1"
  )
    throw Error("Local-chain configuration requires ALLOW_LOCAL_CHAIN=1");
  const rpcUrl = deploymentRpcUrl(manifest.environment, process.env);
  const url = new URL(rpcUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error("Invalid public RPC URL");
  const books = new Books(
      resolve(dataDir, manifest.instanceId.slice(2) + ".sqlite"),
      manifest,
    ),
    client = createPublicClient({ transport: networkSettings(manifest.environment).arc ? arcRpcTransport(rpcUrl) : http(rpcUrl) });
  runtimes.push({
    manifest,
    rpcUrl,
    books,
    client,
    syncError: null,
    running: false,
  });
}
async function refresh(r: Runtime) {
  if (r.running) return;
  r.running = true;
  try {
    await syncBooks(r.client, r.books);
    r.syncError = null;
  } catch (e) {
    r.syncError = e instanceof Error ? e.message : String(e);
    console.error(
      JSON.stringify({
        event: "books_sync_failed",
        deployment: r.manifest.instanceId,
        error: r.syncError,
      }),
    );
  } finally {
    r.running = false;
  }
}
if (process.argv.includes("--rebuild")) {
  for (const r of runtimes) {
    await r.books.rebuild();
    await reconcileBooks(r.client, r.books);
    console.log(
      json({
        deployment: r.manifest.instanceId,
        digest: r.books.digest(),
        status: "rebuilt",
      }),
    );
    r.books.close();
  }
  process.exit(0);
}
await Promise.all(runtimes.map(refresh));
const timer = setInterval(() => {
  for (const r of runtimes) void refresh(r);
}, 3000);
const response = (data: unknown, status = 200) =>
  new Response(json(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
async function body(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > 16384)
    throw Error("Request too large");
  const content = await request.text();
  if (content.length > 16384) throw Error("Request too large");
  return record(JSON.parse(content));
}
const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3001),
  maxRequestBodySize: 16384,
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/deployments" && request.method === "GET")
        return response(
          runtimes.map((r) => ({
            manifest: r.manifest,
            rpcUrl: r.rpcUrl,
            syncError: r.syncError,
          })),
        );
      if (url.pathname.startsWith("/api/")) {
        const id = url.searchParams.get("deployment"),
          r = runtimes.find((r) => r.manifest.instanceId === id);
        if (!r) return response({ error: "Deployment is not configured" }, 404);
        if (request.method === "GET" && url.pathname === "/api/books")
          return response({
            deployment: r.manifest.instanceId,
            progress: r.books.progress(),
            balances: r.books.balances(),
            journals: r.books.journals(),
            issues: r.books.issues(),
            fees: r.books.fees(),
            receipts: r.books.receipts(),
            syncError: r.syncError,
          });
        if (
          request.method === "POST" &&
          (url.pathname === "/api/receipt/challenge" ||
            url.pathname === "/api/receipt/confirm")
        ) {
          const origin = request.headers.get("origin");
          if (
            origin &&
            origin !== url.origin &&
            origin !== process.env.UI_ORIGIN
          )
            return response({ error: "Origin is not allowed" }, 403);
          await refresh(r);
          if (r.syncError)
            throw Error(
              "Books must be synchronized before recording delivery evidence",
            );
          const value = await body(request);
          return response(await recordDeliveryReceipt(r.client, r.books, url.pathname === "/api/receipt/challenge" ? "challenge" : "confirm", value));
        }
        return response(
          { error: "This endpoint is read only or does not exist" },
          405,
        );
      }
      if (request.method !== "GET" && request.method !== "HEAD")
        return response({ error: "Method not allowed" }, 405);
      let decoded: string;
      try {
        decoded = decodeURIComponent(url.pathname);
      } catch {
        return response({ error: "Invalid path" }, 400);
      }
      const file = resolve(root, "." + decoded);
      if (file !== root && !file.startsWith(root + sep))
        return response({ error: "Invalid path" }, 400);
      const candidate = Bun.file(file);
      if (await candidate.exists()) return new Response(candidate);
      return new Response(Bun.file(resolve(root, "index.html")));
    } catch (error) {
      return response(
        { error: error instanceof Error ? error.message : "Request failed" },
        400,
      );
    }
  },
});
console.log(
  json({
    event: "books_server_started",
    port: server.port,
    deployments: runtimes.map((r) => r.manifest.instanceId),
    chainWrites: false,
  }),
);
process.on("SIGTERM", () => {
  clearInterval(timer);
  server.stop();
  for (const r of runtimes) r.books.close();
  process.exit(0);
});
