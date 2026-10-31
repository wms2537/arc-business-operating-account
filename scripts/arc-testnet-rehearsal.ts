import { mkdir, readdir } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { encodeFunctionData, erc20Abi, keccak256, toBytes, BaseError, ContractFunctionRevertedError, type Hex } from "viem";
import { actor, initialize, client, TOKEN, USER, DIR, deploy, send, save, exists, readJson, finalized, actorRows } from "./arc-testnet-support";
import { KERNEL_ABI, RELEASE_ID } from "../src/lib/kernel-abi";
import { readAccount, readPlan, type PlanTerms } from "../src/lib/kernel-client";
import { manifestIdentity, parseManifest, validateDeployment, type DeploymentManifest, type JournalLine } from "../src/lib/deployment";
import { address, record, hex, json, sameAddress } from "../src/lib/boundary";
import { receiptMessage } from "../src/lib/receipt-evidence";
import { Books } from "../server/books";
import { captureDeploymentRange } from "../server/chain";
import { reconcileBooks } from "../server/sync";

type Label = "co" | "cp" | "mixed";
const zero = address("0x0000000000000000000000000000000000000000");
const ref = (s: string) => keccak256(toBytes(`arc-business-2026-10-31:${s}`));
const data = (args: Parameters<typeof encodeFunctionData<typeof KERNEL_ABI>>[0]) => encodeFunctionData(args);
const addr = (label: Label, n: number) => actor(`${label}-${n}`).address;
type Check = { name: string; actual: unknown; expected: unknown; status: "passed" };
let phaseChecks: Check[] = [];
function equal(name: string, actual: unknown, expected: unknown) {
  if (json(actual) !== json(expected)) throw Error(`${name}: expected ${json(expected)}, received ${json(actual)}`);
  phaseChecks.push({ name, actual, expected, status: "passed" });
}
async function rejects(name: string, fn: () => unknown) { let rejected = false; try { await fn(); } catch { rejected = true; } equal(name, rejected, true); }
async function contractReject(name: string, expected: string, run: () => Promise<unknown>) {
  let actual: string | undefined;
  try { await run(); } catch (error) {
    if (!(error instanceof BaseError)) throw error;
    const cause = error.walk(value => value instanceof ContractFunctionRevertedError);
    if (cause instanceof ContractFunctionRevertedError) actual = cause.data?.errorName;
    if (!actual) throw error;
  }
  equal(name, actual, expected);
}
async function phase(label: Label, name: string, run: () => Promise<void>) {
  const path = `${DIR}/${label}-phase-${name}.json`;
  if (await exists(path)) { console.log("RETAINED_PHASE", label, name); return; }
  phaseChecks = [];
  await run();
  const block = await client.getBlock({ blockTag: "finalized" });
  await save(path, { status: "passed", chainId: 5042002, label, phase: name, block: block.number, hash: block.hash, sourceSha256: RELEASE_ID.sourceSha256, checks: phaseChecks });
  console.log("VERIFIED_PHASE", label, name, phaseChecks.length);
}
async function expiry(label: Label) {
  const path = `${DIR}/${label}-terms-time.json`;
  if (!(await exists(path))) await save(path, { expiry: ((await client.getBlock()).timestamp + 604800n).toString() });
  const value = record(await readJson(path)).expiry;
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw Error("Invalid immutable plan expiry");
  return BigInt(value);
}
function configs(label: Label) {
  const merchant = { actor: 2, id: "1", entity: "merchant", cash: 3000000n, floor: 2000000n, ar: 0n, limit: 2000000n };
  if (label === "co") return [merchant];
  const indexes = label === "cp" ? [2, 6, 7] : [6, 7, 8];
  const cash = [300000n, 250000n, 200000n], ar = [160000n, 165000n, 125000n];
  const buyers = indexes.map((n, i) => ({ actor: n, id: String(i + (label === "cp" ? 1 : 2)), entity: ["buyerA", "buyerB", "buyerC"][i], cash: cash[i], floor: 100000n, ar: label === "cp" ? ar[i] : 0n, limit: label === "cp" ? ar[i] : 200000n }));
  return label === "cp" ? buyers : [merchant, ...buyers];
}

async function fixture(label: Label) {
  const manifestPath = `${DIR}/${label}-manifest.json`, accounts = configs(label);
  const pool = label === "co" ? 2000000n : label === "cp" ? 500000n : 1900000n;
  const external = label === "co" ? 10000000n : label === "cp" ? 1000000n : 4000000n;
  let manifest: DeploymentManifest;
  if (await exists(manifestPath)) manifest = parseManifest(await readJson(manifestPath));
  else {
    const deployed = await deploy(label); const kernel = deployed.contractAddress;
    if (!kernel) throw Error("No deployed kernel address");
    const roles = [...new Set([0, 1, 3, 4, ...(label !== "cp" ? [5] : []), ...accounts.map(a => a.actor)])];
    for (const role of roles) {
      const business = role === 1 ? pool + (label === "mixed" ? 50000n : 0n) : role === 3 ? external : accounts.find(a => a.actor === role)?.cash ?? 0n;
      await send(`${label}-fund-${role}`, "master", { to: addr(label, role), data: "0x", value: business * 1000000000000n + (label === "mixed" && role === 0 ? 150000000000000000n : 50000000000000000n) });
    }
    const k = (key: string, role: number, input: Hex) => send(`${label}-setup-${key}`, `${label}-${role}`, { to: kernel, data: input });
    for (const a of accounts) {
      await k(`open-${a.id}`, a.actor, data({ abi: KERNEL_ABI, functionName: "openAccount" }));
      const actual = await client.readContract({ address: kernel, abi: KERNEL_ABI, functionName: "accountOf", args: [addr(label, a.actor)] });
      if (actual !== BigInt(a.id)) throw Error("Account identity differs from the canonical fixture");
    }
    for (const [role, amount] of [[1, pool + (label === "mixed" ? 50000n : 0n)], [3, external], ...accounts.map(a => [a.actor, a.cash] satisfies [number, bigint])] satisfies [number, bigint][]) {
      await send(`${label}-setup-allowance-${role}`, `${label}-${role}`, { to: TOKEN, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [kernel, amount] }) });
    }
    await k("pool", 1, data({ abi: KERNEL_ABI, functionName: "depositPool", args: [1n, pool] }));
    for (const a of accounts) {
      await k(`cash-${a.id}`, a.actor, data({ abi: KERNEL_ABI, functionName: "depositCash", args: [BigInt(a.id), a.cash] }));
      await k(`floor-${a.id}`, a.actor, data({ abi: KERNEL_ABI, functionName: "setProtectedFloor", args: [BigInt(a.id), a.floor] }));
      await k(`limit-${a.id}`, 1, data({ abi: KERNEL_ABI, functionName: "setBorrowerLimit", args: [1n, BigInt(a.id), a.limit] }));
    }
    const openingBlock = await client.getBlock({ blockTag: "finalized" }), lines: JournalLine[] = [];
    const add = (entity: string, account: string, delta: bigint) => { if (delta) lines.push({ entity, account, side: delta > 0n ? "debit" : "credit", amount: (delta < 0n ? -delta : delta).toString() }); };
    let custody = pool, totalAR = 0n;
    for (const a of accounts) { custody += a.cash; totalAR += a.ar; add(a.entity, "cash", a.cash); add(a.entity, `ar:opening:${a.id}`, a.ar); add(a.entity, "equity", -(a.cash + a.ar)); add("kernel", `due:account:${a.id}`, -a.cash); add("customer", `ap:opening:${a.id}`, -a.ar); }
    add("lender", "cash", pool); add("lender", "equity", -pool); add("customer", "external", external); add("customer", "equity", -(external - totalAR)); add("kernel", "usdc", custody); add("kernel", "due:pool", -pool);
    const base: Omit<DeploymentManifest, "instanceId"> = { version: 2, environment: "arc-testnet", chainId: 5042002, kernelAddress: kernel, usdcAddress: TOKEN, lenderAddress: addr(label, 1), deploymentTransaction: deployed.transactionHash, deploymentBlock: deployed.blockNumber.toString(), sourceSha256: RELEASE_ID.sourceSha256, opening: { block: openingBlock.number.toString(), hash: openingBlock.hash, timestamp: openingBlock.timestamp.toString(), fixtureVersion: `arc-${label}-2026-10-31`, ruleVersion: 2, lines, accounts: accounts.map(a => ({ id: a.id, owner: addr(label, a.actor), entity: a.entity, cash: a.cash.toString() })), poolCash: pool.toString(), custody: custody.toString() }, entities: [{ address: addr(label, 0), id: "coordinator" }, { address: addr(label, 1), id: "lender" }, { address: addr(label, 3), id: "customer" }, { address: addr(label, 4), id: "supplier" }, { address: addr(label, 5), id: "freight" }, { address: USER, id: "wallet-operator" }, ...accounts.map(a => ({ address: addr(label, a.actor), id: a.entity }))] };
    manifest = parseManifest({ ...base, instanceId: manifestIdentity(base) });
    await validateDeployment(client, manifest); await save(manifestPath, manifest);
  }
  await validateDeployment(client, manifest);
  const path = `${DIR}/${label}.sqlite`; let books = new Books(path, manifest);
  const kernel = manifest.kernelAddress;
  const k = (key: string, role: number, input: Hex) => send(`${label}-${key}`, `${label}-${role}`, { to: kernel, data: input });
  const sync = async () => {
    const target = (await client.getBlock({ blockTag: "finalized" })).number;
    while (BigInt(books.progress().height) < target) {
      const from = BigInt(books.progress().height) + 1n, to = from + 99n < target ? from + 99n : target;
      for (const block of await captureDeploymentRange(client, from, to, manifest)) books.capture(block);
      books.project();
    }
    await reconcileBooks(client, books);
  };
  return { label, manifest, kernel, path, accounts, k, sync, get books() { return books; }, reopen() { books.close(); books = new Books(path, manifest); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function saleTerms(f: Fixture, offerGoods = 1n, offerFreight = 2n): Promise<PlanTerms> {
  return { kind: 1, buyers: [], saleParty: { merchantOwner: addr(f.label, 2), merchantAccountId: 1n, merchantCash: 1000000n, creditDraw: 1500000n, creditLimit: 2000000n, customerAddress: addr(f.label, 3), requiredEscrow: 4000000n, saleValue: 10000000n }, lenderPoolId: 1n, offerRefs: [{ offerId: offerGoods, quantity: 100n, payee: addr(f.label, 4) }, { offerId: offerFreight, quantity: 1n, payee: addr(f.label, 5) }], expiry: await expiry(f.label), commercialRef: ref(`${f.label}-sale`) };
}
async function groupTerms(f: Fixture, offerId = 1n): Promise<PlanTerms> {
  const buyers = f.accounts.filter(a => a.entity !== "merchant");
  return { kind: 0, buyers: buyers.map((a, i) => ({ owner: addr(f.label, a.actor), accountId: BigInt(a.id), quantity: [40n, 35n, 25n][i], ownCash: [200000n, 150000n, 100000n][i], creditDraw: [160000n, 165000n, 125000n][i], creditLimit: a.limit })), saleParty: { merchantOwner: zero, merchantAccountId: 0n, merchantCash: 0n, creditDraw: 0n, creditLimit: 0n, customerAddress: zero, requiredEscrow: 0n, saleValue: 0n }, lenderPoolId: 1n, offerRefs: [{ offerId, quantity: 100n, payee: addr(f.label, 4) }], expiry: await expiry(f.label), commercialRef: ref(`${f.label}-group`) };
}
async function draftSale(f: Fixture) {
  const exp = await expiry(f.label);
  await f.k("offer-goods", 4, data({ abi: KERNEL_ABI, functionName: "createOffer", args: [addr(f.label, 4), 60000n, 100n, 100n, exp] }));
  await f.k("offer-freight", 5, data({ abi: KERNEL_ABI, functionName: "createOffer", args: [addr(f.label, 5), 500000n, 1n, 1n, exp] }));
  await f.k("draft-sale", 0, data({ abi: KERNEL_ABI, functionName: "draftPlan", args: [await saleTerms(f)] }));
  await f.k("approve-sale-lender", 1, data({ abi: KERNEL_ABI, functionName: "approveLenderPlan", args: [1n, 0n, 1500000n, exp] }));
  await f.k("approve-sale-goods", 4, data({ abi: KERNEL_ABI, functionName: "approveSupplierPlan", args: [1n, 0n, 100n, exp] }));
  await f.k("approve-sale-freight", 5, data({ abi: KERNEL_ABI, functionName: "approveSupplierPlan", args: [1n, 1n, 1n, exp] }));
}
async function draftGroup(f: Fixture, planId: bigint, offerId: bigint) {
  const exp = await expiry(f.label), terms = await groupTerms(f, offerId);
  await f.k("offer-group", 4, data({ abi: KERNEL_ABI, functionName: "createOffer", args: [addr(f.label, 4), 9000n, 100n, 100n, exp] }));
  await f.k("draft-group", 0, data({ abi: KERNEL_ABI, functionName: "draftPlan", args: [terms] }));
  await f.k("approve-group-supplier", 4, data({ abi: KERNEL_ABI, functionName: "approveSupplierPlan", args: [planId, 0n, 100n, exp] }));
  for (let i = 0; i < 3; i++) await f.k(`approve-group-lender-${i}`, 1, data({ abi: KERNEL_ABI, functionName: "approveLenderPlan", args: [planId, BigInt(i), terms.buyers[i].creditDraw, exp] }));
}
async function finish(f: Fixture) {
  await phase(f.label, "recovery", async () => {
    await f.sync(); const digest = f.books.digest();
    equal("rebuild reproduces retained finalized evidence", await f.books.rebuild(), digest);
    f.reopen(); equal("process restart retains the exact ledger", f.books.digest(), digest);
    await reconcileBooks(client, f.books);
    await save(`${DIR}/${f.label}-books.json`, { manifest: f.manifest, progress: f.books.progress(), balances: f.books.balances(), journals: f.books.journals(), fees: f.books.fees(), receipts: f.books.receipts(), digest });
  });
}

async function customerOrder() {
  const f = await fixture("co");
  try {
    await phase("co", "draft", async () => { await draftSale(f); await f.sync(); equal("opening merchant claim", f.books.balance("merchant", "cash"), 3000000n); equal("protected floor excluded", (await readAccount(client, f.kernel, 1n)).availableCash, 1000000n); });
    await phase("co", "escrow", async () => { await f.k("escrow", 3, data({ abi: KERNEL_ABI, functionName: "fundCustomerEscrow", args: [1n] })); await f.sync(); equal("refundable customer escrow", f.books.balance("customer", "escrow:1"), 4000000n); equal("escrow creates no merchant advance", f.books.balance("merchant", "customer-advance:1"), 0n); });
    await phase("co", "reserved", async () => { await f.k("join", 2, data({ abi: KERNEL_ABI, functionName: "joinMerchant", args: [1n] })); await f.sync(); equal("reservation creates no debt", Object.keys(f.books.progress().state.loans).length, 0); equal("available merchant cash is fully reserved", (await readAccount(client, f.kernel, 1n)).availableCash, 0n); });
    await phase("co", "close", async () => {
      const receipt = await f.k("commit", 0, data({ abi: KERNEL_ABI, functionName: "commitPlan", args: [1n] }));
      if (!(await exists(`${DIR}/co-interruption-check.json`))) {
        const initialHeight = f.books.progress().height;
        equal("chain close succeeds while indexer is interrupted", (await readPlan(client, f.kernel, 1n)).status, "Committed");
        equal("cursor predates confirmed close", BigInt(initialHeight) < receipt.blockNumber, true);
        const end = receipt.blockNumber - 1n;
        for (let from = BigInt(initialHeight) + 1n; from <= end; from += 100n) for (const block of await captureDeploymentRange(client, from, from + 99n < end ? from + 99n : end, f.manifest)) f.books.capture(block);
        f.books.project();
        const before = f.books.progress().height;
        for (const block of await captureDeploymentRange(client, receipt.blockNumber, receipt.blockNumber, f.manifest)) f.books.capture(block);
        const db = new Database(f.path);
        db.exec("CREATE TRIGGER IF NOT EXISTS rehearsal_crash BEFORE INSERT ON journal WHEN NEW.kind='PlanCommitted' AND NEW.entity='lender' BEGIN SELECT RAISE(ABORT,'rehearsal interruption after merchant lines'); END;");
        try { await rejects("financial posting failure rolls back atomically", () => f.books.project()); equal("no partial close journal survives", f.books.journals().filter(j => j.kind === "PlanCommitted").length, 0); equal("cursor rolls back with journal", f.books.progress().height, before); } finally { db.exec("DROP TRIGGER IF EXISTS rehearsal_crash"); db.close(); }
        await save(`${DIR}/co-interruption-check.json`, { status: "passed", receipt: receipt.transactionHash, checks: phaseChecks });
      }
      f.reopen(); await f.sync();
      for (const [entity, account, expected] of [["merchant", "cash", 2000000n], ["lender", "cash", 500000n], ["supplier", "external", 6000000n], ["freight", "external", 500000n], ["merchant", "loan-payable:1", -1500000n], ["merchant", "inventory:1", 0n]] satisfies [string, string, bigint][]) equal(`close ${entity}/${account}`, f.books.balance(entity, account), expected);
      await save(`${DIR}/co-close-books.json`, { block: f.books.progress().height, hash: f.books.progress().hash, balances: f.books.balances(), receipt: receipt.transactionHash });
      await contractReject("committed plan cannot spend again", "BK_AlreadyCommitted", () => client.simulateContract({ account: addr("co", 0), address: f.kernel, abi: KERNEL_ABI, functionName: "commitPlan", args: [1n] }));
      const digest = f.books.digest(), from = receipt.blockNumber;
      for (const block of await captureDeploymentRange(client, from, from, f.manifest)) f.books.capture(block);
      f.books.project(); equal("duplicate receipt delivery does not repost", f.books.digest(), digest);
    });
    await phase("co", "delivered", async () => { await f.k("goods", 2, data({ abi: KERNEL_ABI, functionName: "acknowledgeGoods", args: [1n] })); await f.k("freight", 2, data({ abi: KERNEL_ABI, functionName: "acknowledgeFreight", args: [1n] })); await f.sync(); equal("goods plus freight recognized on receipt", f.books.balance("merchant", "inventory:1"), 6500000n); equal("revenue waits for customer acceptance", f.books.balance("merchant", "revenue"), 0n); });
    await phase("co", "accepted", async () => { await f.k("acceptance", 3, data({ abi: KERNEL_ABI, functionName: "acceptSalesOrder", args: [1n] })); await f.sync(); equal("recognized customer receivable", f.books.balance("merchant", "ar:sale:1"), 6000000n); });
    await phase("co", "collected", async () => {
      await f.k("collection", 3, data({ abi: KERNEL_ABI, functionName: "collectSalesBalance", args: [1n, ref("co-full-collection"), 6000000n] })); await f.sync();
      for (const [entity, account, expected] of [["merchant", "cash", 6500000n], ["lender", "cash", 2000000n], ["merchant", "loan-payable:1", 0n], ["merchant", "ar:sale:1", 0n], ["kernel", "usdc", 8500000n], ["customer", "external", 0n]] satisfies [string, string, bigint][]) equal(`final ${entity}/${account}`, f.books.balance(entity, account), expected);
    });
    await finish(f);
  } finally { f.books.close(); }
}

async function group() {
  const f = await fixture("cp");
  try {
    await phase("cp", "draft", async () => { await draftGroup(f, 1n, 1n); for (const a of f.accounts) await f.k(`receivable-${a.id}`, a.actor, data({ abi: KERNEL_ABI, functionName: "registerReceivable", args: [BigInt(a.id), BigInt(a.id), addr("cp", 3), a.ar, ref(`cp-opening-${a.id}`)] })); await f.sync(); });
    await phase("cp", "75", async () => {
      for (const [i, a] of f.accounts.slice(0, 2).entries()) await f.k(`join-${i}`, a.actor, data({ abi: KERNEL_ABI, functionName: "joinBuyer", args: [1n, BigInt(i)] })); await f.sync();
      await contractReject("75-unit group close is rejected", "BK_BuyerNotJoined", () => client.simulateContract({ account: addr("cp", 0), address: f.kernel, abi: KERNEL_ABI, functionName: "commitPlan", args: [1n] }));
      equal("A/B reservations create no principal", Object.keys(f.books.progress().state.loans).length, 0);
      const pool = await client.readContract({ address: f.kernel, abi: KERNEL_ABI, functionName: "getPool", args: [1n] }); equal("A/B credit reserved", pool[2], 325000n);
    });
    await phase("cp", "100", async () => { await f.k("join-2", 7, data({ abi: KERNEL_ABI, functionName: "joinBuyer", args: [1n, 2n] })); await f.sync(); equal("full group remains debt-free before close", Object.keys(f.books.progress().state.loans).length, 0); });
    await phase("cp", "close", async () => {
      const receipt = await f.k("commit", 0, data({ abi: KERNEL_ABI, functionName: "commitPlan", args: [1n] })); await f.sync();
      equal("actual supplier payout", f.books.balance("supplier", "external"), 900000n); equal("lender cash after close", f.books.balance("lender", "cash"), 50000n);
      for (const a of f.accounts) { equal(`protected claim ${a.entity}`, f.books.balance(a.entity, "cash"), 100000n); equal(`separate principal ${a.entity}`, f.books.balance(a.entity, `loan-payable:${a.id}`), -a.ar); equal(`inventory awaits receipt ${a.entity}`, f.books.balance(a.entity, "inventory:1"), 0n); }
      await save(`${DIR}/cp-close-books.json`, { block: f.books.progress().height, hash: f.books.progress().hash, balances: f.books.balances(), receipt: receipt.transactionHash });
    });
    await phase("cp", "goods-receipts", async () => {
      for (const [i, a] of f.accounts.entries()) {
        if (f.books.balance(a.entity, "inventory:1") === [360000n, 315000n, 225000n][i]) continue;
        const challenge = f.books.issueChallenge("1", a.id), signer = actor(`cp-${a.actor}`), signature = await signer.signMessage({ message: receiptMessage(challenge) });
        await f.books.acceptReceipt(challenge, signature);
        equal(`signed buyer allocation ${a.entity}`, f.books.balance(a.entity, "inventory:1"), [360000n, 315000n, 225000n][i]);
        equal(`signed receipt replay is idempotent ${a.entity}`, await f.books.acceptReceipt(challenge, signature), "already-recorded");
      }
    });
    await phase("cp", "collected", async () => {
      for (const a of f.accounts) await f.k(`collection-${a.id}`, 3, data({ abi: KERNEL_ABI, functionName: "collectReceivable", args: [BigInt(a.id), ref(`cp-collection-${a.id}`), a.ar] })); await f.sync();
      for (const a of f.accounts) { equal(`collection leaves debt outstanding ${a.entity}`, f.books.balance(a.entity, `loan-payable:${a.id}`), -a.ar); equal(`opening AR cleared ${a.entity}`, f.books.balance(a.entity, `ar:opening:${a.id}`), 0n); equal(`collection precedes repayment ${a.entity}`, f.books.balance(a.entity, "cash"), 100000n + a.ar); }
    });
    await phase("cp", "repaid", async () => {
      for (const a of f.accounts) await f.k(`repayment-${a.id}`, a.actor, data({ abi: KERNEL_ABI, functionName: "repayLoan", args: [BigInt(a.id), a.ar] })); await f.sync();
      for (const a of f.accounts) { equal(`final protected cash ${a.entity}`, f.books.balance(a.entity, "cash"), 100000n); equal(`final debt ${a.entity}`, f.books.balance(a.entity, `loan-payable:${a.id}`), 0n); }
      equal("lender principal restored", f.books.balance("lender", "cash"), 500000n); equal("final group custody", f.books.balance("kernel", "usdc"), 800000n);
    });
    await finish(f);
  } finally { f.books.close(); }
}

async function mixed() {
  const f = await fixture("mixed"), exp = await expiry("mixed");
  const pool = () => client.readContract({ address: f.kernel, abi: KERNEL_ABI, functionName: "getPool", args: [1n] });
  try {
    await phase("mixed", "draft", async () => { await draftSale(f); await draftGroup(f, 2n, 3n); await f.sync(); });
    await phase("mixed", "contention", async () => {
      await f.k("escrow", 3, data({ abi: KERNEL_ABI, functionName: "fundCustomerEscrow", args: [1n] }));
      await f.k("sale-join", 2, data({ abi: KERNEL_ABI, functionName: "joinMerchant", args: [1n] })); equal("sale reserves shared pool", (await pool())[2], 1500000n);
      await f.k("group-join-0", 6, data({ abi: KERNEL_ABI, functionName: "joinBuyer", args: [2n, 0n] }));
      await f.k("group-join-1", 7, data({ abi: KERNEL_ABI, functionName: "joinBuyer", args: [2n, 1n] })); equal("sale and A/B share the same pool", (await pool())[2], 1825000n);
      await contractReject("C cannot reserve unavailable shared liquidity", "BK_InsufficientPoolLiquidity", () => client.simulateContract({ account: addr("mixed", 8), address: f.kernel, abi: KERNEL_ABI, functionName: "joinBuyer", args: [2n, 2n] }));
      await f.sync(); equal("mixed reservations create no debt", Object.keys(f.books.progress().state.loans).length, 0);
    });
    await phase("mixed", "topup", async () => { await f.k("topup", 1, data({ abi: KERNEL_ABI, functionName: "depositPool", args: [1n, 50000n] })); await f.k("group-join-2", 8, data({ abi: KERNEL_ABI, functionName: "joinBuyer", args: [2n, 2n] })); equal("newly funded liquidity admits C", (await pool())[2], 1950000n); await f.sync(); });
    await phase("mixed", "account-contention", async () => {
      await f.k("shared-offer", 4, data({ abi: KERNEL_ABI, functionName: "createOffer", args: [addr("mixed", 4), 9000n, 40n, 40n, exp] }));
      const terms: PlanTerms = { ...(await groupTerms(f, 4n)), buyers: [{ owner: addr("mixed", 2), accountId: 1n, quantity: 40n, ownCash: 200000n, creditDraw: 160000n, creditLimit: 2000000n }], offerRefs: [{ offerId: 4n, quantity: 40n, payee: addr("mixed", 4) }], commercialRef: ref("mixed-shared-account") };
      await f.k("shared-draft", 0, data({ abi: KERNEL_ABI, functionName: "draftPlan", args: [terms] }));
      await f.k("shared-lender", 1, data({ abi: KERNEL_ABI, functionName: "approveLenderPlan", args: [3n, 0n, 160000n, exp] }));
      await f.k("shared-supplier", 4, data({ abi: KERNEL_ABI, functionName: "approveSupplierPlan", args: [3n, 0n, 40n, exp] }));
      await contractReject("merchant cannot reuse held own cash", "BK_InsufficientBuyerCash", () => client.simulateContract({ account: addr("mixed", 2), address: f.kernel, abi: KERNEL_ABI, functionName: "joinBuyer", args: [3n, 0n] }));
      await f.k("leave-sale", 2, data({ abi: KERNEL_ABI, functionName: "leaveMerchant", args: [1n] }));
      await f.k("shared-join", 2, data({ abi: KERNEL_ABI, functionName: "joinBuyer", args: [3n, 0n] })); await f.sync();
      equal("released cash can be reserved once", (await pool())[2], 610000n);
      const capacityTerms: PlanTerms = { ...(await groupTerms(f, 3n)), buyers: [{ owner: addr("mixed", 2), accountId: 1n, quantity: 100n, ownCash: 700000n, creditDraw: 200000n, creditLimit: 2000000n }], commercialRef: ref("mixed-capacity-reuse") };
      await f.k("capacity-draft", 0, data({ abi: KERNEL_ABI, functionName: "draftPlan", args: [capacityTerms] }));
      await f.k("capacity-lender", 1, data({ abi: KERNEL_ABI, functionName: "approveLenderPlan", args: [4n, 0n, 200000n, exp] }));
      await f.k("capacity-supplier", 4, data({ abi: KERNEL_ABI, functionName: "approveSupplierPlan", args: [4n, 0n, 100n, exp] }));
      await contractReject("reserved supplier capacity cannot be reused", "BK_OfferCapacityExceeded", () => client.simulateContract({ account: addr("mixed", 2), address: f.kernel, abi: KERNEL_ABI, functionName: "joinBuyer", args: [4n, 0n] }));
      await f.sync();
    });
    await phase("mixed", "revocation-refund", async () => {
      await f.k("shared-revoke", 4, data({ abi: KERNEL_ABI, functionName: "revokeOfferApproval", args: [3n, 0n] }));
      await f.k("shared-cleanup", 0, data({ abi: KERNEL_ABI, functionName: "releaseExpiredPlan", args: [3n] }));
      equal("revocation releases the exact shared reservation", (await pool())[2], 450000n);
      await f.k("cancel-sale", 0, data({ abi: KERNEL_ABI, functionName: "cancelPlan", args: [1n] })); await f.sync();
      equal("cancelled escrow remains refundable", f.books.balance("customer", "escrow:1"), 4000000n);
      await f.k("refund-sale", 3, data({ abi: KERNEL_ABI, functionName: "withdrawCustomerEscrow", args: [1n] })); await f.sync();
      equal("separate refund restores customer funds", f.books.balance("customer", "external"), 4000000n);
      equal("mixed rehearsal never creates principal", Object.keys(f.books.progress().state.loans).length, 0);
    });
    await finish(f);
  } finally { f.books.close(); }
}

async function acceptFunding(hash: Hex) {
  const request = record(await readJson(`${DIR}/funding-request.json`));
  const [tx, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
  if (!sameAddress(tx.from, USER) || !tx.to || !sameAddress(tx.to, TOKEN) || tx.input !== request.data || tx.value !== 0n || receipt.status !== "success") throw Error("Funding transaction does not match the exact reviewed request");
  await finalized(receipt); await save(`${DIR}/funding-receipt.json`, receipt);
  const rows = await actorRows(), block = await client.getBlock({ blockTag: "finalized" });
  if (!(await exists(`${DIR}/native-opening.json`))) await save(`${DIR}/native-opening.json`, { block: block.number, hash: block.hash, balances: await Promise.all(rows.map(async row => ({ ...row, nativeWei: (await client.getBalance({ address: row.address, blockNumber: block.number })).toString() }))) });
  console.log("FUNDING_VERIFIED", hash, actor("master").address);
}

await initialize();
await mkdir(DIR, { recursive: true });
const stage = process.argv[2];
if (stage === "funding") await acceptFunding(hex(process.argv[3]));
else {
  if (!(await exists(`${DIR}/funding-receipt.json`))) throw Error("Verify the actual funding receipt before broadcasting rehearsal transactions");
  if (stage === "co") await customerOrder();
  else if (stage === "cp") await group();
  else if (stage === "mixed") await mixed();
  else if (stage === "all") { await customerOrder(); await group(); await mixed(); }
  else throw Error("Usage: funding <hash> | co | cp | mixed | all");
  const files = await readdir(DIR); console.log("REHEARSAL_STAGE_COMPLETE", stage, files.filter(p => p.includes("-phase-")).length);
}
