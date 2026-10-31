import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  erc20Abi,
  parseAbi,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { anvil } from "viem/chains";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { KERNEL_ABI, RELEASE_ID } from "../src/lib/kernel-abi";
import {
  readAccount,
  readPlan,
  type PlanTerms,
} from "../src/lib/kernel-client";
import {
  manifestIdentity,
  parseManifest,
  validateDeployment,
  type DeploymentManifest,
  type JournalLine,
} from "../src/lib/deployment";
import { json, record, hex, parseMoney } from "../src/lib/boundary";
import { receiptMessage } from "../src/lib/receipt-evidence";
import {
  submitIntent,
  reconcileIntent,
  browserIntentStore,
  type Intent,
  type IntentStore,
} from "../src/lib/transactions";
import { Books } from "../server/books";
import { syncBooks, reconcileBooks } from "../server/sync";
import { captureBlock, captureDeploymentRange } from "../server/chain";

const RPC = "http://127.0.0.1:18545",
  DIR =
    process.env.INTEGRATION_EVIDENCE_DIR ?? "docs/evidence/wallet-accounting";
await mkdir(DIR, { recursive: true });
const client = createPublicClient({
  transport: http(RPC),
  pollingInterval: 20,
});
const actors = Array.from({ length: 10 }, (_, addressIndex) =>
  createWalletClient({
    chain: anvil,
    transport: http(RPC),
    account: mnemonicToAccount(
      "test test test test test test test test test test test junk",
      { addressIndex },
    ),
  }),
);
const addr = (i: number) => actors[i].account.address;
const TOKEN = parseAbi([
  "function mint(address to,uint256 amount)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to,uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
]);
const zeroAddress: Address = "0x0000000000000000000000000000000000000000";
const ref = (s: string) => keccak256(toBytes(s));
const checks: {
  name: string;
  actual: unknown;
  expected: unknown;
  status: string;
}[] = [];
const receipts: unknown[] = [];
function equal(name: string, actual: unknown, expected: unknown) {
  const passed = json(actual) === json(expected);
  checks.push({ name, actual, expected, status: passed ? "passed" : "failed" });
  if (!passed)
    throw Error(
      `${name}: expected ${json(expected)}, received ${json(actual)}`,
    );
}
async function rejects(name: string, run: () => unknown | Promise<unknown>) {
  let error = false;
  try {
    await run();
  } catch {
    error = true;
  }
  equal(name, error, true);
}
async function bytecode(path: string) {
  const a = record(JSON.parse(await readFile(path, "utf8")));
  return hex(record(a.bytecode).object);
}
async function sent(actor: number, to: Address, data: Hex) {
  const hash = await actors[actor].sendTransaction({ to, data });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw Error("Setup transaction reverted");
  receipts.push(receipt);
  return receipt;
}
const data = (
  args: Parameters<typeof encodeFunctionData<typeof KERNEL_ABI>>[0],
) => encodeFunctionData(args);
async function fixture(kind: "co" | "cp", label: string) {
  const tokenTx = await actors[0].deployContract({
    abi: TOKEN,
    bytecode: await bytecode("contracts/out/KernelBase.t.sol/MockERC20.json"),
  });
  const tokenReceipt = await client.waitForTransactionReceipt({
    hash: tokenTx,
  });
  if (!tokenReceipt.contractAddress) throw Error("Mock token not deployed");
  const token = tokenReceipt.contractAddress;
  const deploymentTransaction = await actors[0].deployContract({
    abi: KERNEL_ABI,
    bytecode: await bytecode(
      "contracts/release-out/BusinessKernel.sol/BusinessKernel.json",
    ),
    args: [token, addr(1)],
  });
  const deployed = await client.waitForTransactionReceipt({
    hash: deploymentTransaction,
  });
  if (!deployed.contractAddress) throw Error("Kernel not deployed");
  const kernel = deployed.contractAddress;
  const accounts =
    kind === "co"
      ? [
          {
            actor: 2,
            id: "1",
            entity: "merchant",
            cash: 3000000n,
            floor: 2000000n,
            ar: 0n,
            limit: 2000000n,
          },
        ]
      : [
          {
            actor: 2,
            id: "1",
            entity: "buyerA",
            cash: 300000n,
            floor: 100000n,
            ar: 160000n,
            limit: 160000n,
          },
          {
            actor: 6,
            id: "2",
            entity: "buyerB",
            cash: 250000n,
            floor: 100000n,
            ar: 165000n,
            limit: 165000n,
          },
          {
            actor: 7,
            id: "3",
            entity: "buyerC",
            cash: 200000n,
            floor: 100000n,
            ar: 125000n,
            limit: 125000n,
          },
        ];
  const pool = kind === "co" ? 2000000n : 500000n,
    external = kind === "co" ? 10000000n : 1000000n;
  for (const a of accounts) {
    await sent(
      a.actor,
      kernel,
      data({ abi: KERNEL_ABI, functionName: "openAccount" }),
    );
    equal(
      `${label} account identity`,
      await client.readContract({
        address: kernel,
        abi: KERNEL_ABI,
        functionName: "accountOf",
        args: [addr(a.actor)],
      }),
      BigInt(a.id),
    );
  }
  for (const [actor, amount] of [
    [1, pool],
    [3, external],
    ...accounts.map((a) => [a.actor, a.cash] satisfies [number, bigint]),
  ] satisfies [number, bigint][]) {
    await sent(
      0,
      token,
      encodeFunctionData({
        abi: TOKEN,
        functionName: "mint",
        args: [addr(actor), amount],
      }),
    );
    await sent(
      actor,
      token,
      encodeFunctionData({
        abi: TOKEN,
        functionName: "approve",
        args: [kernel, amount],
      }),
    );
  }
  await sent(
    1,
    kernel,
    data({ abi: KERNEL_ABI, functionName: "depositPool", args: [1n, pool] }),
  );
  for (const a of accounts) {
    await sent(
      a.actor,
      kernel,
      data({
        abi: KERNEL_ABI,
        functionName: "depositCash",
        args: [BigInt(a.id), a.cash],
      }),
    );
    await sent(
      a.actor,
      kernel,
      data({
        abi: KERNEL_ABI,
        functionName: "setProtectedFloor",
        args: [BigInt(a.id), a.floor],
      }),
    );
    await sent(
      1,
      kernel,
      data({
        abi: KERNEL_ABI,
        functionName: "setBorrowerLimit",
        args: [1n, BigInt(a.id), a.limit],
      }),
    );
  }
  const openingBlock = await client.getBlock(),
    lines: JournalLine[] = [];
  const add = (entity: string, account: string, delta: bigint) => {
    if (delta)
      lines.push({
        entity,
        account,
        side: delta > 0n ? "debit" : "credit",
        amount: (delta < 0n ? -delta : delta).toString(),
      });
  };
  let custody = pool,
    totalAR = 0n;
  for (const a of accounts) {
    custody += a.cash;
    totalAR += a.ar;
    add(a.entity, "cash", a.cash);
    add(a.entity, `ar:opening:${a.id}`, a.ar);
    add(a.entity, "equity", -(a.cash + a.ar));
    add("kernel", `due:account:${a.id}`, -a.cash);
    add("customer", `ap:opening:${a.id}`, -a.ar);
  }
  add("lender", "cash", pool);
  add("lender", "equity", -pool);
  add("customer", "external", external);
  add("customer", "equity", -(external - totalAR));
  add("kernel", "usdc", custody);
  add("kernel", "due:pool", -pool);
  const base: Omit<DeploymentManifest, "instanceId"> = {
    version: 2,
    environment: "local-anvil",
    chainId: 31337,
    kernelAddress: kernel,
    usdcAddress: token,
    lenderAddress: addr(1),
    deploymentTransaction,
    deploymentBlock: deployed.blockNumber.toString(),
    sourceSha256: RELEASE_ID.sourceSha256,
    opening: {
      block: openingBlock.number.toString(),
      hash: openingBlock.hash,
      timestamp: openingBlock.timestamp.toString(),
      fixtureVersion: label,
      ruleVersion: 2,
      lines,
      accounts: accounts.map((a) => ({
        id: a.id,
        owner: addr(a.actor),
        entity: a.entity,
        cash: a.cash.toString(),
      })),
      poolCash: pool.toString(),
      custody: custody.toString(),
    },
    entities: [
      { address: addr(0), id: "coordinator" },
      { address: addr(1), id: "lender" },
      { address: addr(3), id: "customer" },
      { address: addr(4), id: "supplier" },
      { address: addr(5), id: "freight" },
      ...accounts.map((a) => ({ address: addr(a.actor), id: a.entity })),
    ],
  };
  const manifest = parseManifest({
    ...base,
    instanceId: manifestIdentity(base),
  });
  await validateDeployment(client, manifest);
  const path = `${DIR}/${label}.sqlite`;
  await rm(path, { force: true });
  await rm(path + "-wal", { force: true });
  await rm(path + "-shm", { force: true });
  let books = new Books(path, manifest);
  await writeFile(`${DIR}/${label}-manifest.json`, json(manifest));
  const k = (actor: number, input: Hex) => sent(actor, kernel, input);
  const sync = () => syncBooks(client, books);
  return {
    kind,
    label,
    token,
    kernel,
    manifest,
    path,
    accounts,
    openingBlock,
    k,
    sync,
    get books() {
      return books;
    },
    reopen() {
      books.close();
      books = new Books(path, manifest);
      return books;
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function order(f: Fixture) {
  const expiry = (await client.getBlock()).timestamp + 604800n;
  await f.k(
    4,
    data({
      abi: KERNEL_ABI,
      functionName: "createOffer",
      args: [addr(4), 60000n, 100n, 100n, expiry],
    }),
  );
  await f.k(
    5,
    data({
      abi: KERNEL_ABI,
      functionName: "createOffer",
      args: [addr(5), 500000n, 1n, 1n, expiry],
    }),
  );
  const terms: PlanTerms = {
    kind: 1,
    buyers: [],
    saleParty: {
      merchantOwner: addr(2),
      merchantAccountId: 1n,
      merchantCash: 1000000n,
      creditDraw: 1500000n,
      creditLimit: 2000000n,
      customerAddress: addr(3),
      requiredEscrow: 4000000n,
      saleValue: 10000000n,
    },
    lenderPoolId: 1n,
    offerRefs: [
      { offerId: 1n, quantity: 100n, payee: addr(4) },
      { offerId: 2n, quantity: 1n, payee: addr(5) },
    ],
    expiry,
    commercialRef: ref(f.label),
  };
  await f.k(
    0,
    data({ abi: KERNEL_ABI, functionName: "draftPlan", args: [terms] }),
  );
  await f.k(
    1,
    data({
      abi: KERNEL_ABI,
      functionName: "approveLenderPlan",
      args: [1n, 0n, 1500000n, expiry],
    }),
  );
  await f.k(
    4,
    data({
      abi: KERNEL_ABI,
      functionName: "approveSupplierPlan",
      args: [1n, 0n, 100n, expiry],
    }),
  );
  await f.k(
    5,
    data({
      abi: KERNEL_ABI,
      functionName: "approveSupplierPlan",
      args: [1n, 1n, 1n, expiry],
    }),
  );
  await f.sync();
  return terms;
}
async function customerOrder(split: boolean, crash: boolean) {
  const f = await fixture("co", split ? "co-split" : "co-full");
  try {
    equal(
      `${f.label} opening merchant cash`,
      f.books.balance("merchant", "cash"),
      3000000n,
    );
    equal(
      `${f.label} protected floor excluded`,
      (await readAccount(client, f.kernel, 1n)).availableCash,
      1000000n,
    );
    const terms = await order(f);
    equal(
      `${f.label} plan input reconstructed`,
      f.books.progress().state.plans["1"].hash,
      (await readPlan(client, f.kernel, 1n)).termsHash,
    );
    await rejects("wrong signer cannot fund customer escrow", () =>
      client.call({
        account: addr(2),
        to: f.kernel,
        data: data({
          abi: KERNEL_ABI,
          functionName: "fundCustomerEscrow",
          args: [1n],
        }),
      }),
    );
    await f.k(
      3,
      data({ abi: KERNEL_ABI, functionName: "fundCustomerEscrow", args: [1n] }),
    );
    await f.sync();
    equal(
      "escrow creates no merchant advance",
      f.books.balance("merchant", "customer-advance:1"),
      0n,
    );
    equal(
      "customer refundable escrow",
      f.books.balance("customer", "escrow:1"),
      4000000n,
    );
    await f.k(
      2,
      data({ abi: KERNEL_ABI, functionName: "joinMerchant", args: [1n] }),
    );
    await f.sync();
    equal(
      "joined merchant available cash",
      (await readAccount(client, f.kernel, 1n)).availableCash,
      0n,
    );
    equal(
      "reservation creates no principal",
      Object.keys(f.books.progress().state.loans).length,
      0,
    );
    const before = f.books.progress().height;
    const close = await f.k(
      0,
      data({ abi: KERNEL_ABI, functionName: "commitPlan", args: [1n] }),
    );
    equal(
      "confirmed chain while books pending",
      (await readPlan(client, f.kernel, 1n)).status,
      "Committed",
    );
    equal(
      "indexer still behind successful close",
      f.books.progress().height,
      before,
    );
    if (crash) {
      f.books.capture(await captureBlock(client, close.blockNumber));
      const injected = new Database(f.path);
      injected.exec(
        "CREATE TRIGGER crash_after_merchant BEFORE INSERT ON journal WHEN NEW.kind='PlanCommitted' AND NEW.entity='lender' BEGIN SELECT RAISE(ABORT,'injected write failure after merchant lines'); END;",
      );
      await rejects("injected financial-close write fails", () =>
        f.books.project(),
      );
      equal(
        "all close journal lines rolled back",
        f.books.journals().filter((r) => r.kind === "PlanCommitted").length,
        0,
      );
      equal(
        "cursor rolls back with all entities",
        f.books.progress().height,
        before,
      );
      equal(
        "loan context also rolls back",
        Object.keys(f.books.progress().state.loans).length,
        0,
      );
      injected.exec("DROP TRIGGER crash_after_merchant");
      injected.close();
      f.reopen();
    }
    await f.sync();
    equal(
      "merchant own contribution posted once",
      f.books.balance("merchant", "cash"),
      2000000n,
    );
    equal(
      "goods prepayment equals payout",
      f.books.balance("merchant", "prepayment:goods:1"),
      6000000n,
    );
    equal(
      "freight prepayment equals payout",
      f.books.balance("merchant", "prepayment:freight:1"),
      500000n,
    );
    equal(
      "inventory waits for receipt",
      f.books.balance("merchant", "inventory:1"),
      0n,
    );
    equal(
      "merchant loan payable",
      f.books.balance("merchant", "loan-payable:1"),
      -1500000n,
    );
    equal(
      "lender loan receivable",
      f.books.balance("lender", "loan-receivable:1"),
      1500000n,
    );
    equal(
      "kernel post-close physical books",
      f.books.balance("kernel", "usdc"),
      2500000n,
    );
    const digest = f.books.digest();
    f.books.capture(await captureBlock(client, close.blockNumber));
    await f.sync();
    equal("duplicate block does not repost", f.books.digest(), digest);
    await rejects("collection before acceptance fails", () =>
      client.call({
        account: addr(3),
        to: f.kernel,
        data: data({
          abi: KERNEL_ABI,
          functionName: "collectSalesBalance",
          args: [1n, ref("early"), 6000000n],
        }),
      }),
    );
    await f.k(
      2,
      data({ abi: KERNEL_ABI, functionName: "acknowledgeGoods", args: [1n] }),
    );
    await f.sync();
    equal(
      "goods receipt recognizes only goods",
      f.books.balance("merchant", "inventory:1"),
      6000000n,
    );
    equal(
      "freight remains pending",
      f.books.balance("merchant", "prepayment:freight:1"),
      500000n,
    );
    equal(
      "no merchant revenue before acceptance",
      f.books.balance("merchant", "revenue"),
      0n,
    );
    await f.k(
      2,
      data({ abi: KERNEL_ABI, functionName: "acknowledgeFreight", args: [1n] }),
    );
    await f.k(
      3,
      data({ abi: KERNEL_ABI, functionName: "acceptSalesOrder", args: [1n] }),
    );
    await f.sync();
    equal(
      "recognized receivable after acceptance",
      f.books.balance("merchant", "ar:sale:1"),
      6000000n,
    );
    equal(
      "COGS recognized once",
      f.books.balance("merchant", "cogs"),
      6500000n,
    );
    if (split) {
      await f.k(
        3,
        data({
          abi: KERNEL_ABI,
          functionName: "collectSalesBalance",
          args: [1n, ref("part1"), 3000000n],
        }),
      );
      await f.sync();
      equal(
        "first receipt merchant retained cash",
        f.books.balance("merchant", "cash"),
        3500000n,
      );
      equal(
        "first receipt fully repays principal",
        f.books.balance("merchant", "loan-payable:1"),
        0n,
      );
      equal(
        "first receipt leaves AR",
        f.books.balance("merchant", "ar:sale:1"),
        3000000n,
      );
      await f.k(
        3,
        data({
          abi: KERNEL_ABI,
          functionName: "collectSalesBalance",
          args: [1n, ref("part2"), 3000000n],
        }),
      );
    } else
      await f.k(
        3,
        data({
          abi: KERNEL_ABI,
          functionName: "collectSalesBalance",
          args: [1n, ref("full"), 6000000n],
        }),
      );
    await f.sync();
    for (const [e, a, expected] of [
      ["merchant", "cash", 6500000n],
      ["lender", "cash", 2000000n],
      ["kernel", "usdc", 8500000n],
      ["customer", "external", 0n],
      ["supplier", "external", 6000000n],
      ["freight", "external", 500000n],
      ["merchant", "ar:sale:1", 0n],
      ["merchant", "revenue", -10000000n],
      ["merchant", "loan-payable:1", 0n],
    ] satisfies [string, string, bigint][])
      equal(`${f.label} final ${e}/${a}`, f.books.balance(e, a), expected);
    await reconcileBooks(client, f.books);
    const final = f.books.digest();
    equal(
      "rebuild from raw events and opening",
      await f.books.rebuild(),
      final,
    );
    f.reopen();
    equal("restart retains identical books", f.books.digest(), final);
    const changed = {
      ...f.manifest,
      opening: { ...f.manifest.opening, poolCash: "2000001" },
    };
    const altered = { ...changed, instanceId: manifestIdentity(changed) };
    await rejects(
      "immutable checkpoint mutation rejected",
      () => new Books(f.path, altered),
    );
    await rejects("wrong source hash rejected", () =>
      parseManifest({ ...f.manifest, sourceSha256: "bad" }),
    );
    await rejects("wrong chain rejected", () =>
      validateDeployment(client, { ...f.manifest, chainId: 5042002 }),
    );
    await writeFile(
      `${DIR}/${f.label}-books.json`,
      json({
        manifest: f.manifest,
        balances: f.books.balances(),
        journals: f.books.journals(),
        fees: f.books.fees(),
        digest: final,
      }),
    );
    if (!split) await walletRecovery(f);
    return f.manifest;
  } finally {
    f.books.close();
  }
}
async function walletRecovery(f: Fixture) {
  const items = new Map<string, Intent>(),
    store: IntentStore = {
      list: () => [...items.values()],
      save: (i) => {
        items.set(i.id, i);
      },
    };
  let sends = 0;
  const wallet = {
    identity: async () => ({ address: addr(2), chainId: 31337 }),
    send: async (input: {
      to: Address;
      data: Hex;
      value: bigint;
      nonce: number;
      chainId: number;
    }) => {
      sends++;
      const hash = await actors[2].sendTransaction({
        to: input.to,
        data: input.data,
        value: input.value,
        nonce: input.nonce,
      });
      await client.waitForTransactionReceipt({ hash });
      throw Error("Injected lost RPC response after actual broadcast");
    },
  };
  const before = await readAccount(client, f.kernel, 1n);
  const externalBefore = await client.readContract({
    address: f.token,
    abi: TOKEN,
    functionName: "balanceOf",
    args: [addr(2)],
  });
  const intent = await submitIntent({
    client,
    manifest: f.manifest,
    wallet,
    store,
    to: f.kernel,
    data: data({
      abi: KERNEL_ABI,
      functionName: "withdrawCash",
      args: [1n, addr(2), 100000n],
    }),
    purpose: "Withdraw 0.1 USDC",
  });
  equal("lost wallet response is uncertain", intent.state.kind, "unknown");
  equal("intent has no invented hash", "hash" in intent.state, false);
  const recovered = await reconcileIntent(
    client,
    f.manifest,
    store,
    intent,
    BigInt(f.books.progress().height),
  );
  equal(
    "recover actual transaction by signer nonce",
    recovered.state.kind,
    "confirmed",
  );
  equal("recovery never resubmits", sends, 1);
  equal(
    "withdrawal reduces cash exactly once",
    (await readAccount(client, f.kernel, 1n)).cash,
    before.cash - 100000n,
  );
  equal(
    "recipient receives one actual payment",
    await client.readContract({
      address: f.token,
      abi: TOKEN,
      functionName: "balanceOf",
      args: [addr(2)],
    }),
    externalBefore + 100000n,
  );
  equal(
    "confirmed transaction distinguishes books lag",
    recovered.state.kind === "confirmed" ? recovered.state.books : "wrong",
    "pending",
  );
  await f.sync();
  const posted = await reconcileIntent(
    client,
    f.manifest,
    store,
    recovered,
    BigInt(f.books.progress().height),
  );
  equal(
    "books catch up independently",
    posted.state.kind === "confirmed" ? posted.state.books : "wrong",
    "posted",
  );
  await rejects("storage failure prevents wallet prompt", () =>
    submitIntent({
      client,
      manifest: f.manifest,
      wallet,
      store: {
        list: () => [],
        save: () => {
          throw Error("storage full");
        },
      },
      to: f.kernel,
      data: data({
        abi: KERNEL_ABI,
        functionName: "setProtectedFloor",
        args: [1n, 2200000n],
      }),
      purpose: "storage failure",
    }),
  );
  equal("storage failure sent no transaction", sends, 1);
  const wrong = {
    ...wallet,
    identity: async () => ({ address: addr(2), chainId: 5042002 }),
  };
  await rejects("wrong wallet network prevents send", () =>
    submitIntent({
      client,
      manifest: f.manifest,
      wallet: wrong,
      store,
      to: f.kernel,
      data: data({
        abi: KERNEL_ABI,
        functionName: "setProtectedFloor",
        args: [1n, 2200000n],
      }),
      purpose: "wrong network",
    }),
  );
  equal("wrong network sent no transaction", sends, 1);
  const rows = new Map<string, string>();
  let interleaved = false;
  const backing: Storage = {
    get length() {
      return rows.size;
    },
    key: (index) => [...rows.keys()][index] ?? null,
    getItem: (key) => rows.get(key) ?? null,
    setItem(key, value) {
      if (!interleaved) {
        interleaved = true;
        secondStore.save({
          ...posted,
          id: "other-tab-intent",
          signer: addr(6),
        });
      }
      rows.set(key, value);
    },
    removeItem: (key) => {
      rows.delete(key);
    },
    clear: () => {
      rows.clear();
    },
  };
  const firstStore = browserIntentStore(backing),
    secondStore = browserIntentStore(backing);
  firstStore.save(posted);
  equal(
    "interleaved independent intent saves retain both records",
    firstStore.list().length,
    2,
  );
  equal(
    "original intent survives another signer write",
    firstStore
      .list()
      .some((i) => i.id === posted.id && i.signer === posted.signer),
    true,
  );
  await writeFile(
    `${DIR}/wallet-recovery.json`,
    json({
      environment: "local-anvil",
      sendCount: sends,
      intent,
      recovered,
      posted,
    }),
  );
}
async function cancellation() {
  const f = await fixture("co", "co-cancel");
  try {
    await order(f);
    await f.k(
      3,
      data({ abi: KERNEL_ABI, functionName: "fundCustomerEscrow", args: [1n] }),
    );
    await f.k(
      2,
      data({ abi: KERNEL_ABI, functionName: "joinMerchant", args: [1n] }),
    );
    await f.sync();
    const journalCount = f.books.journals().length;
    await f.k(
      0,
      data({ abi: KERNEL_ABI, functionName: "cancelPlan", args: [1n] }),
    );
    await f.sync();
    equal(
      "cancellation creates no money journal",
      f.books.journals().length,
      journalCount,
    );
    equal(
      "cancellation retains refundable funds",
      f.books.balance("kernel", "usdc"),
      9000000n,
    );
    await f.k(
      3,
      data({
        abi: KERNEL_ABI,
        functionName: "withdrawCustomerEscrow",
        args: [1n],
      }),
    );
    await f.sync();
    equal(
      "separate refund restores customer funds",
      f.books.balance("customer", "external"),
      10000000n,
    );
    equal(
      "separate refund restores custody",
      f.books.balance("kernel", "usdc"),
      5000000n,
    );
    equal(
      "no loan on cancellation",
      Object.keys(f.books.progress().state.loans).length,
      0,
    );
    // Ordinary deposits and withdrawals after opening must be posted.
    await sent(
      0,
      f.token,
      encodeFunctionData({
        abi: TOKEN,
        functionName: "mint",
        args: [addr(2), 100000n],
      }),
    );
    await sent(
      2,
      f.token,
      encodeFunctionData({
        abi: TOKEN,
        functionName: "approve",
        args: [f.kernel, 100000n],
      }),
    );
    await f.k(
      2,
      data({
        abi: KERNEL_ABI,
        functionName: "depositCash",
        args: [1n, 100000n],
      }),
    );
    await f.sync();
    equal(
      "post-opening deposit is not skipped",
      f.books.balance("merchant", "cash"),
      3100000n,
    );
    await f.k(
      2,
      data({
        abi: KERNEL_ABI,
        functionName: "withdrawCash",
        args: [1n, addr(2), 100000n],
      }),
    );
    await f.sync();
    equal(
      "post-opening withdrawal is not skipped",
      f.books.balance("merchant", "cash"),
      3000000n,
    );
    const before = f.books.digest();
    await sent(
      0,
      f.token,
      encodeFunctionData({
        abi: TOKEN,
        functionName: "mint",
        args: [addr(8), 17n],
      }),
    );
    const surplus = await sent(
      8,
      f.token,
      encodeFunctionData({
        abi: TOKEN,
        functionName: "transfer",
        args: [f.kernel, 17n],
      }),
    );
    await f.sync();
    equal(
      "unsolicited transfer creates no claim",
      f.books.balance("kernel", "usdc"),
      5000000n,
    );
    equal(
      "unsolicited transfer is an exception",
      f.books
        .issues()
        .some((i) => i.source === `surplus:${surplus.transactionHash}`),
      true,
    );
    const reconciliation = await reconcileBooks(client, f.books);
    equal("surplus is separately reconciled", reconciliation.surplus, "17");
  } finally {
    f.books.close();
  }
}
async function group() {
  const f = await fixture("cp", "cp");
  try {
    const expiry = (await client.getBlock()).timestamp + 604800n;
    await f.k(
      4,
      data({
        abi: KERNEL_ABI,
        functionName: "createOffer",
        args: [addr(4), 9000n, 100n, 100n, expiry],
      }),
    );
    const quantities = [40n, 35n, 25n],
      cash = [200000n, 150000n, 100000n];
    const terms: PlanTerms = {
      kind: 0,
      buyers: f.accounts.map((a, i) => ({
        owner: addr(a.actor),
        accountId: BigInt(a.id),
        quantity: quantities[i],
        ownCash: cash[i],
        creditDraw: a.ar,
        creditLimit: a.ar,
      })),
      saleParty: {
        merchantOwner: zeroAddress,
        merchantAccountId: 0n,
        merchantCash: 0n,
        creditDraw: 0n,
        creditLimit: 0n,
        customerAddress: zeroAddress,
        requiredEscrow: 0n,
        saleValue: 0n,
      },
      lenderPoolId: 1n,
      offerRefs: [{ offerId: 1n, quantity: 100n, payee: addr(4) }],
      expiry,
      commercialRef: ref("group"),
    };
    await f.k(
      0,
      data({ abi: KERNEL_ABI, functionName: "draftPlan", args: [terms] }),
    );
    await f.k(
      4,
      data({
        abi: KERNEL_ABI,
        functionName: "approveSupplierPlan",
        args: [1n, 0n, 100n, expiry],
      }),
    );
    for (const [i, a] of f.accounts.entries()) {
      await f.k(
        1,
        data({
          abi: KERNEL_ABI,
          functionName: "approveLenderPlan",
          args: [1n, BigInt(i), a.ar, expiry],
        }),
      );
      await f.k(
        a.actor,
        data({
          abi: KERNEL_ABI,
          functionName: "registerReceivable",
          args: [
            BigInt(a.id),
            BigInt(a.id),
            addr(3),
            a.ar,
            ref("opening-" + a.id),
          ],
        }),
      );
    }
    await f.k(
      2,
      data({ abi: KERNEL_ABI, functionName: "joinBuyer", args: [1n, 0n] }),
    );
    await f.k(
      6,
      data({ abi: KERNEL_ABI, functionName: "joinBuyer", args: [1n, 1n] }),
    );
    await f.sync();
    await rejects("75-unit group cannot commit", () =>
      client.call({
        account: addr(0),
        to: f.kernel,
        data: data({ abi: KERNEL_ABI, functionName: "commitPlan", args: [1n] }),
      }),
    );
    equal(
      "75-unit group creates no loans",
      Object.keys(f.books.progress().state.loans).length,
      0,
    );
    await f.k(
      7,
      data({ abi: KERNEL_ABI, functionName: "joinBuyer", args: [1n, 2n] }),
    );
    await f.sync();
    equal(
      "100-unit reservations still create no loans",
      Object.keys(f.books.progress().state.loans).length,
      0,
    );
    await f.k(
      0,
      data({ abi: KERNEL_ABI, functionName: "commitPlan", args: [1n] }),
    );
    await f.sync();
    equal(
      "group supplier receives actual USDC",
      f.books.balance("supplier", "external"),
      900000n,
    );
    equal("group commit custody", f.books.balance("kernel", "usdc"), 350000n);
    for (const a of f.accounts) {
      equal(
        "group cash after close " + a.entity,
        f.books.balance(a.entity, "cash"),
        100000n,
      );
      equal(
        "group prepayment awaits evidence " + a.entity,
        f.books.balance(a.entity, "inventory:1"),
        0n,
      );
    }
    const challenge = f.books.issueChallenge("1", "1");
    const wrong = await actors[6].signMessage({
      message: receiptMessage(challenge),
    });
    await rejects("wrong buyer delivery signature rejected", () =>
      f.books.acceptReceipt(challenge, wrong),
    );
    const stale = f.books.issueChallenge("1", "2", Date.now() - 700000);
    const staleSignature = await actors[6].signMessage({
      message: receiptMessage(stale),
    });
    await rejects("expired signature rejected", () =>
      f.books.acceptReceipt(stale, staleSignature),
    );
    const signature = await actors[2].signMessage({
      message: receiptMessage(challenge),
    });
    await rejects("receipt cannot cross deployments", () =>
      f.books.acceptReceipt(
        { ...challenge, deployment: ref("wrong deployment") },
        signature,
      ),
    );
    const concurrentReceipts = await Promise.all([
      f.books.acceptReceipt(challenge, signature),
      f.books.acceptReceipt(challenge, signature),
    ]);
    equal(
      "concurrent identical signed receipt is idempotent",
      concurrentReceipts.sort(),
      ["accepted", "already-recorded"],
    );
    equal(
      "same signature is idempotent",
      await f.books.acceptReceipt(challenge, signature),
      "already-recorded",
    );
    const replay = f.books.issueChallenge("1", "1");
    const replaySignature = await actors[2].signMessage({
      message: receiptMessage(replay),
    });
    await rejects(
      "second signed receipt cannot recognize inventory twice",
      () => f.books.acceptReceipt(replay, replaySignature),
    );
    equal(
      "signed receipt recognizes only buyer A allocation",
      f.books.balance("buyerA", "inventory:1"),
      360000n,
    );
    equal(
      "buyer B remains prepayment",
      f.books.balance("buyerB", "prepayment:goods:1"),
      315000n,
    );
    await rejects("changed quantity rejected", () =>
      f.books.acceptReceipt({ ...challenge, quantity: "41" }, signature),
    );
    for (const a of f.accounts) {
      await f.k(
        3,
        data({
          abi: KERNEL_ABI,
          functionName: "collectReceivable",
          args: [BigInt(a.id), ref("receivable-" + a.id), a.ar],
        }),
      );
    }
    await f.sync();
    for (const a of f.accounts) {
      equal(
        "collection leaves principal outstanding " + a.entity,
        f.books.balance(a.entity, `loan-payable:${a.id}`),
        -a.ar,
      );
      equal(
        "opening AR cleared " + a.entity,
        f.books.balance(a.entity, `ar:opening:${a.id}`),
        0n,
      );
      equal(
        "collection cash before separate repayment " + a.entity,
        f.books.balance(a.entity, "cash"),
        100000n + a.ar,
      );
    }
    for (const a of f.accounts)
      await f.k(
        a.actor,
        data({
          abi: KERNEL_ABI,
          functionName: "repayLoan",
          args: [BigInt(a.id), a.ar],
        }),
      );
    await f.sync();
    for (const a of f.accounts) {
      equal(
        "final group cash " + a.entity,
        f.books.balance(a.entity, "cash"),
        100000n,
      );
      equal(
        "final group debt " + a.entity,
        f.books.balance(a.entity, `loan-payable:${a.id}`),
        0n,
      );
    }
    equal(
      "final group lender cash",
      f.books.balance("lender", "cash"),
      500000n,
    );
    equal(
      "final group kernel cash",
      f.books.balance("kernel", "usdc"),
      800000n,
    );
    equal(
      "final group customer cash",
      f.books.balance("customer", "external"),
      550000n,
    );
    const digest = f.books.digest();
    equal(
      "rebuild retains signed receipt once",
      await f.books.rebuild(),
      digest,
    );
    equal(
      "rebuild does not restore prepayment after signed receipt",
      f.books.balance("buyerA", "prepayment:goods:1"),
      0n,
    );
    await reconcileBooks(client, f.books);
    await writeFile(
      `${DIR}/cp-books.json`,
      json({
        manifest: f.manifest,
        balances: f.books.balances(),
        journals: f.books.journals(),
        signedReceipts: f.books.receipts(),
        digest,
      }),
    );
    return f.manifest;
  } finally {
    f.books.close();
  }
}

async function orderingAndConcurrency() {
  const f = await fixture("co", "ordering");
  try {
    const first = await f.k(
      2,
      data({
        abi: KERNEL_ABI,
        functionName: "withdrawCash",
        args: [1n, addr(2), 1n],
      }),
    );
    const second = await f.k(
      2,
      data({
        abi: KERNEL_ABI,
        functionName: "withdrawCash",
        args: [1n, addr(2), 2n],
      }),
    );
    const blocks = [
      await captureBlock(client, first.blockNumber),
      await captureBlock(client, second.blockNumber),
    ];
    f.books.capture(blocks[1]);
    equal("out of order waits for predecessor", f.books.project(), 0);
    equal(
      "out of order does not advance cursor",
      f.books.progress().height,
      Number(f.manifest.opening.block),
    );
    f.books.capture(blocks[0]);
    equal("missing predecessor unblocks both blocks", f.books.project(), 2);
    equal(
      "ordered payment total exact",
      f.books.balance("merchant", "cash"),
      2999997n,
    );
    await rejects("conflicting canonical block rejected", () =>
      f.books.capture({ ...blocks[0], hash: ref("conflicting block") }),
    );
    const concurrentPath = `${DIR}/concurrent.sqlite`;
    await rm(concurrentPath, { force: true });
    const init = new Books(concurrentPath, f.manifest);
    init.close();
    await writeFile(
      `${DIR}/concurrent-input.json`,
      json({ manifest: f.manifest, path: concurrentPath, blocks }),
    );
    const childRun = () =>
      new Promise<number>((resolve, reject) => {
        const worker = spawn(
          "bun",
          ["run", "tests/projection-worker.ts", `${DIR}/concurrent-input.json`],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let log = "";
        worker.stdout.on("data", (d) => {
          log += d;
        });
        worker.stderr.on("data", (d) => {
          log += d;
        });
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (code === 0) resolve(worker.pid ?? 0);
          else reject(Error(log));
        });
      });
    const pids = await Promise.all([childRun(), childRun()]);
    equal("two real projection processes used", new Set(pids).size, 2);
    const parallel = new Books(concurrentPath, f.manifest);
    equal(
      "concurrent workers reproduce canonical journals",
      parallel.digest(),
      f.books.digest(),
    );
    equal(
      "concurrent payment posted once",
      parallel.balance("merchant", "cash"),
      2999997n,
    );
    parallel.close();
    const badPath = `${DIR}/unknown-schema.sqlite`;
    await rm(badPath, { force: true });
    const bad = new Database(badPath);
    bad.exec("PRAGMA user_version=999");
    bad.close();
    await rejects(
      "unknown schema rejected before writes",
      () => new Books(badPath, f.manifest),
    );
    const inspect = new Database(badPath);
    equal(
      "unknown schema left untouched",
      inspect
        .query<{ n: number }, []>(
          "SELECT COUNT(*) n FROM sqlite_master WHERE type='table'",
        )
        .get()?.n,
      0,
    );
    inspect.close();
    await writeFile(
      `${DIR}/concurrency.json`,
      json({
        pids,
        digest: f.books.digest(),
        checks:
          "out-of-order, two writers, duplicate delivery, conflicting block, unknown schema",
      }),
    );
  } finally {
    f.books.close();
  }
}

export { fixture, order, group, client, actors, addr, data, DIR };
if (import.meta.main) {
  
async function scopeIsolation(){
 const f=await fixture('co','capture-scope');try{
  const a=await f.k(2,data({abi:KERNEL_ABI,functionName:'withdrawCash',args:[1n,addr(2),1n]}));
  const b=await f.k(2,data({abi:KERNEL_ABI,functionName:'withdrawCash',args:[1n,addr(2),2n]}));
  await sent(0,f.token,encodeFunctionData({abi:TOKEN,functionName:'mint',args:[addr(8),10n]}));
  const unrelatedApproval=await sent(8,f.token,encodeFunctionData({abi:TOKEN,functionName:'approve',args:[addr(9),10n]}));
  const unrelatedTransfer=await sent(8,f.token,encodeFunctionData({abi:TOKEN,functionName:'transfer',args:[addr(9),3n]}));
  const ownApproval=await sent(2,f.token,encodeFunctionData({abi:TOKEN,functionName:'approve',args:[f.kernel,1n]}));
  const surplus=await sent(8,f.token,encodeFunctionData({abi:TOKEN,functionName:'transfer',args:[f.kernel,1n]}));await f.sync();
  equal('shared token unrelated approval fees excluded',f.books.fees().some(r=>r.tx===unrelatedApproval.transactionHash),false);
  equal('shared token unrelated transfer fees excluded',f.books.fees().some(r=>r.tx===unrelatedTransfer.transactionHash),false);
  equal('deployment token approval fee retained',f.books.fees().some(r=>r.tx===ownApproval.transactionHash),true);
  const end=await client.getBlockNumber({cacheTime:0}),blocks=await captureDeploymentRange(client,BigInt(f.manifest.opening.block)+1n,end,f.manifest);
  const selected=blocks.flatMap(block=>block.transactions).map(tx=>tx.hash).sort();
  equal('bounded capture selects only four relevant receipts',selected,[a.transactionHash,b.transactionHash,ownApproval.transactionHash,surplus.transactionHash].sort());
  equal('bounded capture retains every contiguous block',blocks.length,Number(end-BigInt(f.manifest.opening.block)));
  const path=`${DIR}/capture-scoped.sqlite`;await rm(path,{force:true});const scoped=new Books(path,f.manifest);
  try{for(const block of blocks)scoped.capture(block);scoped.project();equal('scoped capture reproduces full-capture financial books',scoped.digest(),f.books.digest());equal('scoped capture preserves unsolicited incoming exception',scoped.issues().some(i=>i.source===`surplus:${surplus.transactionHash}`),true);equal('scoped fees contain only deployment receipts',scoped.fees().map(f=>f.tx).sort(),selected);const before=scoped.digest();for(const block of blocks)scoped.capture(block);scoped.project();equal('scoped receipt redelivery is idempotent',scoped.digest(),before);await reconcileBooks(client,scoped);}finally{scoped.close();}
  await rejects('public capture range is bounded',()=>captureDeploymentRange(client,1n,101n,f.manifest));
  await writeFile(`${DIR}/scoped-capture.json`,json({environment:'local-anvil',from:f.manifest.opening.block,to:end,selected,unrelated:[unrelatedApproval.transactionHash,unrelatedTransfer.transactionHash],digest:f.books.digest()}));
 }finally{f.books.close();}
}

let child: ChildProcess | undefined;
  try {
    let occupied = false;
    try {
      await client.getChainId();
      occupied = true;
    } catch {}
    if (occupied)
      throw Error(
        "Port 18545 is occupied; refusing to use or stop another chain",
      );
    child = spawn(
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
    for (const bad of ["1e3", "0.0000001", "-1", "0", "01", "1."])
      await rejects("money rejects " + bad, () => parseMoney(bad));
    equal("money keeps atomic-unit precision", parseMoney("0.000001"), 1n);
    await customerOrder(false, true);
    await customerOrder(true, false);
    await cancellation();
    await group();
    await orderingAndConcurrency();
    await scopeIsolation();
    console.log("WALLET_ACCOUNTING_PASS", checks.length);
  } catch (error) {
    checks.push({
      name: "runner",
      actual: error instanceof Error ? error.stack : String(error),
      expected: "all scenarios complete",
      status: "failed",
    });
    console.error(error);
    process.exitCode = 1;
  } finally {
    await writeFile(
      `${DIR}/checks.json`,
      json({
        environment: "local-anvil",
        chainId: 31337,
        contractSource: RELEASE_ID.sourceSha256,
        runtimeBytes: RELEASE_ID.runtimeBytes,
        checks,
      }),
    );
    await writeFile(`${DIR}/receipts.json`, json(receipts));
    child?.kill("SIGTERM");
  }
}
