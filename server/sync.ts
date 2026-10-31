import { type PublicClient } from "viem";
import { KERNEL_ABI } from "../src/lib/kernel-abi";
import { validateDeployment, networkSettings } from "../src/lib/deployment";
import { captureBlock, captureDeploymentPrefix } from "./chain";
import { type Books } from "./books-core";
export async function syncBooks(
  client: PublicClient,
  books: Books,
  maxBlocks = 1000,
): Promise<number> {
  books.project();
  await validateDeployment(client, books.manifest);
  const p = books.progress();
  const current = await client.getBlock({ blockNumber: BigInt(p.height) });
  if (current.hash !== p.hash)
    throw Error(
      "Indexed block is no longer canonical. Review the reorg before continuing.",
    );
  const latest = await client.getBlockNumber({ cacheTime: 0 });
  const target =
    books.manifest.environment === "local-anvil"
      ? latest
      : (await client.getBlock({ blockTag: "finalized" })).number;
  if (target === null) throw Error("Finalized block unavailable");
  const batchLimit=networkSettings(books.manifest.environment).arc?Math.min(maxBlocks,100):maxBlocks;
  const end =
    BigInt(p.height) + BigInt(batchLimit) < target
      ? BigInt(p.height) + BigInt(batchLimit)
      : target;
  if(networkSettings(books.manifest.environment).arc){
    books.captureRange(await captureDeploymentPrefix(client,BigInt(p.height)+1n,end,books.manifest));
  }else{
    for(let start=BigInt(p.height)+1n;start<=end;start+=100n){
      const blocks=[];const stop=start+99n<end?start+99n:end;
      for(let n=start;n<=stop;n++)blocks.push(await captureBlock(client,n));
      books.captureRange(blocks);
    }
  }
  const count = books.project();
  await reconcileBooks(client, books);
  return count;
}
export async function reconcileBooks(client: PublicClient, books: Books) {
  const p = books.progress(),
    m = books.manifest,
    blockNumber = BigInt(p.height),
    options = { address: m.kernelAddress, abi: KERNEL_ABI, blockNumber };
  for (const [id, a] of Object.entries(p.state.accounts)) {
    const row = await client.readContract({
      ...options,
      functionName: "getAccount",
      args: [BigInt(id)],
    });
    if (
      books.balance(a.entity, "cash") !== row[1] ||
      books.balance("kernel", `due:account:${id}`) !== -row[1]
    )
      throw Error(
        `Account ${id} ledger differs from chain at block ${p.height}`,
      );
    const principal = Object.values(p.state.loans)
      .filter((l) => l.borrower === id)
      .reduce((n, l) => n + BigInt(l.outstanding), 0n);
    if (principal !== row[5])
      throw Error("Borrower principal differs from chain");
  }
  const pool = await client.readContract({
    ...options,
    functionName: "getPool",
    args: [1n],
  });
  if (
    books.balance(books.entity(m.lenderAddress), "cash") !== pool[1] ||
    books.balance("kernel", "due:pool") !== -pool[1]
  )
    throw Error("Lender claim differs from chain");
  for (const l of Object.values(p.state.loans)) {
    const chain = await client.readContract({
      ...options,
      functionName: "getLoan",
      args: [BigInt(l.id)],
    });
    if (
      chain[4] !== BigInt(l.outstanding) ||
      books.balance(
        books.account(p.state, l.borrower).entity,
        `loan-payable:${l.id}`,
      ) !== -chain[4] ||
      books.balance(
        books.entity(m.lenderAddress),
        `loan-receivable:${l.id}`,
      ) !== chain[4]
    )
      throw Error(`Mirrored principal differs for loan ${l.id}`);
  }
  const [accounted, actual] = await Promise.all([
    client.readContract({ ...options, functionName: "accountedCustody" }),
    client.readContract({ ...options, functionName: "totalCustody" }),
  ]);
  if (books.balance("kernel", "usdc") !== accounted)
    throw Error("Kernel books differ from accounted custody");
  if (actual < accounted) throw Error("Custody deficit");
  return {
    block: p.height,
    accounted: accounted.toString(),
    actual: actual.toString(),
    surplus: (actual - accounted).toString(),
    status: "matched",
  };
}
