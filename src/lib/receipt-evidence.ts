import { recoverMessageAddress, type Address, type Hex } from "viem";
import {
  record,
  text,
  hash,
  hex,
  address,
  integer,
  uint,
  sameAddress,
} from "./boundary";
export type ReceiptChallenge = {
  version: 1;
  deployment: Hex;
  chainId: number;
  kernel: Address;
  planId: string;
  termsHash: Hex;
  buyerAccount: string;
  buyer: Address;
  quantity: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
};
export type SignedReceipt = {
  challenge: ReceiptChallenge;
  signature: Hex;
  acceptedAt: number;
};
export function parseChallenge(value: unknown): ReceiptChallenge {
  const v = record(value);
  if (v.version !== 1) throw Error("Unsupported delivery-evidence version");
  const c: ReceiptChallenge = {
    version: 1,
    deployment: hash(v.deployment),
    chainId: integer(v.chainId),
    kernel: address(v.kernel),
    planId: uint(v.planId).toString(),
    termsHash: hash(v.termsHash),
    buyerAccount: uint(v.buyerAccount).toString(),
    buyer: address(v.buyer),
    quantity: uint(v.quantity).toString(),
    nonce: text(v.nonce),
    issuedAt: integer(v.issuedAt),
    expiresAt: integer(v.expiresAt),
  };
  if (
    !/^[0-9a-f-]{36}$/.test(c.nonce) ||
    c.expiresAt <= c.issuedAt ||
    c.expiresAt - c.issuedAt > 600000 ||
    BigInt(c.quantity) === 0n
  )
    throw Error("Invalid receipt challenge");
  return c;
}
export function receiptMessage(c: ReceiptChallenge): string {
  return [
    "Arc Business Account delivery receipt v1",
    "I confirm receipt of my full goods allocation. This signature records delivery evidence only. It cannot transfer money or approve spending.",
    `Deployment: ${c.deployment}`,
    `Chain: ${c.chainId}`,
    `Kernel: ${c.kernel}`,
    `Plan: ${c.planId}`,
    `Terms hash: ${c.termsHash}`,
    `Buyer account: ${c.buyerAccount}`,
    `Buyer: ${c.buyer}`,
    `Quantity: ${c.quantity}`,
    `Nonce: ${c.nonce}`,
    `Issued at: ${c.issuedAt}`,
    `Expires at: ${c.expiresAt}`,
  ].join("\n");
}
export function parseSignedReceipt(value: unknown): SignedReceipt {
  const v = record(value);
  return {
    challenge: parseChallenge(v.challenge),
    signature: hex(v.signature),
    acceptedAt: integer(v.acceptedAt),
  };
}
export async function verifyReceiptSignature(e: SignedReceipt): Promise<void> {
  if (
    e.acceptedAt < e.challenge.issuedAt ||
    e.acceptedAt > e.challenge.expiresAt
  )
    throw Error("Receipt challenge expired or is from the future");
  const signer = await recoverMessageAddress({
    message: receiptMessage(e.challenge),
    signature: e.signature,
  });
  if (!sameAddress(signer, e.challenge.buyer))
    throw Error("Delivery receipt was not signed by the buyer");
}
