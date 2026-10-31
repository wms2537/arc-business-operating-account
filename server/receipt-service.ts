import type { PublicClient } from "viem";
import type { Books } from "./books-core";
import { validateDeployment } from "../src/lib/deployment";
import { parseChallenge, receiptMessage } from "../src/lib/receipt-evidence";
import { KERNEL_ABI } from "../src/lib/kernel-abi";
import { uint, hex, sameAddress } from "../src/lib/boundary";

/** Shared receipt authorization for the Studio and Workers HTTP adapters. */
export async function recordDeliveryReceipt(client: PublicClient, books: Books, action: "challenge" | "confirm", value: Record<string, unknown>) {
  await validateDeployment(client, books.manifest);
  const requested = action === "challenge" ? { planId: uint(value.planId).toString(), buyerAccount: uint(value.buyerAccount).toString() } : parseChallenge(value.challenge);
  const saved = books.progress().state.plans[requested.planId];
  if (!saved) throw Error("Plan has not been indexed");
  const block = await client.getBlock();
  const [plan, account] = await Promise.all([
    client.readContract({ address: books.manifest.kernelAddress, abi: KERNEL_ABI, functionName: "getPlan", args: [BigInt(requested.planId)], blockNumber: block.number }),
    client.readContract({ address: books.manifest.kernelAddress, abi: KERNEL_ABI, functionName: "getAccount", args: [BigInt(requested.buyerAccount)], blockNumber: block.number }),
  ]);
  const owner = books.progress().state.accounts[requested.buyerAccount]?.owner;
  if (plan[0] !== 0 || plan[1] !== 1 || plan[2] !== saved.hash || !owner || !sameAddress(owner, account[0])) throw Error("Live chain does not confirm the recorded group allocation");
  if (action === "challenge") {
    const challenge = books.issueChallenge(requested.planId, requested.buyerAccount);
    return { challenge, message: receiptMessage(challenge) };
  }
  const result = await books.acceptReceipt(parseChallenge(value.challenge), hex(value.signature));
  return { status: result };
}
