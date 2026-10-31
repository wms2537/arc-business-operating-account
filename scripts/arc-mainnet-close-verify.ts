/** Read-only verification of the human-approved app close. Never reads keys or broadcasts. */
import { readFile, writeFile } from "node:fs/promises";
import { createPublicClient, encodeFunctionData, erc20Abi, formatUnits, parseEventLogs } from "viem";
import { isolatedArcRpcTransport } from "../src/lib/arc-rpc";
import { address, hash, integer, json, record, sameAddress, uint } from "../src/lib/boundary";
import { parseManifest, validateDeployment } from "../src/lib/deployment";
import { readAccount, readPlan } from "../src/lib/kernel-client";
import { KERNEL_ABI } from "../src/lib/kernel-abi";

const DATA = "docs/evidence/arc-mainnet/rehearsal";
const OWNER = address("0x40e4CCd3Db59580b23F5dB16e1F9e1BCf6d2Bf8E");
const SUPPLIER = address("0x088617967558E3Caa312932C78460fab9249C9a0");
const TOKEN = address("0x3600000000000000000000000000000000000000");
const TERMS = hash("0xef003bca666fe7cf68ebbc662de492b182a1dba1a3398fa1b844b56ede866cdc");
const client = createPublicClient({ transport: isolatedArcRpcTransport("https://rpc.blockdaemon.mainnet.arc.io") });
const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));
const checks: { name: string; actual: unknown; expected: unknown }[] = [];
function equal(name: string, actual: unknown, expected: unknown) {
  if (json(actual) !== json(expected)) throw Error(`${name}: ${json(actual)} != ${json(expected)}`);
  checks.push({ name, actual, expected });
}

async function main() {
  const transactionHash = hash(process.argv[2]);
  const expectedNonce = integer(Number(process.argv[3]));
  const manifest = parseManifest(await readJson(`${DATA}/cp-manifest.json`));
  equal("configured chain", manifest.chainId, 5042);
  equal("configured kernel", manifest.kernelAddress.toLowerCase(), "0xc7e3f2c1982207948147b6aa156a819eb826941d");
  equal("RPC chain", await client.getChainId(), 5042);
  await validateDeployment(client, manifest);
  const [tx, receipt, finalized] = await Promise.all([
    client.getTransaction({ hash: transactionHash }), client.getTransactionReceipt({ hash: transactionHash }), client.getBlock({ blockTag: "finalized" }),
  ]);
  equal("transaction chain", tx.chainId, 5042);
  equal("approved signer", sameAddress(tx.from, OWNER), true);
  equal("exact kernel target", tx.to !== null && sameAddress(tx.to, manifest.kernelAddress), true);
  equal("exact call", tx.input, encodeFunctionData({ abi: KERNEL_ABI, functionName: "commitPlan", args: [1n] }));
  equal("native value", tx.value, 0n);
  equal("reviewed nonce", tx.nonce, expectedNonce);
  equal("gas within ceiling", tx.gas <= 900000n, true);
  equal("fee within ceiling", tx.maxFeePerGas !== null && tx.maxFeePerGas !== undefined && tx.maxFeePerGas <= 32000000000n, true);
  equal("tip within ceiling", tx.maxPriorityFeePerGas !== null && tx.maxPriorityFeePerGas !== undefined && tx.maxPriorityFeePerGas <= 1000000000n, true);
  equal("transaction succeeded", receipt.status, "success");
  equal("transaction finalized", receipt.blockNumber <= finalized.number, true);
  equal("canonical receipt", (await client.getBlock({ blockNumber: receipt.blockNumber })).hash, receipt.blockHash);
  const fee = receipt.gasUsed * receipt.effectiveGasPrice;
  equal("actual fee within close cap", fee <= 28800000000000000n, true);
  const committed = parseEventLogs({ abi: KERNEL_ABI, logs: receipt.logs, eventName: "PlanCommitted" }).filter(e => sameAddress(e.address, manifest.kernelAddress));
  equal("one close event", committed.length, 1);
  equal("exact close effects", committed.map(e => e.args), [{ planId: 1n, termsHash: TERMS, goodsPayout: 90000n, freightPayout: 0n, totalPrincipal: 45000n }]);
  const transfers = parseEventLogs({ abi: erc20Abi, logs: receipt.logs, eventName: "Transfer" }).filter(e => sameAddress(e.address, TOKEN));
  equal("exact token transfers", transfers.map(e => ({ from: e.args.from.toLowerCase(), to: e.args.to.toLowerCase(), value: e.args.value })), [{ from: manifest.kernelAddress.toLowerCase(), to: SUPPLIER.toLowerCase(), value: 90000n }]);
  const before = receipt.blockNumber - 1n, after = receipt.blockNumber;
  equal("pre-close plan", (await readPlan(client, manifest.kernelAddress, 1n, before)).status, "Open");
  equal("post-close plan", (await readPlan(client, manifest.kernelAddress, 1n, after)).status, "Committed");
  const principal = [16000n, 16500n, 12500n];
  for (let index = 0; index < 3; index++) {
    const id = BigInt(index + 1), account = await readAccount(client, manifest.kernelAddress, id, after);
    equal(`buyer ${id} claims and principal`, { cash: account.cash, floor: account.floor, held: account.aggregateHeld, active: account.activePlanCount, principal: account.outstandingPrincipal, available: account.availableCash }, { cash: 10000n, floor: 10000n, held: 0n, active: 0n, principal: principal[index], available: 0n });
    equal(`loan ${id}`, await client.readContract({ address: manifest.kernelAddress, abi: KERNEL_ABI, functionName: "getLoan", args: [id], blockNumber: after }), [1n, id, 1n, principal[index], principal[index]]);
  }
  const pool = await client.readContract({ address: manifest.kernelAddress, abi: KERNEL_ABI, functionName: "getPool", args: [1n], blockNumber: after });
  equal("remaining pool cash and reservations", [pool[1], pool[2]], [5000n, 0n]);
  equal("accounted custody", await client.readContract({ address: manifest.kernelAddress, abi: KERNEL_ABI, functionName: "accountedCustody", blockNumber: after }), 35000n);
  const native = async (who: `0x${string}`, blockNumber: bigint) => client.getBalance({ address: who, blockNumber });
  const token = async (who: `0x${string}`, blockNumber: bigint) => client.readContract({ address: TOKEN, abi: erc20Abi, functionName: "balanceOf", args: [who], blockNumber });
  equal("supplier native USDC increase", await native(SUPPLIER, after) - await native(SUPPLIER, before), 90000000000000000n);
  equal("supplier token USDC increase", await token(SUPPLIER, after) - await token(SUPPLIER, before), 90000n);
  equal("remaining native custody", await native(manifest.kernelAddress, after), 35000000000000000n);
  equal("remaining token custody", await token(manifest.kernelAddress, after), 35000n);
  const setup = record(await readJson(`${DATA}/setup-independent-verification.json`));
  const totalGas = uint(setup.actorFeesNativeWei) + uint(setup.fundingFeeNativeWei) + fee;
  equal("total gas within approved allocation", totalGas <= 525000000000000000n, true);
  equal("business capital plus all gas within budget", 225000000000000000n + totalGas <= 750000000000000000n, true);
  const result = { status: "mainnet-close-independently-verified", transactionHash, expectedNonce, chainId: 5042, kernel: manifest.kernelAddress, block: after, blockHash: receipt.blockHash, finalizedThrough: finalized.number, feeUSDC: formatUnits(fee, 18), totalGasUSDC: formatUnits(totalGas, 18), principalOutstandingMicroUSDC: "45000", checks, verifiedAt: new Date().toISOString(), privateVaultAccessed: false, transactionsSent: 0 };
  await writeFile(`${DATA}/app-close-receipt.json`, json(receipt) + "\n");
  await writeFile(`${DATA}/app-close-verification.json`, json(result) + "\n");
  console.log(json({ status: result.status, checks: checks.length, transactionHash, feeUSDC: result.feeUSDC, totalGasUSDC: result.totalGasUSDC }));
}
if (import.meta.main) await main();
