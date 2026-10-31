import { mainnetDemoLimits, checkMainnetCloseQuote, type WalletFeeLimits } from "./mainnet-demo";
import { type Address, type Hex, type PublicClient } from "viem";
import {
  address,
  hash,
  hex,
  integer,
  json,
  record,
  sameAddress,
  text,
  uint,
} from "./boundary";
import { validateDeployment, type DeploymentManifest } from "./deployment";
export type IntentState =
  | { kind: "awaiting-wallet" }
  | { kind: "rejected" }
  | { kind: "unknown"; detail: string }
  | { kind: "submitted"; hash: Hex }
  | { kind: "reverted"; hash: Hex; block: string }
  | {
      kind: "confirmed";
      hash: Hex;
      block: string;
      books: "pending" | "posted";
    };
export type Intent = {
  id: string;
  deployment: Hex;
  chainId: number;
  signer: Address;
  nonce: number;
  to: Address;
  data: Hex;
  value: string;
  fromBlock: string;
  createdAt: number;
  purpose: string;
  state: IntentState;
};
export type IntentStore = { list(): Intent[]; save(intent: Intent): void };
export function parseIntent(value: unknown): Intent {
  const v = record(value),
    s = record(v.state);
  let state: IntentState;
  switch (s.kind) {
    case "awaiting-wallet":
      state = { kind: s.kind };
      break;
    case "rejected":
      state = { kind: s.kind };
      break;
    case "unknown":
      state = { kind: s.kind, detail: text(s.detail) };
      break;
    case "submitted":
      state = { kind: s.kind, hash: hash(s.hash) };
      break;
    case "reverted":
      state = {
        kind: s.kind,
        hash: hash(s.hash),
        block: uint(s.block).toString(),
      };
      break;
    case "confirmed":
      if (s.books !== "pending" && s.books !== "posted")
        throw Error("Invalid books state");
      state = {
        kind: s.kind,
        hash: hash(s.hash),
        block: uint(s.block).toString(),
        books: s.books,
      };
      break;
    default:
      throw Error("Unknown transaction state");
  }
  return {
    id: text(v.id),
    deployment: hash(v.deployment),
    chainId: integer(v.chainId),
    signer: address(v.signer),
    nonce: integer(v.nonce),
    to: address(v.to),
    data: hex(v.data),
    value: uint(v.value).toString(),
    fromBlock: uint(v.fromBlock).toString(),
    createdAt: integer(v.createdAt),
    purpose: text(v.purpose),
    state,
  };
}
export function browserIntentStore(storage: Storage): IntentStore {
  const prefix = "arc-business-intent-v3:";
  const list = () => {
    const values = new Map<string, Intent>();
    // Retain older saved intents, while every new write has its own atomic storage key.
    const legacy = storage.getItem("arc-business-intents-v2");
    if (legacy) {
      const parsed: unknown = JSON.parse(legacy);
      if (!Array.isArray(parsed))
        throw Error("Transaction storage is damaged; submission blocked");
      for (const intent of parsed.map(parseIntent))
        values.set(intent.id, intent);
    }
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const raw = storage.getItem(key);
      if (raw === null) continue;
      const intent = parseIntent(JSON.parse(raw));
      if (key !== prefix + intent.id)
        throw Error(
          "Transaction storage identity mismatch; submission blocked",
        );
      values.set(intent.id, intent);
    }
    return [...values.values()].sort(
      (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
    );
  };
  return {
    list,
    save(intent) {
      const key = prefix + intent.id,
        body = json(intent);
      storage.setItem(key, body);
      if (storage.getItem(key) !== body)
        throw Error("Could not persist transaction intent; submission blocked");
    },
  };
}
type WalletBoundary = {
  identity(): Promise<{ address: Address; chainId: number }>;
  send(input: {
    to: Address;
    data: Hex;
    value: bigint;
    nonce: number;
    chainId: number;
    feeLimits?: WalletFeeLimits;
  }): Promise<Hex>;
};
function rejected(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === 4001) return true;
  return "cause" in error && rejected(error.cause);
}
export async function submitIntent({
  client,
  manifest,
  wallet,
  store,
  to,
  data,
  purpose,
}: {
  client: PublicClient;
  manifest: DeploymentManifest;
  wallet: WalletBoundary;
  store: IntentStore;
  to: Address;
  data: Hex;
  purpose: string;
}): Promise<Intent> {
  const identity = await wallet.identity();
  if (identity.chainId !== manifest.chainId)
    throw Error("Switch wallet to the deployment network");
  if (
    !sameAddress(to, manifest.kernelAddress) &&
    !sameAddress(to, manifest.usdcAddress)
  )
    throw Error("Transaction target is outside this deployment");
  const feeLimits = mainnetDemoLimits(manifest, identity.address, to, data);
  if (feeLimits && store.list().some(i => i.chainId === manifest.chainId && sameAddress(i.signer, identity.address) && i.state.kind !== "rejected"))
    throw Error("A mainnet attempt is already recorded for this wallet. Use Recover status; do not submit another paid attempt before reviewing the remaining budget.");
  await validateDeployment(client, manifest);
  if (
    store
      .list()
      .some(
        (i) =>
          i.chainId === manifest.chainId &&
          sameAddress(i.signer, identity.address) &&
          ["awaiting-wallet", "unknown", "submitted"].includes(i.state.kind),
      )
  )
    throw Error("Resolve the existing transaction before submitting another");
  const block = await client.getBlockNumber({ cacheTime: 0 });
  const nonce = await client.getTransactionCount({
    address: identity.address,
    blockTag: "pending",
  });
  await client.call({ account: identity.address, to, data, value: 0n });
  if (feeLimits) {
    const [estimate, latest, gasPrice] = await Promise.all([client.estimateGas({ account: identity.address, to, data, value: 0n }), client.getBlock(), client.getGasPrice()]);
    checkMainnetCloseQuote(feeLimits, estimate, latest.baseFeePerGas, gasPrice);
  }
  const again = await wallet.identity();
  if (
    !sameAddress(identity.address, again.address) ||
    again.chainId !== identity.chainId
  )
    throw Error("Wallet changed during review");
  let intent: Intent = {
    id: crypto.randomUUID(),
    deployment: manifest.instanceId,
    chainId: manifest.chainId,
    signer: identity.address,
    nonce,
    to,
    data,
    value: "0",
    fromBlock: block.toString(),
    createdAt: Date.now(),
    purpose,
    state: { kind: "awaiting-wallet" },
  };
  store.save(intent);
  try {
    const sent = await wallet.send({
      to,
      data,
      value: 0n,
      nonce,
      chainId: manifest.chainId,
      ...(feeLimits ? { feeLimits } : {}),
    });
    intent = { ...intent, state: { kind: "submitted", hash: hash(sent) } };
  } catch (error) {
    intent = {
      ...intent,
      state: rejected(error)
        ? { kind: "rejected" }
        : {
            kind: "unknown",
            detail:
              "Wallet response was lost. Reconcile this intent before taking further action.",
          },
    };
  }
  store.save(intent);
  return intent;
}
export async function reconcileIntent(
  client: PublicClient,
  manifest: DeploymentManifest,
  store: IntentStore,
  intent: Intent,
  indexedBlock: bigint,
  maxBlocks = 2000,
): Promise<Intent> {
  if (
    intent.deployment !== manifest.instanceId ||
    intent.chainId !== manifest.chainId
  )
    throw Error("Intent belongs to another deployment");
  await validateDeployment(client, manifest);
  if (intent.state.kind === "rejected") return intent;
  let candidate: Hex | undefined =
    "hash" in intent.state ? intent.state.hash : undefined;
  if (!candidate) {
    const latest = await client.getBlockNumber({ cacheTime: 0 }),
      start = BigInt(intent.fromBlock);
    if (latest - start > BigInt(maxBlocks))
      throw Error(
        "Recovery range exceeds the bounded scan. Use the transaction hash or a trusted archive RPC; do not resend.",
      );
    for (let n = start; n <= latest && !candidate; n++) {
      const block = await client.getBlock({
        blockNumber: n,
        includeTransactions: true,
      });
      const tx = block.transactions.find(
        (t) => sameAddress(t.from, intent.signer) && t.nonce === intent.nonce,
      );
      if (tx) {
        if (
          !tx.to ||
          !sameAddress(tx.to, intent.to) ||
          tx.input.toLowerCase() !== intent.data.toLowerCase() ||
          tx.value !== BigInt(intent.value)
        )
          throw Error(
            "This nonce was used by a different transaction. Review the replacement; do not resend.",
          );
        candidate = tx.hash;
      }
    }
  }
  if (!candidate) {
    const pending = {
      ...intent,
      state: {
        kind: "unknown" as const,
        detail:
          "No matching confirmed transaction was found. Funds may still be pending; nothing was resent.",
      },
    };
    store.save(pending);
    return pending;
  }
  const tx = await client.getTransaction({ hash: candidate });
  if (
    !tx.to ||
    !sameAddress(tx.to, intent.to) ||
    !sameAddress(tx.from, intent.signer) ||
    tx.nonce !== intent.nonce ||
    tx.input.toLowerCase() !== intent.data.toLowerCase() ||
    tx.value !== BigInt(intent.value)
  )
    throw Error("Transaction hash does not match the saved intent");
  let updated: Intent = {
    ...intent,
    state: { kind: "submitted", hash: candidate },
  };
  if (tx.blockNumber !== null) {
    const receipt = await client.getTransactionReceipt({ hash: candidate });
    const canonical = await client.getBlock({
      blockNumber: receipt.blockNumber,
    });
    if (canonical.hash !== receipt.blockHash)
      throw Error("Receipt is no longer canonical");
    updated = {
      ...intent,
      state:
        receipt.status === "reverted"
          ? {
              kind: "reverted",
              hash: candidate,
              block: receipt.blockNumber.toString(),
            }
          : {
              kind: "confirmed",
              hash: candidate,
              block: receipt.blockNumber.toString(),
              books: indexedBlock >= receipt.blockNumber ? "posted" : "pending",
            },
    };
  }
  store.save(updated);
  return updated;
}

/** Serialize nonce selection and intent persistence across every tab on this origin. */
export async function withWalletLock<T>(
  chainId: number,
  signer: Address,
  run: () => Promise<T>,
): Promise<T> {
  if (!navigator.locks)
    throw Error(
      "This browser cannot safely coordinate wallet requests. Use a browser with Web Locks support.",
    );
  return navigator.locks.request(
    `arc-wallet:${chainId}:${signer.toLowerCase()}`,
    { mode: "exclusive", ifAvailable: true },
    (lock) => {
      if (!lock)
        throw Error(
          "Another tab has an active wallet request. Resolve it there first.",
        );
      return run();
    },
  );
}
export function restoreInterruptedIntents(store: IntentStore): void {
  for (const intent of store.list())
    if (intent.state.kind === "awaiting-wallet")
      store.save({
        ...intent,
        state: {
          kind: "unknown",
          detail:
            "The page closed during a wallet request. Recover the original transaction; do not resend.",
        },
      });
}
