import { resolve } from "node:path";
import { client, DIR, readJson, save } from "./arc-testnet-support";
import { record, text, hash } from "../src/lib/boundary";
import { parseManifest } from "../src/lib/deployment";
import { Books } from "../server/books";
import { reconcileBooks } from "../server/sync";
if (process.cwd() !== "/home/user/app") throw Error("Run this operator recovery only in the current Studio project");
const dataDir = process.env.BOOKS_DATA_DIR;
if (!dataDir?.endsWith("/arc-testnet-2026-10-31")) throw Error("Unexpected live books directory");
const close = record(await readJson(`${DIR}/wallet-ui-close.json`)), txHash = hash(close.transaction);
const results = [];
for (const label of ["co", "cp", "mixed"]) {
  const manifest = parseManifest(await readJson(`${DIR}/${label}-manifest.json`));
  const path = resolve(dataDir, manifest.instanceId.slice(2) + ".sqlite");
  let books = new Books(path, manifest);
  try {
    const before = books.digest(), progress = books.progress();
    const closeSources = () => [...new Set(books.journals().filter(j => j.kind === "PlanCommitted" && j.source.startsWith(txHash + ":")).map(j => j.source))];
    const beforeSources = closeSources();
    if (label === "mixed" && beforeSources.length !== 1) throw Error("The real wallet close has not been posted exactly once");
    const rebuilt = await books.rebuild();
    if (rebuilt !== before) throw Error(`Rebuild changed ${label} ledger content`);
    books.close(); books = new Books(path, manifest);
    if (books.digest() !== before) throw Error(`Restart changed ${label} ledger content`);
    await reconcileBooks(client, books);
    const afterSources = closeSources();
    if (JSON.stringify(beforeSources) !== JSON.stringify(afterSources)) throw Error("Recovery duplicated or removed the wallet close");
    const walletFees = books.fees().filter(f => f.tx === txHash);
    if (label === "mixed" && (walletFees.length !== 1 || walletFees[0].amount !== text(close.gasFeeNativeWei) || walletFees[0].decimals !== 18)) throw Error("The wallet gas receipt was not retained exactly once");
    const result = { label, instanceId: manifest.instanceId, digestBefore: before, digestAfter: books.digest(), progressBefore: progress, progressAfter: books.progress(), walletCloseSources: afterSources, walletFees, balances: books.balances(), journalLines: books.journals().length, signedReceipts: books.receipts().length, reconciliation: "matched" };
    results.push(result); console.log("LIVE_BOOKS_RECOVERY_PASS", label, before);
    await save(`${DIR}/${label}-live-books-after-recovery.json`, { ...result, journals: books.journals(), fees: books.fees(), receipts: books.receipts() });
  } finally { books.close(); }
}
await save(`${DIR}/live-api-recovery.json`, { status: "passed", walletClose: txHash, resubmissions: 0, scope: "Live API was stopped; retained evidence was rebuilt and reopened without any chain write", results });
