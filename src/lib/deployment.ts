import {
  keccak256,
  toBytes,
  erc20Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { KERNEL_ABI, RELEASE_ID } from "./kernel-abi";
import {
  record,
  text,
  integer,
  uint,
  address,
  hash,
  array,
  sameAddress,
  json,
} from "./boundary";
export const ARC_TESTNET_USDC: Address =
  "0x3600000000000000000000000000000000000000";
export type JournalLine = {
  entity: string;
  account: string;
  side: "debit" | "credit";
  amount: string;
};
export type Opening = {
  block: string;
  hash: Hex;
  timestamp: string;
  fixtureVersion: string;
  ruleVersion: 2;
  lines: JournalLine[];
  accounts: { id: string; owner: Address; entity: string; cash: string }[];
  poolCash: string;
  custody: string;
};
export type DeploymentManifest = {
  version: 2;
  environment: "local-anvil" | "arc-testnet";
  chainId: 31337 | 5042002;
  kernelAddress: Address;
  usdcAddress: Address;
  lenderAddress: Address;
  deploymentTransaction: Hex;
  deploymentBlock: string;
  sourceSha256: string;
  opening: Opening;
  entities: { address: Address; id: string }[];
  instanceId: Hex;
};
export function parseLine(value: unknown): JournalLine {
  const v = record(value);
  const side = v.side;
  if (side !== "debit" && side !== "credit")
    throw Error("Invalid journal side");
  return {
    entity: text(v.entity),
    account: text(v.account),
    side,
    amount: uint(v.amount).toString(),
  };
}
function canonical(value: unknown): unknown {
  if (typeof value === "string")
    return /^0x[0-9a-fA-F]+$/.test(value) ? value.toLowerCase() : value;
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => [key, canonical(v)]),
    );
  return value;
}
export function manifestIdentity(
  value: Omit<DeploymentManifest, "instanceId">,
): Hex {
  const fields = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "instanceId"),
  );
  return keccak256(toBytes(json(canonical(fields))));
}
export function parseManifest(value: unknown): DeploymentManifest {
  const v = record(value),
    o = record(v.opening);
  if (v.version !== 2 || o.ruleVersion !== 2)
    throw Error("Unsupported deployment or posting rules");
  const environment = v.environment,
    chainId = integer(v.chainId);
  if (!(
    (environment === "local-anvil" && chainId === 31337) ||
    (environment === "arc-testnet" && chainId === 5042002)
  ))
    throw Error("Only local Anvil and Arc testnet are supported");
  if (chainId !== 31337 && chainId !== 5042002) throw Error("Invalid chain");
  const usdcAddress = address(v.usdcAddress);
  if (
    environment === "arc-testnet" &&
    !sameAddress(usdcAddress, ARC_TESTNET_USDC)
  )
    throw Error("Arc USDC mismatch");
  const sourceSha256 = text(v.sourceSha256);
  if (sourceSha256 !== RELEASE_ID.sourceSha256)
    throw Error("Source artifact mismatch");
  const opening: Opening = {
    block: uint(o.block).toString(),
    hash: hash(o.hash),
    timestamp: uint(o.timestamp).toString(),
    fixtureVersion: text(o.fixtureVersion),
    ruleVersion: 2,
    lines: array(o.lines).map(parseLine),
    accounts: array(o.accounts).map((x) => {
      const a = record(x);
      return {
        id: uint(a.id).toString(),
        owner: address(a.owner),
        entity: text(a.entity),
        cash: uint(a.cash).toString(),
      };
    }),
    poolCash: uint(o.poolCash).toString(),
    custody: uint(o.custody).toString(),
  };
  const entities = array(v.entities).map((x) => {
    const e = record(x);
    return { address: address(e.address), id: text(e.id) };
  });
  if (
    new Set(entities.map((e) => e.address.toLowerCase())).size !==
      entities.length ||
    new Set(entities.map((e) => e.id)).size !== entities.length
  )
    throw Error("Duplicate entity identity");
  for (const a of opening.accounts)
    if (
      !entities.some(
        (e) => sameAddress(e.address, a.owner) && e.id === a.entity,
      )
    )
      throw Error("Opening owner/entity mismatch");
  const base: Omit<DeploymentManifest, "instanceId"> = {
    version: 2,
    environment,
    chainId,
    kernelAddress: address(v.kernelAddress),
    usdcAddress,
    lenderAddress: address(v.lenderAddress),
    deploymentTransaction: hash(v.deploymentTransaction),
    deploymentBlock: uint(v.deploymentBlock).toString(),
    sourceSha256,
    opening,
    entities,
  };
  const instanceId = manifestIdentity(base);
  if (hash(v.instanceId) !== instanceId)
    throw Error("Deployment identity mismatch");
  if (BigInt(base.deploymentBlock) > BigInt(opening.block))
    throw Error("Opening predates deployment");
  return { ...base, instanceId };
}
export function normalizedRuntimeHash(code: Hex): Hex {
  const bytes = toBytes(code);
  if (bytes.length !== RELEASE_ID.runtimeBytes)
    throw Error("Runtime length differs from verified release");
  for (const range of RELEASE_ID.immutableRanges)
    bytes.fill(0, range.start, range.start + range.length);
  return keccak256(bytes);
}
export async function validateDeployment(
  client: PublicClient,
  m: DeploymentManifest,
): Promise<void> {
  const [chain, code, token, lender, pool, decimals, opening, receipt] =
    await Promise.all([
      client.getChainId(),
      client.getBytecode({ address: m.kernelAddress }),
      client.readContract({
        address: m.kernelAddress,
        abi: KERNEL_ABI,
        functionName: "usdc",
      }),
      client.readContract({
        address: m.kernelAddress,
        abi: KERNEL_ABI,
        functionName: "lender",
      }),
      client.readContract({
        address: m.kernelAddress,
        abi: KERNEL_ABI,
        functionName: "getPool",
        args: [1n],
      }),
      client.readContract({
        address: m.usdcAddress,
        abi: erc20Abi,
        functionName: "decimals",
      }),
      client.getBlock({ blockNumber: BigInt(m.opening.block) }),
      client.getTransactionReceipt({ hash: m.deploymentTransaction }),
    ]);
  if (chain !== m.chainId) throw Error("RPC network differs from deployment");
  if (!code || normalizedRuntimeHash(code) !== RELEASE_ID.normalizedRuntimeHash)
    throw Error("Contract differs from verified release");
  if (
    !sameAddress(token, m.usdcAddress) ||
    !sameAddress(lender, m.lenderAddress) ||
    !sameAddress(pool[0], m.lenderAddress) ||
    decimals !== 6
  )
    throw Error("Token, lender, pool owner or token precision mismatch");
  if (
    opening.hash !== m.opening.hash ||
    opening.timestamp.toString() !== m.opening.timestamp
  )
    throw Error("Opening checkpoint is not canonical");
  if (
    receipt.status !== "success" ||
    !receipt.contractAddress ||
    !sameAddress(receipt.contractAddress, m.kernelAddress) ||
    receipt.blockNumber.toString() !== m.deploymentBlock
  )
    throw Error("Deployment receipt mismatch");
  const checkpointPool = await client.readContract({
    address: m.kernelAddress,
    abi: KERNEL_ABI,
    functionName: "getPool",
    args: [1n],
    blockNumber: opening.number,
  });
  let claims = checkpointPool[1];
  if (claims.toString() !== m.opening.poolCash || checkpointPool[2] !== 0n)
    throw Error("Opening pool mismatch");
  for (const a of m.opening.accounts) {
    const row = await client.readContract({
      address: m.kernelAddress,
      abi: KERNEL_ABI,
      functionName: "getAccount",
      args: [BigInt(a.id)],
      blockNumber: opening.number,
    });
    if (
      !sameAddress(row[0], a.owner) ||
      row[1].toString() !== a.cash ||
      row[3] !== 0n ||
      row[4] !== 0n ||
      row[5] !== 0n
    )
      throw Error("Opening account mismatch or unsettled opening");
    claims += row[1];
  }
  const custody = await client.readContract({
    address: m.kernelAddress,
    abi: KERNEL_ABI,
    functionName: "accountedCustody",
    blockNumber: opening.number,
  });
  if (custody !== claims || custody.toString() !== m.opening.custody)
    throw Error("Opening custody mismatch");
}
