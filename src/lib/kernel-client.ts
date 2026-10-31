import {
  createPublicClient,
  http,
  encodeFunctionData,
  decodeFunctionData,
  erc20Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { KERNEL_ABI } from "./kernel-abi";
import { sameAddress } from "./boundary";
export const PLAN_STATUS = [
  "Open",
  "Committed",
  "Cancelled",
  "Expired",
] as const;
export const WORKFLOW_KIND = ["Collective purchase", "Customer order"] as const;
export type PlanTerms = Extract<
  ReturnType<typeof decodeFunctionData<typeof KERNEL_ABI>>,
  { functionName: "draftPlan" }
>["args"][0];
export const makeKernelClient = (rpcUrl: string) =>
  createPublicClient({ transport: http(rpcUrl) });
export async function readAccount(
  client: PublicClient,
  kernel: Address,
  id: bigint,
  blockNumber?: bigint,
) {
  const [
    owner,
    cash,
    floor,
    aggregateHeld,
    activePlanCount,
    outstandingPrincipal,
  ] = await client.readContract({
    address: kernel,
    abi: KERNEL_ABI,
    functionName: "getAccount",
    args: [id],
    blockNumber,
  });
  if (cash < floor + aggregateHeld)
    throw Error("Account cash is below protected and held claims");
  return {
    owner,
    cash,
    floor,
    aggregateHeld,
    activePlanCount,
    outstandingPrincipal,
    availableCash: cash - floor - aggregateHeld,
  };
}
export async function readPlan(
  client: PublicClient,
  kernel: Address,
  id: bigint,
  blockNumber?: bigint,
) {
  const [kind, status, termsHash, expiry, committedAt] =
    await client.readContract({
      address: kernel,
      abi: KERNEL_ABI,
      functionName: "getPlan",
      args: [id],
      blockNumber,
    });
  if (kind > 1 || status > 3) throw Error("Unknown kernel state");
  return {
    kind: WORKFLOW_KIND[kind],
    status: PLAN_STATUS[status],
    kindCode: kind,
    statusCode: status,
    termsHash,
    expiry,
    committedAt,
  };
}
export function decodeTerms(input: Hex): PlanTerms {
  const decoded = decodeFunctionData({ abi: KERNEL_ABI, data: input });
  if (decoded.functionName !== "draftPlan")
    throw Error("Plan context must come from a confirmed draftPlan input");
  return decoded.args[0];
}
export type KernelCommand = Parameters<
  typeof encodeFunctionData<typeof KERNEL_ABI>
>[0];
export function kernelData(command: KernelCommand): Hex {
  return encodeFunctionData(command);
}
export function approvalData(kernel: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [kernel, amount],
  });
}
export type Snapshot = Awaited<ReturnType<typeof snapshot>>;
export async function snapshot(
  client: PublicClient,
  kernel: Address,
  accountIds: readonly string[],
  planContexts: readonly { id: string; terms: PlanTerms }[],
  signer?: Address,
) {
  const block = await client.getBlock();
  const options = {
    address: kernel,
    abi: KERNEL_ABI,
    blockNumber: block.number,
  };
  const [accounts, pool, plans, custody, accounted, signerAccount] =
    await Promise.all([
      Promise.all(
        accountIds.map(async (id) => ({
          id,
          ...(await readAccount(client, kernel, BigInt(id), block.number)),
        })),
      ),
      client.readContract({ ...options, functionName: "getPool", args: [1n] }),
      Promise.all(
        planContexts.map(async ({ id, terms }) => {
          const planId = BigInt(id);
          const [plan, readiness, escrow, sales] = await Promise.all([
            readPlan(client, kernel, planId, block.number),
            client.readContract({
              ...options,
              functionName: "planReadiness",
              args: [planId],
            }),
            client.readContract({
              ...options,
              functionName: "getEscrow",
              args: [planId],
            }),
            client.readContract({
              ...options,
              functionName: "getSalesState",
              args: [planId],
            }),
          ]);
          const participants = await Promise.all(
            (terms.kind === 1
              ? [terms.saleParty.merchantAccountId]
              : terms.buyers.map((b) => b.accountId)
            ).map(async (accountId, index) => {
              const approval = await client.readContract({
                ...options,
                functionName: "getLenderPlanApproval",
                args: [planId, BigInt(index)],
              });
              if (terms.kind === 1) {
                const r = await client.readContract({
                  ...options,
                  functionName: "getMerchantParticipation",
                  args: [planId],
                });
                return {
                  accountId,
                  joined: r[0],
                  cashHeld: r[1],
                  creditReserved: r[2],
                  approvedDraw: approval[0],
                  approvalExpiry: approval[1],
                };
              }
              const r = await client.readContract({
                ...options,
                functionName: "getBuyerParticipation",
                args: [planId, BigInt(index)],
              });
              return {
                accountId,
                joined: r[0],
                cashHeld: r[2],
                creditReserved: r[3],
                approvedDraw: approval[0],
                approvalExpiry: approval[1],
              };
            }),
          );
          const supplierApprovals = await Promise.all(
            terms.offerRefs.map(async (ref, index) => {
              const r = await client.readContract({
                ...options,
                functionName: "getSupplierPlanApproval",
                args: [planId, BigInt(index)],
              });
              return {
                offerId: ref.offerId,
                approvedQuantity: r[0],
                approvalExpiry: r[1],
              };
            }),
          );
          return {
            id,
            ...plan,
            participants,
            supplierApprovals,
            ready: readiness[0],
            blockedReason: readiness[1],
            escrow: {
              customer: escrow[0],
              amount: escrow[1],
              withdrawable: escrow[2],
              withdrawn: escrow[3],
            },
            sales: {
              goods: sales[0],
              freight: sales[1],
              accepted: sales[2],
              contractReceivable: sales[3],
              collected: sales[4],
              recognizedReceivable: sales[2] ? sales[3] - sales[4] : 0n,
            },
          };
        }),
      ),
      client.readContract({ ...options, functionName: "totalCustody" }),
      client.readContract({ ...options, functionName: "accountedCustody" }),
      signer
        ? client.readContract({
            ...options,
            functionName: "accountOf",
            args: [signer],
          })
        : 0n,
    ]);
  return {
    block: block.number,
    timestamp: block.timestamp,
    accounts,
    pool: {
      owner: pool[0],
      cash: pool[1],
      reserved: pool[2],
      available: pool[1] - pool[2],
    },
    plans,
    custody,
    accounted,
    surplus: custody - accounted,
    signerAccount,
    isLender: !!signer && sameAddress(signer, pool[0]),
  };
}
