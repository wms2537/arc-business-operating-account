import { encodeFunctionData, decodeEventLog, erc20Abi } from "viem";
import { client, DIR, USER, TOKEN, actor, initialize, send, save, readJson, exists, finalized } from "./arc-testnet-support";
import { KERNEL_ABI } from "../src/lib/kernel-abi";
import { parseManifest } from "../src/lib/deployment";
import { record, hash, json, sameAddress } from "../src/lib/boundary";

const mode = process.argv[2];
if (mode === "leave" || mode === "rejoin") await initialize();
else if (await client.getChainId() !== 5042002) throw Error("Wallet verification must use Arc Testnet");
if (record(await readJson(`${DIR}/independent-chain-verification.json`)).status !== "passed") throw Error("Verify all baseline evidence first");
const manifest = parseManifest(await readJson(`${DIR}/mixed-manifest.json`));
const kernel = manifest.kernelAddress;
const options = { address: kernel, abi: KERNEL_ABI };
const input = (name: "joinBuyer" | "leaveBuyer") => encodeFunctionData({ abi: KERNEL_ABI, functionName: name, args: [2n, 2n] });

if (mode === "leave" || mode === "rejoin") {
  const artifact = `${DIR}/wallet-ui-${mode}.json`;
  if (await exists(artifact)) { console.log("RETAINED_UI_PREPARATION", mode, json(await readJson(artifact))); process.exit(0); }
  const owner = await client.readContract({ ...options, functionName: "getAccount", args: [4n] });
  if (!sameAddress(owner[0], actor("mixed-8").address)) throw Error("Buyer C identity changed");
  const receipt = await send(`mixed-ui-${mode}-c`, "mixed-8", { to: kernel, data: input(mode === "leave" ? "leaveBuyer" : "joinBuyer") });
  const block = receipt.blockNumber;
  const participation = await Promise.all([0n, 1n, 2n].map(index => client.readContract({ ...options, functionName: "getBuyerParticipation", args: [2n, index], blockNumber: block })));
  const joinedUnits = participation.reduce((total, part, i) => total + (part[0] ? [40n, 35n, 25n][i] : 0n), 0n);
  const readiness = await client.readContract({ ...options, functionName: "planReadiness", args: [2n], blockNumber: block });
  if (joinedUnits !== (mode === "leave" ? 75n : 100n) || readiness[0] !== (mode === "rejoin")) throw Error("UI preparation differs from the required readiness state");
  for (const id of [2n, 3n, 4n]) {
    const account = await client.readContract({ ...options, functionName: "getAccount", args: [id], blockNumber: block });
    if (account[5] !== 0n) throw Error("Joining must not create principal");
  }
  const report = { status: "passed", deployment: manifest.instanceId, kernel, planId: "2", transaction: receipt.transactionHash, block: block.toString(), joinedUnits: joinedUnits.toString(), ready: readiness[0], reason: readiness[1], principalBeforeClose: "0" };
  await save(artifact, report); console.log(json(report));
} else if (mode === "record") {
  const txHash = hash(process.argv[3]);
  const [tx, receipt] = await Promise.all([client.getTransaction({ hash: txHash }), client.getTransactionReceipt({ hash: txHash })]);
  const expected = encodeFunctionData({ abi: KERNEL_ABI, functionName: "commitPlan", args: [2n] });
  if (!sameAddress(tx.from, USER) || !tx.to || !sameAddress(tx.to, kernel) || tx.input !== expected || tx.value !== 0n || receipt.status !== "success") throw Error("Wallet transaction does not match the reviewed group close");
  await finalized(receipt);
  const path = `${DIR}/operations/mixed-wallet-close`;
  if (await exists(path + ".json")) {
    if (record(await readJson(path + ".json")).hash !== txHash) throw Error("An existing wallet close cannot be replaced");
  } else await save(path + ".json", { id: "mixed-wallet-close", actor: "metamask-operator", from: tx.from, to: tx.to, data: tx.input, value: tx.value.toString(), nonce: tx.nonce, hash: txHash, gas: tx.gas.toString(), maxFeePerGas: (tx.maxFeePerGas ?? tx.gasPrice ?? 0n).toString(), maxPriorityFeePerGas: (tx.maxPriorityFeePerGas ?? 0n).toString(), source: "MetaMask transaction through the application review and intent flow" });
  await save(path + "-receipt.json", receipt);
  const supplier = manifest.entities.find(entity => entity.id === "supplier");
  if (!supplier) throw Error("Supplier identity is missing");
  let payout = 0n;
  for (const log of receipt.logs) {
    if (!sameAddress(log.address, TOKEN) || log.topics[0] !== "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef") continue;
    const event = decodeEventLog({ abi: erc20Abi, eventName: "Transfer", topics: log.topics, data: log.data });
    if (sameAddress(event.args.from, kernel) && sameAddress(event.args.to, supplier.address)) payout += event.args.value;
  }
  if (payout !== 900000n) throw Error("Wallet close did not pay the exact supplier amount");
  const pool = await client.readContract({ ...options, functionName: "getPool", args: [1n], blockNumber: receipt.blockNumber });
  if (pool[1] !== 1500000n || pool[2] !== 0n) throw Error("Wallet close pool balances differ from approved terms");
  const buyers = [];
  for (const [i, id] of [2n, 3n, 4n].entries()) {
    const row = await client.readContract({ ...options, functionName: "getAccount", args: [id], blockNumber: receipt.blockNumber });
    if (row[1] !== 100000n || row[5] !== [160000n, 165000n, 125000n][i]) throw Error("Wallet close changed protected cash or principal terms");
    buyers.push({ accountId: id.toString(), protectedCashMicroUSDC: row[1].toString(), principalMicroUSDC: row[5].toString() });
  }
  const report = { status: "passed", chainId: 5042002, deployment: manifest.instanceId, kernel, from: USER, transaction: txHash, nonce: tx.nonce, block: receipt.blockNumber.toString(), supplierPayoutMicroUSDC: payout.toString(), lenderCashMicroUSDC: pool[1].toString(), totalPrincipalMicroUSDC: "450000", buyers, gasFeeNativeWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(), scope: "Additional live UI settlement after the completed contention baseline. Its 0.45 test-USDC principal remains outstanding for the live demonstration; the separate canonical CO and CP baselines repaid all principal." };
  await save(`${DIR}/wallet-ui-close.json`, report); console.log(json(report));
} else throw Error("Usage: leave | rejoin | record <hash>");
