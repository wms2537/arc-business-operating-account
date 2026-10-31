import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, copyFile, readFile, writeFile, rm } from "node:fs/promises";
process.env.INTEGRATION_EVIDENCE_DIR = "docs/evidence/browser/fixtures";
const { fixture, order, group, client, addr, data, DIR } =
  await import("./integration");
import { KERNEL_ABI } from "../src/lib/kernel-abi";
import { json } from "../src/lib/boundary";
const out = "docs/evidence/browser";
await mkdir(out, { recursive: true });
let chain: ChildProcess | undefined, server: ChildProcess | undefined;
try {
  let occupied = false;
  try {
    await client.getChainId();
    occupied = true;
  } catch {}
  if (occupied)
    throw Error("Local chain port is occupied; refusing another process");
  try {
    await fetch("http://127.0.0.1:3201/api/deployments");
    throw Error("Test server port is occupied");
  } catch (e) {
    if (e instanceof Error && e.message === "Test server port is occupied")
      throw e;
  }
  chain = spawn(
    "anvil",
    [
      "--host",
      "127.0.0.1",
      "--port",
      "18545",
      "--chain-id",
      "31337",
      "--hardfork",
      "cancun",
      "--timestamp",
      "1793318400",
      "--silent",
    ],
    { stdio: "ignore" },
  );
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      ready = (await client.getChainId()) === 31337;
    } catch {}
    if (ready) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw Error("Owned Anvil did not start");
  const co = await fixture("co", "ui-co");
  await order(co);
  await co.k(
    3,
    data({ abi: KERNEL_ABI, functionName: "fundCustomerEscrow", args: [1n] }),
  );
  await co.k(
    2,
    data({ abi: KERNEL_ABI, functionName: "joinMerchant", args: [1n] }),
  );
  await co.sync();
  co.books.close();
  const cp = await group();
  const folder = `${out}/books`;
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  await copyFile(
    co.path,
    `${folder}/${co.manifest.instanceId.slice(2)}.sqlite`,
  );
  await copyFile(
    `${DIR}/cp.sqlite`,
    `${folder}/${cp.instanceId.slice(2)}.sqlite`,
  );
  await writeFile(
    `${out}/fixtures.json`,
    json({
      co: co.manifest,
      cp,
      actors: Array.from({ length: 10 }, (_, i) => addr(i)),
    }),
  );
  const serverLog = await import("node:fs").then((fs) =>
    fs.openSync(`${out}/server.log`, "w"),
  );
  server = spawn("bun", ["run", "server/index.ts"], {
    env: {
      ...process.env,
      PORT: "3201",
      ALLOW_LOCAL_CHAIN: "1",
      BOOKS_MANIFESTS: `${DIR}/ui-co-manifest.json,${DIR}/cp-manifest.json`,
      BOOKS_DATA_DIR: folder,
    },
    stdio: ["ignore", serverLog, serverLog],
  });
  ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      ready = (await fetch("http://127.0.0.1:3201/api/deployments")).ok;
    } catch {}
    if (ready) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw Error("Books test server did not start");
  const run = spawn(
    process.env.BROWSER_PYTHON ?? "/tmp/arc-browser-venv/bin/python",
    ["tests/browser.py"],
    { stdio: "inherit" },
  );
  const exit = await new Promise<number>((resolve) =>
    run.once("exit", (code) => resolve(code ?? 1)),
  );
  if (exit) throw Error(`Browser rehearsal exited ${exit}`);
  const balances = await fetch(
    `http://127.0.0.1:3201/api/books?deployment=${co.manifest.instanceId}`,
  ).then((r) => r.json());
  await writeFile(`${out}/co-final-api.json`, json(balances));
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  server?.kill("SIGTERM");
  chain?.kill("SIGTERM");
}
