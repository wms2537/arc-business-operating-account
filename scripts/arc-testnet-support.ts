import { arcRpcTransport } from "../src/lib/arc-rpc";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, chmod, access } from "node:fs/promises";
import { createPublicClient, createWalletClient, defineChain, http, erc20Abi, encodeFunctionData, encodeDeployData, keccak256, type Address, type Hex, type TransactionReceipt } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { KERNEL_ABI, RELEASE_ID } from "../src/lib/kernel-abi";
import { record, array, text, hex, address, uint, integer, json, sameAddress } from "../src/lib/boundary";
import { normalizedRuntimeHash } from "../src/lib/deployment";

export const RPC = "https://rpc.testnet.arc.io";
export const TOKEN = address("0x3600000000000000000000000000000000000000");
export const USER = address("0x40e4ccd3db59580b23f5db16e1f9e1bcf6d2bf8e");
export const DIR = "docs/evidence/arc-testnet/rehearsal";
const VAULT = "/tmp/arc-business-testnet-private-46704d22-91ee-404d-8ff7-7ad873e3c289";
export const chain = defineChain({ id: 5042002, name: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
export const client = createPublicClient({ chain, transport: arcRpcTransport(RPC), pollingInterval: 1500 });
export const labels = ["co", "cp", "mixed"];
export async function exists(path: string) { try { await access(path); return true; } catch { return false; } }
export async function readJson(path: string): Promise<unknown> { return JSON.parse(await readFile(path, "utf8")); }
export async function save(path: string, value: unknown) { await writeFile(path + ".tmp", json(value) + "\n", { mode: 0o600 }); await rename(path + ".tmp", path); }
export const digest = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex");
const names = ["master", ...labels.flatMap(label => Array.from({ length: 10 }, (_, i) => `${label}-${i}`))];

export async function initialize() {
  if (process.cwd() !== "/home/user/app") throw Error("Run only in the existing Studio project");
  await mkdir(VAULT, { recursive: true, mode: 0o700 }); await chmod(VAULT, 0o700);
  await mkdir(VAULT + "/signed", { recursive: true, mode: 0o700 });
  await mkdir(DIR + "/operations", { recursive: true });
  const file = VAULT + "/actors.json";
  if (!(await exists(file))) {
    if (await exists(DIR + "/actors.json")) throw Error("Private actor vault is missing; never silently replace existing funded actors");
    await writeFile(file, json(Object.fromEntries(names.map(name => [name, generatePrivateKey()]))) + "\n", { mode: 0o600, flag: "wx" });
  }
  await chmod(file, 0o600);
  await loadActors();
  const actors = names.map(name => ({ name, address: actor(name).address }));
  if (await exists(DIR + "/actors.json")) {
    if (json(await readJson(DIR + "/actors.json")) !== json(actors)) throw Error("Public actor identities differ from the retained private vault");
  } else await save(DIR + "/actors.json", actors);
  await preflight();
  return actors;
}

let secretValues: Record<string, unknown> | undefined;
export async function loadActors() { secretValues = record(await readJson(VAULT + "/actors.json")); }
export function actor(name: string) {
  if (!names.includes(name) || !secretValues) throw Error("Actor vault is not initialized");
  return privateKeyToAccount(hex(secretValues[name]));
}
export async function preflight() {
  if (await client.getChainId() !== 5042002) throw Error("RPC is not Arc Testnet");
  if (digest(await readFile("contracts/BusinessKernel.sol")) !== RELEASE_ID.sourceSha256) throw Error("Kernel source changed");
  if (digest(await readFile("contracts/IBusinessKernel.sol")) !== RELEASE_ID.interfaceSha256) throw Error("Kernel interface changed");
  const runtimeCheck = record(await readJson("docs/evidence/arc-testnet/runtime/identity-check.json"));
  if (runtimeCheck.status !== "passed" || runtimeCheck.sameReviewedRuntime !== true || runtimeCheck.sameSources !== true || integer(record(runtimeCheck.tests).Success) !== 177) throw Error("Arc VM release checks are not complete");
  if (await client.readContract({ address: TOKEN, abi: erc20Abi, functionName: "decimals" }) !== 6) throw Error("Unexpected USDC precision");
  const code = await client.getBytecode({ address: TOKEN }); if (!code || code === "0x") throw Error("USDC system contract is missing");
}

type Call = { to: Address; data: Hex; value?: bigint } | { data: Hex; value?: bigint; to?: never };
type Signed = { id: string; actor: string; from: Address; to: Address | null; data: Hex; value: string; nonce: number; hash: Hex; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string };
function signed(value: unknown): Signed {
  const x = record(value);
  return { id: text(x.id), actor: text(x.actor), from: address(x.from), to: x.to === null ? null : address(x.to), data: hex(x.data), value: uint(x.value).toString(), nonce: integer(x.nonce), hash: hex(x.hash), gas: uint(x.gas).toString(), maxFeePerGas: uint(x.maxFeePerGas).toString(), maxPriorityFeePerGas: uint(x.maxPriorityFeePerGas).toString() };
}
export async function finalized(receipt: TransactionReceipt) {
  for (let i = 0; i < 60; i++) {
    const block = await client.getBlock({ blockTag: "finalized" });
    if (block.number >= receipt.blockNumber) {
      if ((await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw Error("Transaction is not on the finalized canonical chain");
      return;
    }
    await Bun.sleep(1000);
  }
  throw Error("Finality is still pending; rerun this exact operation to reconcile it");
}
export async function send(id: string, actorName: string, call: Call) {
  if (!/^[a-z0-9-]+$/.test(id)) throw Error("Invalid operation identity");
  if (await client.getChainId() !== 5042002) throw Error("Transaction blocked: wrong chain");
  const account = actor(actorName), path = `${DIR}/operations/${id}`;
  let op: Signed;
  if (await exists(path + ".json")) {
    op = signed(await readJson(path + ".json"));
    if (op.actor !== actorName || !sameAddress(op.from, account.address) || op.to?.toLowerCase() !== call.to?.toLowerCase() || op.data !== call.data || BigInt(op.value) !== (call.value ?? 0n)) throw Error("An operation id cannot authorize different transaction terms");
  } else {
    const estimate = await client.estimateGas({ account: account.address, ...call });
    const gas = estimate * 120n / 100n + 20000n;
    const fees = await client.estimateFeesPerGas();
    if (gas > 9000000n || fees.maxFeePerGas > 100000000000n || gas * fees.maxFeePerGas > 1000000000000000000n) throw Error("Test transaction fee exceeds its one-test-USDC cap");
    const value = call.value ?? 0n;
    if (await client.getBalance({ address: account.address }) < value + gas * fees.maxFeePerGas) throw Error(`Actor ${actorName} needs testnet gas funding`);
    const nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
    const wallet = createWalletClient({ account, chain, transport: http(RPC, { retryCount: 0 }) });
    const raw = await wallet.signTransaction({ ...call, value, nonce, gas, ...fees, type: "eip1559", chain });
    const hash = keccak256(raw);
    await writeFile(`${VAULT}/signed/${hash}.txt`, raw, { mode: 0o600, flag: "wx" });
    op = { id, actor: actorName, from: account.address, to: call.to ?? null, data: call.data, value: value.toString(), nonce, hash, gas: gas.toString(), maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString() };
    await save(path + ".json", op);
  }
  let receipt: TransactionReceipt | undefined;
  try { receipt = await client.getTransactionReceipt({ hash: op.hash }); } catch { /* Read-back can precede the first broadcast. */ }
  if (!receipt) {
    const raw = hex((await readFile(`${VAULT}/signed/${op.hash}.txt`, "utf8")).trim());
    if (keccak256(raw) !== op.hash) throw Error("Retained signed transaction changed");
    try { await client.sendRawTransaction({ serializedTransaction: raw }); } catch {
      // Reconcile the same signed hash, including an already-known response. Never allocate a replacement nonce.
    }
    receipt = await client.waitForTransactionReceipt({ hash: op.hash, timeout: 60000, confirmations: 1 });
  }
  await finalized(receipt);
  await save(path + "-receipt.json", receipt);
  if (receipt.status !== "success") throw Error(`Confirmed transaction reverted: ${id} ${op.hash}`);
  return receipt;
}

export async function releaseBytecode() {
  const file = record(await readJson("contracts/release-out/BusinessKernel.sol/BusinessKernel.json"));
  const runtime = hex(record(file.deployedBytecode).object);
  if (normalizedRuntimeHash(runtime) !== RELEASE_ID.normalizedRuntimeHash) throw Error("Release bytecode differs from the reviewed runtime");
  return hex(record(file.bytecode).object);
}
export async function deploy(label: string) {
  if (!labels.includes(label)) throw Error("Unknown canonical instance");
  const data = encodeDeployData({ abi: KERNEL_ABI, bytecode: await releaseBytecode(), args: [TOKEN, actor(`${label}-1`).address] });
  const receipt = await send(`${label}-deploy`, "master", { data });
  if (!receipt.contractAddress) throw Error("Deployment did not create a contract");
  const code = await client.getBytecode({ address: receipt.contractAddress });
  if (!code || normalizedRuntimeHash(code) !== RELEASE_ID.normalizedRuntimeHash) throw Error("Deployed runtime differs from reviewed release");
  return receipt;
}

export async function prepareFunding() {
  await initialize();
  const master = actor("master").address;
  const balance = await client.getBalance({ address: master });
  const request = { version: 1, kind: "testnet-rehearsal-funding", chainId: 5042002, from: USER, to: TOKEN, recipient: master, amountMicroUSDC: "30000000", value: "0x0", data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [master, 30000000n] }), sourceSha256: RELEASE_ID.sourceSha256, scope: "Thirty test USDC to the isolated rehearsal wallet for three reviewed contract instances, controlled demo actors and gas. Private test keys remain outside the project and exports.", masterNativeWei: balance.toString() };
  await save(DIR + "/funding-request.json", request);
  await mkdir("public/rehearsal", { recursive: true });
  await save("public/rehearsal/funding-request.json", request);
  return request;
}

export async function actorRows() {
  const rows = array(await readJson(DIR + "/actors.json"));
  return rows.map(row => { const x = record(row); return { name: text(x.name), address: address(x.address) }; });
}

if (import.meta.main) {
  // Initialization creates test-only keys once. It never signs or broadcasts a transaction.
  if (process.argv[2] !== "prepare") throw Error("Usage: bun run scripts/arc-testnet-support.ts prepare");
  console.log(json(await prepareFunding()));
}
