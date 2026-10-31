import { readdir } from "node:fs/promises";
import { decodeEventLog, decodeFunctionData, erc20Abi, type Address, type TransactionReceipt } from "viem";
import { client, TOKEN, USER, DIR, actorRows, readJson, save, exists } from "./arc-testnet-support";
import { record, array, address, hash, text, uint, integer, json, sameAddress } from "../src/lib/boundary";
import { parseManifest, validateDeployment } from "../src/lib/deployment";
import { KERNEL_ABI } from "../src/lib/kernel-abi";

const SYSTEM = address("0xfffffffffffffffffffffffffffffffffffffffe");
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const checks: { name: string; actual: unknown; expected: unknown; status: "passed" }[] = [];
function equal(name: string, actual: unknown, expected: unknown) {
  if (json(actual) !== json(expected)) throw Error(`${name}: expected ${json(expected)}, received ${json(actual)}`);
  checks.push({ name, actual, expected, status: "passed" });
}
function movements(receipt: TransactionReceipt, emitter: Address) {
  return receipt.logs.filter(log => sameAddress(log.address, emitter) && log.topics[0] === TRANSFER).map(log => {
    const event = decodeEventLog({ abi: erc20Abi, eventName: "Transfer", data: log.data, topics: log.topics });
    return { from: event.args.from, to: event.args.to, value: event.args.value, logIndex: log.logIndex };
  });
}
const pairKey = (from: Address, to: Address, value: bigint) => `${from.toLowerCase()}:${to.toLowerCase()}:${value}`;
function paired(receipt: TransactionReceipt) {
  const native = movements(receipt, SYSTEM), token = movements(receipt, TOKEN);
  const counts = new Map<string, number>();
  for (const event of native) { const key = pairKey(event.from, event.to, event.value); counts.set(key, (counts.get(key) ?? 0) + 1); }
  for (const event of token) {
    const key = pairKey(event.from, event.to, event.value * 1000000000000n), remaining = counts.get(key) ?? 0;
    equal(`paired native/erc20 event ${receipt.transactionHash}:${event.logIndex}`, remaining > 0, true);
    counts.set(key, remaining - 1);
  }
  return token.length;
}

if (await client.getChainId() !== 5042002) throw Error("Verification RPC must be Arc Testnet");
const anchor = await client.getBlock({ blockTag: "finalized" });
const opening = record(await readJson(`${DIR}/native-opening.json`));
const openingBlock = BigInt(text(opening.block));
equal("native opening is canonical", (await client.getBlock({ blockNumber: openingBlock })).hash, opening.hash);
const initial = new Map(array(opening.balances).map(value => { const row = record(value); return [address(row.address).toLowerCase(), uint(row.nativeWei)] satisfies [string, bigint]; }));
const deltas = new Map<string, bigint>();
const fees = new Map<string, bigint>();
const operatorReceipts: TransactionReceipt[] = [];
const mixedManifest = parseManifest(await readJson(`${DIR}/mixed-manifest.json`));
const receipts: { id: string; hash: string; block: string; gasUsed: string; effectiveGasPrice: string; gasFeeNativeWei: string; pairedTransfers: number }[] = [];
let totalFees = 0n, pairs = 0;
const files = (await readdir(`${DIR}/operations`)).filter(name => name.endsWith(".json") && !name.endsWith("-receipt.json")).sort();
for (const file of files) {
  const op = record(await readJson(`${DIR}/operations/${file}`)), txHash = hash(op.hash);
  const tx = await client.getTransaction({ hash: txHash }), receipt = await client.getTransactionReceipt({ hash: txHash });
  equal(`successful receipt ${file}`, receipt.status, "success");
  equal(`finalized receipt ${file}`, receipt.blockNumber <= anchor.number, true);
  equal(`receipt follows native opening ${file}`, receipt.blockNumber > openingBlock, true);
  equal(`sender bound ${file}`, tx.from.toLowerCase(), address(op.from).toLowerCase());
  equal(`target bound ${file}`, tx.to?.toLowerCase() ?? null, op.to === null ? null : address(op.to).toLowerCase());
  equal(`calldata bound ${file}`, tx.input, op.data);
  equal(`value bound ${file}`, tx.value.toString(), op.value);
  equal(`nonce bound ${file}`, tx.nonce, op.nonce);
  equal(`block identity bound ${file}`, tx.blockHash, receipt.blockHash);
  for (const move of movements(receipt, SYSTEM)) {
    const from = move.from.toLowerCase(), to = move.to.toLowerCase();
    deltas.set(from, (deltas.get(from) ?? 0n) - move.value); deltas.set(to, (deltas.get(to) ?? 0n) + move.value);
  }
  const fee = receipt.gasUsed * receipt.effectiveGasPrice, from = receipt.from.toLowerCase();
  fees.set(from, (fees.get(from) ?? 0n) + fee);
  if (initial.has(from)) totalFees += fee;
  else {
    equal(`external fee payer is the approved MetaMask operator ${file}`, from, USER.toLowerCase());
    equal(`operator target is the mixed kernel ${file}`, tx.to?.toLowerCase(), mixedManifest.kernelAddress.toLowerCase());
    const call = decodeFunctionData({ abi: KERNEL_ABI, data: tx.input });
    if (call.functionName !== "commitPlan") throw Error("Unexpected operator action in rehearsal evidence");
    equal(`operator closes the approved group ${file}`, call.args[0], 2n);
    equal(`operator transfers no native value ${file}`, tx.value, 0n);
    operatorReceipts.push(receipt);
  }
  const count = paired(receipt); pairs += count;
  receipts.push({ id: text(op.id), hash: txHash, block: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: receipt.effectiveGasPrice.toString(), gasFeeNativeWei: fee.toString(), pairedTransfers: count });
}
equal("actual Arc paired events were observed", pairs > 0, true);
let openingTotal = 0n, finalTotal = 0n;
const eoa = [];
for (const row of await actorRows()) {
  const key = row.address.toLowerCase(), start = initial.get(key);
  if (start === undefined) throw Error("An actor has no native opening balance");
  const finish = await client.getBalance({ address: row.address, blockNumber: anchor.number });
  const token = await client.readContract({ address: TOKEN, abi: erc20Abi, functionName: "balanceOf", args: [row.address], blockNumber: anchor.number });
  const transferDelta = deltas.get(key) ?? 0n, fee = fees.get(key) ?? 0n;
  equal(`native balance reconciles transfers and gas ${row.name}`, finish - start, transferDelta - fee);
  equal(`ERC20 is the same asset at six decimals ${row.name}`, token, finish / 1000000000000n);
  openingTotal += start; finalTotal += finish;
  eoa.push({ ...row, openingNativeWei: start.toString(), finalNativeWei: finish.toString(), netNativeTransfers: transferDelta.toString(), receiptFeesNativeWei: fee.toString(), erc20MicroUSDC: token.toString() });
}
const deployments = [];
for (const label of ["co", "cp", "mixed"]) {
  if (!(await exists(`${DIR}/${label}-phase-recovery.json`))) throw Error(`The ${label} lifecycle is incomplete`);
  const manifest = parseManifest(await readJson(`${DIR}/${label}-manifest.json`)); await validateDeployment(client, manifest);
  const book = record(await readJson(`${DIR}/${label}-books.json`)), progress = record(book.progress), at = BigInt(integer(progress.height));
  equal(`final book block is canonical ${label}`, (await client.getBlock({ blockNumber: at })).hash, progress.hash);
  const pool = await client.readContract({ address: manifest.kernelAddress, abi: KERNEL_ABI, functionName: "getPool", args: [1n], blockNumber: at });
  equal(`canonical final lender cash ${label}`, pool[1], label === "co" ? 2000000n : label === "cp" ? 500000n : 1950000n);
  for (const account of manifest.opening.accounts) {
    const current = await client.readContract({ address: manifest.kernelAddress, abi: KERNEL_ABI, functionName: "getAccount", args: [BigInt(account.id)], blockNumber: at });
    equal(`canonical account cash ${label}/${account.id}`, current[1], label === "co" ? 6500000n : label === "cp" ? 100000n : BigInt(account.cash));
    equal(`canonical principal ${label}/${account.id}`, current[5], 0n);
  }
  const custody = await client.readContract({ address: manifest.kernelAddress, abi: KERNEL_ABI, functionName: "accountedCustody", blockNumber: anchor.number });
  const native = await client.getBalance({ address: manifest.kernelAddress, blockNumber: anchor.number });
  equal(`kernel native custody equals accounted USDC ${label}`, native, custody * 1000000000000n);
  finalTotal += native;
  deployments.push({ label, kernel: manifest.kernelAddress, deploymentTransaction: manifest.deploymentTransaction, instanceId: manifest.instanceId, finalBookBlock: at.toString(), finalBookHash: progress.hash, custodyMicroUSDC: custody.toString() });
}
equal("controlled-actor assets conserve the initial 30 USDC after their own actual gas fees", finalTotal + totalFees, openingTotal);
const operator = [];
for (const receipt of operatorReceipts) {
  const before = await client.getBalance({ address: USER, blockNumber: receipt.blockNumber - 1n });
  const after = await client.getBalance({ address: USER, blockNumber: receipt.blockNumber });
  const block = await client.getBlock({ blockNumber: receipt.blockNumber, includeTransactions: true });
  equal("one operator transaction in the close block", block.transactions.filter(tx => sameAddress(tx.from, USER)).map(tx => tx.hash), [receipt.transactionHash]);
  const fee = receipt.gasUsed * receipt.effectiveGasPrice;
  equal("operator wallet pays only the actual close fee", after - before, -fee);
  const options = { address: mixedManifest.kernelAddress, abi: KERNEL_ABI, blockNumber: receipt.blockNumber };
  const pool = await client.readContract({ ...options, functionName: "getPool", args: [1n] });
  equal("live UI close leaves 1.50 in lender cash", pool[1], 1500000n);
  equal("live UI close consumes reservations once", pool[2], 0n);
  for (const [i, accountId] of [2n, 3n, 4n].entries()) {
    const account = await client.readContract({ ...options, functionName: "getAccount", args: [accountId] });
    equal(`live UI protected cash ${accountId}`, account[1], 100000n);
    equal(`live UI principal ${accountId}`, account[5], [160000n, 165000n, 125000n][i]);
  }
  operator.push({ hash: receipt.transactionHash, signer: USER, block: receipt.blockNumber.toString(), beforeNativeWei: before.toString(), afterNativeWei: after.toString(), actualFeeNativeWei: fee.toString() });
}
equal("one real application wallet close", operator.length, 1);

const fundingSaved = record(await readJson(`${DIR}/funding-receipt.json`)), fundingHash = hash(fundingSaved.transactionHash);
const funding = await client.getTransactionReceipt({ hash: fundingHash });
equal("real MetaMask funding sender", funding.from.toLowerCase(), USER.toLowerCase());
equal("real MetaMask funding receipt success", funding.status, "success"); paired(funding);
const fundingBefore = await client.getBalance({ address: USER, blockNumber: funding.blockNumber - 1n });
const fundingAfter = await client.getBalance({ address: USER, blockNumber: funding.blockNumber });
const fundingBlock = await client.getBlock({ blockNumber: funding.blockNumber, includeTransactions: true });
const userTransactions = fundingBlock.transactions.filter(tx => sameAddress(tx.from, USER));
equal("funding block has one operator transaction", userTransactions.map(tx => tx.hash), [fundingHash]);
const fundingFee = funding.gasUsed * funding.effectiveGasPrice;
equal("MetaMask funding native delta includes actual fee", fundingAfter - fundingBefore, -30000000000000000000n - fundingFee);

await save(`${DIR}/independent-chain-verification.json`, { status: "passed", chainId: 5042002, finalizedBlock: anchor.number, finalizedHash: anchor.hash, nativeOpeningBlock: openingBlock, nativeOpeningHash: opening.hash, contractDeployments: deployments, receipts, eoa, operator, feeScope: "nativeFeesWei covers only the 31 controlled test actors funded by the 30-USDC opening; operator-paid gas is independently reconciled in operator and funding", nativeFeesWei: totalFees.toString(), openingAssetsNativeWei: openingTotal.toString(), finalAssetsNativeWei: finalTotal.toString(), erc20NativePairs: pairs, funding: { hash: fundingHash, from: USER, actualFeeNativeWei: fundingFee.toString(), beforeNativeWei: fundingBefore.toString(), afterNativeWei: fundingAfter.toString() }, checks });
console.log("ARC_INDEPENDENT_VERIFICATION_PASS", checks.length, "RECEIPTS", receipts.length, "PAIRED_TRANSFERS", pairs);
