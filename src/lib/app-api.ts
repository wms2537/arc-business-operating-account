import { arcRpcTransport } from "./arc-rpc";
import { createPublicClient, http } from "viem";
import { parseManifest } from "./deployment";
import {
  array,
  record,
  text,
  integer,
  uint,
  address,
  hex,
  hash,
} from "./boundary";
import { decodeTerms } from "./kernel-client";
export async function api(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const r = record(result);
    throw Error(
      typeof r.error === "string" ? r.error : "Books service request failed",
    );
  }
  return result;
}
export function parseDeployments(value: unknown) {
  return array(value).map((x) => {
    const v = record(x),
      manifest = parseManifest(v.manifest),
      rpcUrl = text(v.rpcUrl),
      url = new URL(rpcUrl);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw Error("Invalid RPC URL");
    return {
      manifest,
      rpcUrl,
      client: createPublicClient({ transport: manifest.environment === "arc-testnet" ? arcRpcTransport(rpcUrl) : http(rpcUrl) }),
    };
  });
}
export type Deployment = ReturnType<typeof parseDeployments>[number];
export function parseBooks(value: unknown) {
  const b = record(value),
    progress = record(b.progress),
    state = record(progress.state);
  const plans = Object.entries(record(state.plans)).map(([id, x]) => {
    const p = record(x);
    const input = hex(p.input);
    return {
      id: uint(id).toString(),
      terms: decodeTerms(input),
      input,
      termsHash: hash(p.hash),
      status: text(p.status),
      coordinator: address(p.coordinator),
    };
  });
  const accounts = Object.entries(record(state.accounts)).map(([id, x]) => {
    const a = record(x);
    return {
      id: uint(id).toString(),
      owner: address(a.owner),
      entity: text(a.entity),
    };
  });
  const offers = Object.entries(record(state.offers)).map(([id, x]) => {
    const a = record(x);
    return {
      id: uint(id).toString(),
      owner: address(a.owner),
      payee: address(a.payee),
      price: uint(a.price),
      capacity: uint(a.capacity),
      minimumFill: uint(a.minimumFill),
      expiry: uint(a.expiry),
    };
  });
  const loans = Object.entries(record(state.loans)).map(([id, x]) => {
    const a = record(x);
    return {
      id: uint(id).toString(),
      plan: uint(a.plan).toString(),
      borrower: uint(a.borrower).toString(),
      original: uint(a.original),
      outstanding: uint(a.outstanding),
    };
  });
  const balances = array(b.balances).map((x) => {
    const a = record(x),
      amount = text(a.debitBalance);
    if (!/^-?(0|[1-9][0-9]*)$/.test(amount))
      throw Error("Invalid ledger balance");
    return {
      entity: text(a.entity),
      account: text(a.account),
      amount: BigInt(amount),
    };
  });
  const journals = array(b.journals).map((x) => {
    const a = record(x),
      side = a.side;
    if (side !== "debit" && side !== "credit")
      throw Error("Invalid journal side");
    return {
      id: integer(a.id),
      entity: text(a.entity),
      account: text(a.account),
      amount: uint(a.amount),
      side,
      kind: text(a.kind),
      source: text(a.source),
      timestamp: integer(a.timestamp),
      plan: a.plan === null ? null : text(a.plan),
    };
  });
  const issues = array(b.issues).map((x) => {
    const a = record(x);
    return {
      source: text(a.source),
      detail: text(a.detail),
      blocking: integer(a.blocking),
    };
  });
  const fees = array(b.fees).map((x) => {
    const a = record(x);
    return {
      tx: hash(a.tx),
      actor: address(a.actor),
      amount: uint(a.amount).toString(),
      asset: text(a.asset),
      decimals: integer(a.decimals),
      block: integer(a.block),
    };
  });
  return {
    deployment: hash(b.deployment),
    height: integer(progress.height),
    hash: hash(progress.hash),
    plans,
    accounts,
    offers,
    loans,
    balances,
    journals,
    issues,
    fees,
    receipts: array(b.receipts),
    syncError: b.syncError === null ? null : text(b.syncError),
  };
}
export type BookView = ReturnType<typeof parseBooks>;
