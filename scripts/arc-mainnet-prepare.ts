import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, readFile, writeFile, chmod, access } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createPublicClient, encodeDeployData, erc20Abi, toBytes, type Address } from "viem";
import { arc } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arcRpcTransport } from "../src/lib/arc-rpc";
import { KERNEL_ABI, RELEASE_ID } from "../src/lib/kernel-abi";
import { normalizedRuntimeHash } from "../src/lib/deployment";
import { address, hex, record, integer, json, sameAddress } from "../src/lib/boundary";

import { MAINNET_DEMO_OWNER, MAINNET_CLOSE_LIMITS } from "../src/lib/mainnet-demo";
export const OWNER = MAINNET_DEMO_OWNER;
export const TOKEN = address("0x3600000000000000000000000000000000000000");
export const RPC = "https://rpc.blockdaemon.mainnet.arc.io";
export const DATA = "docs/evidence/arc-mainnet/rehearsal";
export const VAULT = join(homedir(), ".local", "share", "arc-business-operating-account", "mainnet-5042-v1");
export const TOTAL_CAP = 750000000000000000n;
export const ACTOR_FUNDING = 650000000000000000n;
export const CAPITAL = 225000000000000000n;
export const ACTOR_GAS_CAP = ACTOR_FUNDING - CAPITAL;
export const MAX_FEE = MAINNET_CLOSE_LIMITS.maxFeePerGas;
export const TIP = MAINNET_CLOSE_LIMITS.maxPriorityFeePerGas;
export const FUNDING_GAS_LIMIT = 30000n;
export const CLOSE_GAS_LIMIT = MAINNET_CLOSE_LIMITS.gas;
export const ROLES = ["master", "cp-0", "cp-1", "cp-2", "cp-3", "cp-4", "cp-6", "cp-7"];
export type PublicActor = { name: string; address: Address };
export const client = createPublicClient({ chain: arc, transport: arcRpcTransport(RPC) });
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
export async function exists(path: string) { try { await access(path); return true; } catch { return false; } }
export async function readJson(path: string): Promise<unknown> { return JSON.parse(await readFile(path, "utf8")); }
export function gasLimit(estimate: bigint) { return (estimate * 110n + 99n) / 100n + 10000n; }
export function checkBudget({ estimate, gasPrice, baseFee, ownerBalance }: { estimate: bigint; gasPrice: bigint; baseFee: bigint; ownerBalance: bigint }) {
  if (estimate <= 0n || estimate > 9000000n) throw Error("Invalid deployment estimate");
  if (gasPrice > MAX_FEE || baseFee + TIP > MAX_FEE) throw Error("Network fee exceeds the approved fee ceiling");
  const deploymentGas = gasLimit(estimate), deploymentFeeCap = deploymentGas * MAX_FEE;
  if (deploymentFeeCap > 200000000000000000n) throw Error("Deployment exceeds its 0.20 USDC gas limit");
  const directWalletFees = (FUNDING_GAS_LIMIT + CLOSE_GAS_LIMIT) * MAX_FEE;
  if (ACTOR_FUNDING + directWalletFees > TOTAL_CAP) throw Error("Funding and wallet fees exceed the total cap");
  if (ownerBalance < TOTAL_CAP) throw Error("Owner balance is below the approved total cap");
  return { deploymentGas, deploymentFeeCap, directWalletFees, maxOwnerOutflow: ACTOR_FUNDING + directWalletFees };
}
export function publicPlan(actors: PublicActor[]) {
  if (actors.length !== ROLES.length || new Set(actors.map(a => a.name)).size !== ROLES.length || new Set(actors.map(a => a.address.toLowerCase())).size !== ROLES.length) throw Error("Actor identities are incomplete or duplicated");
  if (actors.some(a => !ROLES.includes(a.name) || sameAddress(a.address, OWNER))) throw Error("Unexpected actor identity");
  const master = actors.find(a => a.name === "master"); if (!master) throw Error("Missing master identity");
  const plan = { version: 1, chainId: 5042, project: "46704d22-91ee-404d-8ff7-7ad873e3c289", owner: OWNER, totalCapNativeWei: TOTAL_CAP.toString(), fundingNativeWei: ACTOR_FUNDING.toString(), capitalMicroUSDC: "225000", actorGasCapNativeWei: ACTOR_GAS_CAP.toString(), maxFeePerGas: MAX_FEE.toString(), maxPriorityFeePerGas: TIP.toString(), sourceSha256: RELEASE_ID.sourceSha256, actors, group: { units: [40,35,25], unitPriceMicroUSDC: "900", cashMicroUSDC: ["20000","15000","10000"], principalMicroUSDC: ["16000","16500","12500"], protectedEachMicroUSDC: "10000", poolOpeningMicroUSDC: "50000", externalPayerOpeningMicroUSDC: "100000" }, funding: { from: OWNER, to: master.address, value: ACTOR_FUNDING.toString(), data: "0x", gas: FUNDING_GAS_LIMIT.toString() }, scope: "Dedicated owner-controlled mainnet group demo. This file is a proposal, not a signature or broadcast authorization." };
  return { ...plan, planSha256: sha(json(plan)) };
}
export async function reviewedBytecode() {
  const artifact = record(await readJson("release/business-kernel.json"));
  if (sha(await readFile("contracts/BusinessKernel.sol")) !== RELEASE_ID.sourceSha256 || sha(await readFile("contracts/IBusinessKernel.sol")) !== RELEASE_ID.interfaceSha256) throw Error("Reviewed contract source changed");
  const bytecode = hex(artifact.bytecode), runtime = hex(artifact.deployedBytecode);
  if (sha(toBytes(bytecode)) !== artifact.creationSha256 || artifact.creationSha256 !== "6c27cfebaf0df19bb6442eac77ef8527e4a02afe2aae03b5f72956f404313880") throw Error("Creation bytecode differs from the reviewed artifact");
  if (normalizedRuntimeHash(runtime) !== RELEASE_ID.normalizedRuntimeHash) throw Error("Runtime differs from the reviewed artifact");
  const proof = record(await readJson("release/arc-vm-verification.json"));
  if (proof.status !== "passed" || integer(record(proof.tests).Success) !== 177 || proof.sameReviewedRuntime !== true || proof.sameSources !== true) throw Error("Arc VM release proof is missing");
  return bytecode;
}
async function humanPrepare() {
  if (process.platform !== "darwin" || process.cwd() === "/home/user/app") throw Error("Prepare these mainnet identities on the owner's Mac, not in a cloud sandbox");
  if (!stdin.isTTY || !stdout.isTTY) throw Error("Run this preparation interactively in your own terminal");
  console.log("This creates dedicated UNFUNDED demo wallets. It does not request a signature or send a transaction.");
  console.log("Private keys stay outside this repository at: " + VAULT);
  console.log("Keep that folder private and retain it to recover the demo accounts. Never enter your MetaMask seed or key.");
  const terminal = createInterface({ input: stdin, output: stdout });
  let confirmation: string;
  try { confirmation = await terminal.question("Type PREPARE to create or retain those identities: "); } finally { terminal.close(); }
  if (confirmation !== "PREPARE") throw Error("Preparation cancelled; no new identities created");
  await mkdir(VAULT, { recursive: true, mode: 0o700 }); await chmod(VAULT, 0o700);
  await mkdir(DATA, { recursive: true });
  const file = join(VAULT, "actors.json");
  if (!(await exists(file))) {
    if (await exists(DATA + "/actors.json")) throw Error("Private vault is missing; never replace existing demo identities");
    const privateKeys = Object.fromEntries(ROLES.map(name => [name, generatePrivateKey()]));
    await writeFile(file, json({ owner: OWNER, chainId: 5042, privateKeys }) + "\n", { mode: 0o600, flag: "wx" });
  }
  await chmod(file, 0o600);
  const vault = record(await readJson(file));
  if (vault.chainId !== 5042 || !sameAddress(address(vault.owner), OWNER)) throw Error("Vault owner/network mismatch");
  const values = record(vault.privateKeys);
  const actors = ROLES.map(name => ({ name, address: privateKeyToAccount(hex(values[name])).address }));
  const plan = publicPlan(actors);
  if (await exists(DATA + "/plan.json")) {
    const existing = record(await readJson(DATA + "/plan.json"));
    if (existing.planSha256 !== plan.planSha256) throw Error("An existing plan cannot silently change terms or identities");
  }
  await writeFile(DATA + "/actors.json", json(actors) + "\n", { mode: 0o600 });
  await writeFile(DATA + "/plan.json", json(plan) + "\n", { mode: 0o600 });
  if (await client.getChainId() !== 5042) throw Error("RPC is not Arc mainnet");
  if (await client.readContract({ address: TOKEN, abi: erc20Abi, functionName: "decimals" }) !== 6) throw Error("USDC precision mismatch");
  const master = actors.find(a => a.name === "master"), lender = actors.find(a => a.name === "cp-1");
  if (!master || !lender) throw Error("Missing actor");
  const [balance, nonce, code] = await Promise.all([client.getBalance({ address: master.address }),client.getTransactionCount({ address: master.address, blockTag: "pending" }),client.getBytecode({ address: master.address })]);
  if (balance !== 0n || nonce !== 0 || (code && code !== "0x")) {
    await writeFile(DATA + "/prepare-status.json", json({ status: "reconcile-existing-activity", master: master.address, noNewFundingRequest: true }) + "\n");
    throw Error("These actors already have activity. Reconcile it; do not fund again.");
  }
  const data = encodeDeployData({ abi: KERNEL_ABI, bytecode: await reviewedBytecode(), args: [TOKEN, lender.address] });
  const [estimate, gasPrice, block, ownerBalance] = await Promise.all([client.estimateGas({ account: OWNER, data }),client.getGasPrice(),client.getBlock({ blockTag: "latest" }),client.getBalance({ address: OWNER })]);
  if (block.baseFeePerGas === null) throw Error("Mainnet base fee unavailable");
  const checked = checkBudget({ estimate, gasPrice, baseFee: block.baseFeePerGas, ownerBalance });
  const request = { status: "ready-for-owner-review", planSha256: plan.planSha256, chainId: 5042, ...plan.funding, maxFeePerGas: MAX_FEE.toString(), maxPriorityFeePerGas: TIP.toString(), sourceSha256: RELEASE_ID.sourceSha256, fromBlock: block.number.toString(), preparedAt: new Date().toISOString(), deploymentEstimateGas: estimate.toString(), ...checked, noTransactionsSent: true, next: "Review the request. A human must authorize the funding transaction in MetaMask. Do not run any setup or send money just because this file exists." };
  await writeFile(DATA + "/funding-request.json", json(request) + "\n", { mode: 0o600 });
  console.log(json({ status: request.status, planSha256: plan.planSha256, fundTo: master.address, fundingUSDC: "0.650000", maximumTotalUSDC: "0.750000", businessCapitalUSDC: "0.225000", actorGasReserveUSDC: "0.425000", deploymentEstimateGas: estimate.toString(), deploymentMaxFeeUSDC: (Number(checked.deploymentFeeCap)/1e18).toFixed(6), noTransactionsSent: true, requestFile: resolve(DATA + "/funding-request.json") }));
}
if (import.meta.main) {
  if (process.argv[2] !== "prepare") throw Error("Usage: bun run scripts/arc-mainnet-prepare.ts prepare");
  await humanPrepare();
}
