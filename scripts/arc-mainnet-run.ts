/** Human-operated mainnet runner. Never launch this file from an agent tool. */
import { mkdir, readFile, writeFile, rename, readdir, rm } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createWalletClient, encodeDeployData, encodeFunctionData, erc20Abi, http, keccak256, toBytes, type Address, type Hex, type TransactionReceipt } from "viem";
import { arc } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { OWNER, TOKEN, RPC, DATA, VAULT, ROLES, ACTOR_FUNDING, ACTOR_GAS_CAP, MAX_FEE, TIP, FUNDING_GAS_LIMIT, CLOSE_GAS_LIMIT, client, gasLimit, exists, readJson, publicPlan, reviewedBytecode } from "./arc-mainnet-prepare";
import { KERNEL_ABI, RELEASE_ID } from "../src/lib/kernel-abi";
import { address, array, hex, hash, record, text, uint, json, sameAddress } from "../src/lib/boundary";
import { normalizedRuntimeHash, manifestIdentity, parseManifest, validateDeployment, type DeploymentManifest, type JournalLine } from "../src/lib/deployment";
import { readPlan, type PlanTerms } from "../src/lib/kernel-client";

const save = async (path: string, value: unknown) => { await writeFile(path + ".tmp", json(value) + "\n", { mode: 0o600 }); await rename(path + ".tmp", path); };
const ref = (s: string) => keccak256(toBytes("arc-mainnet-2026-10-31:" + s));
const data = (input: Parameters<typeof encodeFunctionData<typeof KERNEL_ABI>>[0]) => encodeFunctionData(input);
const BUYERS = [{ role: 2, id: 1n, entity: "buyerA", cash: 30000n, own: 20000n, loan: 16000n, units: 40n }, { role: 6, id: 2n, entity: "buyerB", cash: 25000n, own: 15000n, loan: 16500n, units: 35n }, { role: 7, id: 3n, entity: "buyerC", cash: 20000n, own: 10000n, loan: 12500n, units: 25n }];
export const ALLOCATIONS = [{ role: 0, business: 0n, gas: 35000000000000000n }, { role: 1, business: 50000n, gas: 26000000000000000n }, { role: 2, business: 30000n, gas: 36000000000000000n }, { role: 3, business: 100000n, gas: 16000000000000000n }, { role: 4, business: 0n, gas: 14000000000000000n }, { role: 6, business: 25000n, gas: 34000000000000000n }, { role: 7, business: 20000n, gas: 34000000000000000n }];
export function enforceFeeBudget(spentOrReserved: bigint, nextGas: bigint) {
  if (spentOrReserved < 0n || nextGas <= 0n || nextGas > 9000000n) throw Error("Invalid gas budget input");
  if (spentOrReserved + nextGas * MAX_FEE > ACTOR_GAS_CAP) throw Error("STOP: actor gas would exceed the approved 0.425 USDC allowance");
}
type Call = { to: Address; data: Hex; value?: bigint } | { to?: never; data: Hex; value?: bigint };
let secrets: Record<string, unknown> | undefined;
function actor(name: string) { if (!ROLES.includes(name) || !secrets) throw Error("Actor vault not loaded by the human operator"); return privateKeyToAccount(hex(secrets[name])); }
const addr = (n: number) => actor(`cp-${n}`).address;
async function final(receipt: TransactionReceipt) {
  for (let n = 0; n < 60; n++) {
    if ((await client.getBlock({ blockTag: "finalized" })).number >= receipt.blockNumber) {
      if ((await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw Error("Receipt is not canonical");
      return;
    }
    await Bun.sleep(1000);
  }
  throw Error("Finality is pending. Resume the same operation; do not replace it.");
}
export function validateFunding(tx: { from: string; to: string | null; input: string; value: bigint; gas: bigint; maxFeePerGas?: bigint | null; chainId?: number }, master: string) {
  if (!sameAddress(tx.from, OWNER) || !tx.to || !sameAddress(tx.to, master) || tx.input !== "0x" || tx.value !== ACTOR_FUNDING || tx.chainId !== 5042 || tx.gas > FUNDING_GAS_LIMIT || tx.maxFeePerGas == null || tx.maxFeePerGas > MAX_FEE) throw Error("Funding differs from the exact reviewed amount, recipient, network, or fee ceiling");
}
async function funding(fundingHash: Hex) {
  const [tx, receipt] = await Promise.all([client.getTransaction({ hash: fundingHash }), client.getTransactionReceipt({ hash: fundingHash })]);
  validateFunding(tx, actor("master").address);
  if (receipt.status !== "success") throw Error("Funding was not successful");
  await final(receipt);
  const file = `${DATA}/funding-receipt.json`;
  if (await exists(file) && record(await readJson(file)).transactionHash !== fundingHash) throw Error("Funding was already recorded. Never fund twice.");
  await save(file, receipt);
}
async function feeLiability() {
  let total = 0n;
  for (const file of await readdir(`${DATA}/operations`)) {
    if (!file.endsWith(".json") || file.endsWith("-receipt.json")) continue;
    const op = record(await readJson(`${DATA}/operations/${file}`)), receiptFile = `${DATA}/operations/${file.replace(/\.json$/, "-receipt.json")}`;
    if (await exists(receiptFile)) { const r = record(await readJson(receiptFile)); total += uint(r.gasUsed) * uint(r.effectiveGasPrice); }
    else total += uint(op.gas) * uint(op.maxFeePerGas);
  }
  return total;
}
async function send(id: string, name: string, call: Call) {
  if (!/^[a-z0-9-]+$/.test(id)) throw Error("Invalid operation id");
  if (await client.getChainId() !== 5042) throw Error("Wrong chain");
  const account = actor(name), path = `${DATA}/operations/${id}`, value = call.value ?? 0n;
  let op: Record<string, unknown>;
  if (await exists(path + ".json")) {
    op = record(await readJson(path + ".json"));
    if (op.actor !== name || !sameAddress(address(op.from), account.address) || op.to !== (call.to ?? null) || op.data !== call.data || uint(op.value) !== value || op.chainId !== 5042) throw Error("Saved operation has different terms");
  } else {
    const block = await client.getBlock(), estimate = await client.estimateGas({ account: account.address, ...call });
    if (block.baseFeePerGas === null || block.baseFeePerGas + TIP > MAX_FEE || await client.getGasPrice() > MAX_FEE) throw Error("STOP: network fee exceeds the fixed ceiling");
    const gas = gasLimit(estimate);
    if (id === "deploy" && gas * MAX_FEE > 200000000000000000n) throw Error("Deployment exceeds its fixed 0.20 USDC fee ceiling");
    enforceFeeBudget(await feeLiability(), gas);
    if (await client.getBalance({ address: account.address }) < value + gas * MAX_FEE) throw Error(`STOP: ${name} lacks its fixed funding. Do not top up automatically.`);
    const nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
    const wallet = createWalletClient({ account, chain: arc, transport: http(RPC, { retryCount: 0 }) });
    const raw = await wallet.signTransaction({ ...call, value, nonce, gas, maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: TIP, type: "eip1559", chain: arc });
    const txHash = keccak256(raw), rawFile = `${VAULT}/signed/${txHash}.txt`;
    if (await exists(rawFile)) { if ((await readFile(rawFile, "utf8")).trim() !== raw) throw Error("Retained transaction differs"); }
    else await writeFile(rawFile, raw, { mode: 0o600, flag: "wx" });
    op = { id, actor: name, from: account.address, to: call.to ?? null, data: call.data, value: value.toString(), chainId: 5042, nonce, gas: gas.toString(), maxFeePerGas: MAX_FEE.toString(), maxPriorityFeePerGas: TIP.toString(), hash: txHash };
    await save(path + ".json", op);
  }
  const txHash = hash(op.hash);
  let receipt: TransactionReceipt | undefined;
  try { receipt = await client.getTransactionReceipt({ hash: txHash }); } catch { /* It may not have been broadcast yet. */ }
  if (!receipt) {
    const raw = hex((await readFile(`${VAULT}/signed/${txHash}.txt`, "utf8")).trim());
    if (keccak256(raw) !== txHash) throw Error("Signed transaction hash changed");
    console.log("SENDING", id, txHash);
    try { await client.sendRawTransaction({ serializedTransaction: raw }); } catch { /* Same hash is reconciled below. No new nonce. */ }
    receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 60000 });
  }
  await final(receipt); await save(path + "-receipt.json", receipt);
  if (receipt.status !== "success") throw Error(`Transaction reverted: ${id}. Stop and inspect; do not create a replacement operation.`);
  console.log("CONFIRMED", id, txHash);
  return receipt;
}
async function setup() {
  const bytecode = await reviewedBytecode();
  const deployed = await send("deploy", "master", { data: encodeDeployData({ abi: KERNEL_ABI, bytecode, args: [TOKEN, addr(1)] }) });
  const kernel = deployed.contractAddress;
  if (!kernel) throw Error("No contract address");
  const runtime = await client.getBytecode({ address: kernel });
  if (!runtime || normalizedRuntimeHash(runtime) !== RELEASE_ID.normalizedRuntimeHash) throw Error("Deployed code is not the reviewed release");
  for (const a of ALLOCATIONS) await send(`fund-${a.role}`, "master", { to: addr(a.role), data: "0x", value: a.business * 1000000000000n + a.gas });
  const k = (id: string, role: number, input: Hex) => send(id, `cp-${role}`, { to: kernel, data: input });
  for (const a of BUYERS) {
    await k(`open-${a.id}`, a.role, data({ abi: KERNEL_ABI, functionName: "openAccount" }));
    if (await client.readContract({ address: kernel, abi: KERNEL_ABI, functionName: "accountOf", args: [addr(a.role)] }) !== a.id) throw Error("Unexpected account identity");
  }
  for (const a of ALLOCATIONS.filter(a => a.business > 0n)) await send(`allowance-${a.role}`, `cp-${a.role}`, { to: TOKEN, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [kernel, a.business] }) });
  await k("pool", 1, data({ abi: KERNEL_ABI, functionName: "depositPool", args: [1n, 50000n] }));
  for (const a of BUYERS) {
    await k(`cash-${a.id}`, a.role, data({ abi: KERNEL_ABI, functionName: "depositCash", args: [a.id, a.cash] }));
    await k(`floor-${a.id}`, a.role, data({ abi: KERNEL_ABI, functionName: "setProtectedFloor", args: [a.id, 10000n] }));
    await k(`limit-${a.id}`, 1, data({ abi: KERNEL_ABI, functionName: "setBorrowerLimit", args: [1n, a.id, a.loan] }));
  }
  const manifestFile = `${DATA}/cp-manifest.json`;
  if (!(await exists(manifestFile))) {
    const block = await client.getBlock({ blockTag: "finalized" }), lines: JournalLine[] = [];
    const add = (entity: string, account: string, delta: bigint) => { if (delta !== 0n) lines.push({ entity, account, side: delta > 0n ? "debit" : "credit", amount: (delta < 0n ? -delta : delta).toString() }); };
    for (const a of BUYERS) { add(a.entity,"cash",a.cash); add(a.entity,`ar:opening:${a.id}`,a.loan); add(a.entity,"equity",-a.cash-a.loan); add("kernel",`due:account:${a.id}`,-a.cash); add("customer",`ap:opening:${a.id}`,-a.loan); }
    add("lender","cash",50000n); add("lender","equity",-50000n); add("customer","external",100000n); add("customer","equity",-55000n); add("kernel","usdc",125000n); add("kernel","due:pool",-50000n);
    const base: Omit<DeploymentManifest,"instanceId"> = { version: 2, environment: "arc-mainnet", chainId: 5042, kernelAddress: kernel, usdcAddress: TOKEN, lenderAddress: addr(1), deploymentTransaction: deployed.transactionHash, deploymentBlock: deployed.blockNumber.toString(), sourceSha256: RELEASE_ID.sourceSha256, opening: { block: block.number.toString(), hash: block.hash, timestamp: block.timestamp.toString(), fixtureVersion: "mainnet-small-group-2026-10-31", ruleVersion: 2, lines, accounts: BUYERS.map(a => ({id:a.id.toString(),owner:addr(a.role),entity:a.entity,cash:a.cash.toString()})), poolCash: "50000", custody: "125000" }, entities: [{address:addr(0),id:"coordinator"},{address:addr(1),id:"lender"},{address:addr(3),id:"customer"},{address:addr(4),id:"supplier"},{address:OWNER,id:"wallet-operator"},...BUYERS.map(a=>({address:addr(a.role),id:a.entity}))] };
    const manifest = parseManifest({...base,instanceId:manifestIdentity(base)}); await validateDeployment(client,manifest); await save(manifestFile,manifest);
  }
  const manifest = parseManifest(await readJson(manifestFile)); await validateDeployment(client,manifest);
  const expiryFile = `${DATA}/expiry.json`;
  if (!(await exists(expiryFile))) await save(expiryFile,{expiry:((await client.getBlock()).timestamp+604800n).toString()});
  const expiry = uint(record(await readJson(expiryFile)).expiry), zero = address("0x0000000000000000000000000000000000000000");
  const terms: PlanTerms = {kind:0,buyers:BUYERS.map(a=>({owner:addr(a.role),accountId:a.id,quantity:a.units,ownCash:a.own,creditDraw:a.loan,creditLimit:a.loan})),saleParty:{merchantOwner:zero,merchantAccountId:0n,merchantCash:0n,creditDraw:0n,creditLimit:0n,customerAddress:zero,requiredEscrow:0n,saleValue:0n},lenderPoolId:1n,offerRefs:[{offerId:1n,quantity:100n,payee:addr(4)}],expiry,commercialRef:ref("group")};
  await k("offer",4,data({abi:KERNEL_ABI,functionName:"createOffer",args:[addr(4),900n,100n,100n,expiry]}));
  await k("draft",0,data({abi:KERNEL_ABI,functionName:"draftPlan",args:[terms]}));
  await k("supplier-approval",4,data({abi:KERNEL_ABI,functionName:"approveSupplierPlan",args:[1n,0n,100n,expiry]}));
  for (const [i,a] of BUYERS.entries()) {
    await k(`lender-approval-${a.id}`,1,data({abi:KERNEL_ABI,functionName:"approveLenderPlan",args:[1n,BigInt(i),a.loan,expiry]}));
    await k(`receivable-${a.id}`,a.role,data({abi:KERNEL_ABI,functionName:"registerReceivable",args:[a.id,a.id,addr(3),a.loan,ref(`opening-${a.id}`)]}));
    await k(`join-${a.id}`,a.role,data({abi:KERNEL_ABI,functionName:"joinBuyer",args:[1n,BigInt(i)]}));
  }
  const plan = await readPlan(client,kernel,1n);
  if (plan.status !== "Open") throw Error("Plan already changed state; reconcile instead of requesting another close");
  const input = data({abi:KERNEL_ABI,functionName:"commitPlan",args:[1n]});
  const estimate = await client.estimateGas({account:OWNER,to:kernel,data:input});
  if (gasLimit(estimate) > CLOSE_GAS_LIMIT) throw Error("Close exceeds its pre-approved gas limit");
  const close = {chainId:5042,from:OWNER,to:kernel,data:input,value:"0",gas:CLOSE_GAS_LIMIT.toString(),maxFeePerGas:MAX_FEE.toString(),maxPriorityFeePerGas:TIP.toString(),planId:"1",status:"ready-for-human-wallet-close",supplierPayoutMicroUSDC:"90000",principalMicroUSDC:"45000",protectedEachMicroUSDC:"10000",estimatedGas:estimate.toString(),noCloseSent:true};
  await save(`${DATA}/close-request.json`,close);
  await save(`${DATA}/setup-status.json`,{status:"ready-for-human-wallet-close",manifest:manifestFile,closeRequest:`${DATA}/close-request.json`,actorFeesNativeWei:(await feeLiability()).toString()});
  console.log(json(close));
}
async function main() {
  const stage = process.argv[2];
  if (!["funding","setup"].includes(stage ?? "")) throw Error("Usage: funding <hash> | setup");
  if (process.platform !== "darwin" || !stdin.isTTY || !stdout.isTTY) throw Error("A human must run this interactively on the owner's Mac");
  if (await client.getChainId() !== 5042) throw Error("Wrong chain");
  await reviewedBytecode();
  const stored = record(await readJson(VAULT+"/actors.json"));
  if (stored.chainId !== 5042 || !sameAddress(address(stored.owner),OWNER)) throw Error("Vault owner/network mismatch");
  secrets = record(stored.privateKeys);
  const actors = ROLES.map(name=>({name,address:actor(name).address})), expected=publicPlan(actors), plan=record(await readJson(DATA+"/plan.json"));
  if (json(plan)!==json(expected)) throw Error("Public plan changed");
  const publicActors=array(await readJson(DATA+"/actors.json")).map(v=>{const r=record(v);return {name:text(r.name),address:address(r.address)};});
  if (json(publicActors)!==json(actors)) throw Error("Public actors changed");
  await mkdir(`${DATA}/operations`,{recursive:true}); await mkdir(`${VAULT}/signed`,{recursive:true,mode:0o700});
  const lock=VAULT+"/runner.lock";
  if (await exists(lock)) throw Error("A prior runner lock exists. Check that no runner remains active before removing it. No transactions sent.");
  await writeFile(lock,json({pid:process.pid,started:new Date().toISOString()}),{mode:0o600,flag:"wx"});
  try {
    if (stage === "funding") { await funding(hash(process.argv[3])); console.log("Funding verified. No transaction was signed or sent."); return; }
    const fundingReceipt=record(await readJson(DATA+"/funding-receipt.json")); await funding(hash(fundingReceipt.transactionHash));
    console.log("This will deploy the reviewed contract and prepare the 0.225 USDC group-purchase demo on ARC MAINNET using dedicated local keys.");
    console.log("Fixed demo funding: 0.65 USDC; maximum total wallet outflow: 0.75 USDC. Actor gas ceiling: 0.425 USDC. No automatic top-ups. Final purchase close stays in MetaMask.");
    console.log("Saved receipts resume the exact same transaction hash. Keep the local vault for recovery. Public evidence contains no private keys.");
    const terminal=createInterface({input:stdin,output:stdout}); let consent:string;
    try {consent=await terminal.question("Type SEND SETUP to sign and send these mainnet setup transactions: ");}finally{terminal.close();}
    if(consent!=="SEND SETUP")throw Error("Cancelled; nothing sent");
    await setup();
  } finally { secrets=undefined; await rm(lock); }
}
if(import.meta.main)await main();
